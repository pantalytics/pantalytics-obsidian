/**
 * One open Excalidraw drawing, bound to its note's live document (ADR-0109,
 * step 2).
 *
 * The file binding settles a drawing per element whenever the Excalidraw
 * plugin saves, which is every few seconds. That keeps a drawing whole, but
 * it is not two people drawing together: a stroke shows on the other screen
 * after the next save, and nobody sees where the other person is pointing.
 * So while a drawing is open, its view is bound to the document directly,
 * the way y-excalidraw binds one:
 *
 * - a local change puts each element that changed into the map, by the same
 *   rule the file binding uses, at most a few times a second;
 * - a remote element that beats the scene's goes into the view through
 *   `updateScene`, without touching the view's undo history;
 * - the pointer rides awareness (ADR-0076), and every other person's comes
 *   back as an Excalidraw collaborator, with their name beside it.
 *
 * The file binding keeps running for the note underneath: the text around
 * the scene (text elements, embedded files) still reaches the document
 * through the file, and the file still follows the document.
 *
 * Framework-light, like `LiveNote`: it takes anything shaped like the slice
 * of Excalidraw's API it uses, which is what a test can be without a screen.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import { ELEMENTS, type Element, beats, byIndex } from "./drawing";
import { USER_FIELD, publishUser, type CursorUser } from "./NoteCursors";
import { DrawingLatency, MEASURE_FIELD, SEEN_FIELD, type Seen, drawingLatency, keyOf } from "./drawingLatency";

/** The awareness field holding a pointer on the canvas. */
export const POINTER_FIELD = "pointer";

/** How often local strokes go out, at most. A drag is a change per frame. */
export const SEND_EVERY_MS = 100;
/** At most one pointer frame per this many milliseconds; the last one always goes. */
export const POINTER_EVERY_MS = 40;

export interface Pointer {
	x: number;
	y: number;
	tool: "pointer" | "laser";
	button: "up" | "down";
}

/** The slice of Excalidraw's imperative API this binding uses. */
export interface ExcalidrawLike {
	getSceneElementsIncludingDeleted(): readonly Element[];
	updateScene(scene: {
		elements?: readonly Element[];
		collaborators?: Map<string, unknown>;
		captureUpdate?: "IMMEDIATELY" | "EVENTUALLY" | "NEVER";
	}): void;
	onChange(callback: (elements: readonly Element[]) => void): () => void;
	/** `null` when the pointer left the drawing: a mouse out, a finger or pen lifted. */
	onPointerUpdate(
		callback: (
			payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" } | null,
		) => void,
	): () => void;
}

export class LiveDrawing {
	private readonly map: Y.Map<string>;
	/**
	 * Each element as the map holds it, so a frame costs no parsing. What the
	 * map holds, not what wins: two people setting one element at once leave
	 * the map with whichever set it keeps, and `send` puts the winner back.
	 */
	private readonly held = new Map<string, Element>();
	// Never an object the view holds: Excalidraw mutates those in place.
	private readonly stops: (() => void)[] = [];
	private pending = false;
	/** When the first change since the last send came in, for #695's wait. */
	private firstChangeAt = 0;
	private announced = false;
	private timer: number | null = null;
	/** The pointer as it last went out, and as it is now. */
	private pointerSent: Pointer | null = null;
	private pointerNext: Pointer | null = null;
	private pointerTimer = 0;
	private destroyed = false;

	constructor(
		private readonly api: ExcalidrawLike,
		private readonly doc: Y.Doc,
		private readonly awareness: Awareness,
		private readonly who: string,
		private readonly latency: DrawingLatency = drawingLatency,
	) {
		this.map = doc.getMap<string>(ELEMENTS);
		for (const raw of this.map.values()) this.remember(raw);

		const onMap = (event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
			if (transaction.origin === this) return;
			const arrived: Element[] = [];
			for (const key of event.keysChanged as Set<string>) {
				const raw = this.map.get(key);
				if (raw === undefined) continue;
				const element = this.remember(raw);
				if (element) arrived.push(element);
			}
			const started = performance.now();
			// An element the view holds that beats what arrived goes back.
			if (!this.show(arrived)) this.schedule();
			if (this.someoneMeasures()) {
				const seen: Seen = { keys: arrived.map(keyOf), renderMs: performance.now() - started };
				this.awareness.setLocalStateField(SEEN_FIELD, seen);
			}
		};
		this.map.observe(onMap);
		this.stops.push(() => this.map.unobserve(onMap));

		this.stops.push(this.api.onChange(() => this.schedule()));
		this.stops.push(
			this.api.onPointerUpdate((update) => {
				this.pointerNext = update
					? ({
							x: update.pointer.x,
							y: update.pointer.y,
							tool: update.pointer.tool,
							button: update.button,
						} satisfies Pointer)
					: null;
				// Gone, or the button changed: say it now. A move waits for the
				// next slot, so a pen at 240 Hz is not 240 awareness frames a
				// second to everybody in the drawing.
				const last = this.pointerSent;
				if (!update || !last || last.button !== update.button) this.sendPointer();
				else if (!this.pointerTimer) {
					this.pointerTimer = window.setTimeout(() => this.sendPointer(), POINTER_EVERY_MS);
				}
			}),
		);
		const onAwareness = () => {
			this.showPointers();
			this.takeEchoes();
		};
		this.awareness.on("change", onAwareness);
		this.stops.push(() => this.awareness.off("change", onAwareness));

		publishUser(this.awareness, this.who);
		// What the document has that the view does not: strokes made while
		// this drawing was closed here, before the file caught up.
		this.show([...this.held.values()]);
		this.showPointers();
	}

