/**
 * One open editor, bound to one note's live document.
 *
 * The binding in `VaultBinding.ts` keeps files and documents equal, and it
 * is deliberately coarse: Obsidian saves a note a second or two after the
 * typing stops, so that is how often a keystroke can reach anybody else. A
 * cursor cannot live on that clock. A caret drawn from a document that is
 * two seconds behind the editor sits in the wrong sentence, and a remote
 * paragraph that arrives as a whole-file write lands under somebody's hands
 * while they are typing.
 *
 * So for as long as a note is open in an editor, the editor is bound to the
 * document directly: every keystroke goes in as a difference (ADR-0010, the
 * same rule the server writes under), every remote change comes back as a
 * difference, and the file binding stands down for that one note until the
 * editor lets go. Nothing here replaces a document or a file wholesale.
 *
 * Deliberately framework-light: it takes anything with CodeMirror's `state`
 * and `dispatch`, which is what an Obsidian editor is, and what a test can
 * be without a screen. The CodeMirror plugin that drives it lives in
 * `knapEditor.ts`.
 */

import { Annotation, ChangeSet, EditorState, type ChangeSpec } from "@codemirror/state";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import { publishCursor, publishUser, withdrawCursor } from "./NoteCursors";

/**
 * Marks the transactions this module dispatches, so the change it just wrote
 * into the editor does not come straight back as a local edit.
 */
export const fromDocument = Annotation.define<boolean>();

/** Y.Text implements toString; the lint rule cannot see that through AbstractType. */
function textOf(content: Y.Text): string {
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text has a real toString
	return content.toString();
}

/** What LiveNote needs an editor to be. A CodeMirror EditorView is one. */
export interface EditorLike {
	state: EditorState;
	dispatch(spec: {
		changes?: ChangeSpec;
		annotations?: ReturnType<typeof fromDocument.of>[];
		scrollIntoView?: boolean;
	}): void;
}

/** The smallest single replacement that turns one string into another. */
export function minimalChange(
	oldText: string,
	newText: string,
): { from: number; to: number; insert: string } | null {
	if (oldText === newText) return null;
	let prefix = 0;
	const limit = Math.min(oldText.length, newText.length);
	while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}
	return {
		from: prefix,
		to: oldText.length - suffix,
		insert: newText.slice(prefix, newText.length - suffix),
	};
}

/**
 * Keystrokes the editor took in the same update that bound it: the text it
 * held just before them, and the changes themselves.
 */
export interface PendingTyping {
	before: string;
	changes: ChangeSet;
}

export class LiveNote {
	private readonly observer: (event: Y.YTextEvent, transaction: Y.Transaction) => void;
	private destroyed = false;

	/**
	 * Bound, but not lined up yet: call `align` once the editor may take a
	 * dispatch. The constructor can run inside a CodeMirror update, and a
	 * dispatch there throws and switches the whole plugin off for that
	 * editor (issue #183, measured on 1.13.49 with two people in one note).
	 */
	constructor(
		private readonly view: EditorLike,
		private readonly text: Y.Text,
		private readonly awareness: Awareness,
		private readonly who: string,
	) {
		publishUser(this.awareness, this.who);
		this.observer = (event, transaction) => this.onDocumentChange(event, transaction);
		this.text.observe(this.observer);
	}

	/**
	 * Line the two up once they are bound, document first.
	 *
	 * The document wins because it is the one both sides of the vault agree
	 * on, and because the editor was filled from the file, which the file
	 * binding wrote from this same document. The one case where that would
	 * throw work away is a document nobody has typed in yet, and there the
	 * editor's text is the note: an empty document and a note somebody
	 * deliberately emptied look identical from here, so this goes the way
	 * that cannot lose anything, exactly as `VaultBinding.bindNote` does.
	 *
	 * `pending` is typing that arrived in the very update that bound the
	 * note. When the editor held the document's text just before it, those
	 * keystrokes are the whole difference: they go into the document rather
	 * than being reverted by it, and never twice (the other half of #183).
	 */
	align(pending?: PendingTyping): void {
		if (this.destroyed) return;
		const editorText = this.view.state.doc.toString();
		const documentText = textOf(this.text);
		if (editorText === documentText) return;
		if (pending && pending.before === documentText) {
			this.pushChanges(pending.changes);
			return;
		}
		if (documentText === "") {
			this.pushText("", editorText);
			return;
		}
		const change = minimalChange(editorText, documentText);
		if (change) {
			this.view.dispatch({
				changes: change,
				annotations: [fromDocument.of(true)],
				scrollIntoView: false,
			});
		}
	}

	/** Local editing: the editor's own changes, spliced into the document. */
	pushChanges(changes: ChangeSet): void {
		if (this.destroyed) return;
		const doc = this.text.doc;
		if (!doc) return;
		doc.transact(() => {
			// `adjust` carries the drift between the editor's coordinates,
			// which are the ones the change set is written in, and the
			// document's, which have already moved by every earlier change in
			// this same set.
			let adjust = 0;
			changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				const insert = inserted.sliceString(0, inserted.length, "\n");
				if (toA > fromA) this.text.delete(fromA + adjust, toA - fromA);
				if (insert.length > 0) this.text.insert(fromA + adjust, insert);
				adjust += insert.length - (toA - fromA);
			});
		}, this);
	}

	/** Where this editor's caret is, for everybody else in the note. */
	publishSelection(state: EditorState, hasFocus: boolean): void {
		if (this.destroyed) return;
		if (!hasFocus) {
			publishCursor(this.awareness, this.text, null);
			return;
		}
		const main = state.selection.main;
		publishCursor(this.awareness, this.text, { anchor: main.anchor, head: main.head });
	}

	/** Remote editing: a difference from anywhere else, into this editor. */
	private onDocumentChange(event: Y.YTextEvent, transaction: Y.Transaction): void {
		if (this.destroyed || transaction.origin === this) return;
		const changes: ChangeSpec[] = [];
		// Yjs deltas are written against the text as it was, which is also
		// what a CodeMirror change set wants, so an insert does not move the
		// cursor into the old coordinates and only retain and delete do.
		let position = 0;
		for (const part of event.delta) {
			if (part.retain != null) {
				position += part.retain;
			} else if (typeof part.insert === "string") {
				changes.push({ from: position, to: position, insert: part.insert });
			} else if (part.delete != null) {
				changes.push({ from: position, to: position + part.delete });
				position += part.delete;
			}
		}
		if (changes.length === 0) return;
		this.view.dispatch({
			changes,
			annotations: [fromDocument.of(true)],
			// Somebody else typing may not drag this reader's window around.
			scrollIntoView: false,
		});
	}

	private pushText(oldText: string, newText: string): void {
		const doc = this.text.doc;
		const change = minimalChange(oldText, newText);
		if (!doc || !change) return;
		doc.transact(() => {
			if (change.to > change.from) this.text.delete(change.from, change.to - change.from);
			if (change.insert) this.text.insert(change.from, change.insert);
		}, this);
	}

	/** The editor is gone: take the caret with it, leave the text alone. */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.text.unobserve(this.observer);
		withdrawCursor(this.awareness);
	}
}
