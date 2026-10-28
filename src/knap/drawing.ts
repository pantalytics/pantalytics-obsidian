/**
 * An Excalidraw drawing, held per element (ADR-0109).
 *
 * A `.excalidraw.md` is markdown on top and one JSON scene at the bottom,
 * LZ-compressed by default. As one Text, two people drawing at once spliced
 * into the same compressed line and the drawing stopped opening: about 199
 * times in 200, measured in odoo-mcp-pro-admin's
 * `scripts/vault/spikes/excalidraw/`. So the document holds it in two parts:
 *
 * - the note's Text holds the file with the scene's body taken out, which
 *   leaves "## Drawing" followed by an empty json fence;
 * - `drawing` holds the elements, one entry per element id, each the
 *   element's JSON, and `drawing_scene` holds the rest of the scene.
 *
 * Elements settle by Excalidraw's own rule: the higher `version` wins, on a
 * tie the lower `versionNonce`, and a delete is a tombstone that plays by the
 * same rule. Every write is one element in or out, never the scene
 * (ADR-0010).
 *
 * The file is derived, and there is one form of it: uncompressed, elements
 * in z-order. Every comparison the binding makes goes through `canonical`,
 * so the Excalidraw plugin saving the same scene compressed is the same
 * file, and not an edit.
 *
 * A Text whose fence still has a body is a drawing from before this: a note
 * synced as one Text, or a device on an older plugin. Its elements count as
 * if they were in the map, and the next file this device takes in folds
 * them there and empties the fence.
 */

import * as Y from "yjs";
import LZString from "lz-string";

export const ELEMENTS = "drawing";
export const SCENE = "drawing_scene";
const CONTENT = "content";

/** Y.Text implements toString; the lint rule cannot see that through AbstractType. */
function textOf(content: Y.Text): string {
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text has a real toString
	return content.toString();
}

/** The fence the Text keeps where the scene was. */
export const EMPTY_FENCE = "```json\n```";

/**
 * Where the scene sits: after "## Drawing", one fenced block, closed where the
 * Excalidraw plugin closes it (before "%%" or at the end), so a text element
 * with a fence of its own inside the JSON does not end the scene early.
 */
