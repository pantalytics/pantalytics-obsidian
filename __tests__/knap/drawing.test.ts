/**
 * Two people in one Excalidraw drawing (ADR-0109).
 *
 * Before this, a drawing synced as one Text, and two saves that crossed on
 * the wire spliced into the same compressed line: about 199 times in 200 the
 * drawing no longer opened (odoo-mcp-pro-admin, scripts/vault/spikes/
 * excalidraw). Every scenario here crosses two saves with `hub.split()` and
 * asserts what a person would check: the drawing opens on both laptops, it
 * is the same drawing, and both people's strokes are in it.
 */

import { readFileSync } from "fs";
import { join } from "path";

import LZString from "lz-string";
import * as Y from "yjs";

import {
	ELEMENTS,
	EMPTY_FENCE,
	type Element,
	beats,
	canonical,
	parseDrawing,
	renderDocument,
} from "../../src/knap/drawing";
import { Hub, MemorySeen, device, settle } from "../mocks/vaultHub";

const PATH = "Whiteboard.excalidraw.md";

let nonce = 1;
function rect(id: string, index: string, x = 0): Element {
	return {
		id,
		type: "rectangle",
		x,
		y: 0,
		width: 100,
		height: 60,
		index,
		version: 1,
		versionNonce: nonce++,
		isDeleted: false,
	};
}

/** A drawing file the way obsidian-excalidraw-plugin 2.29.0 writes one. */
function file(elements: Element[], { compressed = true, top = "" } = {}): string {
	const scene = JSON.stringify(
		{
			type: "excalidraw",
			version: 2,
			source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
			elements,
			appState: { viewBackgroundColor: "#ffffff" },
			files: {},
		},
		null,
		"\t",
	);
	let body = scene;
	if (compressed) {
		const packed = LZString.compressToBase64(scene);
		body = "";
		for (let i = 0; i < packed.length; i += 256) body += `${packed.slice(i, i + 256)}\n\n`;
		body = body.trim();
	}
	return [
		"---",
		"",
		"excalidraw-plugin: parsed",
		"tags: [excalidraw]",
		"",
		"---",
		top + "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
		"",
		"",
		"# Excalidraw Data",
		"",
		"## Text Elements",
		"%%",
		"## Drawing",
		"```" + (compressed ? "compressed-json" : "json"),
		body,
		"```",
		"%%",
	].join("\n");
}

function elementsOf(text: string | undefined): Map<string, Element> {
	const drawing = parseDrawing(text ?? "");
	if (!drawing) throw new Error("this file does not open as a drawing");
	return new Map(drawing.elements.map((e) => [e.id, e]));
}

const moved = (e: Element, x: number): Element => ({
	...e,
	x,
	version: e.version + 1,
	versionNonce: nonce++,
});

async function twoPeople(seed: Element[]) {
	const hub = new Hub();
	const rutger = await device(hub, { [PATH]: file(seed) }, new MemorySeen(), "rutger conflict");
	const daniel = await device(hub, {}, new MemorySeen(), "daniel conflict");
	await settle(rutger.binding, daniel.binding);
	return { hub, rutger, daniel };
}

describe("a drawing file", () => {
	it("reads the same compressed or not, which is what keeps a save from being an edit", () => {
		const elements = [rect("a", "a0"), rect("b", "a1")];
		expect(canonical(file(elements, { compressed: true }))).toBe(
			canonical(file(elements, { compressed: false })),
		);
	});

	it("keeps the elements in z-order whatever order they arrive in", () => {
		const drawing = parseDrawing(file([rect("b", "a1"), rect("a", "a0")]));
		expect(drawing).not.toBeNull();
		const again = parseDrawing(canonical(file([rect("b", "a1"), rect("a", "a0")])));
		expect(again?.elements.map((e) => e.id)).toEqual(["a", "b"]);
	});

	it("is not a drawing when the scene does not read, and stays as it is", () => {
		const broken = file([rect("a", "a0")]).replace(/```compressed-json\n[\s\S]*?\n```/, "```compressed-json\nnot lz at all\n```");
		expect(parseDrawing(broken)).toBeNull();
		expect(canonical(broken)).toBe(broken);
	});

	it("settles one element by Excalidraw's rule: version, then the lower nonce", () => {
		const base = rect("a", "a0");
		const one = { ...base, version: 2, versionNonce: 5 };
		const two = { ...base, version: 2, versionNonce: 9 };
		expect(beats(one, two)).toBe(true);
		expect(beats(two, one)).toBe(false);
		expect(beats({ ...base, version: 3, versionNonce: 99 }, one)).toBe(true);
	});
});

