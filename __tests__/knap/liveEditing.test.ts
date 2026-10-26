/**
 * @jest-environment jsdom
 */
/**
 * Two and three people in one open note, each in a real CodeMirror editor.
 *
 * `LiveNote.test.ts` drives a stub editor, which has no idea of CodeMirror's
 * one hard rule: nothing dispatches while an update is in progress. The
 * plugin broke that rule on the first click, CodeMirror switched it off for
 * the editor, and two people in one note never saw each other and saved a
 * conflict copy every few seconds instead (issue #183, measured on 1.13.49).
 * So everything here runs through a real `EditorView` with the extension
 * Obsidian registers, and every test fails if CodeMirror reports a crash.
 *
 * The room plays the server: one document that every person syncs with,
 * awareness forwarded to everybody else, and a person who goes offline keeps
 * typing into their own copy and is caught up when they come back.
 */

import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";

import { knapLiveEditing, type LiveNoteSource } from "../../src/knap/knapEditor";

// What Obsidian puts on the window, and the caret widget draws with.
type ElementOptions = { cls?: string | string[]; text?: string };
const make = (tag: string, options?: ElementOptions) => {
	const element = document.createElement(tag);
	if (options?.cls) element.className = ([] as string[]).concat(options.cls).join(" ");
	if (options?.text) element.textContent = options.text;
	return element;
};
Object.assign(globalThis, {
	createSpan: (options?: ElementOptions) => make("span", options),
	createDiv: (options?: ElementOptions) => make("div", options),
});

const PATH = "ICP App.md";
const pathField = StateField.define<string>({ create: () => PATH, update: (value) => value });
/** The extensions Obsidian gives every editor showing `PATH`. */
const editing = (source: LiveNoteSource) => [
	pathField,
	knapLiveEditing(source, (state) => state.field(pathField, false) ?? null),
];

class Person {
	readonly doc = new Y.Doc();
	readonly text = this.doc.getText("content");
	readonly awareness = new Awareness(this.doc);
	view!: EditorView;
	source!: LiveNoteSource;
	online = true;
	/** Updates this person made while offline, sent when they are back. */
	outbox: Uint8Array[] = [];
	/** Whether the note's socket has synced, as `openNote` sees it. */
	ready = true;
	/** Document updates this person's editor produced, one per transaction. */
	sent = 0;

	constructor(readonly name: string) {}

	get editorText(): string {
		return this.view.state.doc.toString();
	}

	/** Click: focus the editor and put the caret at `at`. */
	click(at: number): void {
		this.view.focus();
		this.view.dispatch({ selection: EditorSelection.cursor(at) });
	}

	/** Type `words` one key at a time from where the caret is. */
	type(words: string): void {
		this.view.focus();
		for (const key of words) {
			const at = this.view.state.selection.main.head;
			this.view.dispatch({
				changes: { from: at, insert: key },
				selection: EditorSelection.cursor(at + key.length),
				userEvent: "input.type",
			});
		}
	}

	/** Type `words` straight after the first occurrence of `anchor`. */
	typeAfter(anchor: string, words: string): void {
		const at = this.editorText.indexOf(anchor);
		if (at < 0) throw new Error(`${this.name} cannot see "${anchor}"`);
		this.click(at + anchor.length);
		this.type(words);
	}

	/** The carets this person's editor draws for everybody else, by name. */
	caretNames(): string[] {
		return [...this.view.contentDOM.querySelectorAll(".knap-caret-name")].map(
			(label) => label.textContent ?? "",
		);
	}
}

class Room {
	readonly server = new Y.Doc();
	readonly people: Person[] = [];

	constructor(seed: string) {
		this.server.getText("content").insert(0, seed);
	}

