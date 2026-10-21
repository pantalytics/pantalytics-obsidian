/**
 * @jest-environment jsdom
 */
/**
 * Rutger and Daniel in one note, the whole plugin between them.
 *
 * `liveEditing.test.ts` proves the editor half on its own. This is the walk
 * of 2026-10-21 end to end: two `KnapSync`s linked to one cloud vault over
 * the fake server, real sockets with a turn of latency each way, the socket
 * pool, `openNote` and the file binding standing down for the open note,
 * and Obsidian saving the file every few keys the way it does. On 1.13.49
 * this ended with a conflict copy on Rutger's disk and no caret on either
 * screen (issue #183).
 */

import { webcrypto } from "crypto";
import { TextDecoder, TextEncoder } from "util";

import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { KnapSync } from "../../src/knap/KnapSync";
import { knapLiveEditing } from "../../src/knap/knapEditor";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import type { FileEvent } from "../../src/knap/VaultBinding";
import { FakeNetwork, MemoryFiles, roomOf } from "../mocks/fakeNetwork";

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
	// Obsidian's window has these; jsdom's does not.
	TextEncoder,
	TextDecoder,
});
if (!globalThis.crypto?.subtle) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const PATH = "🏢 Company/ICP/ICP App.md";
const NOTE = "# ICP App\n\nWie is de klant?\n\nOpen vragen\n";
/** Which file an editor shows: Obsidian's `editorInfoField`, as far as the plugin reads it. */
const fileOf = StateField.define<string>({ create: () => PATH, update: (value) => value });

/** A disk that tells the binding about every write, as Obsidian's vault does. */
class ObsidianFiles extends MemoryFiles {
	private listeners: ((event: FileEvent) => void)[] = [];

	async write(path: string, text: string): Promise<void> {
		const existed = this.map.has(path);
		await super.write(path, text);
		this.emit({ type: existed ? "modify" : "create", path });
	}

	onChange(callback: (event: FileEvent) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((listener) => listener !== callback);
		};
	}

	emit(event: FileEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

async function person(network: FakeNetwork, email: string, deviceName: string) {
	const files = new ObsidianFiles();
	let held: Parameters<ConstructorParameters<typeof KnapSync>[0]["save"]>[0] = {
		token: `knap_${deviceName}`,
		cloudVaultId: "",
		cloudVaultName: "",
	};
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName,
		// jsdom has no `Response`, and a fetch that throws reads to the plugin
		// as a server with no name for this person, so it is answered by hand.
		fetchFn: async (url: string) => {
			const body = url.endsWith("/api/me")
				? { subject: email, email }
				: { max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 };
			return { ok: true, status: 200, json: async () => body } as unknown as Response;
		},
		files,
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: network.socket,
	});
	await sync.link({ id: "v1", name: "Pantalytics_V03" });
	return { sync, files, view: null as unknown as EditorView };
}

type Person = Awaited<ReturnType<typeof person>>;

/** Obsidian opens the note in an editor, filled from the file on disk. */
function open(who: Person): void {
	who.view = new EditorView({
		state: EditorState.create({
			doc: who.files.map.get(PATH) ?? "",
			extensions: [
				fileOf,
				knapLiveEditing(who.sync, (state) => state.field(fileOf, false) ?? null),
			],
		}),
		parent: document.body,
	});
}

/** Type at the end of `anchor`, a key at a time, with Obsidian saving now and then. */
async function type(who: Person, anchor: string, words: string): Promise<void> {
	const text = () => who.view.state.doc.toString();
	who.view.focus();
	who.view.dispatch({ selection: EditorSelection.cursor(text().indexOf(anchor) + anchor.length) });
	for (const [index, key] of [...words].entries()) {
		const at = who.view.state.selection.main.head;
		who.view.dispatch({
			changes: { from: at, insert: key },
			selection: EditorSelection.cursor(at + 1),
			userEvent: "input.type",
		});
		// The other person's keys arrive in between, a socket turn later.
		await wait(1);
		if (index % 4 === 3) save(who);
	}
	save(who);
}

