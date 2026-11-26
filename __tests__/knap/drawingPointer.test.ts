/**
 * @jest-environment jsdom
 */
/**
 * The pointer a drawing publishes, read off the view's element (adapt). A
 * finger or a pen that lifts, a gesture the browser takes over, or a mouse
 * that leaves takes the pointer away; a mouse that only lets go stays.
 */

import { adapt } from "../../src/knap/ObsidianDrawings";

type Update = { pointer: { x: number; y: number }; button: "up" | "down" } | null;

function setup() {
	const element = document.createElement("div");
	const api = {
		getAppState: () => ({ zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0, scrollX: 0, scrollY: 0 }),
	} as unknown as Parameters<typeof adapt>[0];
	const seen: Update[] = [];
	const stop = adapt(api, element).onPointerUpdate((update) => seen.push(update));
	const fire = (type: string, pointerType = "mouse", x = 10, y = 20) => {
		const event = new Event(type) as Event & { pointerType: string; clientX: number; clientY: number };
		Object.assign(event, { pointerType, clientX: x, clientY: y });
		element.dispatchEvent(event);
	};
	return { seen, fire, stop };
}

describe("a drawing's pointer on touch and with a mouse", () => {
	it("a finger that lifts takes the pointer away", () => {
		const { seen, fire } = setup();
		fire("pointerdown", "touch");
		fire("pointermove", "touch", 30, 40);
		fire("pointerup", "touch");
		expect(seen[0]).toMatchObject({ button: "down" });
		expect(seen[1]).toMatchObject({ pointer: { x: 30, y: 40 }, button: "down" });
		expect(seen[seen.length - 1]).toBeNull();
	});

	it("a gesture the browser takes over takes it away too", () => {
		const { seen, fire } = setup();
		fire("pointerdown", "pen");
		fire("pointercancel", "pen");
		expect(seen[seen.length - 1]).toBeNull();
	});

	it("a mouse that lets go stays, and one that leaves goes", () => {
		const { seen, fire } = setup();
		fire("pointerdown");
		fire("pointerup");
		expect(seen[seen.length - 1]).toMatchObject({ button: "up" });
		fire("pointerleave");
		expect(seen[seen.length - 1]).toBeNull();
	});

	it("stops listening when asked", () => {
		const { seen, fire, stop } = setup();
		stop();
		fire("pointermove");
		expect(seen).toHaveLength(0);
	});
});
