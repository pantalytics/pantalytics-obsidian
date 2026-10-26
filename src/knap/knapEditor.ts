/**
 * The CodeMirror half: what an editor does with a live note and its cursors.
 *
 * Two jobs, one plugin, because both need the same thing and neither is
 * worth a second lookup: the note behind the file this editor is showing.
 * Typing goes into the document through `LiveNote`, and everybody else's
 * caret comes back out of awareness as decorations (`NoteCursors`).
 *
 * Nothing here imports Obsidian, and which file an editor is showing, the
 * one thing only Obsidian can answer, arrives as a function. So the whole
 * extension can be driven by a test with no screen. The caret's own markup
 * uses Obsidian's `createSpan` and `createDiv`, which is house style and
 * only runs when something is actually drawn.
 */

import { type EditorState, type Extension } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type PluginValue,
	type ViewUpdate,
} from "@codemirror/view";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import { LiveNote, fromDocument, type PendingTyping } from "./LiveNote";
import { readCursors } from "./NoteCursors";

/** One note, live: its text, the awareness beside it, and how to let go. */
export interface LiveNoteHandle {
	text: Y.Text;
	awareness: Awareness;
	/**
	 * What a caret in this note is labelled with: the person at this device,
	 * falling back to the device's own name when the server has no address
	 * for them. It said the device name and only the device name until two
	 * people shared a vault and a caret named a machine.
	 */
	who: string;
	/** Hand the note back to the file binding. */
	release: () => void;
}

/** Where an editor's live note comes from. `KnapSync` is the one in Obsidian. */
export interface LiveNoteSource {
	/** The live note for a vault path, or null if this vault is not linked. */
	openNote(path: string): LiveNoteHandle | null;
	/**
	 * Call `ready` once the note behind `path` can be opened. Returns the
	 * cancel. Optional: a source without it leaves the editor to ask again
	 * on its next update.
	 */
	whenSynced?(path: string, ready: () => void): () => void;
}

/** A caret with a name on it, the way every collaborative editor draws one. */
class CaretWidget extends WidgetType {
	constructor(
		private readonly color: string,
		private readonly name: string,
		private readonly ai: boolean,
	) {
		super();
	}

	eq(other: CaretWidget): boolean {
		return other.color === this.color && other.name === this.name && other.ai === this.ai;
	}

