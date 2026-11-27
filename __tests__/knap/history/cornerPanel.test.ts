/** What the corner's panel says about the vault and the open note, and when. */

import {
	NOTE_LOCAL,
	NOTE_STUCK,
	NOTE_SYNCED,
	NOTE_WAITING,
	cornerPanel,
	noteWord,
	vaultWhen,
	type VaultInput,
} from "../../../src/knap/history/cornerPanel";

const at = (d: number, h: number, min: number) => new Date(2026, 10, d, h, min).getTime();
const NOW = at(27, 15, 0);

const vault = (over: Partial<VaultInput> = {}): VaultInput => ({
	name: "Work notes",
	word: "Up to date",
	dot: "ok",
	up: 0,
	down: 0,
	checked: { done: 0, total: 0 },
	problems: 0,
	upToDateAt: NOW,
	...over,
});

const cloud = { inCloud: true, stuck: null, retrying: false, pending: false };
const note = { name: "Acme", facts: cloud, lastChanged: "Daniel, 3 min ago", created: at(12, 9, 0), history: true };

describe("the vault's line", () => {
	it("says just now, how much is moving, or since when", () => {
		expect(vaultWhen(vault(), NOW)).toBe("just now");
		expect(vaultWhen(vault({ word: "Uploading", up: 12 }), NOW)).toBe("↑ 12");
		expect(vaultWhen(vault({ word: "Syncing", up: 2, down: 340 }), NOW)).toBe("↑ 2 ↓ 340");
		expect(vaultWhen(vault({ word: "Syncing", checked: { done: 290, total: 3127 } }), NOW)).toBe("290 of 3,127");
		expect(vaultWhen(vault({ word: "Offline", upToDateAt: at(27, 14, 2) }), NOW)).toBe("since 14:02");
		expect(vaultWhen(vault({ word: "Offline", upToDateAt: at(20, 14, 2) }), NOW)).toBe("since 20 Nov");
		expect(vaultWhen(vault({ word: "Offline", upToDateAt: 0 }), NOW)).toBe("");
	});

	it("names the changes that did not sync under Problem only", () => {
		expect(cornerPanel(vault({ word: "Problem", problems: 2 }), null, NOW).vault.problem).toBe(
			"2 changes did not sync",
		);
		expect(cornerPanel(vault({ word: "Problem", problems: 1 }), null, NOW).vault.problem).toBe(
			"1 change did not sync",
		);
		expect(cornerPanel(vault({ word: "Offline", problems: 2 }), null, NOW).vault.problem).toBe("");
	});

	it("has no note block with no file open", () => {
		expect(cornerPanel(vault(), null, NOW).note).toBeNull();
	});
});

describe("the note's word", () => {
	it("is Could not sync first, with its reason", () => {
		expect(noteWord("Up to date", { ...cloud, stuck: "Too large" })).toEqual({ word: NOTE_STUCK, dot: "error" });
		const panel = cornerPanel(vault(), { ...note, facts: { ...cloud, stuck: "Too large" } }, NOW);
		expect(panel.note?.reason).toBe("Too large");
	});

	it("is Synced for a note the cloud vault holds, also while others are moving or stuck", () => {
		expect(noteWord("Up to date", cloud).word).toBe(NOTE_SYNCED);
		expect(noteWord("Uploading", cloud).word).toBe(NOTE_SYNCED);
		expect(noteWord("Problem", cloud).word).toBe(NOTE_SYNCED);
	});

	it("is Not synced yet while offline, while retrying, or before it reaches the cloud", () => {
		expect(noteWord("Offline", cloud).word).toBe(NOTE_WAITING);
		expect(noteWord("Up to date", { ...cloud, retrying: true }).word).toBe(NOTE_WAITING);
		expect(noteWord("Uploading", { ...cloud, inCloud: false }).word).toBe(NOTE_WAITING);
		expect(noteWord("Uploading", { ...cloud, pending: true })).toEqual({ word: NOTE_WAITING, dot: "working" });
	});

	it("waits in yellow while offline, whatever it waits for", () => {
		for (const facts of [cloud, { ...cloud, retrying: true }, { ...cloud, inCloud: false }]) {
			expect(noteWord("Offline", facts)).toEqual({ word: NOTE_WAITING, dot: "wait" });
		}
	});

	it("is Only on this device when the vault is up to date and still lacks it", () => {
		expect(noteWord("Up to date", { ...cloud, inCloud: false })).toEqual({ word: NOTE_LOCAL, dot: "wait" });
	});

	it("carries who changed it, when it was made, and whether it has versions", () => {
		expect(cornerPanel(vault(), note, NOW).note).toEqual({
			name: "Acme",
			word: NOTE_SYNCED,
			dot: "ok",
			reason: "",
			lastChanged: "Daniel, 3 min ago",
			created: "12 Nov",
			history: true,
		});
	});
});
