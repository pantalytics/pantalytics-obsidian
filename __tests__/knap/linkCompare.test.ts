/**
 * The two pictures a link shows before it writes anything (ADR-0107): the
 * sides next to each other, and what the cloud vault's settings would take
 * off this device.
 */

import {
	barSegments,
	hasHotkeys,
	pluginCount,
	settingsAsk,
	settingsLoss,
	sideBySide,
} from "../../src/knap/linkCompare";

describe("the two sides next to each other", () => {
	it("waits until both sides are counted and compared", () => {
		expect(sideBySide({ cloudNotes: 3, cloudAttachments: 1 })).toBeNull();
	});

	it("splits the notes four ways, each note once", () => {
		const picture = sideBySide({
			cloudNotes: 10,
			cloudAttachments: 2,
			localNotes: 9,
			localAttachments: 1,
			differentNotes: 2,
			onlyCloudNotes: 3,
			onlyLocalNotes: 2,
		});
		expect(picture?.bar).toEqual({ same: 5, different: 2, onlyCloud: 3, onlyLocal: 2 });
		expect(picture?.cloud.plugins).toBeUndefined();
	});

	it("shows plugins on both columns or on neither", () => {
		const picture = sideBySide({
			cloudNotes: 1,
			cloudAttachments: 0,
			localNotes: 0,
			localAttachments: 0,
			differentNotes: 0,
			onlyCloudNotes: 1,
			onlyLocalNotes: 0,
			cloudPlugins: 4,
			localPlugins: 0,
		});
		expect(picture?.cloud.plugins).toBe(4);
		expect(picture?.local.plugins).toBe(0);
	});

	it("draws only the parts there is something in", () => {
		expect(barSegments({ same: 5, different: 0, onlyCloud: 1, onlyLocal: 0 })).toEqual([
			{ key: "same", label: "Same", count: 5 },
			{ key: "onlyCloud", label: "Only in the cloud", count: 1 },
		]);
	});

	it("counts plugin folders, not files", () => {
		expect(
			pluginCount([
				".obsidian/plugins/dataview/main.js",
				".obsidian/plugins/dataview/manifest.json",
				".obsidian/plugins/templater/main.js",
				".obsidian/appearance.json",
			]),
		).toBe(2);
	});
});

describe("what the cloud vault's settings take off this device", () => {
	const cloud = [".obsidian/appearance.json", ".obsidian/plugins/dataview/main.js"];

	it("asks nothing when the cloud vault has no settings, because this device seeds it", () => {
		expect(settingsLoss([], [".obsidian/plugins/templater/main.js"], true)).toBeNull();
	});

	it("asks nothing of a fresh vault, which has only Obsidian's own files", () => {
		expect(
			settingsLoss(cloud, [".obsidian/app.json", ".obsidian/core-plugins.json"], false),
		).toBeNull();
	});

	it("names the plugins, themes and snippets removed here, and what comes", () => {
		const loss = settingsLoss(
			cloud,
			[
				".obsidian/plugins/templater/main.js",
				".obsidian/themes/Minimal/theme.css",
				".obsidian/snippets/wide.css",
			],
			false,
		);
		expect(loss).toEqual({
			plugins: ["templater"],
			themes: ["Minimal"],
			snippets: ["wide.css"],
			hotkeys: false,
			added: ["dataview"],
		});
	});

	it("asks when only the hotkeys would go", () => {
		expect(settingsLoss(cloud, [], true)?.hotkeys).toBe(true);
	});

	it("tells a hotkeys file with bindings from an empty one", () => {
		expect(hasHotkeys('{"app:go-back":[]}')).toBe(true);
		expect(hasHotkeys("{}")).toBe(false);
		expect(hasHotkeys(null)).toBe(false);
		expect(hasHotkeys("not json")).toBe(false);
	});

	it("says it with names", () => {
		const ask = settingsAsk(
			"Work notes",
			{ plugins: ["templater"], themes: [], snippets: [], hotkeys: true, added: ["dataview"] },
			(id) => (id === "templater" ? "Templater" : id),
		);
		expect(ask.title).toBe("Settings come from Work notes");
		expect(ask.removed).toBe("Removed here: Templater, your hotkeys.");
		expect(ask.added).toBe("Added: dataview.");
	});
});
