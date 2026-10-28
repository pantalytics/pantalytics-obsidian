/**
 * An editor that asked for a note before its socket had synced.
 *
 * `openNote` turns such an editor away, on purpose: an editor bound to a
 * document that is still empty would offer the file's text to fill it. What
 * it did not do was say when to ask again, so the editor waited for its own
 * next update, and on 2026-09-20 a phone typed into an empty page in the
 * meantime (issue #169). `whenSynced` is the answer to "when".
 */

import { KnapSync } from "../../src/knap/KnapSync";
import type { KnapVaultClient } from "../../src/knap/KnapVaultClient";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

const answers = async (url: string) => {
	if (url.endsWith("/api/me")) {
		return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
	}
	return new Response(
		JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
	);
};

async function linked(network: FakeNetwork) {
	const files = new MemoryFiles();
	let held: Parameters<ConstructorParameters<typeof KnapSync>[0]["save"]>[0] = {
		token: "knap_abc",
		cloudVaultId: "",
		cloudVaultName: "",
	};
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Phone",
		fetchFn: answers,
		files,
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: network.socket,
	});
	await sync.link({ id: "v1", name: "Work notes" });
	return { sync, files };
}

/** The client behind the engine, to close one note's socket the way the pool does. */
const clientOf = (sync: KnapSync) => (sync as unknown as { client: KnapVaultClient }).client;

describe("an editor that asked too early", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("is told the moment the note has synced, and then gets the whole note", async () => {
		const network = new FakeNetwork();
		const tree = new TreeDoc(network.doc(`/sync/v1/${TREE_DOC_ID}`));
		const docId = tree.ensureNote("bord.md");
		network.doc(`/sync/v1/${docId}`).getText("content").insert(0, "de hele kaart");
		const { sync } = await linked(network);

		// The pool closed the note's socket, as it does with any note nobody
		// has open. An editor opening it now finds a socket that has not
		// synced yet.
		clientOf(sync).close(docId);
		expect(sync.openNote("bord.md")).toBeNull();

		const ready = new Promise<void>((resolve) => sync.whenSynced("bord.md", resolve));
		await ready;

		const note = sync.openNote("bord.md");
		expect(note?.text.toString()).toBe("de hele kaart");
		note?.release();
		// The release catches the file up from the document; let it land
		// before the link comes down under it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		sync.stop();
	});

	it("an editor that moved on cancels, and is never called", async () => {
		const network = new FakeNetwork();
		const tree = new TreeDoc(network.doc(`/sync/v1/${TREE_DOC_ID}`));
		const docId = tree.ensureNote("een.md");
		network.doc(`/sync/v1/${docId}`).getText("content").insert(0, "x");
		const { sync } = await linked(network);
		clientOf(sync).close(docId);

		const ready = jest.fn();
		const cancel = sync.whenSynced("een.md", ready);
		cancel();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(ready).not.toHaveBeenCalled();
		sync.stop();
	});

	it("a drawing is never bound to a text editor, synced or not", async () => {
		const network = new FakeNetwork();
		const tree = new TreeDoc(network.doc(`/sync/v1/${TREE_DOC_ID}`));
		const docId = tree.ensureNote("Bord.excalidraw.md");
		network.doc(`/sync/v1/${docId}`).getText("content").insert(0, "## Drawing\n```json\n```\n%%");
		const { sync } = await linked(network);
		await new Promise<void>((resolve) => sync.whenSynced("Bord.excalidraw.md", resolve));

		// Bound, the editor would hold the empty fence, and Excalidraw would
		// read it while switching the file to its own view (issue #193).
		expect(sync.openNote("Bord.excalidraw.md")).toBeNull();
		sync.stop();
	});

	it("a note the cloud vault has never heard of is not waited for", async () => {
		const network = new FakeNetwork();
		const { sync } = await linked(network);
		const ready = jest.fn();

		sync.whenSynced("nieuw.md", ready)();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(ready).not.toHaveBeenCalled();
		sync.stop();
	});
});
