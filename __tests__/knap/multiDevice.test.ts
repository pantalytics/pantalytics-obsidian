/**
 * Three people on one cloud vault: Rutger, Daniel and Iris, each with their
 * own disk and their own binding, on the hub that relays like the server.
 *
 * These are the awkward days rather than the happy path: two saves that
 * cross on the wire, a laptop that was offline for an afternoon, two people
 * who both make "Meeting.md", a delete on one side of an edit, a rename on
 * the other. What every scenario asserts is the same three promises:
 *
 * 1. Everybody ends up with the same files.
 * 2. Nothing anybody wrote is gone: it is in the note, or in a copy beside it.
 * 3. A copy appears only where two people really wrote the same note at once.
 *
 * Offline is the plugin not running: Obsidian closed, or open on a train
 * where nothing syncs and the next start reconciles. Two saves at the same
 * moment is `hub.split()`: each device writes before it has seen the other.
 */

import { Hub, MemoryFiles, MemorySeen, device, restart, settle } from "../mocks/vaultHub";
import type { VaultBinding } from "../../src/knap/VaultBinding";

interface Person {
	name: string;
	files: MemoryFiles;
	binding: VaultBinding;
	seen: MemorySeen;
}

async function team(hub: Hub, seed: Record<string, string>, names = ["rutger", "daniel", "iris"]) {
	const people: Person[] = [];
	for (const [index, name] of names.entries()) {
		const seen = new MemorySeen();
		// The first person brings the vault; everybody else joins it empty.
		const { files, binding } = await device(
			hub,
			index === 0 ? seed : {},
			seen,
			`${name} conflict`,
		);
		people.push({ name, files, binding, seen });
	}
	await settleAll(people);
	return people;
}

const settleAll = (people: Person[]) => settle(...people.map((person) => person.binding));

/** Obsidian closes; the disk stays. */
function goOffline(person: Person): void {
	person.binding.stop();
}

/** Obsidian opens again, and the binding reconciles. */
async function comeBack(hub: Hub, person: Person): Promise<void> {
	person.binding = await restart(hub, person.files, person.seen, `${person.name} conflict`);
}

/** An edit made with the plugin not running: no event, just a different file. */
function editOnDisk(person: Person, path: string, text: string): void {
	person.files.map.set(path, text);
}

function notesOf(person: Person): Record<string, string> {
	return Object.fromEntries(
		[...person.files.map].filter(([path]) => path.endsWith(".md")).sort(),
	);
}

function expectSameEverywhere(people: Person[]): Record<string, string> {
	const first = notesOf(people[0]);
	for (const person of people.slice(1)) expect(notesOf(person)).toEqual(first);
	return first;
}

const copies = (notes: Record<string, string>) =>
	Object.keys(notes).filter((path) => path.includes("conflict"));

/** Every piece of `words` is somewhere in the vault, intact. */
function expectKept(notes: Record<string, string>, ...words: string[]): void {
	const everything = Object.values(notes).join("\n---\n");
	for (const word of words) expect(everything).toContain(word);
}

const NOTE = "regel 1\nregel 2\nregel 3\n";

