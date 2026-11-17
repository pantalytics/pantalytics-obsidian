/**
 * A note that would not sync is named, with its reason (odoo-mcp-pro-admin#706).
 *
 * "Could not sync: 7 changes" and nothing else left somebody hunting for
 * seven notes in four hundred, on a phone. The binding keeps which note
 * failed and what it said, and forgets it once the note goes through.
 */

import { KnapServer } from "../../src/knap/KnapServer";
import { KnapVaultClient } from "../../src/knap/KnapVaultClient";
import { RetryLater } from "../../src/knap/deadline";
import { nameOf } from "../../src/knap/StuckNotesModal";
import { VaultBinding } from "../../src/knap/VaultBinding";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

class Flaky extends MemoryFiles {
	broken = new Set<string>();
	async read(path: string): Promise<string | null> {
		if (this.broken.has(path)) throw new Error(`EACCES: permission denied, open '${path}'\n    at stack`);
		return super.read(path);
	}
}

it("names the note that failed and forgets it once it goes through", async () => {
	process.setMaxListeners(0);
	const network = new FakeNetwork();
	const server = new KnapServer("https://knap.test", async () => new Response("{}"));
	const client = new KnapVaultClient(server, "v1", "knap_token", "Phone", network.socket);
	const files = new Flaky();
	files.map.set("Clients/Acme.md", "# Acme\n");
	files.map.set("Clients/Other.md", "# Other\n");
	files.broken.add("Clients/Acme.md");
	const binding = new VaultBinding(files, client, () => "conflict");

	await binding.start();
	await binding.flush();
	expect(binding.problems).toBe(1);
	expect(binding.stuckNotes).toEqual([
		{ path: "Clients/Acme.md", reason: "EACCES: permission denied, open 'Clients/Acme.md'" },
	]);

	files.broken.clear();
	await binding.start();
	await binding.flush();
	expect(binding.stuckNotes).toEqual([]);
	expect(binding.problems).toBe(0);
	binding.stop?.();
	client.destroy?.();
});

it("tries one stuck note again on its own", async () => {
	process.setMaxListeners(0);
	const network = new FakeNetwork();
	const server = new KnapServer("https://knap.test", async () => new Response("{}"));
	const client = new KnapVaultClient(server, "v1", "knap_token", "Phone", network.socket);
	const files = new Flaky();
	files.map.set("Clients/Acme.md", "# Acme\n");
	files.broken.add("Clients/Acme.md");
	const binding = new VaultBinding(files, client, () => "conflict");
	await binding.start();
	await binding.flush();
	expect(binding.stuckNotes.map((n) => n.path)).toEqual(["Clients/Acme.md"]);

	files.broken.clear();
	await binding.retryNote("Clients/Acme.md");
	await binding.flush();
	expect(binding.stuckNotes).toEqual([]);
	expect(client.tree().docIdFor("Clients/Acme.md")).toBeDefined();
	binding.stop?.();
	client.destroy?.();
});

it("splits a path into the note's name and its folder", () => {
	expect(nameOf("Clients/Acme/Renewal.md")).toEqual({ name: "Renewal", folder: "Clients/Acme" });
	expect(nameOf("Inbox.md")).toEqual({ name: "Inbox", folder: "" });
});

it("tries a note whose connection dropped again by itself, without calling it a problem", async () => {
	// #706: an iPhone that put Obsidian in the background showed seven notes
	// as "Could not sync". The connection went, not the notes.
	process.setMaxListeners(0);
	const network = new FakeNetwork();
	const server = new KnapServer("https://knap.test", async () => new Response("{}"));
	const client = new KnapVaultClient(server, "v1", "knap_token", "Phone", network.socket);
	const files = new MemoryFiles();
	files.map.set("Clients/Acme.md", "# Acme\n");
	let drops = 1;
	const read = files.read.bind(files);
	files.read = async (path: string) => {
		if (drops > 0) {
			drops -= 1;
			throw new RetryLater("The connection dropped before this note was sent.");
		}
		return read(path);
	};
	const binding = new VaultBinding(files, client, () => "conflict");
	await binding.start();
	await binding.flush();
	expect(binding.problems).toBe(0);
	expect(binding.stuckNotes).toEqual([]);

	await new Promise((resolve) => setTimeout(resolve, 2_500));
	await binding.flush();
	expect(client.tree().docIdFor("Clients/Acme.md")).toBeDefined();
	expect(binding.problems).toBe(0);
	binding.stop?.();
	client.destroy?.();
});