	toDOM(): HTMLElement {
		const caret = createSpan({ cls: "knap-caret" });
		caret.style.borderColor = this.color;
		caret.style.backgroundColor = this.color;
		const label = createDiv({
			cls: this.ai ? ["knap-caret-name", "knap-caret-name-ai"] : "knap-caret-name",
			text: this.name,
		});
		label.style.backgroundColor = this.color;
		caret.appendChild(label);
		return caret;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export const knapCursorTheme = EditorView.baseTheme({
	".knap-caret": {
		position: "relative",
		borderLeft: "1px solid",
		borderRight: "1px solid",
		marginLeft: "-1px",
		marginRight: "-1px",
		boxSizing: "border-box",
		display: "inline",
	},
	".knap-caret-name": {
		position: "absolute",
		top: "-1.15em",
		left: "-1px",
		fontSize: ".7em",
		lineHeight: "normal",
		color: "white",
		padding: "0 3px",
		borderRadius: "3px",
		whiteSpace: "nowrap",
		userSelect: "none",
		zIndex: "101",
		// Out of the way while somebody is reading, back on a mouseover.
		opacity: "0",
		transition: "opacity .2s ease-in-out",
	},
	".knap-caret:hover > .knap-caret-name, .knap-caret-name-ai": {
		opacity: "1",
	},
	".knap-selection": {
		borderRadius: "2px",
	},
});

/** Decorations for everybody else's selection and caret, in editor offsets. */
export function cursorDecorations(
	awareness: Awareness,
	text: Y.Text,
	length: number,
): DecorationSet {
	const decorations = [];
	for (const cursor of readCursors(awareness, text)) {
		if (cursor.to > length) continue; // this editor has not caught up yet
		if (cursor.from !== cursor.to) {
			decorations.push(
				Decoration.mark({
					class: "knap-selection",
					attributes: { style: `background-color: ${cursor.color}33` },
				}).range(cursor.from, cursor.to),
			);
		}
		decorations.push(
			Decoration.widget({
				widget: new CaretWidget(cursor.color, cursor.name, cursor.ai),
				// The caret belongs outside the selection it trails.
				side: cursor.head > cursor.from ? 1 : -1,
			}).range(cursor.head),
		);
	}
	// Sorted, because CodeMirror takes its ranges in document order and
	// awareness hands them over in whatever order the states arrived.
	return Decoration.set(decorations, true);
}

/**
 * Whether this editor is a table cell being edited in Live Preview. Obsidian
 * builds that editor inside a `.table-cell-wrapper`, and it shows the note's
 * own file, so by its path it looks like the note. It is one cell of it:
 * bound to the note, lining up put the whole note into that cell (#187). The
 * note's editor already carries what is typed in the cell.
 */
function inTableCell(view: EditorView): boolean {
	return view.dom.closest(".table-cell-wrapper") !== null;
}

class KnapEditorPlugin implements PluginValue {
	private note: LiveNoteHandle | null = null;
	private live: LiveNote | null = null;
	private path: string | null = null;
	/** The note this editor is waiting on, and how to stop waiting. */
	private waitingFor: string | null = null;
	private stopWaiting: (() => void) | null = null;
	private onAwareness: (changes: unknown, origin: unknown) => void;
	/** A redraw is already on its way; the next one would draw the same. */
	private redrawing = false;
	private destroyed = false;
	decorations: DecorationSet = Decoration.none;

	constructor(
		private readonly view: EditorView,
		private readonly source: LiveNoteSource,
		private readonly pathOf: (state: EditorState) => string | null,
	) {
		// An awareness change is not an editor change, so it needs a nudge to
		// get the decorations recomputed. Our own caret is published from
		// inside `update`, where awareness fires synchronously and a dispatch
		// throws; CodeMirror then switches this plugin off for the editor and
		// nobody is live any more (issue #183). Our own caret is not drawn
		// here anyway, so only somebody else's change asks for a redraw.
		this.onAwareness = (_changes, origin) => {
			if (origin !== "local") this.redraw();
		};
		this.bind();
	}

	/**
	 * Bind this editor to its note. May run inside a CodeMirror update or the
	 * plugin's own construction, so nothing in here dispatches: lining the
	 * editor up with the document waits for the update to finish.
	 */
	private bind(pending?: PendingTyping): void {
		const path = inTableCell(this.view) ? null : this.pathOf(this.view.state);
		if (!path || path === this.path) return;
		this.unbind();
		const note = this.source.openNote(path);
		if (!note) {
			this.waitFor(path);
			return;
		}
		this.cancelWait();
		this.path = path;
		this.note = note;
		const live = new LiveNote(this.view, note.text, note.awareness, note.who);
		this.live = live;
		note.awareness.on("change", this.onAwareness);
		this.refresh();
		// A microtask runs before the next keystroke or socket message can, so
		// nothing reaches either side between binding and lining up.
		queueMicrotask(() => {
			if (this.live !== live) return;
			live.align(pending);
			this.refresh();
		});
	}

	/** Recompute the carets once the current update, if any, is over. */
	private redraw(): void {
		if (this.redrawing) return;
		this.redrawing = true;
		queueMicrotask(() => {
			this.redrawing = false;
			if (!this.destroyed && this.note) this.view.dispatch({});
		});
	}

	/**
	 * Bind the moment the note's socket has synced, not on whatever update
	 * comes next. Until then the editor shows the file, and an empty file is
	 * an empty page somebody may start typing in (issue #169). Binding lets
	 * `LiveNote` fill it from the document before the first save.
	 */
	private waitFor(path: string): void {
		if (this.waitingFor === path || !this.source.whenSynced) return;
		this.cancelWait();
		this.waitingFor = path;
		this.stopWaiting = this.source.whenSynced(path, () => {
			this.stopWaiting = null;
			this.waitingFor = null;
			if (this.pathOf(this.view.state) !== path) return;
			this.bind();
			// So the decorations are drawn now rather than on the next keystroke.
			if (this.live) this.redraw();
		});
	}

	private cancelWait(): void {
		this.stopWaiting?.();
		this.stopWaiting = null;
		this.waitingFor = null;
	}

	private unbind(): void {
		this.note?.awareness.off("change", this.onAwareness);
		this.live?.destroy();
		this.note?.release();
		this.live = null;
		this.note = null;
		this.path = null;
		this.decorations = Decoration.none;
	}

	update(update: ViewUpdate): void {
		// A note that is not in the cloud vault's tree yet has no document to
		// bind to, and a note opened in a tab that already existed has not
		// been asked for. Both settle on a later update rather than never.
		if (!this.live || this.pathOf(update.state) !== this.path) {
			// Typing in this very update is handed to the binding rather than
			// pushed below: `align` decides whether it is the difference
			// between editor and document, and pushing it again here put it
			// into the note twice.
			const mine =
				update.docChanged && update.transactions.some((tr) => !tr.annotation(fromDocument));
			this.bind(
				mine ? { before: update.startState.doc.toString(), changes: update.changes } : undefined,
			);
			if (!this.live) return;
			this.live.publishSelection(update.state, update.view.hasFocus);
			this.refresh();
			return;
		}
		if (update.docChanged) {
			const mine = update.transactions.some((tr) => !tr.annotation(fromDocument));
			if (mine) this.live.pushChanges(update.changes);
		}
		this.live.publishSelection(update.state, update.view.hasFocus);
		this.refresh();
	}

	private refresh(): void {
		if (!this.note) return;
		this.decorations = cursorDecorations(
			this.note.awareness,
			this.note.text,
			this.view.state.doc.length,
		);
	}

	destroy(): void {
		this.destroyed = true;
		this.cancelWait();
		this.unbind();
	}
}

/**
 * The extension to register with Obsidian: live editing and the cursors on it.
 */
export function knapLiveEditing(
	source: LiveNoteSource,
	pathOf: (state: EditorState) => string | null,
): Extension[] {
	return [
		knapCursorTheme,
		ViewPlugin.define((view) => new KnapEditorPlugin(view, source, pathOf), {
			decorations: (plugin) => plugin.decorations,
		}),
	];
}