describe("three people on one cloud vault", () => {
	describe("at the same moment", () => {
		it("three saves to different lines of one note cross on the wire and merge, no copy", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE });

			hub.split();
			await rutger.files.write("plan.md", "regel 1 van Rutger\nregel 2\nregel 3\n");
			await daniel.files.write("plan.md", "regel 1\nregel 2 van Daniel\nregel 3\n");
			await iris.files.write("plan.md", "regel 1\nregel 2\nregel 3 van Iris\n");
			await settleAll([rutger, daniel, iris]);
			hub.heal();
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["plan.md"]).toBe("regel 1 van Rutger\nregel 2 van Daniel\nregel 3 van Iris\n");
			expect(copies(notes)).toEqual([]);
		});

		it("a save that lands after the other person's edit already arrived keeps both texts", async () => {
			// What 1.13.49 did to two people in an open note on 2026-10-21, at
			// file level: Daniel's change reaches Rutger's document before
			// Rutger's own save has been read. The open note no longer takes
			// this road (issue #183); a note nobody has open still can.
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "ICP App.md": NOTE });

			hub.split();
			await daniel.files.write("ICP App.md", NOTE + "zie je mij werken\n");
			// Rutger's save event is queued, and Daniel's edit arrives before
			// the binding gets to it.
			rutger.files.map.set("ICP App.md", NOTE + "Daniel is een held\n");
			hub.heal();
			rutger.files.emit({ type: "modify", path: "ICP App.md" });
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "zie je mij werken", "Daniel is een held");
			expect(copies(notes).length).toBeLessThanOrEqual(1);
		});

		it("two people make a note with the same name at once: one note, one copy, both texts", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "index.md": "start\n" });

			hub.split();
			await rutger.files.write("Meeting.md", "agenda van Rutger\n");
			await daniel.files.write("Meeting.md", "agenda van Daniel\n");
			await settleAll([rutger, daniel, iris]);
			hub.heal();
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "agenda van Rutger", "agenda van Daniel");
			expect(Object.keys(notes).filter((path) => path.startsWith("Meeting"))).toHaveLength(2);
			expect(copies(notes)).toHaveLength(1);
		});

		it("two people rename one note to different names at once: one note, nothing lost", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "oud.md": "inhoud\n" });

			hub.split();
			await rutger.files.rename("oud.md", "Rutgers naam.md");
			await daniel.files.rename("oud.md", "Daniels naam.md");
			await settleAll([rutger, daniel, iris]);
			hub.heal();
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["oud.md"]).toBeUndefined();
			expectKept(notes, "inhoud");
		});
	});

	describe("somebody was offline", () => {
		it("an edit made offline goes up as a difference when nobody else touched the note", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE });

			goOffline(daniel);
			editOnDisk(daniel, "plan.md", "regel 1\nregel 2 in de trein\nregel 3\n");
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["plan.md"]).toBe("regel 1\nregel 2 in de trein\nregel 3\n");
			expect(copies(notes)).toEqual([]);
		});

		it("an offline edit to a note somebody else changed meanwhile keeps both, named for who", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE });

			goOffline(daniel);
			editOnDisk(daniel, "plan.md", "regel 1\nregel 2 in de trein\nregel 3\n");
			await rutger.files.write("plan.md", "regel 1 op kantoor\nregel 2\nregel 3\n");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "regel 1 op kantoor", "regel 2 in de trein");
			expect(copies(notes)).toEqual(["plan (daniel conflict).md"]);
		});

		it("two people offline both make the same note: one note, one copy, both texts", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "index.md": "start\n" });

			goOffline(rutger);
			goOffline(daniel);
			editOnDisk(rutger, "Dailies/2026-10-21.md", "Rutger: klantgesprek\n");
			editOnDisk(daniel, "Dailies/2026-10-21.md", "Daniel: demo gegeven\n");
			await comeBack(hub, rutger);
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "Rutger: klantgesprek", "Daniel: demo gegeven");
			expect(copies(notes)).toEqual(["Dailies/2026-10-21 (daniel conflict).md"]);
		});

		it("an edit made offline survives a delete made in the cloud meanwhile", async () => {
			// A delete only says "I did not want this note as it was". Somebody
			// who wrote in it since did want it, and their words may not go
			// down with it.
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE, "blijft.md": "x\n" });

			goOffline(daniel);
			editOnDisk(daniel, "plan.md", NOTE + "Daniel schreef dit offline\n");
			await rutger.files.remove("plan.md");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "Daniel schreef dit offline");
		});

		it("a delete made in the cloud still goes through to a device that did not touch the note", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE, "blijft.md": "x\n" });

			goOffline(daniel);
			await rutger.files.remove("plan.md");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["plan.md"]).toBeUndefined();
			expect(notes["blijft.md"]).toBe("x\n");
		});

		it("an edit made offline follows a rename made in the cloud meanwhile", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "concept.md": NOTE });

			goOffline(daniel);
			editOnDisk(daniel, "concept.md", "regel 1\nregel 2 in de trein\nregel 3\n");
			await rutger.files.rename("concept.md", "Archief/definitief.md");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["concept.md"]).toBeUndefined();
			expect(notes["Archief/definitief.md"]).toBe("regel 1\nregel 2 in de trein\nregel 3\n");
			expect(copies(notes)).toEqual([]);
		});

		it("a note renamed offline keeps the edit somebody made in the cloud meanwhile", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "concept.md": NOTE });

			goOffline(daniel);
			daniel.files.map.delete("concept.md");
			daniel.files.map.set("Archief/definitief.md", NOTE);
			await rutger.files.write("concept.md", NOTE + "Rutger vulde aan\n");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expectKept(notes, "Rutger vulde aan");
		});
	});

	describe("somebody was offline, the other way round", () => {
		it("a note deleted offline comes back when somebody wrote in it meanwhile", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE });
			const before = hub.treeOf().get("plan.md");

			goOffline(daniel);
			daniel.files.map.delete("plan.md");
			await rutger.files.write("plan.md", NOTE + "Rutger vulde aan\n");
			await settleAll([rutger, iris]);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["plan.md"]).toBe(NOTE + "Rutger vulde aan\n");
			// The note itself stayed, history and all: not deleted and then
			// made again by whichever device happened to still hold the text.
			expect(hub.treeOf().get("plan.md")).toBe(before);
		});

		it("a note deleted offline that nobody touched since is deleted everywhere", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "plan.md": NOTE, "blijft.md": "x\n" });

			goOffline(daniel);
			daniel.files.map.delete("plan.md");
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes).toEqual({ "blijft.md": "x\n" });
		});

		it("a note renamed and edited offline keeps both the new name and the edit", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "concept.md": NOTE });

			goOffline(daniel);
			daniel.files.map.delete("concept.md");
			daniel.files.map.set("Archief/definitief.md", NOTE + "en afgerond\n");
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes["Archief/definitief.md"]).toBe(NOTE + "en afgerond\n");
			expect(notes["concept.md"]).toBeUndefined();
		});

		it("a note renamed offline, unchanged, is a move: one document, not a new one", async () => {
			const hub = new Hub();
			const [rutger, daniel, iris] = await team(hub, { "concept.md": NOTE });
			const before = hub.treeOf().get("concept.md");

			goOffline(daniel);
			daniel.files.map.delete("concept.md");
			daniel.files.map.set("Archief/definitief.md", NOTE);
			await comeBack(hub, daniel);
			await settleAll([rutger, daniel, iris]);

			expectSameEverywhere([rutger, daniel, iris]);
			expect(hub.treeOf().get("Archief/definitief.md")).toBe(before);
			expect(hub.treeOf().size).toBe(1);
		});
	});

	describe("joining and names", () => {
		it("somebody who joins after all of that gets exactly what everybody else has", async () => {
			const hub = new Hub();
			const [rutger, daniel] = await team(hub, { "a.md": "1\n", "b.md": "2\n" }, ["rutger", "daniel"]);
			await rutger.files.write("a.md", "1 en meer\n");
			await daniel.files.rename("b.md", "Map/b.md");
			await daniel.files.write("c.md", "nieuw\n");
			await settleAll([rutger, daniel]);

			const seen = new MemorySeen();
			const late = await device(hub, {}, seen, "iris conflict");
			const iris = { name: "iris", seen, ...late };
			await settleAll([rutger, daniel, iris]);

			const notes = expectSameEverywhere([rutger, daniel, iris]);
			expect(notes).toEqual({ "Map/b.md": "2\n", "a.md": "1 en meer\n", "c.md": "nieuw\n" });
		});

		// Known to fail: issue #184. Flip to `it` with the fix; jest says so
		// the day this starts passing.
		it.failing("one name typed on a Mac and on Windows is one note, not two", async () => {
			// macOS hands out decomposed names (NFD) where Windows and Linux
			// compose them (NFC). They look identical on screen.
			const nfc = "Café.md".normalize("NFC");
			const nfd = "Café.md".normalize("NFD");
			const hub = new Hub();
			const [mac, windows] = await team(hub, { [nfd]: "van de Mac\n" }, ["mac", "windows"]);

			await windows.files.write(nfc, "van de Mac\nen van Windows\n");
			await settleAll([mac, windows]);

			expect(hub.treeOf().size).toBe(1);
			const all = [...mac.files.map.keys(), ...windows.files.map.keys()].map((path) =>
				path.normalize("NFC"),
			);
			expect(new Set(all)).toEqual(new Set([nfc]));
		});
	});
});
