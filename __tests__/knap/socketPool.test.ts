/**
 * The socket pool, against a network that runs out of sockets like a browser.
 *
 * Issue #115, measured on 2026-08-31: a vault of 2612 notes filled to 297
 * and stopped, with 258 connections to the server that never moved again,
 * because every note opened a websocket and none of them ever closed. A
 * renderer gets 255 of them, and the 256th handshake does not fail: it waits
 * in a queue nobody answers, so the note that asked for it waits forever and
 * every note behind it waits on that.
 *
 * So the fake network here has a ceiling and goes quiet above it, exactly
 * the way the real one did. The claims are about what the client does under
 * that ceiling: it never holds more sockets than the pool allows, a fill of
 * more notes than a browser has sockets runs to the end, two vaults in one
 * process both fill, and a note is never closed until what was written into
 * it has reached the server.
 *
 * Real `WebsocketProvider`s over a real y-protocol exchange, because the
 * thing under test is when a socket exists, and a fake provider would decide
 * that question itself.
 */

import { KnapServer } from "../../src/knap/KnapServer";
import { KnapVaultClient, NOTE_SOCKET_CAP } from "../../src/knap/KnapVaultClient";
import { TREE_DOC_ID } from "../../src/knap/TreeDoc";
import { VaultBinding } from "../../src/knap/VaultBinding";
import { FakeNetwork, MemoryFiles, roomOf } from "../mocks/fakeNetwork";

function clientFor(network: FakeNetwork, vaultId: string): KnapVaultClient {
	const server = new KnapServer("https://knap.test", async () => new Response("{}"));
	return new KnapVaultClient(server, vaultId, "knap_token", "Laptop", network.socket);
}

function vaultOf(count: number, prefix = "Notes"): MemoryFiles {
	const files = new MemoryFiles();
	for (let index = 0; index < count; index++) {
		files.map.set(`${prefix}/note-${index}.md`, `# Note ${index}\n`);
	}
	return files;
}

