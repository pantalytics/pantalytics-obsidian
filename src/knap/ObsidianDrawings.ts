/**
 * Which Excalidraw drawings are open, and a LiveDrawing for each (ADR-0109).
 *
 * The Excalidraw plugin is somebody else's, so nothing here imports it: a
 * view counts as a drawing when Obsidian calls it "excalidraw" and it carries
 * an `excalidrawAPI`, which is what obsidian-excalidraw-plugin 2.29.0 does
 * (measured in odoo-mcp-pro-admin's scripts/vault/spikes/excalidraw). A
 * build of it without that API is a drawing that syncs on save, as before.
 *
 * Views come and go without telling anybody, and the API only exists once a
 * drawing has finished loading, so the open views are compared against the
 * bound ones on every layout change and once a second besides.
 */

import type { Plugin, WorkspaceLeaf } from "obsidian";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import type { Element } from "./drawing";
import { isDrawing } from "./drawing";
import { LiveDrawing, type ExcalidrawLike } from "./LiveDrawing";

/** What `KnapSync.openDrawing` hands a view: the document, held open. */
export interface LiveDrawingHandle {
	doc: Y.Doc;
	awareness: Awareness;
	who: string;
	release: () => void;
}

export interface DrawingSource {
	openDrawing(path: string): LiveDrawingHandle | null;
}

/** The parts of Excalidraw's own API this reads, as the plugin exposes them. */
interface ExcalidrawApi {
	getSceneElementsIncludingDeleted(): readonly Element[];
	updateScene: ExcalidrawLike["updateScene"];
	onChange(callback: (elements: readonly Element[]) => void): () => void;
	getAppState(): {
		scrollX: number;
		scrollY: number;
		zoom: { value: number };
		offsetLeft: number;
		offsetTop: number;
	};
}

interface ExcalidrawViewLike {
	file?: { path: string } | null;
	excalidrawAPI?: ExcalidrawApi | null;
	contentEl: HTMLElement;
}

interface Bound {
	path: string;
	api: ExcalidrawApi;
	live: LiveDrawing;
	handle: LiveDrawingHandle;
}

/**
 * Excalidraw's API has no pointer stream of its own (2.29.0 has pointer
 * down and up, not move), so the pointer is read off the view's own element
 * and turned into scene coordinates the way Excalidraw does it.
 */
export function adapt(api: ExcalidrawApi, element: HTMLElement): ExcalidrawLike {
	return {
		getSceneElementsIncludingDeleted: () => api.getSceneElementsIncludingDeleted(),
		updateScene: (scene) => api.updateScene(scene),
		onChange: (callback) => api.onChange(callback),
		onPointerUpdate: (callback) => {
			let button: "up" | "down" = "up";
			const move = (event: PointerEvent) => {
				const state = api.getAppState();
				const zoom = state.zoom.value || 1;
				callback({
					pointer: {
						x: (event.clientX - state.offsetLeft) / zoom - state.scrollX,
						y: (event.clientY - state.offsetTop) / zoom - state.scrollY,
						tool: "pointer",
					},
					button,
				});
			};
			const down = () => (button = "down");
			const up = () => (button = "up");
			element.addEventListener("pointermove", move);
			element.addEventListener("pointerdown", down);
			element.addEventListener("pointerup", up);
			return () => {
				element.removeEventListener("pointermove", move);
				element.removeEventListener("pointerdown", down);
				element.removeEventListener("pointerup", up);
			};
		},
	};
}

export function followDrawings(host: Plugin, source: DrawingSource): void {
	const bound = new Map<WorkspaceLeaf, Bound>();

	const unbind = (leaf: WorkspaceLeaf) => {
		const entry = bound.get(leaf);
		if (!entry) return;
		bound.delete(leaf);
		entry.live.destroy();
		entry.handle.release();
	};

	const check = () => {
		const open = new Set(host.app.workspace.getLeavesOfType("excalidraw"));
		for (const leaf of [...bound.keys()]) if (!open.has(leaf)) unbind(leaf);
		for (const leaf of open) {
			const view = leaf.view as unknown as ExcalidrawViewLike;
			const path = view.file?.path;
			const api = view.excalidrawAPI;
			const entry = bound.get(leaf);
			if (entry && entry.path === path && entry.api === api) continue;
			unbind(leaf);
			if (!path || !api || !isDrawing(path)) continue;
			// Null until the note is in the cloud vault and synced; the next
			// check asks again.
			const handle = source.openDrawing(path);
			if (!handle) continue;
			const live = new LiveDrawing(adapt(api, view.contentEl), handle.doc, handle.awareness, handle.who);
			bound.set(leaf, { path, api, live, handle });
		}
	};

	host.registerEvent(host.app.workspace.on("layout-change", check));
	host.registerEvent(host.app.workspace.on("file-open", check));
	host.registerInterval(window.setInterval(check, 1000));
	host.register(() => {
		for (const leaf of [...bound.keys()]) unbind(leaf);
	});
}
