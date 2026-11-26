/**
 * A version's text with what is different from the current note marked.
 *
 * Read as what Restore would do: **added** is text this version has and the
 * note has not, which Restore brings back; **removed** is text the note has
 * and this version has not, which Restore takes out. Both are shown in the
 * one text, in place, so nobody has to hold two columns side by side on a
 * phone.
 *
 * Words rather than characters or lines: a line is too coarse for one
 * changed word in a paragraph, and a character diff of a rewritten sentence
 * is confetti.
 */

import { diffWordsWithSpace } from "diff";

export type MarkKind = "same" | "added" | "removed";

export interface Mark {
	kind: MarkKind;
	text: string;
}

export function markChanges(versionText: string, currentText: string): Mark[] {
	const marks: Mark[] = [];
	for (const part of diffWordsWithSpace(currentText, versionText)) {
		const kind: MarkKind = part.added ? "added" : part.removed ? "removed" : "same";
		const last = marks[marks.length - 1];
		if (last && last.kind === kind) {
			last.text += part.value;
		} else {
			marks.push({ kind, text: part.value });
		}
	}
	return marks;
}

/** Whether there is anything to mark at all. */
export function hasChanges(marks: readonly Mark[]): boolean {
	return marks.some((mark) => mark.kind !== "same");
}
