/**
 * A palm on an iPad while the pen draws (palmRest.ts). Excalidraw stands in
 * as a listener added after it on the same target; the lifts go to a
 * separate document target.
 */

import { rejectPalms } from "../../src/knap/palmRest";

const drawing = { closest: (selector: string) => (selector === ".excalidraw" ? {} : null) };
const elsewhere = { closest: () => null };

function pointer(type: string, pointerType: string, pointerId: number, target: object = drawing, clientX = 0) {
	const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
	Object.assign(event, { pointerType, pointerId, clientX, clientY: 0 });
	Object.defineProperty(event, "target", { value: target });
	return event;
}

function setup() {
	const win = new EventTarget();
	const doc = new EventTarget();
	const stop = rejectPalms(win, doc, (p) => {
		const up = new Event("pointerup") as Event & Record<string, unknown>;
		return Object.assign(up, p, { pointerType: "touch" });
	});
	// Excalidraw listens after: on a real page it is behind the window's capture phase.
	const excalidraw: string[] = [];
	const lifted: number[] = [];
	for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
		win.addEventListener(type, (e) => {
			const p = e as Event & { pointerType: string; pointerId: number };
			excalidraw.push(`${type}:${p.pointerType}:${p.pointerId}`);
		});
	}
	doc.addEventListener("pointerup", (e) => lifted.push((e as Event & { pointerId: number }).pointerId));
	const send = (event: Event) => win.dispatchEvent(event);
	return { send, excalidraw, lifted, stop };
}

describe("a palm resting while the pen draws", () => {
	test("a palm that lands mid-stroke never reaches Excalidraw", () => {
		const { send, excalidraw } = setup();
		send(pointer("pointerdown", "pen", 1));
		send(pointer("pointermove", "pen", 1));
		send(pointer("pointerdown", "touch", 7));
		send(pointer("pointermove", "touch", 7, drawing, 590));
		send(pointer("pointerup", "touch", 7));
		send(pointer("pointermove", "pen", 1));
		send(pointer("pointerup", "pen", 1));
		expect(excalidraw).toEqual([
			"pointerdown:pen:1",
			"pointermove:pen:1",
			"pointermove:pen:1",
			"pointerup:pen:1",
		]);
	});

	test("a palm already down is lifted for Excalidraw when the pen lands, and kept away until it lifts", () => {
		const { send, excalidraw, lifted } = setup();
		send(pointer("pointerdown", "touch", 7));
		send(pointer("pointerdown", "pen", 1));
		send(pointer("pointermove", "touch", 7));
		send(pointer("pointerup", "pen", 1));
		send(pointer("pointermove", "touch", 7));
		send(pointer("pointerup", "touch", 7));
		expect(lifted).toEqual([7]);
		expect(excalidraw).toEqual(["pointerdown:touch:7", "pointerdown:pen:1", "pointerup:pen:1"]);
	});

	test("a finger with no pen down pans as before", () => {
		const { send, excalidraw } = setup();
		send(pointer("pointerdown", "touch", 3));
		send(pointer("pointermove", "touch", 3));
		send(pointer("pointerup", "touch", 3));
		expect(excalidraw).toEqual(["pointerdown:touch:3", "pointermove:touch:3", "pointerup:touch:3"]);
	});

	test("a pen outside a drawing changes nothing", () => {
		const { send, excalidraw, lifted } = setup();
		send(pointer("pointerdown", "touch", 7));
		send(pointer("pointerdown", "pen", 1, elsewhere));
		send(pointer("pointermove", "touch", 7));
		expect(lifted).toEqual([]);
		expect(excalidraw).toEqual(["pointerdown:touch:7", "pointerdown:pen:1", "pointermove:touch:7"]);
	});

	test("stopping removes every listener", () => {
		const { send, excalidraw, stop } = setup();
		stop();
		send(pointer("pointerdown", "pen", 1));
		send(pointer("pointermove", "touch", 7));
		expect(excalidraw).toEqual(["pointerdown:pen:1", "pointermove:touch:7"]);
	});
});