	/**
	 * Somebody opens the note. Their editor shows `editorText`, which is the
	 * file on their disk, and by default that is the note as it is now.
	 */
	join(name: string, options: { editorText?: string; ready?: boolean } = {}): Person {
		const person = new Person(name);
		person.ready = options.ready ?? true;
		Y.applyUpdate(person.doc, Y.encodeStateAsUpdate(this.server), this);
		person.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === this) return;
			if (!person.online) {
				person.outbox.push(update);
				return;
			}
			this.fromPerson(person, update);
		});
		person.awareness.on(
			"update",
			(
				{ added, updated, removed }: Record<"added" | "updated" | "removed", number[]>,
				origin: unknown,
			) => {
				if (origin === this || !person.online) return;
				const changed = [...added, ...updated, ...removed];
				const message = encodeAwarenessUpdate(person.awareness, changed);
				for (const other of this.people) {
					if (other !== person && other.online) {
						applyAwarenessUpdate(other.awareness, message, this);
					}
				}
			},
		);
		for (const other of this.people) {
			const states = [...other.awareness.getStates().keys()];
			applyAwarenessUpdate(person.awareness, encodeAwarenessUpdate(other.awareness, states), this);
		}
		this.people.push(person);

		const source: LiveNoteSource = (person.source = {
			openNote: () =>
				person.ready
					? {
							text: person.text,
							awareness: person.awareness,
							who: name,
							release: () => undefined,
						}
					: null,
		});
		person.view = new EditorView({
			state: EditorState.create({
				doc: options.editorText ?? this.server.getText("content").toString(),
				extensions: editing(source),
			}),
			parent: document.body,
		});
		return person;
	}

	private fromPerson(person: Person, update: Uint8Array): void {
		person.sent += 1;
		Y.applyUpdate(this.server, update, this);
		for (const other of this.people) {
			if (other !== person && other.online) Y.applyUpdate(other.doc, update, this);
		}
	}

	offline(...people: Person[]): void {
		for (const person of people) person.online = false;
	}

	/** Back online: what they typed goes up, and what they missed comes down. */
	online(...people: Person[]): void {
		for (const person of people) {
			person.online = true;
			for (const update of person.outbox.splice(0)) this.fromPerson(person, update);
			Y.applyUpdate(
				person.doc,
				Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(person.doc)),
				this,
			);
		}
	}

	/** The note as the server holds it. */
	get note(): string {
		return this.server.getText("content").toString();
	}

	/** Everybody agrees, editors and documents alike, with the server. */
	expectConverged(): void {
		for (const person of this.people) {
			expect(person.text.toString()).toBe(this.note);
			expect(person.editorText).toBe(this.note);
		}
	}

	leave(): void {
		for (const person of this.people) {
			person.view.destroy();
			person.awareness.destroy();
		}
	}
}

