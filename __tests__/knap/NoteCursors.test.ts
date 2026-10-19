/**
 * Cursors between two devices, on real Yjs documents and real awareness.
 *
 * Two docs with their updates relayed by hand, the way the server relays
 * them, and two Awareness instances beside them. That is enough to make
 * every claim here a claim about what the other device actually sees, and
 * it needs no server and no screen. The claim about our own server carrying
 * the same traffic lives in the admin repository, in
 * `scripts/spikes/cursor_presence/` and in its `make test` suite.
 */

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";

import {
	colorFor,
	publishCursor,
	publishUser,
	readCursors,
	withdrawCursor,
} from "../../src/knap/NoteCursors";
import { cursorDecorations } from "../../src/knap/knapEditor";

/** One device: a document, its text, and what it is telling the others. */
function device(name: string) {
	const doc = new Y.Doc();
	const text = doc.getText("content");
	const awareness = new Awareness(doc);
	publishUser(awareness, name);
	return { doc, text, awareness };
}

/** What the server does with an awareness frame, without the server. */
function relayAwareness(from: Awareness, to: Awareness): void {
	const update = encodeAwarenessUpdate(from, [...from.getStates().keys()]);
	applyAwarenessUpdate(to, update, "relay");
}

/** And what it does with a document update. */
function relayDoc(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from), "relay");
}

describe("a cursor between two devices", () => {
	it("arrives with a name and a colour on it", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);

		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		relayAwareness(a.awareness, b.awareness);

		const [seen] = readCursors(b.awareness, b.text);
		expect(seen.head).toBe(6);
		expect(seen.from).toBe(6);
		expect(seen.to).toBe(6);
		expect(seen.name).toBe("Laptop");
		expect(seen.color).toBe(colorFor("Laptop"));
	});

	it("stays on its character while the text moves under it", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		relayAwareness(a.awareness, b.awareness);

		// The other device types seven characters ahead of that caret. An
		// offset would now point into the middle of the new word.
		b.text.insert(0, "PREFIX ");

		expect(readCursors(b.awareness, b.text)[0].head).toBe(13);
	});

	it("carries a selection as well as a caret", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);

		publishCursor(a.awareness, a.text, { anchor: 6, head: 11 });
		relayAwareness(a.awareness, b.awareness);

		const [seen] = readCursors(b.awareness, b.text);
		expect([seen.from, seen.to, seen.head]).toEqual([6, 11, 11]);
	});

	it("goes when the editor lets go of it", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		relayAwareness(a.awareness, b.awareness);
		expect(readCursors(b.awareness, b.text)).toHaveLength(1);

		withdrawCursor(a.awareness);
		relayAwareness(a.awareness, b.awareness);
		expect(readCursors(b.awareness, b.text)).toHaveLength(0);
	});

	it("is not sent again when it has not moved", () => {
		const a = device("Laptop");
		a.text.insert(0, "Hello world\n");
		let updates = 0;
		a.awareness.on("update", () => updates++);

		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		expect(updates).toBe(1);
		// A selection is recomputed on every keystroke and every repaint, and
		// every set is a frame to every device in the note.
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		expect(updates).toBe(1);

		publishCursor(a.awareness, a.text, { anchor: 7, head: 7 });
		expect(updates).toBe(2);
	});

	it("is skipped rather than guessed at when it points at text we lack", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });
		// b never received the document, so the position resolves to nothing.
		relayAwareness(a.awareness, b.awareness);

		expect(readCursors(b.awareness, b.text)).toHaveLength(0);
	});

	it("does not report our own caret back to us", () => {
		const a = device("Laptop");
		a.text.insert(0, "Hello world\n");
		publishCursor(a.awareness, a.text, { anchor: 6, head: 6 });

		expect(readCursors(a.awareness, a.text)).toHaveLength(0);
	});

	it("gives the same person the same colour on every device", () => {
		expect(colorFor("Werk on desktop")).toBe(colorFor("Werk on desktop"));
		expect(colorFor("Werk on desktop")).not.toBe(colorFor("Werk on phone"));
	});
});

describe("what the editor draws", () => {
	it("marks the selection and puts a caret at its head", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);
		publishCursor(a.awareness, a.text, { anchor: 6, head: 11 });
		relayAwareness(a.awareness, b.awareness);

		const decorations = cursorDecorations(b.awareness, b.text, b.text.length);
		const ranges: [number, number][] = [];
		const cursor = decorations.iter();
		while (cursor.value !== null) {
			ranges.push([cursor.from, cursor.to]);
			cursor.next();
		}
		expect(ranges).toEqual([
			[6, 11], // the selection
			[11, 11], // the caret at its head
		]);
	});

	it("draws nothing for a caret past the end of what this editor holds", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);
		publishCursor(a.awareness, a.text, { anchor: 11, head: 11 });
		relayAwareness(a.awareness, b.awareness);

		// The editor is a few characters behind the document it is bound to.
		expect(cursorDecorations(b.awareness, b.text, 4).size).toBe(0);
	});
});

describe("the AI's caret", () => {
	/**
	 * The state the server puts on awareness for a tool write (ADR-0108 in
	 * the admin repository): a selection over what was written, the head
	 * sticking to its last character, and `ai` on the user. The admin suite
	 * proves the server sends exactly this shape over the wire.
	 */
	function aiWrites(text: Y.Text, at: number, written: string) {
		text.insert(at, written);
		const anchor = Y.createRelativePositionFromTypeIndex(text, at, 0);
		const head = Y.createRelativePositionFromTypeIndex(text, at + written.length, -1);
		return {
			user: { name: "daniel (AI)", ai: true },
			cursor: { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head) },
		};
	}

	it("covers what the AI wrote while somebody types around it", () => {
		const me = device("Laptop");
		me.text.insert(0, "Notulen\n");
		const state = aiWrites(me.text, 8, "Besluit: ja.");
		me.awareness.states.set(42, state);

		me.text.insert(0, "Vandaag. ");
		me.text.insert(me.text.length, "\nEinde");

		const [seen] = readCursors(me.awareness, me.text);
		expect(me.text.toString().slice(seen.from, seen.to)).toBe("Besluit: ja.");
		expect(seen.name).toBe("daniel (AI)");
		expect(seen.ai).toBe(true);
	});

	it("is the only caret that says so", () => {
		const a = device("Laptop");
		const b = device("Telefoon");
		a.text.insert(0, "Hello world\n");
		relayDoc(a.doc, b.doc);
		publishCursor(a.awareness, a.text, { anchor: 3, head: 3 });
		relayAwareness(a.awareness, b.awareness);

		expect(readCursors(b.awareness, b.text)[0].ai).toBe(false);
	});
});
