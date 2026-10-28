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

/** The awareness field holding a pointer on the canvas. */
export const POINTER_FIELD = "pointer";

/** How often local strokes go out, at most. A drag is a change per frame. */
export const SEND_EVERY_MS = 100;

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
	onPointerUpdate(
		callback: (payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }) => void,
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
	private readonly stops: (() => void)[] = [];
	private pending = false;
	private timer: number | null = null;
	private destroyed = false;

	constructor(
		private readonly api: ExcalidrawLike,
		private readonly doc: Y.Doc,
		private readonly awareness: Awareness,
		private readonly who: string,
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
			// An element the view holds that beats what arrived goes back.
			if (!this.show(arrived)) this.schedule();
		};
		this.map.observe(onMap);
		this.stops.push(() => this.map.unobserve(onMap));

		this.stops.push(this.api.onChange(() => this.schedule()));
		this.stops.push(
			this.api.onPointerUpdate(({ pointer, button }) => {
				this.awareness.setLocalStateField(POINTER_FIELD, {
					x: pointer.x,
					y: pointer.y,
					tool: pointer.tool,
					button,
				} satisfies Pointer);
			}),
		);
		const onAwareness = () => this.showPointers();
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
		this.doc.transact(() => {
			for (const element of changed) {
				this.map.set(element.id, JSON.stringify(element));
				this.held.set(element.id, element);
			}
		}, this);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.send();
		this.destroyed = true;
		if (this.timer) window.clearTimeout(this.timer);
		for (const stop of this.stops) stop();
		this.awareness.setLocalStateField(POINTER_FIELD, null);
	}

	private schedule(): void {
		if (this.pending || this.destroyed) return;
		this.pending = true;
		this.timer = window.setTimeout(() => this.send(), SEND_EVERY_MS);
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
				byId.set(element.id, element);
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
