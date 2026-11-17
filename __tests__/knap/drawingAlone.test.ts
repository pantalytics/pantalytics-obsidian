/**
 * One person drawing alone never gets a conflict copy (issue #690 in
 * odoo-mcp-pro-admin).
 *
 * With a drawing open, this device writes to its document twice over:
 * LiveDrawing puts each stroke into the element map as it is drawn, and
 * Excalidraw's own save brings the file in a few seconds later. The binding
 * took the first for "the document moved" and the second for "the file
 * moved", and when the save also changed the text around the scene (a text
 * element typed, which Excalidraw lists under "## Text Elements") it wrote a
 * conflict copy of a drawing nobody else had touched.
 */

import * as Y from "yjs";

import { ELEMENTS, type Element, parseDrawing } from "../../src/knap/drawing";
import { Hub, MemorySeen, device, settle } from "../mocks/vaultHub";

const PATH = "Excalidraw/Drawing.excalidraw.md";

let nonce = 1;
function element(id: string, index: string, extra: Partial<Element> = {}): Element {
	return { id, type: "rectangle", x: 0, y: 0, index, version: 1, versionNonce: nonce++, isDeleted: false, ...extra };
}

/** A drawing file as Excalidraw saves one, with its text elements listed. */
function file(elements: Element[], textLines: string[] = []): string {
	const scene = JSON.stringify(
		{ type: "excalidraw", version: 2, source: "https://github.com/zsviczian/obsidian-excalidraw-plugin", elements, appState: {}, files: {} },
		null,
		"\t",
	);
	const listed = textLines.map((line) => `${line}\n`).join("\n");
	return `---\n\nexcalidraw-plugin: parsed\n\n---\n\n# Excalidraw Data\n\n## Text Elements\n${listed}%%\n## Drawing\n\`\`\`json\n${scene}\n\`\`\`\n%%`;
}

const copies = (files: Map<string, string>) => [...files.keys()].filter((p) => p.includes("conflict"));

/** What LiveDrawing does with a stroke: one element into the map. */
function stroke(hub: Hub, docId: string, e: Element): void {
	hub.docOf(docId).getMap<string>(ELEMENTS).set(e.id, JSON.stringify(e));
}

describe("one person drawing alone", () => {
	it("gets no conflict copy when a save that lists a new text element follows the live strokes", async () => {
		const a = element("a", "a0");
		const hub = new Hub();
		const rutger = await device(hub, { [PATH]: file([a]) }, new MemorySeen(), "rutger conflict");
		await settle(rutger.binding);
		const docId = hub.treeOf().get(PATH) as string;

		await rutger.binding.follow(PATH);
		rutger.binding.drawingOpen(PATH);
		const t1 = element("t1", "a1", { type: "text", text: "Hallo" });
		stroke(hub, docId, t1);
		await settle(rutger.binding);

		await rutger.files.write(PATH, file([a, t1], ["Hallo ^t1"]));
		await settle(rutger.binding);

		expect(copies(rutger.files.map)).toEqual([]);
		const held = new Y.Doc();
		Y.applyUpdate(held, Y.encodeStateAsUpdate(hub.docOf(docId)));
		expect(held.getText("content").toString()).toContain("Hallo ^t1");
	});

	it("still copies the text around the scene when somebody else changed it too", async () => {
		const a = element("a", "a0");
		const hub = new Hub();
		const rutger = await device(hub, { [PATH]: file([a]) }, new MemorySeen(), "rutger conflict");
		const daniel = await device(hub, {}, new MemorySeen(), "daniel conflict");
		await settle(rutger.binding, daniel.binding);

		hub.split();
		await rutger.files.write(PATH, file([a], ["Rutger ^r"]));
		await daniel.files.write(PATH, file([a], ["Daniel ^d"]));
		await settle(rutger.binding, daniel.binding);
		hub.heal();
		await settle(rutger.binding, daniel.binding);
		await rutger.files.write(PATH, rutger.files.map.get(PATH) as string);
		await daniel.files.write(PATH, daniel.files.map.get(PATH) as string);
		await settle(rutger.binding, daniel.binding);

		const everything = [...rutger.files.map.values(), ...daniel.files.map.values()].join("\n");
		expect(everything).toContain("Rutger ^r");
		expect(everything).toContain("Daniel ^d");
		expect(parseDrawing(rutger.files.map.get(PATH) as string)).not.toBeNull();
	});
});