	/** Put the view's changed elements into the map now. Tests call it directly. */
	send(): void {
		this.pending = false;
		if (this.destroyed) return;
		const changed: Element[] = [];
		for (const element of this.api.getSceneElementsIncludingDeleted()) {
			if (beats(element, this.held.get(element.id))) changed.push(element);
		}
		if (changed.length === 0) return;
		const raws = changed.map((element) => JSON.stringify(element));
		// Stamped before the write: a relay can echo before transact returns.
		this.announceMeasuring();
		const waitMs = this.firstChangeAt ? performance.now() - this.firstChangeAt : 0;
		this.latency.sent(changed.map(keyOf), waitMs, raws.reduce((n, raw) => n + raw.length, 0));
		this.firstChangeAt = 0;
		this.doc.transact(() => {
			changed.forEach((element, i) => {
				this.map.set(element.id, raws[i]);
				// A copy: Excalidraw adds a pen stroke's points to this very
				// object and bumps its version in place, so holding the object
				// itself made every later frame look already sent (#695).
				this.held.set(element.id, { ...element });
			});
		}, this);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.send();
		this.destroyed = true;
		if (this.timer) window.clearTimeout(this.timer);
		for (const stop of this.stops) stop();
		if (this.pointerTimer) window.clearTimeout(this.pointerTimer);
		this.awareness.setLocalStateField(POINTER_FIELD, null);
		if (this.announced) this.awareness.setLocalStateField(MEASURE_FIELD, null);
	}

	private sendPointer(): void {
		if (this.pointerTimer) window.clearTimeout(this.pointerTimer);
		this.pointerTimer = 0;
		if (this.destroyed) return;
		this.pointerSent = this.pointerNext;
		this.awareness.setLocalStateField(POINTER_FIELD, this.pointerNext);
	}

	private schedule(): void {
		if (this.pending || this.destroyed) return;
		this.pending = true;
		this.firstChangeAt = performance.now();
		this.timer = window.setTimeout(() => this.send(), SEND_EVERY_MS);
	}

	/** #695: tell the other devices to echo while this one measures. */
	private announceMeasuring(): void {
		if (this.latency.measuring === this.announced) return;
		this.announced = this.latency.measuring;
		this.awareness.setLocalStateField(MEASURE_FIELD, this.announced || null);
	}

	private someoneMeasures(): boolean {
		for (const [clientId, state] of this.awareness.getStates()) {
			if (clientId !== this.awareness.clientID && state[MEASURE_FIELD]) return true;
		}
		return false;
	}

	private takeEchoes(): void {
		if (!this.latency.measuring) return;
		for (const [clientId, state] of this.awareness.getStates()) {
			if (clientId === this.awareness.clientID) continue;
			const seen = state[SEEN_FIELD] as Seen | null | undefined;
			if (seen && Array.isArray(seen.keys)) this.latency.echoed(seen);
		}
	}

	private remember(raw: string): Element | null {
		let element: Element;
		try {
			element = JSON.parse(raw) as Element;
		} catch {
			return null;
		}
		this.held.set(element.id, element);
		return element;
	}

	/**
	 * Remote elements into the view, each only where it beats what the view
	 * has. False when the view holds one that beats what arrived.
	 */
	private show(arrived: Element[]): boolean {
		if (this.destroyed || arrived.length === 0) return true;
		const scene = this.api.getSceneElementsIncludingDeleted();
		const byId = new Map(scene.map((element) => [element.id, element]));
		let changed = false;
		let settled = true;
		for (const element of arrived) {
			const mine = byId.get(element.id);
			if (beats(element, mine)) {
				// The view's own copy, for the same reason: what the view later
				// changes in place must not change what the map is held to be.
				byId.set(element.id, { ...element });
				changed = true;
			} else if (mine && beats(mine, element)) {
				settled = false;
			}
		}
		if (changed) {
			this.api.updateScene({ elements: [...byId.values()].sort(byIndex), captureUpdate: "NEVER" });
		}
		return settled;
	}

	/** Everybody else in this drawing, as Excalidraw draws a collaborator. */
	private showPointers(): void {
		if (this.destroyed) return;
		const collaborators = new Map<string, unknown>();
		for (const [clientId, state] of this.awareness.getStates()) {
			if (clientId === this.awareness.clientID) continue;
			const pointer = state[POINTER_FIELD] as Pointer | null | undefined;
			const user = state[USER_FIELD] as CursorUser | undefined;
			if (!pointer || !user) continue;
			collaborators.set(String(clientId), {
				username: user.name,
				pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool },
				button: pointer.button,
				color: { background: user.color, stroke: user.color },
			});
		}
		this.api.updateScene({ collaborators });
	}
}
