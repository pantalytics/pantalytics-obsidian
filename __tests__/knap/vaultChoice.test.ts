/**
 * The picker's list, and the line above it.
 *
 * Both are pure, and both are here rather than exercised through the modal,
 * because what matters about them is a rule rather than a rendering: making a
 * cloud vault is always offered, and the state of the fetch never becomes a
 * row somebody can select.
 */

import {
	NEW_VAULT_CHOICE,
	pickerPlaceholder,
	vaultChoices,
} from "../../src/knap/ObsidianKnap";

jest.mock("obsidian", () => ({
	Notice: class {},
	Platform: { isMobileApp: false },
	Plugin: class {},
	// Both are extended at module load, so a stand-in has to be a class even
	// though nothing here builds one.
	PluginSettingTab: class {},
	SuggestModal: class {},
	// The picker hands over to the progress modal, so that module loads with
	// this one and needs a base class to extend.
	Modal: class {
		contentEl = {};
		open() {}
		close() {}
	},
	setIcon: () => undefined,
	Setting: class {},
	// A note's history registers two views, which extend this at load.
	ItemView: class {},
}));

const vaults = [
	{ id: "v1", name: "Work notes" },
	{ id: "v2", name: "Personal" },
];

describe("what the picker offers", () => {
	it("lists the vaults, and ends with the way out", () => {
		expect(vaultChoices(vaults, "")).toEqual([
			{ kind: "vault", vault: vaults[0] },
			{ kind: "vault", vault: vaults[1] },
			NEW_VAULT_CHOICE,
		]);
	});

	it("filters on what was typed, ignoring case", () => {
		expect(vaultChoices(vaults, "work")).toEqual([
			{ kind: "vault", vault: vaults[0] },
			NEW_VAULT_CHOICE,
		]);
	});

	it("still offers making one when nothing matches", () => {
		// Somebody typing the name of a vault that does not exist yet is
		// exactly the person who needs the last row.
		expect(vaultChoices(vaults, "quarterly")).toEqual([NEW_VAULT_CHOICE]);
	});

	it("still offers making one when the account has none at all", () => {
		// This case used to be a notice in the corner with nothing to press.
		expect(vaultChoices([], "")).toEqual([NEW_VAULT_CHOICE]);
	});
});

describe("the line above the list", () => {
	it("says what the fetch is doing, so no row has to", () => {
		expect(pickerPlaceholder("loading")).toContain("Asking Pantalytics");
		expect(pickerPlaceholder("ready")).toContain("Search");
	});

	it("says the notes are safe when Knap cannot be reached", () => {
		expect(pickerPlaceholder("failed")).toContain("Could not reach Pantalytics");
		expect(pickerPlaceholder("failed")).toContain("safe here");
	});

	it("uses no em-dashes anywhere", () => {
		for (const state of ["loading", "ready", "failed"] as const) {
			expect(pickerPlaceholder(state)).not.toContain("—");
		}
	});
});