describe("the file the server writes", () => {
	// Shared with odoo-mcp-pro-admin (tests/vault/fixtures/drawing.json), whose
	// mirror renders the same document to the same bytes. A change to the
	// format on either side fails one of the two tests.
	const fixture = JSON.parse(
		readFileSync(join(__dirname, "fixtures", "drawing.json"), "utf-8"),
	) as { text: string; map: Record<string, string>; scene: Record<string, string>; rendered: string };

	it("is the file this plugin writes for the same document, byte for byte", () => {
		const doc = new Y.Doc();
		doc.getText("content").insert(0, fixture.text);
		for (const [id, raw] of Object.entries(fixture.map)) doc.getMap<string>(ELEMENTS).set(id, raw);
		for (const [key, raw] of Object.entries(fixture.scene)) doc.getMap<string>("drawing_scene").set(key, raw);
		expect(renderDocument(doc)).toBe(fixture.rendered);
		expect(canonical(fixture.rendered)).toBe(fixture.rendered);
	});
});

describe("two people drawing at once", () => {
	it("keeps both people's strokes, and the drawing opens on both laptops", async () => {
		const a = rect("a", "a0");
		const b = rect("b", "a1");
		const { hub, rutger, daniel } = await twoPeople([a, b]);

		hub.split();
		await rutger.files.write(PATH, file([moved(a, 300), b]));
		await daniel.files.write(PATH, file([a, b, rect("c", "a2", 500)]));
		await settle(rutger.binding, daniel.binding);
		hub.heal();
		await settle(rutger.binding, daniel.binding);
		// Each side's next save brings the other's strokes down.
		await rutger.files.write(PATH, rutger.files.map.get(PATH) as string);
		await daniel.files.write(PATH, daniel.files.map.get(PATH) as string);
		await settle(rutger.binding, daniel.binding);

		const onRutger = elementsOf(rutger.files.map.get(PATH));
		const onDaniel = elementsOf(daniel.files.map.get(PATH));
		expect(rutger.files.map.get(PATH)).toBe(daniel.files.map.get(PATH));
		expect(onRutger.get("a")?.x).toBe(300);
		expect(onRutger.has("c")).toBe(true);
		expect(onDaniel.get("a")?.x).toBe(300);
		expect([...rutger.files.map.keys(), ...daniel.files.map.keys()].filter((p) => p.includes("conflict"))).toEqual([]);
	});

	it("ends on one of the two when both move the same element, never on a mix", async () => {
		const a = rect("a", "a0");
		const { hub, rutger, daniel } = await twoPeople([a]);

		const one = moved(a, 300);
		const two = moved(a, -50);
		hub.split();
		await rutger.files.write(PATH, file([one]));
		await daniel.files.write(PATH, file([two]));
		await settle(rutger.binding, daniel.binding);
		hub.heal();
		await settle(rutger.binding, daniel.binding);
		await rutger.files.write(PATH, rutger.files.map.get(PATH) as string);
		await daniel.files.write(PATH, daniel.files.map.get(PATH) as string);
		await settle(rutger.binding, daniel.binding);

		const winner = beats(one, two) ? one : two;
		expect(elementsOf(rutger.files.map.get(PATH)).get("a")).toEqual(winner);
		expect(elementsOf(daniel.files.map.get(PATH)).get("a")).toEqual(winner);
	});

	it("settles a delete against a drag the way excalidraw.com does", async () => {
		const a = rect("a", "a0");
		const { hub, rutger, daniel } = await twoPeople([a, rect("b", "a1")]);

		const deleted = { ...a, isDeleted: true, version: 2, versionNonce: nonce++ };
		const dragged = moved(a, 120);
		hub.split();
		await rutger.files.write(PATH, file([deleted, rect("b", "a1")]));
		await daniel.files.write(PATH, file([dragged, rect("b", "a1")]));
		await settle(rutger.binding, daniel.binding);
		hub.heal();
		await settle(rutger.binding, daniel.binding);
		await rutger.files.write(PATH, rutger.files.map.get(PATH) as string);
		await daniel.files.write(PATH, daniel.files.map.get(PATH) as string);
		await settle(rutger.binding, daniel.binding);

		const winner = beats(deleted, dragged) ? deleted : dragged;
		expect(elementsOf(rutger.files.map.get(PATH)).get("a")).toEqual(winner);
		expect(rutger.files.map.get(PATH)).toBe(daniel.files.map.get(PATH));
	});

	it("does not take a compressed save of the same scene for an edit", async () => {
		const a = rect("a", "a0");
		const { hub, rutger, daniel } = await twoPeople([a]);
		const before = daniel.files.map.get(PATH);
		const docId = hub.treeOf().get(PATH) as string;
		const state = Y.encodeStateVector(hub.docOf(docId)).toString();

		await rutger.files.write(PATH, file([a], { compressed: true }));
		await settle(rutger.binding, daniel.binding);

		expect(daniel.files.map.get(PATH)).toBe(before);
		expect(Y.encodeStateVector(hub.docOf(docId)).toString()).toBe(state);
	});

	it("puts the text around the drawing in a copy only when both changed it", async () => {
		const a = rect("a", "a0");
		const { hub, rutger, daniel } = await twoPeople([a]);

		hub.split();
		await rutger.files.write(PATH, file([moved(a, 10)], { top: "Rutger's note\n" }));
		await daniel.files.write(PATH, file([a, rect("b", "a1")], { top: "Daniel's note\n" }));
		await settle(rutger.binding, daniel.binding);
		hub.heal();
		await settle(rutger.binding, daniel.binding);
		await rutger.files.write(PATH, rutger.files.map.get(PATH) as string);
		await daniel.files.write(PATH, daniel.files.map.get(PATH) as string);
		await settle(rutger.binding, daniel.binding);

		// Both strokes are in the drawing either way.
		const drawing = elementsOf(rutger.files.map.get(PATH));
		expect(drawing.get("a")?.x).toBe(10);
		expect(drawing.has("b")).toBe(true);
		const everything = [...rutger.files.map.values(), ...daniel.files.map.values()].join("\n");
		expect(everything).toContain("Rutger's note");
		expect(everything).toContain("Daniel's note");
	});
});

