/**
 * The count a device sends on its sockets, after a first fill (#181).
 *
 * The plugin counts this disk once at start, before anything has come down.
 * On a vault linked empty that number is 0, and before this fix every socket
 * for the rest of the session said so, which on the panel reads as a device
 * stuck at nothing. Once the first pass is through, the next socket says
 * what is on disk.
 */

import { KnapSync } from "../../src/knap/KnapSync";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import { UP_TO_DATE } from "../../src/syncStatus";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

const answers = async (url: string) => {
	if (url.endsWith("/api/me")) {
		return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
	}
	return new Response(
		JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
	);
};

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("the count on a device's sockets", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("says what came down once the first pass is through", async () => {
		const network = new FakeNetwork();
		const tree = new TreeDoc(network.doc(`/sync/v1/${TREE_DOC_ID}`));
		for (const path of ["Cloud/a.md", "Cloud/b.md", "Cloud/c.md"]) tree.ensureNote(path);

		const urls: string[] = [];
		const Base = network.socket;
		const recording = class extends Base {
			constructor(url: string | URL) {
				super(url);
				urls.push(String(url));
			}
		};
		const files = new MemoryFiles();
		let held = { token: "knap_abc", cloudVaultId: "", cloudVaultName: "" };
		const sync = new KnapSync({
			serverUrl: "https://knap.test",
			deviceName: "Laptop",
			fetchFn: answers,
			files,
			load: () => held,
			save: async (value) => {
				held = value as typeof held;
			},
			webSocket: recording,
		});

		await sync.link({ id: "v1", name: "Work notes" });
		expect(urls[0]).toContain("notes=0");
		expect(sync.status().word).toBe(UP_TO_DATE);
		// The recount reads the disk, so give it a turn.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// A note that arrives after the pass opens a socket of its own.
		tree.ensureNote("Cloud/d.md");
		await until(() => urls.some((url) => url.includes("notes=3")));
		expect(urls.pop()).toContain("notes=3&attachments=0");

		sync.stop();
	});
});
