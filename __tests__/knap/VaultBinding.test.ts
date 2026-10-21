/**
 * The binding engine, on real Yjs docs and an in-memory file store.
 *
 * Two devices hang off one hub that relays updates the way the server
 * does, so every claim about convergence is a claim about two bindings
 * ending up with the same files. The file store fires events for the
 * binding's own writes too, exactly like Obsidian's vault does, which is
 * what makes the no-echo tests honest.
 */

import * as Y from "yjs";

import { generateHash } from "../../src/hashing";
import { VaultBinding, splice } from "../../src/knap/VaultBinding";
import { Hub, MemoryFiles, MemorySeen, device, restart, settle } from "../mocks/vaultHub";

describe("VaultBinding", () => {
	it("uploads local notes at link time, and a second device receives them", async () => {
		const hub = new Hub();
		const a = await device(hub, { "Notes/plan.md": "# Plan\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		expect(b.files.map.get("Notes/plan.md")).toBe("# Plan\n");
	});

	it("downloads remote notes at link time", async () => {
		const hub = new Hub();
		const a = await device(hub, { "een.md": "inhoud" });
		await settle(a.binding);
		const b = await device(hub);
		await settle(b.binding);

		expect(b.files.map.get("een.md")).toBe("inhoud");
	});

	it("a local edit reaches the other device as a merge, not a steamroll", async () => {
		const hub = new Hub();
		const a = await device(hub, { "samen.md": "regel1\nregel2\nregel3\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Both devices edit different lines of the same note, "offline".
		await a.files.write("samen.md", "regel1 door A\nregel2\nregel3\n");
		await settle(a.binding, b.binding);
		await b.files.write("samen.md", "regel1 door A\nregel2\nregel3 door B\n");
		await settle(a.binding, b.binding);

		expect(a.files.map.get("samen.md")).toBe("regel1 door A\nregel2\nregel3 door B\n");
		expect(a.files.map.get("samen.md")).toBe(b.files.map.get("samen.md"));
	});

	it("a rename travels as a tree move and the other device follows", async () => {
		const hub = new Hub();
		const a = await device(hub, { "oud.md": "tekst" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		await a.files.rename("oud.md", "Archief/nieuw.md");
		await settle(a.binding, b.binding);

		expect(b.files.map.has("oud.md")).toBe(false);
		expect(b.files.map.get("Archief/nieuw.md")).toBe("tekst");
	});

	it("a device that starts before the tree arrives does not mint a second document", async () => {
		// Measured on production 2026-08-31: one note ended up with two
		// documents and then no name in the tree at all, and vanished from
		// every device. The binding reconciled against a tree that had not
		// synced yet, so every local file looked new.
		const hub = new Hub();
		const a = await device(hub, { "Welkom.md": "# Welkom\n" });
		await settle(a.binding);
		const first = a.binding ? hub.treeOf().get("Welkom.md") : undefined;

		hub.treeDelay = 5;
		const b = await device(hub, { "Welkom.md": "# Welkom\n" });
		await settle(a.binding, b.binding);

		expect(hub.treeOf().get("Welkom.md")).toBe(first);
		expect(hub.documentCount()).toBe(1);
	});

	it("a note whose tree entry changes id stays on disk and in the tree", async () => {
		// The other half of the same failure: an update to a tree entry was
		// reported as removed plus added, and the removed half deleted the
		// file. The delete event that followed then took the path out of the
		// tree on every device.
		const hub = new Hub();
		const a = await device(hub, { "Welkom.md": "# Welkom\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Somebody points the path at a different document, the way a device
		// starting on an empty tree used to.
		hub.repoint("Welkom.md", "1111ffff2222aaaa3333bbbb4444cccc", "# Welkom\n");
		await settle(a.binding, b.binding);

		expect(a.files.map.has("Welkom.md")).toBe(true);
		expect(b.files.map.has("Welkom.md")).toBe(true);
		expect(hub.treeOf().has("Welkom.md")).toBe(true);
	});

	it("a tree that never arrives fails the link with a sentence, not a hang", async () => {
		// The cost of waiting for the tree: a socket that never syncs would
		// leave the Link button waiting with nothing on screen.
		jest.useFakeTimers();
		try {
			const hub = new Hub();
			hub.treeDelay = 10 * 60 * 1000; // longer than the binding waits
			const files = new MemoryFiles();
			const binding = new VaultBinding(files, hub.device(), () => "conflict");
			const started = binding.start();
			const caught = started.catch((error: Error) => error.message);
			await jest.advanceTimersByTimeAsync(31_000);

			await expect(caught).resolves.toContain("Could not reach the server");
		} finally {
			jest.useRealTimers();
		}
	});

	it("a delete leaves the tree and the other device's disk", async () => {
		const hub = new Hub();
		const a = await device(hub, { "weg.md": "x" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		await a.files.remove("weg.md");
		await settle(a.binding, b.binding);

		expect(b.files.map.has("weg.md")).toBe(false);
	});

	it("deleting a folder takes the notes in it out of the tree", async () => {
		// Obsidian's delete event for a folder names the folder and not the
		// notes in it. Left at that, the notes stayed in the tree and came
		// straight back down onto the disk they had just been deleted from.
		const hub = new Hub();
		const a = await device(hub, {
			"Map/een.md": "x",
			"Map/twee.md": "y",
			"los.md": "z",
		});
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.files.map.delete("Map/een.md");
		a.files.map.delete("Map/twee.md");
		a.files.emit({ type: "delete", path: "Map" });
		await settle(a.binding, b.binding);

		expect(hub.treeOf().has("Map/een.md")).toBe(false);
		expect(b.files.map.has("Map/twee.md")).toBe(false);
		expect(b.files.map.get("los.md")).toBe("z");
	});

	it("a note deleted while the plugin was not running is deleted in the cloud vault", async () => {
		// The delete somebody makes with Obsidian closed, or with the plugin
		// off, or on a laptop that never got back online before it was shut.
		// No event ever fires for it, so the only trace is a file that is not
		// where the record says it was.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "weg.md": "x", "blijft.md": "y" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);
		expect(b.files.map.get("weg.md")).toBe("x");

		a.binding.stop();
		a.files.map.delete("weg.md");

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(hub.treeOf().has("weg.md")).toBe(false);
		expect(a.files.map.has("weg.md")).toBe(false);
		expect(b.files.map.has("weg.md")).toBe(false);
		expect(b.files.map.get("blijft.md")).toBe("y");
	});

	it("a note deleted in the cloud vault while the device was away goes from its disk", async () => {
		// The same fact from the other end: this device kept the note, so on
		// the next start it used to upload it again under a new document and
		// undo somebody else's delete on every device.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "weg.md": "x" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.binding.stop();
		await b.files.remove("weg.md");
		await settle(b.binding);

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(a.files.map.has("weg.md")).toBe(false);
		expect(hub.treeOf().has("weg.md")).toBe(false);
	});

	it("a note that arrived while the device was away is still downloaded", async () => {
		// The record may only speak about notes it has seen. Reading a note
		// it has never heard of as a deletion is how this would eat the work
		// of every other device.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "eigen.md": "x" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.binding.stop();
		await b.files.write("nieuw.md", "van B");
		await settle(b.binding);

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(a.files.map.get("nieuw.md")).toBe("van B");
		expect(a.files.map.get("eigen.md")).toBe("x");
	});

	it("a restart opens no note whose file is what the server last mirrored", async () => {
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "een.md": "1", "twee.md": "2" }, seen);
		await settle(a.binding);
		await hub.mirror();

		hub.borrowed.clear();
		const again = await restart(hub, a.files, seen);
		await settle(again);
		expect(hub.borrowed.size).toBe(0);
		// The pass still counts them: the screen says the check is done.
		expect(again.checked).toEqual({ done: 2, total: 2 });
	});

	it("a restart opens the one note that changed in the cloud while the device was away", async () => {
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "stil.md": "blijft", "druk.md": "oud" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);
		await hub.mirror();
		a.binding.stop();

		await b.files.write("druk.md", "nieuw");
		await settle(b.binding);
		await hub.mirror();

		hub.borrowed.clear();
		const again = await restart(hub, a.files, seen);
		await settle(again);
		expect(hub.borrowed.has(hub.treeOf().get("stil.md") as string)).toBe(false);
		expect(hub.borrowed.has(hub.treeOf().get("druk.md") as string)).toBe(true);
		expect(a.files.map.get("druk.md")).toBe("nieuw");
	});

	it("a restart opens the one note edited here while the plugin was not running", async () => {
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "stil.md": "blijft", "druk.md": "oud" }, seen);
		await settle(a.binding);
		await hub.mirror();
		a.binding.stop();
		a.files.map.set("druk.md", "hier veranderd"); // no event: the plugin was off

		hub.borrowed.clear();
		const again = await restart(hub, a.files, seen);
		await settle(again);
		expect(hub.borrowed.has(hub.treeOf().get("stil.md") as string)).toBe(false);
		expect(hub.borrowed.has(hub.treeOf().get("druk.md") as string)).toBe(true);
	});

	it("a note the server has not hashed yet is opened, as before", async () => {
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "een.md": "1" }, seen);
		await settle(a.binding);

		hub.borrowed.clear();
		const again = await restart(hub, a.files, seen);
		await settle(again);
		expect(hub.borrowed.has(hub.treeOf().get("een.md") as string)).toBe(true);
	});

	it("a vault whose files have not loaded deletes nothing", async () => {
		// A vault Obsidian is still opening answers "which notes are here"
		// with too few, and a vault somebody emptied answers it with none.
		// The two are the same answer, and only one of them is worth acting
		// on, so the empty one is not acted on at all.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "een.md": "x", "twee.md": "y" }, seen);
		await settle(a.binding);
		a.binding.stop();

		const unloaded = new MemoryFiles();
		const back = await restart(hub, unloaded, seen);
		await settle(back);

		expect(hub.treeOf().has("een.md")).toBe(true);
		expect(hub.treeOf().has("twee.md")).toBe(true);
		expect(unloaded.map.get("een.md")).toBe("x");
	});

	it("without a record a restart deletes nothing on either side", async () => {
		// A device linking for the first time, and every device before this
		// record existed: a missing file is a note that has not arrived yet,
		// so it arrives. Nothing is deleted anywhere on the strength of a
		// guess.
		const hub = new Hub();
		const a = await device(hub, { "weg.md": "x" });
		await settle(a.binding);

		a.binding.stop();
		a.files.map.delete("weg.md");

		const back = await restart(hub, a.files);
		await settle(back);

		expect(hub.treeOf().has("weg.md")).toBe(true);
		expect(a.files.map.get("weg.md")).toBe("x");
	});

	it("a note arriving where an unsynced local file sits keeps both", async () => {
		// Not link time: B is already linked and typing, and A makes a note of
		// the same name on the other side of the world. The tree change reaches
		// B with a file already at that path, and writing over it would be the
		// one thing this binding promises never to do.
		const hub = new Hub();
		const a = await device(hub);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		b.files.map.set("Notes/idee.md", "wat ik zelf had");
		await a.files.write("Notes/idee.md", "wat zij schreef");
		await settle(a.binding, b.binding);

		expect(b.files.map.get("Notes/idee.md")).toBe("wat zij schreef");
		const copies = [...b.files.map].filter(([path]) => path.includes("conflict"));
		expect(copies).toHaveLength(1);
		expect(copies[0][1]).toBe("wat ik zelf had");
	});

	it("link-time conflict keeps the cloud text and saves the local text beside it", async () => {
		const hub = new Hub();
		const a = await device(hub, { "nota.md": "cloudversie" });
		await settle(a.binding);

		const b = await device(hub, { "nota.md": "lokale versie" });
		await settle(a.binding, b.binding);

		expect(b.files.map.get("nota.md")).toBe("cloudversie");
		expect(b.files.map.get("nota (conflict).md")).toBe("lokale versie");
		// The conflict copy is a new note like any other: it syncs too.
		expect(a.files.map.get("nota (conflict).md")).toBe("lokale versie");
	});

	it("an empty local file is filled, not copied beside itself", async () => {
		// What a fill killed halfway leaves at a path. Measured on 2026-09-05:
		// a phone made 57 of these, every copy nought bytes, and every one of
		// them became a note in the cloud vault and on every other device.
		const hub = new Hub();
		const a = await device(hub, { "nota.md": "cloudversie" });
		await settle(a.binding);

		const b = await device(hub, { "nota.md": "" });
		await settle(a.binding, b.binding);

		expect(b.files.map.get("nota.md")).toBe("cloudversie");
		expect([...b.files.map].filter(([path]) => path.includes("conflict"))).toHaveLength(0);
		expect([...a.files.map].filter(([path]) => path.includes("conflict"))).toHaveLength(0);
	});

	it("a fill that did not finish deletes nothing it never downloaded", async () => {
		// Measured 2026-09-05: a phone whose fill kept dying wrote down the
		// whole tree as notes it agreed with, and on the next start read its
		// own missing files as deletions. Four notes went off every device.
		const hub = new Hub();
		const a = await device(hub, { "komt.md": "aangekomen", "komt-niet.md": "kostbaar" });
		await settle(a.binding);

		// One note's socket never comes up, so the fill gets part of the way.
		hub.broken.add(hub.treeOf().get("komt-niet.md") as string);
		const seen = new MemorySeen();
		const b = await device(hub, {}, seen);
		await settle(a.binding, b.binding);
		expect(b.files.map.get("komt.md")).toBe("aangekomen");
		expect(b.files.map.has("komt-niet.md")).toBe(false);

		// Anything at all happening in the tree writes the record, which is
		// how a fill that is still limping along commits what it has not done.
		await a.files.write("later.md", "iets anders");
		await settle(a.binding, b.binding);

		// The record may not claim a note this device has not got.
		expect(seen.entries?.has("komt-niet.md") ?? false).toBe(false);

		// And the restart downloads it rather than deleting it everywhere.
		hub.broken.clear();
		const again = await restart(hub, b.files, seen);
		await settle(a.binding, again);

		expect(a.files.map.get("komt-niet.md")).toBe("kostbaar");
		expect(b.files.map.get("komt-niet.md")).toBe("kostbaar");
		expect(hub.treeOf().has("komt-niet.md")).toBe(true);
	});

	describe("three ways, against what this device last agreed with", () => {
		const copiesOn = (files: MemoryFiles) =>
			[...files.map].filter(([path]) => path.includes("conflict"));

		it("an empty local file this device cannot vouch for never deletes the cloud text (#169)", async () => {
			// Measured on production 2026-09-20: a phone whose copy of a note
			// was empty, and whose editor had not bound yet, saved one typed
			// character. The file binding diffed that against the full
			// document and the difference was every character of the note.
			const hub = new Hub();
			const board = "---\ntype: board\n---\n" + "## Kolom\n- kaart\n".repeat(200);
			const a = await device(hub, { "bord.md": board });
			await settle(a.binding);
			const docId = hub.treeOf().get("bord.md") as string;

			// The phone's fill dies on this note and leaves an empty file.
			hub.broken.add(docId);
			const phone = await device(hub, { "bord.md": "" }, new MemorySeen());
			await settle(a.binding, phone.binding);
			hub.broken.clear();
			expect(phone.files.map.get("bord.md")).toBe("");

			// The person opens it and types one character before anything
			// fills it. Obsidian saves the file.
			await phone.files.write("bord.md", "H");
			await settle(a.binding, phone.binding);

			// The note is whole, everywhere.
			expect(a.files.map.get("bord.md")).toBe(board);
			expect(phone.files.map.get("bord.md")).toBe(board);
			// And the character is not lost: it is a copy beside the note.
			expect(copiesOn(phone.files)).toEqual([["bord (conflict).md", "H"]]);
			expect(a.files.map.get("bord (conflict).md")).toBe("H");
		});

		it("an empty save with no base is filled from the cloud, not pushed as a deletion", async () => {
			const hub = new Hub();
			const a = await device(hub, { "nota.md": "cloudversie" });
			await settle(a.binding);
			hub.broken.add(hub.treeOf().get("nota.md") as string);
			const phone = await device(hub, {}, new MemorySeen());
			await settle(a.binding, phone.binding);
			hub.broken.clear();

			await phone.files.write("nota.md", "");
			await settle(a.binding, phone.binding);

			expect(a.files.map.get("nota.md")).toBe("cloudversie");
			expect(phone.files.map.get("nota.md")).toBe("cloudversie");
			expect(copiesOn(phone.files)).toHaveLength(0);
		});

		it("emptying a note on purpose still travels, because this device held it", async () => {
			const hub = new Hub();
			const a = await device(hub, { "weg-ermee.md": "oude inhoud" });
			const b = await device(hub);
			await settle(a.binding, b.binding);

			await a.files.write("weg-ermee.md", "");
			await settle(a.binding, b.binding);

			expect(b.files.map.get("weg-ermee.md")).toBe("");
			expect(copiesOn(a.files)).toHaveLength(0);
		});

		it("only the cloud moved: the old file is overwritten, no copy (#142)", async () => {
			const hub = new Hub();
			const seen = new MemorySeen();
			const a = await device(hub, { "nota.md": "oud" }, seen);
			const b = await device(hub);
			await settle(a.binding, b.binding);
			a.binding.stop();

			await b.files.write("nota.md", "nieuw van B");
			await settle(b.binding);

			const again = await restart(hub, a.files, seen);
			await settle(again, b.binding);

			expect(a.files.map.get("nota.md")).toBe("nieuw van B");
			expect(copiesOn(a.files)).toHaveLength(0);
			expect(copiesOn(b.files)).toHaveLength(0);
		});

		it("only this device moved: the edit goes up as a difference, no copy (#142)", async () => {
			const hub = new Hub();
			const seen = new MemorySeen();
			const a = await device(hub, { "nota.md": "regel1\nregel2\n" }, seen);
			const b = await device(hub);
			await settle(a.binding, b.binding);
			a.binding.stop();
			a.files.map.set("nota.md", "regel1\nregel2 hier\n"); // no event: the plugin was off

			const again = await restart(hub, a.files, seen);
			await settle(again, b.binding);

			expect(b.files.map.get("nota.md")).toBe("regel1\nregel2 hier\n");
			expect(a.files.map.get("nota.md")).toBe("regel1\nregel2 hier\n");
			expect(copiesOn(a.files)).toHaveLength(0);
			expect(copiesOn(b.files)).toHaveLength(0);
		});

		it("both moved: the cloud keeps the note, this device's text becomes a copy", async () => {
			const hub = new Hub();
			const seen = new MemorySeen();
			const a = await device(hub, { "nota.md": "begin" }, seen);
			const b = await device(hub);
			await settle(a.binding, b.binding);
			a.binding.stop();

			await b.files.write("nota.md", "begin, en B");
			await settle(b.binding);
			a.files.map.set("nota.md", "begin, en A"); // edited while the plugin was off

			const again = await restart(hub, a.files, seen);
			await settle(again, b.binding);

			expect(a.files.map.get("nota.md")).toBe("begin, en B");
			expect(b.files.map.get("nota.md")).toBe("begin, en B");
			expect(a.files.map.get("nota (conflict).md")).toBe("begin, en A");
			expect(b.files.map.get("nota (conflict).md")).toBe("begin, en A");
		});

		it("a held note's own saves keep its base, so a restart after typing is not a conflict", async () => {
			// The editor writes into the document directly and the binding never
			// sees those keystrokes. Obsidian's save of the same text is the one
			// moment it can tell the two sides agree.
			const hub = new Hub();
			const seen = new MemorySeen();
			const a = await device(hub, { "open.md": "een" }, seen);
			const b = await device(hub);
			await settle(a.binding, b.binding);

			const release = a.binding.hold("open.md");
			await b.files.write("open.md", "een twee"); // arrives in a's editor
			await settle(a.binding, b.binding);
			a.files.map.set("open.md", "een twee"); // and Obsidian saves it
			a.files.emit({ type: "modify", path: "open.md" });
			await settle(a.binding, b.binding);
			a.binding.stop();
			release();

			await b.files.write("open.md", "een twee drie");
			await settle(b.binding);

			const again = await restart(hub, a.files, seen);
			await settle(again, b.binding);

			expect(a.files.map.get("open.md")).toBe("een twee drie");
			expect(copiesOn(a.files)).toHaveLength(0);
		});

		it("the bases are written down with the tree, and only for notes on this disk", async () => {
			const hub = new Hub();
			const seen = new MemorySeen();
			const a = await device(hub, { "een.md": "1", "twee.md": "2" }, seen);
			await settle(a.binding);

			const ids = [hub.treeOf().get("een.md"), hub.treeOf().get("twee.md")];
			expect([...(seen.bases?.keys() ?? [])].sort()).toEqual([...ids].sort());
			expect(seen.bases?.get(ids[0] as string)).toBe(
				await generateHash(new TextEncoder().encode("1")),
			);
		});
	});

	it("its own writes do not echo", async () => {
		const hub = new Hub();
		const a = await device(hub, { "stil.md": "rust" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		const before = { a: a.files.writes, b: b.files.writes };
		await settle(a.binding, b.binding);
		await settle(a.binding, b.binding);
		expect(a.files.writes).toBe(before.a);
		expect(b.files.writes).toBe(before.b);
	});

	it("stands down for a note an editor is holding, and catches the file up after", async () => {
		const hub = new Hub();
		const a = await device(hub, { "open.md": "eerste regel\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Obsidian opens the note here: from now on the editor writes this
		// file, so a remote change may not be written over its buffer.
		const release = a.binding.hold("open.md");
		const docId = hub.device().tree().docIdFor("open.md");
		expect(docId).toBeTruthy();

		await b.files.write("open.md", "eerste regel\ntweede regel\n");
		await settle(a.binding, b.binding);
		expect(a.files.map.get("open.md")).toBe("eerste regel\n");

		// The editor closes: the file is brought up to date once, here.
		release();
		await settle(a.binding);
		expect(a.files.map.get("open.md")).toBe("eerste regel\ntweede regel\n");
	});

	it("ignores the save event of a held note, whose editor is already ahead", async () => {
		const hub = new Hub();
		const a = await device(hub, { "open.md": "een\ntwee\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		const release = a.binding.hold("open.md");
		// The other device adds a line while this editor holds the note.
		await b.files.write("open.md", "een\ntwee\ndrie van B\n");
		await settle(a.binding, b.binding);

		// The file here is a save behind the buffer somebody is typing in,
		// which is the ordinary state of an open note. Set rather than
		// written, because a write is what Obsidian is doing, not us.
		a.files.map.set("open.md", "een\ntwee\n");
		// And now Obsidian saves. Without the stand-down this splices the
		// other device's line back out of the document for everybody.
		a.files.emit({ type: "modify", path: "open.md" });
		await settle(a.binding, b.binding);
		expect(b.files.map.get("open.md")).toBe("een\ntwee\ndrie van B\n");

		release();
	});

	it("only markdown is bound; other files stay local", async () => {
		const hub = new Hub();
		const a = await device(hub, { "foto.png": "bytes", "echt.md": "note" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		expect(b.files.map.has("echt.md")).toBe(true);
		expect(b.files.map.has("foto.png")).toBe(false);
	});
});

describe("splice", () => {
	it("touches only the changed range", () => {
		const doc = new Y.Doc();
		const text = doc.getText("content");
		text.insert(0, "aaa MIDDEN zzz");
		splice(text, "aaa MIDDEN zzz", "aaa NIEUW zzz", doc);
		expect(text.toString()).toBe("aaa NIEUW zzz");
	});

	it("survives emoji and accents on UTF-16 boundaries", () => {
		const doc = new Y.Doc();
		const text = doc.getText("content");
		const before = "café ☕ plan 🚀 einde";
		text.insert(0, before);
		splice(text, before, "café ☕ plan 🚀🚀 einde", doc);
		expect(text.toString()).toBe("café ☕ plan 🚀🚀 einde");
	});
});