describe("a drawing synced the old way", () => {
	it("reads from a Text that still holds the whole file, and moves it into the map on the next save", async () => {
		const a = rect("a", "a0");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, file([a]));
		expect(elementsOf(renderDocument(doc)).has("a")).toBe(true);

		// A note an older plugin made: the whole file in the Text.
		const hub = new Hub();
		const rutger = await device(hub, {}, new MemorySeen());
		hub.repoint(PATH, "legacy", file([a]));
		const daniel = await device(hub, {}, new MemorySeen());
		await settle(rutger.binding, daniel.binding);
		expect(elementsOf(daniel.files.map.get(PATH)).has("a")).toBe(true);

		await daniel.files.write(PATH, file([moved(a, 40), rect("b", "a1")]));
		await settle(daniel.binding);
		// Rutger's binding catches up the next time anything touches the note.
		await rutger.files.write(PATH, rutger.files.map.get(PATH) ?? file([a]));
		await settle(daniel.binding, rutger.binding);
		const drawing = elementsOf(rutger.files.map.get(PATH));
		expect(drawing.get("a")?.x).toBe(40);
		expect(drawing.has("b")).toBe(true);

		const held = new Y.Doc();
		Y.applyUpdate(held, Y.encodeStateAsUpdate(hub.docOf("legacy")));
		expect(held.getText("content").toString()).toContain(EMPTY_FENCE);
		expect(held.getMap(ELEMENTS).size).toBe(2);
	});
});
