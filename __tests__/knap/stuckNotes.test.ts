/**
 * A note that would not sync is named, with its reason (odoo-mcp-pro-admin#706).
 *
 * "Could not sync: 7 changes" and nothing else left somebody hunting for
 * seven notes in four hundred, on a phone. The binding keeps which note
 * failed and what it said, and forgets it once the note goes through.
 */

import { KnapServer } from "../../src/knap/KnapServer";
import { KnapVaultClient } from "../../src/knap/KnapVaultClient";
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
