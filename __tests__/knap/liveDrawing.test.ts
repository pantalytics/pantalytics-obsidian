/**
 * Two open Excalidraw views on one drawing, bound live (ADR-0109, step 2).
 *
 * The views are fakes shaped like the slice of Excalidraw's API the binding
 * uses; the documents and the awareness are real Yjs, relayed the way the
 * server relays them, and `split` holds the relay back so two people can
 * change one element before either has seen the other.
 */

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";

import { type Element, beats } from "../../src/knap/drawing";
import { LiveDrawing, type ExcalidrawLike } from "../../src/knap/LiveDrawing";

class FakeExcalidraw implements ExcalidrawLike {
	elements: Element[] = [];
	collaborators = new Map<string, unknown>();
	updates = 0;
	private changes: ((elements: readonly Element[]) => void)[] = [];
	private pointers: ((payload: {
		pointer: { x: number; y: number; tool: "pointer" | "laser" };
		button: "up" | "down";
	}) => void)[] = [];

	getSceneElementsIncludingDeleted(): readonly Element[] {
		return this.elements;
	}

	updateScene(scene: { elements?: readonly Element[]; collaborators?: Map<string, unknown> }): void {
		if (scene.collaborators) this.collaborators = scene.collaborators;
		if (scene.elements) {
			this.updates += 1;
			this.elements = [...scene.elements];
			// Excalidraw fires onChange for a scene put in from outside too
			// (measured), which is the echo the binding has to ignore.
			for (const change of this.changes) change(this.elements);
		}
	}

	onChange(callback: (elements: readonly Element[]) => void): () => void {
		this.changes.push(callback);
		return () => (this.changes = this.changes.filter((c) => c !== callback));
	}

	onPointerUpdate(callback: (typeof this.pointers)[number]): () => void {
		this.pointers.push(callback);
		return () => (this.pointers = this.pointers.filter((c) => c !== callback));
	}

	/** A person drawing: the scene changes and Excalidraw says so. */
	draw(elements: Element[]): void {
		this.elements = elements;
		for (const change of this.changes) change(this.elements);
	}

	point(x: number, y: number): void {
		for (const pointer of this.pointers) pointer({ pointer: { x, y, tool: "pointer" }, button: "up" });
	}
}

/** Two documents and two awarenesses, relayed like the server, or held back. */
class Relay {
	held: (() => void)[] | null = null;
	readonly docs = [new Y.Doc(), new Y.Doc()];
	readonly awareness = this.docs.map((doc) => new Awareness(doc));

	constructor() {
		for (const [i, doc] of this.docs.entries()) {
			const other = this.docs[1 - i];
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin === "relay") return;
				this.deliver(() => Y.applyUpdate(other, update, "relay"));
			});
			const mine = this.awareness[i];
			const theirs = this.awareness[1 - i];
			mine.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
				if (origin === "relay") return;
				const changed = [...added, ...updated, ...removed];
				this.deliver(() => applyAwarenessUpdate(theirs, encodeAwarenessUpdate(mine, changed), "relay"));
			});
		}
	}

	split(): void {
		this.held ??= [];
	}

	heal(): void {
		const held = this.held ?? [];
		this.held = null;
		for (const delivery of held) delivery();
	}

	private deliver(delivery: () => void): void {
		if (this.held) this.held.push(delivery);
		else delivery();
	}
}

let nonce = 1;
const rect = (id: string, index: string, x = 0): Element => ({
	id,
	type: "rectangle",
	x,
	y: 0,
	index,
	version: 1,
	versionNonce: nonce++,
	isDeleted: false,
});
const moved = (e: Element, x: number): Element => ({ ...e, x, version: e.version + 1, versionNonce: nonce++ });

function twoViews() {
	const relay = new Relay();
	const views = [new FakeExcalidraw(), new FakeExcalidraw()];
	const live = [
		new LiveDrawing(views[0], relay.docs[0], relay.awareness[0], "rutger"),
		new LiveDrawing(views[1], relay.docs[1], relay.awareness[1], "daniel"),
	];
	return { relay, views, live };
}

describe("a drawing open on two screens", () => {
	it("shows one person's stroke on the other screen", () => {
		const { views, live } = twoViews();
		views[0].draw([rect("a", "a0")]);
		live[0].send();
		expect(views[1].elements.map((e) => e.id)).toEqual(["a"]);
	});

	it("does not send back what it was just shown", () => {
		const { relay, views, live } = twoViews();
		views[0].draw([rect("a", "a0")]);
		live[0].send();
		const before = Y.encodeStateVector(relay.docs[0]).toString();
		live[1].send();
		expect(Y.encodeStateVector(relay.docs[0]).toString()).toBe(before);
	});

	it("keeps the other person's stroke when both draw at once", () => {
		const { relay, views, live } = twoViews();
		const a = rect("a", "a0");
		views[0].draw([a]);
		live[0].send();

		relay.split();
		views[0].draw([moved(a, 300)]);
		live[0].send();
		views[1].draw([...views[1].elements, rect("b", "a1")]);
		live[1].send();
		relay.heal();

		for (const view of views) {
			const byId = new Map(view.elements.map((e) => [e.id, e]));
			expect(byId.get("a")?.x).toBe(300);
			expect(byId.has("b")).toBe(true);
		}
	});

	it("ends both screens on the element Excalidraw's rule picks when both drag it", () => {
		const { relay, views, live } = twoViews();
		const a = rect("a", "a0");
		views[0].draw([a]);
		live[0].send();

		const one = moved(a, 300);
		const two = moved(a, -50);
		relay.split();
		views[0].draw([one]);
		live[0].send();
		views[1].draw([two]);
		live[1].send();
		relay.heal();
		// The screen holding the winner puts it back on its next send.
		live[0].send();
		live[1].send();

		const winner = beats(one, two) ? one : two;
		expect(views[0].elements).toEqual([winner]);
		expect(views[1].elements).toEqual([winner]);
		expect(JSON.parse(relay.docs[0].getMap<string>("drawing").get("a") as string)).toEqual(winner);
	});

	it("shows the other person's pointer with their name", () => {
		const { views } = twoViews();
		views[0].point(120, 80);
		const [collaborator] = [...views[1].collaborators.values()] as {
			username: string;
			pointer: { x: number; y: number };
		}[];
		expect(collaborator.username).toBe("rutger");
		expect(collaborator.pointer).toMatchObject({ x: 120, y: 80 });
		expect(views[0].collaborators.size).toBe(0);
	});

	it("takes the pointer away when the drawing closes", () => {
		const { views, live } = twoViews();
		views[0].point(120, 80);
		live[0].destroy();
		expect(views[1].collaborators.size).toBe(0);
	});
});
