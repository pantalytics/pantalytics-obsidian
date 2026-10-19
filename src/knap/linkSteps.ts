/**
 * What linking a vault does, said out loud while it happens.
 *
 * Linking used to be one press and then nothing: the picker closed, a notice
 * said *Linked*, and the settings screen sat on *Syncing* over a vault whose
 * size nobody had been told. Everything that made the wait reasonable, how
 * much is already up there, how much is on this device, how much of it has to
 * move, was known inside the plugin at that moment and never said.
 *
 * So the link reports itself. Nine steps, in the order the facts become
 * true, and each one either a number or a phrase. Two of them are the ones
 * worth waiting for: what has to come down, and what has to go up.
 *
 * This file is pure. It holds the step list, the labels and the arithmetic,
 * and nothing in it knows about Obsidian, sockets or the modal that draws it.
 * The engine reports a step id and the facts so far; the modal turns that
 * into rows. That seam is why the interesting half is testable.
 */

/**
 * The eight, in order. The work does not happen in quite this order (the
 * local counts are taken before the socket opens, because they ride along on
 * it), but every number is true at the moment its step is reported, and this
 * is the order a person reads them in: the far side first, because that is
 * the side they cannot see.
 */
export const LINK_STEPS = [
	"connecting",
	"cloudNotes",
	"cloudAttachments",
	"localNotes",
	"localAttachments",
	"different",
	"toDownload",
	"toUpload",
	"linked",
] as const;

export type LinkStep = (typeof LINK_STEPS)[number];

/** What the steps have found out so far. Filled in as they go. */
export interface LinkFacts {
	cloudNotes?: number;
	cloudAttachments?: number;
	localNotes?: number;
	localAttachments?: number;
	differentNotes?: number;
	differentAttachments?: number;
	downloadNotes?: number;
	downloadAttachments?: number;
	uploadNotes?: number;
	uploadAttachments?: number;
	/** Notes on one side only, from the comparison a link makes. */
	onlyCloudNotes?: number;
	onlyLocalNotes?: number;
	/** Plugin folders on each side, where this host has settings. */
	cloudPlugins?: number;
	localPlugins?: number;
}

/** Told each time a step is done, with everything known at that point. */
export type LinkReporter = (step: LinkStep, facts: LinkFacts) => void;

const LABELS: Record<LinkStep, string> = {
	connecting: "Connecting",
	cloudNotes: "Notes in the cloud vault",
	cloudAttachments: "Attachments in the cloud vault",
	localNotes: "Notes on this device",
	localAttachments: "Attachments on this device",
	different: "Different on each side",
	toDownload: "To download",
	toUpload: "To upload",
	linked: "Linked",
};

export type StepState = "done" | "doing" | "waiting" | "failed";

export interface LinkRow {
	step: LinkStep;
	label: string;
	/** The number or phrase this step found, or "" while it has not. */
	value: string;
	state: StepState;
}

/**
 * The rows to draw, given the last step that finished.
 *
 * `done` is the step that just completed, or null before the first one.
 * Everything before it is done, the one after it is what is happening now,
 * and the rest are waiting. A failure stops the run where it stood: the step
 * that was in flight is the one that failed, and nothing after it happens.
 */
export function linkRows(
	done: LinkStep | null,
	facts: LinkFacts,
	failed = false,
	paused = false,
): LinkRow[] {
	const at = done === null ? -1 : LINK_STEPS.indexOf(done);
	return LINK_STEPS.map((step, index) => ({
		step,
		label: LABELS[step],
		value: valueOf(step, facts),
		state: stateOf(index, at, failed, paused),
	}));
}

function stateOf(index: number, at: number, failed: boolean, paused: boolean): StepState {
	if (index <= at) return "done";
	// Paused is waiting on the person, and a spinner would say the plugin is busy.
	if (index === at + 1 && !paused) return failed ? "failed" : "doing";
	return "waiting";
}

function valueOf(step: LinkStep, facts: LinkFacts): string {
	switch (step) {
		case "cloudNotes":
			return number(facts.cloudNotes);
		case "cloudAttachments":
			return number(facts.cloudAttachments);
		case "localNotes":
			return number(facts.localNotes);
		case "localAttachments":
			return number(facts.localAttachments);
		case "different":
			return movePhrase(facts.differentNotes, facts.differentAttachments);
		case "toDownload":
			return movePhrase(facts.downloadNotes, facts.downloadAttachments);
		case "toUpload":
			return movePhrase(facts.uploadNotes, facts.uploadAttachments);
		default:
			// Connecting and the last line are acts rather than counts, and a
			// column of numbers with two blanks in it reads better than two
			// invented words.
			return "";
	}
}