describe("the note socket pool", () => {
	jest.setTimeout(60_000);

	// y-websocket registers a process listener per provider when it thinks it
	// is on Node, and this file has two vaults' worth of pools open at once.
	// Obsidian is not Node by that test, so this is jest's noise and not the
	// plugin's.
	process.setMaxListeners(0);

	it("fills a vault of more than three hundred notes without ever holding more sockets than the pool", async () => {
		const network = new FakeNetwork();
		const client = clientFor(network, "v1");
		const files = vaultOf(320);
		const binding = new VaultBinding(files, client, () => "conflict");

		await binding.start();
		await binding.flush();

		// The whole point: one tree, one pool, and nothing else standing open.
		expect(network.peak).toBeLessThanOrEqual(NOTE_SOCKET_CAP + 1);
		expect(network.refused).toBe(0);
		expect(client.socketCount).toBeLessThanOrEqual(NOTE_SOCKET_CAP + 1);
		expect(binding.problems).toBe(0);

		// Every note arrived, and the tree names every one of them.
		const tree = client.tree().entries();
		expect(tree.size).toBe(320);
		for (const [path, docId] of tree) {
			expect(network.text(roomOf("v1", docId))).toBe(files.map.get(path));
		}

		// And none of them was closed before what it held had got there. A
		// close that beats the send buffer is an edit nobody ever sees again.
		let closed = 0;
		for (const [path, docId] of tree) {
			const room = roomOf("v1", docId);
			if (!network.closedWith.has(room)) continue;
			closed += 1;
			expect(network.closedWith.get(room)).toBe(files.map.get(path));
		}
		expect(closed).toBeGreaterThanOrEqual(320 - NOTE_SOCKET_CAP);

		binding.stop();
		client.destroy();
	});

	it("fills two vaults in one process, which is where the ceiling used to be reached", async () => {
		// The second face of #115, seen 2026-09-01: with the big vault open,
		// a second vault got its tree socket and then nothing, and said
		// "could not reach server" over a sign-in that had worked.
		const network = new FakeNetwork();
		const first = clientFor(network, "v1");
		const second = clientFor(network, "v2");
		const filesOne = vaultOf(300, "Een");
		const filesTwo = vaultOf(300, "Twee");
		const one = new VaultBinding(filesOne, first, () => "conflict");
		const two = new VaultBinding(filesTwo, second, () => "conflict");

		await Promise.all([one.start(), two.start()]);
		await Promise.all([one.flush(), two.flush()]);

		expect(network.peak).toBeLessThanOrEqual(2 * (NOTE_SOCKET_CAP + 1));
		expect(network.refused).toBe(0);
		expect(first.tree().entries().size).toBe(300);
		expect(second.tree().entries().size).toBe(300);
		for (const [path, docId] of second.tree().entries()) {
			expect(network.text(roomOf("v2", docId))).toBe(filesTwo.map.get(path));
		}

		one.stop();
		two.stop();
		first.destroy();
		second.destroy();
	});

	it("promotes a note an editor opens instead of reconnecting it, and keeps it through the fill", async () => {
		const network = new FakeNetwork();
		const client = clientFor(network, "v1");
		const tree = client.tree();
		await client.treeSynced();

		// A note the pool has open, which is what a note somebody opens
		// during a fill is.
		const docId = tree.ensureNote("Open.md");
		await client.withNote(docId, async ({ doc }) => {
			doc.getText("content").insert(0, "de eerste regel\n");
		});
		const room = roomOf("v1", docId);
		expect(network.opens.get(room)).toBe(1);

		// Obsidian opens it in an editor. Same document, same socket, same
		// first sync: nothing about it happens twice.
		const open = client.pin(docId);
		expect(open.provider.synced).toBe(true);
		// eslint-disable-next-line @typescript-eslint/no-base-to-string
		expect(open.text.toString()).toBe("de eerste regel\n");

		// And now the fill goes on around it, several pools deep.
		const others: string[] = [];
		for (let index = 0; index < NOTE_SOCKET_CAP * 5; index++) {
			const other = tree.ensureNote(`Vulling/${index}.md`);
			others.push(other);
			await client.withNote(other, async ({ doc }) => {
				doc.getText("content").insert(0, `nummer ${index}\n`);
			});
		}

		// The note the editor is holding was never closed and never asked
		// for a second connection, so nothing re-synced under the cursor.
		expect(network.opens.get(room)).toBe(1);
		expect(network.closedWith.has(room)).toBe(false);
		expect(open.provider.wsconnected).toBe(true);
		// The pool did recycle around it, which is what makes that a claim.
		expect(others.some((id) => network.closedWith.has(roomOf("v1", id)))).toBe(true);
		expect(network.peak).toBeLessThanOrEqual(NOTE_SOCKET_CAP + 2);

		// Typing in the editor still reaches the server over that socket.
		open.text.insert(open.text.length, "en de tweede\n");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(network.text(room)).toBe("de eerste regel\nen de tweede\n");

		open.release();
		client.destroy();
	});

	it("leaves nothing open when the vault is unlinked in the middle of a fill", async () => {
		// Unlink stops the binding and destroys the client, and the fill that
		// was running does not stop with it: it is a queue of promises, not a
		// thread. Every note still in the air used to be able to open a fresh
		// socket to a vault this device had just let go of.
		const network = new FakeNetwork();
		const client = clientFor(network, "v1");
		const binding = new VaultBinding(vaultOf(200), client, () => "conflict");

		const filling = binding.start();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(network.live).toBeGreaterThan(1); // it really was filling
		binding.stop();
		client.destroy();
		await filling.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(network.live).toBe(0);
	});

	it("keeps the tree's socket whatever the pool is doing", async () => {
		const network = new FakeNetwork();
		const client = clientFor(network, "v1");
		const tree = client.tree();
		await client.treeSynced();

		for (let index = 0; index < NOTE_SOCKET_CAP * 3; index++) {
			const docId = tree.ensureNote(`Vulling/${index}.md`);
			await client.withNote(docId, async ({ doc }) => {
				doc.getText("content").insert(0, `nummer ${index}\n`);
			});
		}

		expect(network.opens.get(roomOf("v1", TREE_DOC_ID))).toBe(1);
		expect(network.closedWith.has(roomOf("v1", TREE_DOC_ID))).toBe(false);
		expect(client.connected).toBe(true);
		expect(client.settled).toBe(true);

		client.destroy();
	});

	it("says on every socket what the device counts, and says nothing when it has not counted", async () => {
		// The fill of 2026-09-01: Mac at 2611 notes, server at 1773, phone at
		// 1420, and a card reading "Up to date". The server can only put the
		// gap on a screen if the device tells it the local total.
		const network = new FakeNetwork();
		const urls: string[] = [];
		const Base = network.socket as { new (url: string | URL): object };
		const recording = class extends Base {
			constructor(url: string | URL) {
				super(url);
				urls.push(String(url));
			}
		};
		const server = new KnapServer("https://knap.test", async () => new Response("{}"));

		const counting = new KnapVaultClient(server, "v1", "knap_token", "Laptop", recording, undefined, () => ({
			notes: 2611,
			attachments: 349,
		}));
		counting.tree();
		await counting.treeSynced();
		expect(urls.pop()).toContain("notes=2611&attachments=349");
		counting.destroy();

		// No supplier, or a supplier with nothing yet: the parameters stay off
		// the wire entirely rather than sending a zero nobody counted.
		const silent = new KnapVaultClient(server, "v2", "knap_token", "Laptop", recording, undefined, () => null);
		silent.tree();
		await silent.treeSynced();
		expect(urls.pop()).not.toContain("notes=");
		silent.destroy();
	});

	it("says what the device is, so a note's history can tell a phone from a desktop", async () => {
		const network = new FakeNetwork();
		const urls: string[] = [];
		const Base = network.socket as { new (url: string | URL): object };
		const recording = class extends Base {
			constructor(url: string | URL) {
				super(url);
				urls.push(String(url));
			}
		};
		const server = new KnapServer("https://knap.test", async () => new Response("{}"));
		const phone = new KnapVaultClient(
			server, "v1", "knap_token", "Laptop", recording, undefined, undefined, undefined, "iphone",
		);
		phone.tree();
		await phone.treeSynced();
		expect(urls.pop()).toContain("platform=iphone");
		phone.destroy();

		const older = new KnapVaultClient(server, "v2", "knap_token", "Laptop", recording);
		older.tree();
		await older.treeSynced();
		expect(urls.pop()).not.toContain("platform=");
		older.destroy();
	});
});
