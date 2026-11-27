/**
 * What the panel behind the corner of the window says, as data.
 *
 * Two blocks, in the order a person asks: is the vault all right, and is the
 * note in front of me all right. The vault block is the word the corner
 * already wears, with when or how much. The note block is one word of its
 * own, then who changed it last, when it was made, and the way into its
 * versions. Built here and drawn in `cornerPanelView.ts`, so which line shows
 * when is pinned in a test rather than read off a screen.
 *
 * No Settings in it: Obsidian already has a place for settings.
 */

import { backlogText } from "../../quiet";
import type { SyncDot, SyncWord } from "../../syncStatus";
import { OFFLINE, PROBLEM, UP_TO_DATE, isMoving, syncCounts } from "../../syncStatus";
import { clock, shortDate } from "./words";

/** The four words a note can have. A fifth is a new decision, not a new line. */
export const NOTE_SYNCED = "Synced";
export const NOTE_WAITING = "Not synced yet";
export const NOTE_STUCK = "Could not sync";
export const NOTE_LOCAL = "Only on this device";

export type NoteWord = typeof NOTE_SYNCED | typeof NOTE_WAITING | typeof NOTE_STUCK | typeof NOTE_LOCAL;

/** What the device knows about one file, `KnapSync.noteSync()`'s answer. */
export interface NoteFacts {
	inCloud: boolean;
	stuck: string | null;
	retrying: boolean;
	/** Work for this note is queued or running here: a save not yet sent. */
	pending: boolean;
}

/**
 * The note's word, off facts and the vault's word, never a guess.
 *
 * Stuck beats everything because it is the one a person acts on. A note with
 * work queued or being tried again is waiting. A note the cloud vault does not
 * hold yet is waiting while anything is still moving or out of reach, and is
 * only here once the vault says it is up to date. A note it holds is synced,
 * except offline, where an edit made since cannot have gone up. Waiting is
 * yellow while offline, because nothing is moving then.
 */
export function noteWord(vault: SyncWord, facts: NoteFacts): { word: NoteWord; dot: SyncDot } {
	if (facts.stuck) return { word: NOTE_STUCK, dot: "error" };
	const waiting = { word: NOTE_WAITING, dot: vault === OFFLINE ? "wait" : "working" } as const;
	if (facts.retrying || facts.pending) return waiting;
	if (!facts.inCloud) return vault === UP_TO_DATE ? { word: NOTE_LOCAL, dot: "wait" } : waiting;
	if (vault === OFFLINE) return waiting;
	return { word: NOTE_SYNCED, dot: "ok" };
}

/** The vault, as `KnapSync.status()` reads it; only the parts the panel uses. */
export interface VaultInput {
	word: SyncWord;
	dot: SyncDot;
	/** Notes and attachments still going up, and still coming down. */
	up: number;
	down: number;
	/** The pass at start, notes and attachments together. */
	checked: { done: number; total: number };
	problems: number;
	upToDateAt: number;
}

export interface NoteInput {
	facts: NoteFacts;
	/** "Daniel, 3 min ago", or null while the history has not said. */
	lastChanged: string | null;
	/** Epoch ms the note was made. */
	created: number;
	/** Whether the note has versions to open: a markdown note the cloud vault holds. */
	history: boolean;
}

export interface CornerPanel {
	vault: {
		word: SyncWord;
		dot: SyncDot;
		/** "just now", "since 14:02", "↑ 12 ↓ 340", "290 of 3,127", or empty. */
		when: string;
		/** "2 changes did not sync", under Problem only, with Try again. */
		problem: string;
	};
	note: null | {
		word: NoteWord;
		dot: SyncDot;
		/** Why it would not sync, under Could not sync only, with Try again. */
		reason: string;
		lastChanged: string | null;
		created: string;
		history: boolean;
	};
}

/** The right-hand side of the vault's line. */
export function vaultWhen(vault: VaultInput, now: number): string {
	if (vault.word === UP_TO_DATE) return "just now";
	if (isMoving(vault.word)) {
		const arrows = backlogText(vault.up, vault.down);
		if (arrows) return arrows;
		const { done, total } = vault.checked;
		return total > 0 && done < total ? syncCounts(done, total) : "";
	}
	if (!vault.upToDateAt) return "";
	const today = new Date(vault.upToDateAt).toDateString() === new Date(now).toDateString();
	return `since ${today ? clock(vault.upToDateAt) : shortDate(vault.upToDateAt, now)}`;
}

export function cornerPanel(vault: VaultInput, note: NoteInput | null, now: number): CornerPanel {
	const problem =
		vault.word === PROBLEM && vault.problems > 0
			? `${vault.problems} change${vault.problems === 1 ? "" : "s"} did not sync`
			: "";
	let noteOut: CornerPanel["note"] = null;
	if (note) {
		const { word, dot } = noteWord(vault.word, note.facts);
		noteOut = {
			word,
			dot,
			reason: word === NOTE_STUCK ? (note.facts.stuck ?? "") : "",
			lastChanged: note.lastChanged,
			created: shortDate(note.created, now),
			history: note.history,
		};
	}
	return {
		vault: { word: vault.word, dot: vault.dot, when: vaultWhen(vault, now), problem },
		note: noteOut,
	};
}
