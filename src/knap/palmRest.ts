/**
 * A hand resting on an iPad while the pen draws in an Excalidraw drawing.
 *
 * Safari reports the palm as a second, "touch" pointer, and Excalidraw
 * (0.18, inside obsidian-excalidraw-plugin 2.29) takes it for input:
 *
 * - while a stroke is drawn, it listens to every `pointermove` and
 *   `pointerup` on the window, whichever pointer sent it, so the palm adds a
 *   point where it lies and its lift ends the stroke with a line to it;
 * - a palm that lands mid-stroke ends the stroke;
 * - a palm already down when the pen lands makes two pointers, which
 *   Excalidraw reads as a pinch: the pen pans the canvas instead of drawing.
 *
 * Measured 2026-11-21 on the drawing that showed it: a stroke with one point
 * 330 units to the right of the pen, on its line, and a stray dot there.
 *
 * So while a pen is down in a drawing, touch pointers do not reach
 * Excalidraw, and touches already down when the pen lands are lifted for
 * Excalidraw (a `pointerup` on the document, which is where it forgets a
 * pointer) and kept from it until they really lift. A finger with no pen on
 * the screen pans and draws as before. Dropped on purpose: a second finger
 * pinching while the pen is down, which nobody does while writing.
 */

/** Excalidraw's own root element carries this class. */
const IN_DRAWING = ".excalidraw";

const TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;

/** The fields of a PointerEvent this reads. */
export interface PointerLike extends Event {
	pointerId: number;
	pointerType: string;
	clientX: number;
	clientY: number;
}

/** A `pointerup` for a touch, which Excalidraw takes as that touch lifting. */
export type MakeUp = (pointer: { pointerId: number; clientX: number; clientY: number }) => Event;

function inDrawing(event: Event): boolean {
	const target = event.target as { closest?: (selector: string) => unknown } | null;
	return typeof target?.closest === "function" && target.closest(IN_DRAWING) !== null;
}

/**
 * Listen on `win` in the capture phase, ahead of everything Excalidraw
 * listens with; lifts go out on `doc`. Returns the function that stops it.
 */
export function rejectPalms(win: EventTarget, doc: EventTarget, makeUp: MakeUp): () => void {
	let pen: number | null = null;
	/** Touches down in a drawing that Excalidraw knows about. */
	const touching = new Map<number, { clientX: number; clientY: number }>();
	/** Touches Excalidraw must not see again until they lift. */
	const palms = new Set<number>();
	/** Our own lifts, which must get through. */
	const ours = new WeakSet<Event>();

	const swallow = (event: Event) => event.stopImmediatePropagation();

	const handle = (raw: Event) => {
		if (ours.has(raw)) return;
		const event = raw as PointerLike;
		const ends = event.type === "pointerup" || event.type === "pointercancel";

		if (event.pointerType === "pen") {
			if (event.type === "pointerdown" && inDrawing(event)) {
				pen = event.pointerId;
				for (const [pointerId, at] of touching) {
					palms.add(pointerId);
					const up = makeUp({ pointerId, ...at });
					ours.add(up);
					doc.dispatchEvent(up);
				}
				touching.clear();
			} else if (ends && event.pointerId === pen) {
				pen = null;
			}
			return;
		}
		if (event.pointerType !== "touch") return;

		if (palms.has(event.pointerId)) {
			if (ends) palms.delete(event.pointerId);
			swallow(event);
			return;
		}
		if (pen !== null) {
			if (!ends) palms.add(event.pointerId);
			swallow(event);
			return;
		}
		if (event.type === "pointerdown" && inDrawing(event)) {
			touching.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
		} else if (event.type === "pointermove" && touching.has(event.pointerId)) {
			touching.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
		} else if (ends) {
			touching.delete(event.pointerId);
		}
	};

	for (const type of TYPES) win.addEventListener(type, handle, { capture: true });
	return () => {
		for (const type of TYPES) win.removeEventListener(type, handle, { capture: true });
	};
}