const SCENE_BLOCK = /(## Drawing\n)```(compressed-json|json)\n([\s\S]*?)\n?```(?=\n%%|\s*$)/;

/**
 * What Excalidraw writes above the scene on its first save. A new drawing is
 * created without it, and Excalidraw 2.29.0, reloading an open drawing whose
 * file changed, copies each text element's entry out of this section: with
 * no section the entries come back undefined and every save after that
 * throws (issue #193, measured in a real Obsidian). So a drawing that reaches
 * the document without it gets it, in the form Excalidraw's own save gives.
 */
const EXCALIDRAW_HEADER = "# Excalidraw Data\n\n## Text Elements\n%%\n";

/** A file older than the "# Excalidraw Data" layout keeps the layout it has. */
function withHeader(head: string): string {
	if (/^# Excalidraw Data$|^# Text Elements$|^%%$/m.test(head)) return head;
	return head + EXCALIDRAW_HEADER;
}

export interface Element {
	id: string;
	version: number;
	versionNonce: number;
	index?: string | null;
	isDeleted?: boolean;
	[key: string]: unknown;
}

/** Everything in the scene except its elements. */
type SceneRest = Record<string, unknown>;

export interface Drawing {
	/** The file with the scene's body taken out. */
	text: string;
	elements: Element[];
	rest: SceneRest;
}

export function isDrawing(path: string): boolean {
	return path.endsWith(".excalidraw.md");
}

/** Excalidraw's reconcile: does `a` replace `b`? */
export function beats(a: Element, b: Element | undefined): boolean {
	if (!b) return true;
	if (a.version !== b.version) return a.version > b.version;
	return a.versionNonce < b.versionNonce;
}

/**
 * Split a drawing file into its text and its scene.
 *
 * Null for a file with no scene in it, or one whose scene does not read: a
 * save cut off halfway, or the markdown of somebody who turned it into a
 * plain note. Neither is a drawing anybody can merge.
 */
export function parseDrawing(file: string): Drawing | null {
	const match = SCENE_BLOCK.exec(file);
	if (!match) return null;
	const [whole, heading, kind, body] = match;
	const text = withHeader(file.slice(0, match.index)) + heading + EMPTY_FENCE + file.slice(match.index + whole.length);
	if (body.trim() === "") return { text, elements: [], rest: {} };
	const json = kind === "json" ? body : LZString.decompressFromBase64(body.replace(/[\r\n]/g, ""));
	if (!json) return null;
	let scene: { elements?: unknown };
	try {
		scene = JSON.parse(json) as { elements?: unknown };
	} catch {
		return null;
	}
	if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) return null;
	const { elements, ...rest } = scene as { elements: Element[] } & SceneRest;
	return { text, elements: elements.filter(isElement), rest };
}

function isElement(value: unknown): value is Element {
	const e = value as Element;
	return !!e && typeof e.id === "string" && typeof e.version === "number" && typeof e.versionNonce === "number";
}

/** Z-order: Excalidraw's fractional index, then the id so ties are stable. */
export function byIndex(a: Element, b: Element): number {
	const ai = a.index ?? "";
	const bi = b.index ?? "";
	if (ai !== bi) return ai < bi ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The one form a drawing file takes, whatever wrote it. */
export function renderDrawing(drawing: Drawing): string {
	const scene: SceneRest & { elements: Element[] } = {
		type: "excalidraw",
		version: 2,
		source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
		...drawing.rest,
		elements: [...drawing.elements].sort(byIndex),
	};
	// Excalidraw's key order: type, version, source, elements, then the rest,
	// which is appState and files, alphabetical. Sorted rather than taken in
	// the order they arrived, because a map does not keep one.
	const { type, version, source, elements, ...after } = scene;
	const ordered: SceneRest = { type, version, source, elements };
	for (const key of Object.keys(after).sort()) ordered[key] = after[key];
	const json = JSON.stringify(ordered, null, "\t");
	const match = SCENE_BLOCK.exec(drawing.text);
	if (!match) return drawing.text;
	const end = match.index + match[0].length;
	return drawing.text.slice(0, match.index) + match[1] + "```json\n" + json + "\n```" + drawing.text.slice(end);
}

/**
 * The file as every comparison sees it. A text that is not a drawing stays
 * as it is: there is nothing to settle in it but its characters.
 */
export function canonical(file: string): string {
	const drawing = parseDrawing(file);
	return drawing ? renderDrawing(drawing) : file;
}

/** One map from id to element, each id kept at the version that wins. */
function winners(...lists: Element[][]): Map<string, Element> {
	const out = new Map<string, Element>();
	for (const list of lists) {
		for (const element of list) {
			if (beats(element, out.get(element.id))) out.set(element.id, element);
		}
	}
	return out;
}

function mapElements(doc: Y.Doc): Element[] {
	const out: Element[] = [];
	for (const raw of doc.getMap<string>(ELEMENTS).values()) {
		try {
			out.push(JSON.parse(raw) as Element);
		} catch {
			// An entry nobody can read is an entry nobody wrote on purpose.
		}
	}
	return out;
}

function mapRest(doc: Y.Doc): SceneRest {
	const rest: SceneRest = {};
	for (const [key, raw] of doc.getMap<string>(SCENE).entries()) {
		try {
			rest[key] = JSON.parse(raw);
		} catch {
			// as above
		}
	}
	return rest;
}

/** The document as a drawing: its Text, the map, and anything still in the fence. */
function drawingOf(doc: Y.Doc): Drawing | null {
	const text = textOf(doc.getText(CONTENT));
	const legacy = parseDrawing(text);
	if (!legacy) return null;
	const elements = winners(legacy.elements, mapElements(doc));
	return {
		text: legacy.text,
		elements: [...elements.values()],
		rest: { ...legacy.rest, ...mapRest(doc) },
	};
}

/**
 * The file this document stands for. A document with no scene in it at all
 * is still a note, and reads like one.
 */
export function renderDocument(doc: Y.Doc): string {
	const drawing = drawingOf(doc);
	return drawing ? renderDrawing(drawing) : textOf(doc.getText(CONTENT));
}

/**
 * Take a drawing file into the document: each element that wins goes into
 * the map, the rest of the scene where it moved, and the text around the
 * scene as one splice. Elements missing from the file stay: the Excalidraw
 * plugin writes a delete as a tombstone, and a file without an element is a
 * file that has not caught up with it yet.
 *
 * Returns false when the file is not a drawing this can read, and leaves the
 * document alone.
 */
export function ingestDrawing(doc: Y.Doc, file: string, takeText = true): boolean {
	const incoming = parseDrawing(file);
	if (!incoming) return false;
	const content = doc.getText(CONTENT);
	const current = textOf(content);
	const legacy = parseDrawing(current);
	const map = doc.getMap<string>(ELEMENTS);
	const sceneMap = doc.getMap<string>(SCENE);
	doc.transact(() => {
		const held = winners(mapElements(doc));
		const fold = legacy ? [...legacy.elements, ...incoming.elements] : incoming.elements;
		for (const element of fold) {
			if (beats(element, held.get(element.id))) {
				map.set(element.id, JSON.stringify(element));
				held.set(element.id, element);
			}
		}
		const rest = { ...(legacy?.rest ?? {}), ...incoming.rest };
		for (const [key, value] of Object.entries(rest)) {
			const raw = JSON.stringify(value);
			if (sceneMap.get(key) !== raw) sceneMap.set(key, raw);
		}
		const target = takeText ? incoming.text : (legacy?.text ?? incoming.text);
		spliceText(content, current, target);
	});
	return true;
}

/** The text around the scene, as it stands in the document. */
export function textOfDocument(doc: Y.Doc): string {
	const text = textOf(doc.getText(CONTENT));
	return parseDrawing(text)?.text ?? text;
}

/** The same minimal splice the binding uses, kept here to stay a leaf module. */
function spliceText(content: Y.Text, oldText: string, newText: string): void {
	if (oldText === newText) return;
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
	const deleteLen = oldText.length - prefix - suffix;
	if (deleteLen > 0) content.delete(prefix, deleteLen);
	const middle = newText.slice(prefix, newText.length - suffix);
	if (middle) content.insert(prefix, middle);
}
