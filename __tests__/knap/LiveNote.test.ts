/**
 * An editor bound to a live note, without a screen.
 *
 * `LiveNote` takes anything with CodeMirror's `state` and `dispatch`, so a
 * stub is a legitimate editor here: the state is a real `EditorState` and
 * the change sets are real change sets, which is where the arithmetic that
 * can go wrong actually lives. Two of these on two relayed documents is two
 * people typing in one note.
 */

import { EditorState, type TransactionSpec } from "@codemirror/state";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { LiveNote, fromDocument, minimalChange } from "../../src/knap/LiveNote";
import { readCursors } from "../../src/knap/NoteCursors";

class StubEditor {
	state: EditorState;
	specs: TransactionSpec[] = [];

	constructor(text: string) {
		this.state = EditorState.create({ doc: text });
	}

	dispatch(spec: TransactionSpec): void {
		this.specs.push(spec);
		this.state = this.state.update(spec).state;
	}

	/** What a person typing produces: a change, then the same change out. */
	type(from: number, to: number, insert: string, live: LiveNote): void {
		const transaction = this.state.update({ changes: { from, to, insert } });
		this.state = transaction.state;
		live.pushChanges(transaction.changes);
	}

	get text(): string {
		return this.state.doc.toString();
	}
}

function device(text: string, name = "Laptop") {
	const doc = new Y.Doc();
	const content = doc.getText("content");
	if (text) content.insert(0, text);
	const editor = new StubEditor(text);
	const awareness = new Awareness(doc);
	const live = new LiveNote(editor, content, awareness, name);
	live.align();
	return { doc, content, editor, awareness, live };
}

/** The server, as far as these tests need one. */
function relay(a: Y.Doc, b: Y.Doc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(b, update, "relay");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(a, update, "relay");
	});
}

describe("LiveNote", () => {
	it("puts a keystroke into the document as it is typed", () => {
		const a = device("Hello world\n");
		a.editor.type(5, 5, " there", a.live);

		expect(a.content.toString()).toBe("Hello there world\n");
	});

	it("brings a change from anywhere else into the editor", () => {
		const a = device("Hello world\n");
		// Anybody but this editor: another device, or the AI writing over MCP.
		a.doc.transact(() => a.content.insert(5, " there"), "somebody else");

		expect(a.editor.text).toBe("Hello there world\n");
		expect(a.editor.specs).toHaveLength(1);
	});

	it("marks what it wrote, so the editor's echo is not typed back in", () => {
		const a = device("Hello world\n");
		a.doc.transact(() => a.content.insert(5, " there"), "somebody else");

		const [spec] = a.editor.specs;
		const transaction = EditorState.create({ doc: "Hello world\n" }).update(spec);
		expect(transaction.annotation(fromDocument)).toBe(true);
	});

	it("does not send its own edit back into the editor", () => {
		const a = device("Hello world\n");
		a.editor.type(5, 5, " there", a.live);

		expect(a.editor.specs).toHaveLength(0);
	});

	it("carries typing between two editors, both ways", () => {
		const a = device("Hello world\n", "Laptop");
		const b = device("", "Telefoon");
		relay(a.doc, b.doc);
		// b joins an empty document and receives the note.
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "relay");

		a.editor.type(5, 5, " there", a.live);
		expect(b.editor.text).toBe("Hello there world\n");

		b.editor.type(0, 0, "PREFIX ", b.live);
		expect(a.editor.text).toBe("PREFIX Hello there world\n");
		expect(a.content.toString()).toBe(b.content.toString());
	});

	it("merges two people typing in different places, rather than steamrolling", () => {
		const a = device("regel1\nregel2\nregel3\n");
		const b = device("");
		relay(a.doc, b.doc);
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "relay");

		a.editor.type(6, 6, " door A", a.live);
		b.editor.type(b.editor.text.length - 1, b.editor.text.length - 1, " door B", b.live);

		expect(a.editor.text).toBe("regel1 door A\nregel2\nregel3 door B\n");
		expect(b.editor.text).toBe(a.editor.text);
	});

	it("takes the document's text when the two differ at binding time", () => {
		const doc = new Y.Doc();
		const content = doc.getText("content");
		content.insert(0, "wat de cloud heeft\n");
		const editor = new StubEditor("wat op deze schijf staat\n");

		new LiveNote(editor, content, new Awareness(doc), "Laptop").align();

		expect(editor.text).toBe("wat de cloud heeft\n");
		expect(content.toString()).toBe("wat de cloud heeft\n");
	});

	it("fills an empty document from the editor rather than emptying the note", () => {
		const doc = new Y.Doc();
		const content = doc.getText("content");
		const editor = new StubEditor("# Nieuw\n\nNog nergens heen gesynct.\n");

		new LiveNote(editor, content, new Awareness(doc), "Laptop").align();

		expect(content.toString()).toBe("# Nieuw\n\nNog nergens heen gesynct.\n");
		expect(editor.text).toBe("# Nieuw\n\nNog nergens heen gesynct.\n");
	});

	it("publishes the selection while the editor has focus, and takes it off when it does not", () => {
		const a = device("Hello world\n");
		const b = device("");
		relay(a.doc, b.doc);
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "relay");

		a.live.publishSelection(a.editor.state.update({ selection: { anchor: 6 } }).state, true);
		expect(a.awareness.getLocalState()?.cursor).toBeTruthy();

		a.live.publishSelection(a.editor.state, false);
		expect(a.awareness.getLocalState()?.cursor).toBeNull();
	});

	it("takes its caret with it when the editor closes", () => {
		const a = device("Hello world\n");
		a.live.publishSelection(a.editor.state.update({ selection: { anchor: 6 } }).state, true);

		a.live.destroy();

		expect(a.awareness.getLocalState()?.cursor).toBeNull();
		// And nothing arrives in the editor after that.
		a.doc.transact(() => a.content.insert(0, "later"), "somebody else");
		expect(a.editor.specs).toHaveLength(0);
	});

	it("a caret set here is what the other device reads", () => {
		const a = device("Hello world\n");
		const b = device("");
		relay(a.doc, b.doc);
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "relay");

		a.live.publishSelection(a.editor.state.update({ selection: { anchor: 6 } }).state, true);
		// The relay the awareness protocol would do over the socket.
		const update = a.awareness.getLocalState();
		expect(update?.user).toEqual(expect.objectContaining({ name: "Laptop" }));
		expect(readCursors(a.awareness, a.content)).toHaveLength(0); // not our own
		expect(b.content.toString()).toBe("Hello world\n");
	});
});

describe("minimalChange", () => {
	it("touches only the range that differs", () => {
		expect(minimalChange("regel1\nregel2\n", "regel1 erbij\nregel2\n")).toEqual({
			from: 6,
			to: 6,
			insert: " erbij",
		});
	});

	it("is nothing at all when the two are equal", () => {
		expect(minimalChange("zelfde", "zelfde")).toBeNull();
	});

	it("survives emoji on UTF-16 boundaries", () => {
		const change = minimalChange("een 🌍 wereld", "een 🌍 grote wereld");
		expect(change).not.toBeNull();
		const before = "een 🌍 wereld";
		const after =
			before.slice(0, change!.from) + change!.insert + before.slice(change!.to);
		expect(after).toBe("een 🌍 grote wereld");
	});
});