/** Let the microtasks the plugin defers its dispatches to run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const NOTE = "# ICP App\n\nWie is de klant?\n\nDe doelgroep.\n\nOpen vragen\n";

describe("two and three people in one open note, in real editors", () => {
	let errors: string[];
	let room: Room;
	const consoleError = console.error;

	beforeEach(() => {
		errors = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		room = new Room(NOTE);
	});

	afterEach(() => {
		room.leave();
		console.error = consoleError;
		// CodeMirror catches a plugin's exception, logs it here and switches
		// the plugin off. Every scenario below is void if that happened.
		expect(errors.filter((line) => line.includes("CodeMirror plugin crashed"))).toEqual([]);
	});

	it("clicking into the note and typing keeps the editor live, one update per key", async () => {
		const rutger = room.join("Rutger");
		await tick();

		rutger.typeAfter("Wie is de klant?", " Een MKB-bedrijf");
		await tick();

		expect(room.note).toContain("Wie is de klant? Een MKB-bedrijf");
		// One update per key is what live means. A save-sized chunk is the
		// file binding, which is what everybody fell back on in #183.
		expect(rutger.sent).toBe(" Een MKB-bedrijf".length);
	});

	it("each person sees the other's caret with their name on it", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		await tick();

		daniel.click(daniel.editorText.indexOf("De doelgroep"));
		await tick();
		expect(rutger.caretNames()).toEqual(["Daniel"]);
		const caret = rutger.view.contentDOM.querySelector(".knap-caret");
		expect(caret?.parentElement?.textContent).toContain("De doelgroep");

		rutger.click(3);
		await tick();
		expect(daniel.caretNames()).toEqual(["Rutger"]);
	});

	it("a caret goes away when its person closes the note", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		await tick();
		daniel.click(5);
		await tick();
		expect(rutger.caretNames()).toEqual(["Daniel"]);

		daniel.view.destroy();
		await tick();

		expect(rutger.caretNames()).toEqual([]);
		daniel.view = new EditorView({ parent: document.body }); // for afterEach
	});

	it("two people typing in one sentence at the same moment both keep every keystroke", async () => {
		// The 2026-10-21 session, replayed: both type into line three before
		// either has seen the other's first key.
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		await tick();

		room.offline(rutger, daniel);
		rutger.typeAfter("Wie is de klant?", " Daniel is een held");
		daniel.typeAfter("Wie is de klant?", " zie je mij werken, hallo Rutger");
		room.online(rutger, daniel);
		await tick();

		room.expectConverged();
		expect(room.note).toContain(" Daniel is een held");
		expect(room.note).toContain(" zie je mij werken, hallo Rutger");
	});

	it("three people typing in three places at once end up with one note", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		const iris = room.join("Iris");
		await tick();

		room.offline(rutger, daniel, iris);
		rutger.typeAfter("# ICP App", " (concept)");
		daniel.typeAfter("De doelgroep.", " Odoo-gebruikers in de Benelux.");
		iris.typeAfter("Open vragen\n", "- prijs per gebruiker?\n");
		room.online(rutger, daniel, iris);
		await tick();

		room.expectConverged();
		expect(room.note).toBe(
			"# ICP App (concept)\n\nWie is de klant?\n\n" +
				"De doelgroep. Odoo-gebruikers in de Benelux.\n\n" +
				"Open vragen\n- prijs per gebruiker?\n",
		);
	});

	it("three people typing at the very same spot, key for key, lose nothing", async () => {
		const people = [room.join("Rutger"), room.join("Daniel"), room.join("Iris")];
		await tick();
		const words = ["aaaa", "bbbb", "cccc"];
		const at = NOTE.indexOf("Open vragen");
		for (const person of people) person.click(at);

		// Online the whole time, keys alternating between the three of them.
		for (let key = 0; key < 4; key++) {
			people.forEach((person, index) => person.type(words[index][key]));
		}
		await tick();

		room.expectConverged();
		const typed = room.note.slice(at, at + 12).split("").sort().join("");
		expect(typed).toBe("aaaabbbbcccc");
		expect(room.note.endsWith("Open vragen\n")).toBe(true);
	});

	it("somebody who typed offline is merged in when they are back, with nobody's work lost", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		const iris = room.join("Iris");
		await tick();

		room.offline(daniel);
		daniel.typeAfter("De doelgroep.", " (getypt in de trein)");
		rutger.typeAfter("Wie is de klant?", " Rutger was hier");
		iris.typeAfter("Wie is de klant?", " en Iris ook");
		await tick();
		expect(daniel.editorText).not.toContain("Rutger was hier");

		room.online(daniel);
		await tick();

		room.expectConverged();
		expect(room.note).toContain("(getypt in de trein)");
		expect(room.note).toContain("Rutger was hier");
		expect(room.note).toContain("en Iris ook");
	});

	it("an editor that opens a few keystrokes behind the note catches up and stays live", async () => {
		const rutger = room.join("Rutger");
		await tick();
		rutger.typeAfter("De doelgroep.", " Al getypt door Rutger.");
		await tick();

		// Daniel's file is the note as it was before Rutger typed: the file
		// binding writes it a moment later than the document moves.
		const daniel = room.join("Daniel", { editorText: NOTE });
		await tick();
		expect(daniel.editorText).toBe(room.note);

		daniel.typeAfter("Open vragen", "!");
		await tick();
		room.expectConverged();
		expect(room.note).toContain("Al getypt door Rutger.");
		expect(room.note).toContain("Open vragen!");
	});

	it("a key typed in the very update that binds the note goes in once", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel", { ready: false });
		await tick();

		// The note's socket syncs, and the next thing that happens in the
		// editor is a keystroke: that update is the one that binds.
		daniel.ready = true;
		daniel.typeAfter("Open vragen", "?");
		await tick();

		room.expectConverged();
		expect(room.note.match(/Open vragen\?/g)).toHaveLength(1);
		expect(room.note).not.toContain("??");
		expect(rutger.editorText).toContain("Open vragen?");
	});

	it("a table cell being edited keeps its own text, and the note stays the note", async () => {
		// Live Preview edits a table cell in an editor of its own, built inside
		// a `.table-cell-wrapper` and showing the same file as the note. Bound
		// to the note, it was lined up with all of it: the whole note went into
		// one cell, newlines as <br>, and Obsidian padded every row to that
		// width, 7k chars to 66k (#187, measured on prod 2026-10-26).
		const rutger = room.join("Rutger");
		await tick();
		const wrapper = document.body.appendChild(make("div", { cls: "table-cell-wrapper" }));
		const cell = new EditorView({
			state: EditorState.create({ doc: "De doelgroep.", extensions: editing(rutger.source) }),
			parent: wrapper,
		});
		await tick();

		expect(cell.state.doc.toString()).toBe("De doelgroep.");
		expect(room.note).toBe(NOTE);
		cell.destroy();
		wrapper.remove();
	});

	it("a remote change lands in an editor without moving its own caret", async () => {
		const rutger = room.join("Rutger");
		const daniel = room.join("Daniel");
		await tick();
		const at = rutger.editorText.indexOf("Open vragen");
		rutger.click(at);

		daniel.typeAfter("# ICP App", " met een langere titel");
		await tick();

		const head = rutger.view.state.selection.main.head;
		expect(rutger.editorText.slice(head)).toMatch(/^Open vragen/);
	});
});
