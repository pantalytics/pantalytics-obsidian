/**
 * The two pictures a link shows before it writes anything (ADR-0107).
 *
 * The first is the two sides next to each other: what the cloud vault holds,
 * what this device holds, and how the notes line up. Nine rows of counts said
 * the same, and nobody could read them at a glance before choosing which side
 * wins.
 *
 * The second is what a link takes off this device when the cloud vault's
 * settings replace this device's (ADR-0099): plugins, themes, snippets and
 * hotkeys, by name, so the question is asked before rather than discovered
 * after. A device with nothing to lose is not asked.
 *
 * Pure, like `linkSteps.ts`: the engine hands in paths and counts, the modal
 * draws what comes back.
 */

import type { LinkFacts } from "./linkSteps";
import { CONFIG_DIR, pluginFolderOf } from "./configPaths";

/** One side's column. `plugins` is absent where this host has no settings. */
export interface Side {
	notes: number;
	attachments: number;
	plugins?: number;
}

/** The notes, split four ways. Each note is in exactly one of them. */
export interface NoteBar {
	same: number;
	different: number;
	onlyCloud: number;
	onlyLocal: number;
}

export interface SideBySide {
	cloud: Side;
	local: Side;
	bar: NoteBar;
}

/**
 * The comparison, once both sides are counted and compared, or null before.
 * Plugins appear on both columns or on neither.
 */
export function sideBySide(facts: LinkFacts): SideBySide | null {
	const { cloudNotes, cloudAttachments, localNotes, localAttachments } = facts;
	if (
		cloudNotes === undefined ||
		cloudAttachments === undefined ||
		localNotes === undefined ||
		localAttachments === undefined ||
		facts.differentNotes === undefined ||
		facts.onlyCloudNotes === undefined ||
		facts.onlyLocalNotes === undefined
	) {
		return null;
	}
	const plugins = facts.cloudPlugins !== undefined && facts.localPlugins !== undefined;
	return {
		cloud: {
			notes: cloudNotes,
			attachments: cloudAttachments,
			...(plugins ? { plugins: facts.cloudPlugins } : {}),
		},
		local: {
			notes: localNotes,
			attachments: localAttachments,
			...(plugins ? { plugins: facts.localPlugins } : {}),
		},
		bar: {
			same: Math.max(0, localNotes - facts.onlyLocalNotes - facts.differentNotes),
			different: facts.differentNotes,
			onlyCloud: facts.onlyCloudNotes,
			onlyLocal: facts.onlyLocalNotes,
		},
	};
}

export type BarKey = keyof NoteBar;

export const BAR_LABELS: Record<BarKey, string> = {
	same: "Same",
	different: "Different",
	onlyCloud: "Only in the cloud",
	onlyLocal: "Only here",
};

/** The segments to draw, in order, leaving out the empty ones. */
export function barSegments(bar: NoteBar): { key: BarKey; label: string; count: number }[] {
	return (Object.keys(BAR_LABELS) as BarKey[])
		.filter((key) => bar[key] > 0)
		.map((key) => ({ key, label: BAR_LABELS[key], count: bar[key] }));
}

/** How many plugin folders a list of config paths holds. */
export function pluginCount(paths: Iterable<string>): number {
	return pluginIds(paths).size;
}

function pluginIds(paths: Iterable<string>): Set<string> {
	const ids = new Set<string>();
	for (const path of paths) {
		const id = pluginFolderOf(path);
		if (id) ids.add(id);
	}
	return ids;
}

/** Folder names one level under `.obsidian/<dir>/`. */
function namesUnder(paths: Iterable<string>, dir: string): Set<string> {
	const names = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		if (parts[0] === CONFIG_DIR && parts[1] === dir && parts.length >= 3) names.add(parts[2]);
	}
	return names;
}

/** What linking takes off this device, and what it brings. */
export interface SettingsLoss {
	/** Plugin ids on this device that the cloud vault does not have. */
	plugins: string[];
	themes: string[];
	snippets: string[];
	/** This device's own hotkeys, replaced by the cloud vault's. */
	hotkeys: boolean;
	/** Plugin ids the cloud vault brings that this device does not have. */
	added: string[];
}

/**
 * What the cloud vault's settings would replace here, or null when there is
 * nothing to ask about.
 *
 * Both lists are settings paths that travel (`isSyncedConfig`), so our own
 * folder is never in them. Null when the cloud vault has no settings (this
 * device seeds it, and nobody loses anything) and when this device has
 * nothing of its own to lose: a fresh vault holds Obsidian's default files,
 * and replacing those is not a question worth a stop. `hotkeysLost` is the
 * caller's: whether this device has hotkeys of its own that differ from the
 * cloud vault's, which takes reading a file.
 */
export function settingsLoss(
	cloud: Iterable<string>,
	local: Iterable<string>,
	hotkeysLost: boolean,
): SettingsLoss | null {
	const cloudPaths = [...cloud];
	if (cloudPaths.length === 0) return null;
	const localPaths = [...local];
	const minus = (here: Set<string>, there: Set<string>) =>
		[...here].filter((name) => !there.has(name)).sort();
	const cloudPlugins = pluginIds(cloudPaths);
	const localPlugins = pluginIds(localPaths);
	const loss: SettingsLoss = {
		plugins: minus(localPlugins, cloudPlugins),
		themes: minus(namesUnder(localPaths, "themes"), namesUnder(cloudPaths, "themes")),
		snippets: minus(namesUnder(localPaths, "snippets"), namesUnder(cloudPaths, "snippets")),
		hotkeys: hotkeysLost,
		added: minus(cloudPlugins, localPlugins),
	};
	const loses =
		loss.plugins.length > 0 || loss.themes.length > 0 || loss.snippets.length > 0 || loss.hotkeys;
	return loses ? loss : null;
}

/** Whether a hotkeys file holds any binding of its own. */
export function hasHotkeys(text: string | null): boolean {
	if (text === null) return false;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
	} catch {
		return false;
	}
}

/** The question, with the names. `name` turns a plugin id into its name. */
export function settingsAsk(
	vaultName: string,
	loss: SettingsLoss,
	name: (id: string) => string = (id) => id,
): { title: string; body: string; removed: string; added: string } {
	const gone = [
		...loss.plugins.map(name),
		...loss.themes.map((theme) => `theme ${theme}`),
		...loss.snippets.map((snippet) => `snippet ${snippet}`),
		...(loss.hotkeys ? ["your hotkeys"] : []),
	];
	return {
		title: `Settings come from ${vaultName}`,
		body: `Linking replaces this device's theme, hotkeys and plugins with the ones in ${vaultName}.`,
		removed: gone.length > 0 ? `Removed here: ${gone.join(", ")}.` : "",
		added: loss.added.length > 0 ? `Added: ${loss.added.map(name).join(", ")}.` : "",
	};
}

/** The button that goes ahead. */
export const USE_CLOUD_SETTINGS = "Use cloud settings";