/**
 * What linking means for a delete, said where somebody is choosing.
 *
 * #116 put this on the Cloud vault row in Settings, which is a row somebody
 * reads every week about a decision they took once. It belongs on the screen
 * that makes the link: from here on a delete travels, and that is worth
 * knowing before rather than after.
 */
export const BOTH_WAYS =
	"Deleting a note here deletes it in the cloud vault too, and the other way round.";

function number(value?: number): string {
	return value === undefined ? "" : value.toLocaleString("en-US");
}

/**
 * "14 notes, 3 attachments", or "Nothing" when there is none of either.
 *
 * *Nothing* rather than *0*, because these two rows are the answer to how
 * long this is going to take, and a zero in a column of counts is read as a
 * number rather than as an answer.
 */
export function movePhrase(notes?: number, attachments?: number): string {
	if (notes === undefined || attachments === undefined) return "";
	const parts: string[] = [];
	if (notes > 0) parts.push(`${number(notes)} note${notes === 1 ? "" : "s"}`);
	if (attachments > 0) {
		parts.push(`${number(attachments)} attachment${attachments === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(", ") : "Nothing";
}

/**
 * What has to move, counted as a plain difference between the two sides.
 *
 * Deliberately simpler than what the bindings then do. They have a record of
 * what this device last agreed with, so they can tell a note somebody deleted
 * here from one that has not arrived yet, and a fresh link has no such record
 * anyway. What a person wants before that starts is the size of the job: what
 * is on one side and not the other.
 */
export function linkCounts(
	cloud: { notes: Iterable<string>; attachments: Iterable<string> },
	local: { notes: Iterable<string>; attachments: Iterable<string> },
): Pick<
	LinkFacts,
	"downloadNotes" | "downloadAttachments" | "uploadNotes" | "uploadAttachments"
> {
	const cloudNotes = new Set(cloud.notes);
	const cloudFiles = new Set(cloud.attachments);
	const localNotes = new Set(local.notes);
	const localFiles = new Set(local.attachments);
	return {
		downloadNotes: missing(cloudNotes, localNotes),
		downloadAttachments: missing(cloudFiles, localFiles),
		uploadNotes: missing(localNotes, cloudNotes),
		uploadAttachments: missing(localFiles, cloudFiles),
	};
}

function missing(from: Set<string>, here: Set<string>): number {
	let count = 0;
	for (const path of from) if (!here.has(path)) count += 1;
	return count;
}

/**
 * Whether linking these two would merge two vaults, which it refuses to do.
 *
 * The two journeys a link is for both have an empty side: a cloud vault made
 * in the panel takes what is on this device, and a vault somebody was added to
 * comes down onto a device that has nothing yet. Notes on both sides is the
 * third case, and it is the only one that can duplicate a path or leave a
 * conflict copy behind, at the moment somebody trusts the plugin least. A side
 * counts as holding something if it has a note or an attachment, because a
 * vault of nothing but PNGs is still somebody's vault (ADR-0098).
 */
export function isMerge(facts: LinkFacts): boolean {
	const cloud = (facts.cloudNotes ?? 0) + (facts.cloudAttachments ?? 0);
	const local = (facts.localNotes ?? 0) + (facts.localAttachments ?? 0);
	return cloud > 0 && local > 0;
}

/**
 * How the two sides of a link compare, path by path. `different` is a path
 * on both sides whose contents do not match; `notes` says which paths are
 * notes, so the counts can keep notes and attachments apart.
 */
export interface LinkDiff {
	onlyCloud: string[];
	onlyLocal: string[];
	different: string[];
	notes: ReadonlySet<string>;
}

/**
 * What to do when both sides hold notes and they are not the same (ADR-0105).
 * `both` keeps everything on both sides, and a note that differs is kept in
 * both versions (the cloud's at the path, this device's as a conflict copy).
 * `cloud` and `device` make one side the same as the other.
 */
export type LinkChoice = "both" | "cloud" | "device";

/** Asked once a link needs a choice. Null is a cancel. */
export type LinkChooser = (diff: LinkDiff) => Promise<LinkChoice | null>;

/**
 * Compare the two sides. `cloud` maps a path to its sha256 (undefined for a
 * note the server has not hashed yet, which counts as different); `localHash`
 * is asked only for paths on both sides, so a vault that shares nothing
 * costs no reads.
 */
export async function diffSides(
	cloud: Map<string, string | undefined>,
	local: string[],
	notes: ReadonlySet<string>,
	localHash: (path: string) => Promise<string | null>,
): Promise<LinkDiff> {
	const here = new Set(local);
	const diff: LinkDiff = { onlyCloud: [], onlyLocal: [], different: [], notes };
	for (const path of cloud.keys()) if (!here.has(path)) diff.onlyCloud.push(path);
	for (const path of here) {
		if (!cloud.has(path)) {
			diff.onlyLocal.push(path);
			continue;
		}
		const theirs = cloud.get(path);
		const ours = await localHash(path);
		if (theirs === undefined || ours === null || ours !== theirs) diff.different.push(path);
	}
	return diff;
}

/**
 * Whether a link with notes on both sides needs a choice. It does not when
 * one side is already a copy of part of the other: nothing differs and only
 * one side has anything the other lacks, so the link only fills that side in.
 * That is a device whose link was lost, not two vaults (ADR-0105).
 */
export function needsChoice(diff: LinkDiff): boolean {
	if (diff.different.length > 0) return true;
	return diff.onlyCloud.length > 0 && diff.onlyLocal.length > 0;
}

/** What a choice removes, before the bindings fill in the rest. */
export function removalsFor(
	choice: LinkChoice,
	diff: LinkDiff,
): { local: string[]; cloud: string[] } {
	if (choice === "cloud") return { local: [...diff.onlyLocal, ...diff.different], cloud: [] };
	if (choice === "device") return { local: [], cloud: [...diff.onlyCloud, ...diff.different] };
	return { local: [], cloud: [] };
}

/** "12 notes, 3 attachments" for a list of paths. */
export function pathsPhrase(paths: string[], notes: ReadonlySet<string>): string {
	const noteCount = paths.filter((path) => notes.has(path)).length;
	return movePhrase(noteCount, paths.length - noteCount);
}

/**
 * The one sentence over the choice. How far apart the two sides are is
 * already on the rows above it: Different, To download, To upload.
 */
export function choiceSay(vaultName: string): string {
	return `This device and ${vaultName} hold different notes.`;
}

/** Help under Keep both, the choice that deletes nothing. */
export const KEEP_BOTH_SAY =
	"Both sides get everything, and a note that differs is kept in both versions.";

/**
 * The confirmation for a choice that deletes, or null for one that does not.
 * The title asks the question with the thing, the body says the consequence.
 */
export function replaceConfirm(
	choice: LinkChoice,
	vaultName: string,
	diff: LinkDiff,
): { title: string; body: string } | null {
	const gone = removalsFor(choice, diff);
	if (choice === "cloud") {
		const what = pathsPhrase(gone.local, diff.notes);
		return {
			title: "Replace the notes on this device?",
			body: `This device becomes the same as ${vaultName}. ${what} on this device are deleted.`,
		};
	}
	if (choice === "device") {
		const what = pathsPhrase(gone.cloud, diff.notes);
		return {
			title: `Replace the notes in ${vaultName}?`,
			body: `${vaultName} becomes the same as this device. ${what} in it are deleted, for everyone in the vault.`,
		};
	}
	return null;
}

/**
 * Why the link stopped, and what to do instead. Both counts, because what is
 * in the cloud vault is the one thing a person cannot see from Obsidian.
 */
export function mergeRefusal(vaultName: string, facts: LinkFacts): string {
	const local = movePhrase(facts.localNotes, facts.localAttachments);
	const cloud = movePhrase(facts.cloudNotes, facts.cloudAttachments);
	return (
		`This device holds ${local} and ${vaultName} holds ${cloud}. ` +
		"Linking two vaults that both hold notes would merge them, and there is no " +
		"undo for that, so it does not happen. Make a new cloud vault for the notes " +
		"on this device, or open an empty local vault to take this cloud vault down."
	);
}
