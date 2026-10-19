/**
 * Which settings files travel, and the three that do not.
 *
 * This list is written down twice, here and in the server's
 * `knap_mcp/providers/filesystem/paths.py`, because a device and a server that
 * disagree about it produce a 422 and a sentence about a file the person never
 * put anywhere. The cases below are the same cases that file's tests use, in
 * the same order, so a change to one is obvious in the other.
 */

import {
	CONFIG_DIR,
	isSyncedConfig,
	isUnderConfigDir,
	manifestLast,
	pluginFolderOf,
	withOurselves,
} from "../../src/knap/configPaths";

describe("what settings sync carries", () => {
	it.each([
		[".obsidian/app.json", true],
		[".obsidian/appearance.json", true],
		[".obsidian/snippets/mine.css", true],
		[".obsidian/themes/Minimal/theme.css", true],
		[".obsidian/community-plugins.json", true],
		[".obsidian/plugins/dataview/main.js", true],
		[".obsidian/plugins/dataview/data.json", true],
		// Ours, permanently: the account token and this vault's link.
		[".obsidian/plugins/pantalytics/data.json", false],
		[".obsidian/plugins/pantalytics/knap-seen.json", false],
		[".obsidian/plugins/pantalytics", false],
		// The id before ADR-0103: its folder stays on disk with the old token.
		[".obsidian/plugins/synced-vaults/data.json", false],
		[".obsidian/plugins/synced-vaults", false],
		// A plugin whose name merely starts the same way is not ours.
		[".obsidian/plugins/pantalytics-extra/main.js", true],
		// Which panes are open, on either kind of device.
		[".obsidian/workspace.json", false],
		[".obsidian/workspace-mobile.json", false],
		// The rest of the family, seen on a real vault (#147): an older
		// Obsidian's extensionless file, and a file syncer's duplicates.
		[".obsidian/workspace", false],
		[".obsidian/workspace 2.json", false],
		[".obsidian/workspace 3.json", false],
		// Dropped with them on purpose: the core plugin's saved layouts.
		[".obsidian/workspaces.json", false],
		// A plugin named after them lives a directory down and travels.
		[".obsidian/plugins/workspaces-plus/main.js", true],
		// What the operating system left lying around, at any depth.
		[".obsidian/.DS_Store", false],
		[".obsidian/plugins/.DS_Store", false],
		[".obsidian/plugins/dataview/.ds_store", false],
		[".obsidian/Thumbs.db", false],
		// Hidden, and not settings.
		[".trash/gone.md", false],
		[".git/config", false],
		["Areas/.hidden/note.md", false],
		// A renamed config directory is out of this feature's scope.
		[".obsidian-beta/app.json", false],
		// The directory itself is not a file to carry.
		[".obsidian", false],
		// Not hidden at all.
		["Areas/Work/note.md", false],
	])("%s -> %s", (path, carried) => {
		expect(isSyncedConfig(path)).toBe(carried);
	});

	it("judges the spelling, not the string somebody typed", () => {
		// Every escape this codebase has seen has been a spelling, so the
		// carve-out has to survive one. `normalize` runs first, inside.
		for (const spelling of [
			".obsidian/plugins/./synced-vaults/data.json",
			".obsidian\\plugins\\pantalytics\\data.json",
			"./.obsidian/workspace.json",
		]) {
			expect(isSyncedConfig(spelling)).toBe(false);
		}
	});

	it("refuses a path that leaves the vault rather than throwing at the caller", () => {
		expect(isSyncedConfig("../.obsidian/app.json")).toBe(false);
	});

	it("knows the whole directory, carve-outs included", () => {
		expect(isUnderConfigDir(`${CONFIG_DIR}/workspace.json`)).toBe(true);
		expect(isUnderConfigDir(`${CONFIG_DIR}/plugins/pantalytics/data.json`)).toBe(true);
		expect(isUnderConfigDir("Areas/Work/note.md")).toBe(false);
	});
});

describe("plugin folders", () => {
	it("names the folder a file belongs to", () => {
		expect(pluginFolderOf(".obsidian/plugins/dataview/main.js")).toBe("dataview");
		expect(pluginFolderOf(".obsidian/plugins/dataview/styles/x.css")).toBe("dataview");
	});

	it("is null for everything that is not inside one", () => {
		expect(pluginFolderOf(".obsidian/appearance.json")).toBeNull();
		expect(pluginFolderOf(".obsidian/plugins")).toBeNull();
		expect(pluginFolderOf("Areas/Work/note.md")).toBeNull();
	});
});

describe("the order a plugin folder is written in", () => {
	it("puts every manifest last, and leaves everything else where it was", () => {
		// Obsidian reads a plugin by its manifest, so a folder that has one
		// before it has its main.js is a plugin that half exists: listed, and
		// failing to load.
		const written = manifestLast([
			".obsidian/plugins/dataview/manifest.json",
			".obsidian/plugins/dataview/main.js",
			".obsidian/appearance.json",
			".obsidian/plugins/tasks/manifest.json",
			".obsidian/plugins/tasks/main.js",
		]);
		expect(written).toEqual([
			".obsidian/plugins/dataview/main.js",
			".obsidian/appearance.json",
			".obsidian/plugins/tasks/main.js",
			".obsidian/plugins/dataview/manifest.json",
			".obsidian/plugins/tasks/manifest.json",
		]);
	});

	it("leaves a list with no manifest in it alone", () => {
		const paths = [".obsidian/appearance.json", ".obsidian/hotkeys.json"];
		expect(manifestLast(paths)).toEqual(paths);
	});
});

describe("withOurselves", () => {
	const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
	const dec = (content: ArrayBuffer) => new TextDecoder().decode(content);
	const roster = ".obsidian/community-plugins.json";

	it("adds us to the roster and drops the old id", () => {
		const out = withOurselves(roster, enc('["synced-vaults","dataview"]'));
		expect(JSON.parse(dec(out))).toEqual(["dataview", "pantalytics"]);
	});

	it("leaves a roster that already has us untouched, byte for byte", () => {
		const content = enc('["pantalytics"]');
		expect(withOurselves(roster, content)).toBe(content);
	});

	it("leaves every other file, and a roster it cannot read, alone", () => {
		const theme = enc("{}");
		const broken = enc("not json");
		expect(withOurselves(".obsidian/appearance.json", theme)).toBe(theme);
		expect(withOurselves(roster, broken)).toBe(broken);
	});
});
