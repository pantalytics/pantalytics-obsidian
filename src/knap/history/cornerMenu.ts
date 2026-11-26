/**
 * What the menu behind the corner of the window holds, as data.
 *
 * The corner used to open Settings and nothing else. It opens a menu now,
 * Obsidian's own, and what is in it depends on three things: the word, whether
 * a note is open, and what the server said about that note. Built here and
 * drawn in `cornerMenuView.ts`, so which line shows when is pinned in a test
 * rather than read off a screen.
 *
 * No Settings item: the settings are one click away in Obsidian's own place
 * for them, and a menu that ends in Settings is a menu that hands the
 * question on.
 */

export type CornerItem =
	/** A line to read, not to press. */
	| { kind: "info"; title: string }
	| { kind: "history"; title: string }
	| { kind: "retry"; title: string };

export interface CornerInput {
	/** The status line, `statusLine()`'s answer. */
	status: string;
	/** Whether the word is Problem, the one word with a Try again here. */
	problem: boolean;
	/** The open note, or null for none. */
	note: null | {
		/** "Daniel, 3 min ago", or null when the history has not said. */
		lastChanged: string | null;
		/** "12 Nov", off the file. */
		created: string;
		/** Whether the note is one the cloud vault holds, so it has a history. */
		synced: boolean;
	};
}

export function cornerItems(input: CornerInput): CornerItem[] {
	const items: CornerItem[] = [{ kind: "info", title: input.status }];
	if (input.note) {
		if (input.note.lastChanged) {
			items.push({ kind: "info", title: `Last changed: ${input.note.lastChanged}` });
		}
		items.push({ kind: "info", title: `Created: ${input.note.created}` });
		if (input.note.synced) items.push({ kind: "history", title: "Version history" });
	}
	if (input.problem) items.push({ kind: "retry", title: "Try again" });
	return items;
}