/** Obsidian's save: the buffer goes to disk and the vault says so. */
function save(who: Person): void {
	who.files.map.set(PATH, who.view.state.doc.toString());
	who.files.emit({ type: "modify", path: PATH });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (condition()) return;
		await wait(5);
	}
	throw new Error(`Gave up waiting for ${what}`);
}

const caretNames = (who: Person) =>
	[...who.view.contentDOM.querySelectorAll(".knap-caret-name")].map((label) => label.textContent);

const conflicts = (who: Person) => [...who.files.map.keys()].filter((path) => path.includes("conflict"));

describe("two people in one open note, through the whole plugin", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	let errors: string[];
	const consoleError = console.error;
	beforeEach(() => {
		errors = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
	});
	afterEach(() => {
		console.error = consoleError;
		expect(errors.filter((line) => line.includes("CodeMirror plugin crashed"))).toEqual([]);
	});

	it("both type at once, both see each other, and nobody gets a conflict copy", async () => {
		const network = new FakeNetwork();
		const tree = new TreeDoc(network.doc(roomOf("v1", TREE_DOC_ID)));
		const docId = tree.ensureNote(PATH);
		network.doc(roomOf("v1", docId)).getText("content").insert(0, NOTE);

		const rutger = await person(network, "rutger@pantalytics.com", "Pantalytics_v03 on desktop");
		const daniel = await person(network, "daniel@pantalytics.com", "Pantalytics_V03 on desktop");
		await until(
			() => rutger.files.map.get(PATH) === NOTE && daniel.files.map.get(PATH) === NOTE,
			"the note on both disks",
		);

		open(rutger);
		open(daniel);
		await until(
			() => rutger.sync.openNote(PATH) !== null && daniel.sync.openNote(PATH) !== null,
			"both editors bound",
		);
		// Those two handles were only a probe; give them back.
		await wait(20);

		await Promise.all([
			type(rutger, "Wie is de klant?", " Daniel is een held"),
			type(daniel, "Wie is de klant?", " zie je mij werken, hallo Rutger"),
		]);
		const server = () => network.text(roomOf("v1", docId));
		await until(
			() =>
				rutger.view.state.doc.toString() === server() &&
				daniel.view.state.doc.toString() === server(),
			"both editors equal to the server",
		);

		expect(server()).toContain(" Daniel is een held");
		expect(server()).toContain(" zie je mij werken, hallo Rutger");
		expect(conflicts(rutger)).toEqual([]);
		expect(conflicts(daniel)).toEqual([]);

		// Each sees the other's caret, named after the person, not the device.
		// One test document has one focus, and an editor without it rightly
		// takes its caret back, so each direction is read while its owner
		// has the focus.
		const click = (who: Person, at: number) => {
			who.view.focus();
			who.view.dispatch({ selection: EditorSelection.cursor(at) });
		};
		click(rutger, 2);
		await until(() => caretNames(daniel).length > 0, "Rutger's caret on Daniel's screen");
		expect(caretNames(daniel)).toEqual(["rutger"]);
		click(daniel, 4);
		await until(() => caretNames(rutger).length > 0, "Daniel's caret on Rutger's screen");
		expect(caretNames(rutger)).toEqual(["daniel"]);

		// Daniel closes the note: his caret goes, and Rutger's file is whole.
		daniel.view.destroy();
		await until(() => caretNames(rutger).length === 0, "Daniel's caret gone");
		rutger.view.destroy();
		await wait(50);
		expect(rutger.files.map.get(PATH)).toBe(server());
		expect(daniel.files.map.get(PATH)).toBe(server());
		expect(conflicts(rutger)).toEqual([]);
		expect(conflicts(daniel)).toEqual([]);

		rutger.sync.stop();
		daniel.sync.stop();
	});
});
