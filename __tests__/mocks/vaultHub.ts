/**
 * A cloud vault with several devices on it, in memory: real Yjs documents,
 * a file store per device that fires events for every write the way
 * Obsidian's vault does, and a hub that relays updates the way the server
 * does. Shared by the binding's own suite and the multi-device scenarios.
 * It lives under `mocks/` because jest runs every other file under
 * `__tests__` as a suite, and this one makes no claims.
 */

import * as Y from "yjs";

import { generateHash } from "../../src/hashing";
import { TreeDoc } from "../../src/knap/TreeDoc";
import { FileEvent, FileStore, SeenTree, VaultBinding, VaultDocs } from "../../src/knap/VaultBinding";

export class MemoryFiles implements FileStore {
	map = new Map<string, string>();
	listeners: ((event: FileEvent) => void)[] = [];
	writes = 0;

	async read(path: string): Promise<string | null> {
		return this.map.has(path) ? (this.map.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		const existed = this.map.has(path);
		this.map.set(path, text);
		this.writes++;
		this.emit({ type: existed ? "modify" : "create", path });
	}
	async remove(path: string): Promise<void> {
		this.map.delete(path);
		this.emit({ type: "delete", path });
	}
	async rename(from: string, to: string): Promise<void> {
		const text = this.map.get(from) ?? "";
		this.map.delete(from);
		this.map.set(to, text);
		this.emit({ type: "rename", path: to, oldPath: from });
	}
	async readBinary(): Promise<ArrayBuffer | null> {
		// The note half of the store. AttachmentBinding.test.ts has the
		// store that carries bytes.
		return null;
	}
	async writeBinary(): Promise<void> {
		throw new Error("This store holds notes.");
	}
	async listNotes(): Promise<string[]> {
		return [...this.map.keys()].filter((p) => p.endsWith(".md"));
	}
	async listAttachments(): Promise<string[]> {
		return [...this.map.keys()].filter((p) => !p.endsWith(".md"));
	}
	onChange(callback: (event: FileEvent) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== callback);
		};
	}
	emit(event: FileEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

/** The tree this device last agreed with, surviving a restart in memory. */
export class MemorySeen implements SeenTree {
	entries: Map<string, string> | null = null;
	bases: Map<string, string> | null = null;

	async load(): Promise<Map<string, string>> {
		return new Map(this.entries ?? []);
	}
	async loadBases(): Promise<Map<string, string>> {
		return new Map(this.bases ?? []);
	}
	async save(entries: Map<string, string>, bases: Map<string, string>): Promise<void> {
		this.entries = new Map(entries);
		this.bases = new Map(bases);
	}
	async forget(): Promise<void> {
		this.entries = null;
		this.bases = null;
	}
}

/** Relays updates between per-device docs, the way the server would. */
export class Hub {
	private byId = new Map<string, Y.Doc[]>();

	/**
	 * How long the tree takes to arrive after its socket opens. Zero is the
	 * shape every test had before: the document is full the instant it is
	 * opened, which no websocket has ever managed. Set it and a device starts
	 * on an empty tree, which is what a real one does.
	 */
	treeDelay = 0;

	/** Which documents any device borrowed, by id. */
	borrowed = new Set<string>();

	/**
	 * Documents whose socket refuses to come up, by id. A fill that dies
	 * halfway is the ordinary case on a phone, and this is how a test says so.
	 */
	broken = new Set<string>();

	/**
	 * Deliveries held back while the network is split, in the order they
	 * would have happened. Every relay goes through `deliver`, so a split
	 * holds all of them, a first fill included.
	 */
	private held: (() => void)[] | null = null;

	/**
	 * Stop relaying. Every device keeps working on its own copies, which is
	 * the moment two people save at once: each has written before seeing the
	 * other. `heal` delivers everything that was held, in order.
	 */
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

	/**
	 * What the server's markdown mirror does after every flush: a sha256 per
	 * note, in the tree's third map, keyed by document id.
	 */
	async mirror(): Promise<void> {
		const tree = this.byId.get("tree")?.[0];
		if (!tree) return;
		const hashes = tree.getMap<string>("hashes");
		for (const docId of tree.getMap<string>("files").values()) {
			const doc = this.byId.get(docId)?.[0];
			if (!doc) continue;
			const text = doc.getText("content").toString();
			hashes.set(docId, await generateHash(new TextEncoder().encode(text)));
		}
	}

	/** The tree as the server holds it. */
	treeOf(): Y.Map<string> {
		const peers = this.byId.get("tree") ?? [];
		return (peers[0] ?? new Y.Doc()).getMap<string>("files");
	}

	/** Every document that has ever been opened, minus the tree. */
	documentCount(): number {
		return [...this.byId.keys()].filter((id) => id !== "tree").length;
	}

	/** Point a path at a different document, with the given text in it. */
	repoint(path: string, docId: string, text: string): void {
		const doc = new Y.Doc();
		doc.getText("content").insert(0, text);
		const peers = this.byId.get(docId) ?? [];
		peers.push(doc);
		this.byId.set(docId, peers);
		this.treeOf().set(path, docId);
	}

	device(): VaultDocs {
		const mine = new Map<string, { doc: Y.Doc; synced: Promise<void> }>();
		let tree: TreeDoc | null = null;
		const open = (docId: string) => {
			let entry = mine.get(docId);
			if (!entry) {
				const doc = new Y.Doc();
				const peers = this.byId.get(docId) ?? [];
				const late = docId === "tree" && this.treeDelay > 0;
				const fill = () =>
					this.deliver(() => {
						for (const peer of peers) {
							if (peer === doc) continue;
							Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
							Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
						}
					});
				const relay = (source: Y.Doc, targets: () => Y.Doc[]) => {
					source.on("update", (update: Uint8Array, origin: unknown) => {
						if (origin === "hub") return;
						this.deliver(() => {
							for (const target of targets()) {
								if (target !== source) Y.applyUpdate(target, update, "hub");
							}
						});
					});
				};
				peers.push(doc);
				this.byId.set(docId, peers);
				relay(doc, () => this.byId.get(docId) ?? []);
				let synced = Promise.resolve();
				if (late) {
					synced = new Promise<void>((resolve) =>
						setTimeout(() => {
							fill();
							resolve();
						}, this.treeDelay),
					);
				} else {
					fill();
				}
				entry = { doc, synced };
				mine.set(docId, entry);
			}
			return entry;
		};
		// The real client hands a note's document out for the length of one
		// piece of work and closes the socket again (KnapVaultClient's pool).
		// This hub lends the same way, synced first, but keeps the documents:
		// what a device does with a note it has finished with is the pool's
		// business, and every rule in this file is about what the binding
		// does while it has one.
		return {
			tree: () => (tree ??= new TreeDoc(open("tree").doc)),
			treeSynced: () => open("tree").synced,
			withNote: async <T,>(docId: string, use: (note: { doc: Y.Doc }) => Promise<T>) => {
				if (this.broken.has(docId)) throw new Error("This note did not sync in time.");
				this.borrowed.add(docId);
				const entry = open(docId);
				await entry.synced;
				return use({ doc: entry.doc });
			},
			onNoteClosed: () => () => undefined,
		};
	}
}

/**
 * A device linking to the hub's vault. `label` is what its conflict copies
 * are named after; the real one is `<person> conflict <date>`.
 */
export async function device(
	hub: Hub,
	seed: Record<string, string> = {},
	seen: SeenTree | null = null,
	label = "conflict",
) {
	const files = new MemoryFiles();
	for (const [path, text] of Object.entries(seed)) files.map.set(path, text);
	const binding = new VaultBinding(files, hub.device(), () => label, seen);
	await binding.start();
	return { files, binding };
}

/**
 * The same device, started again: the same disk, the same record, and fresh
 * documents, because a restart is exactly a set of sockets opening again.
 */
export async function restart(
	hub: Hub,
	files: MemoryFiles,
	seen: SeenTree | null = null,
	label = "conflict",
) {
	const binding = new VaultBinding(files, hub.device(), () => label, seen);
	await binding.start();
	return binding;
}

export const settle = async (...bindings: VaultBinding[]) => {
	// Event chains hop between queues, so settle twice around a microtask turn.
	for (let round = 0; round < 3; round++) {
		for (const binding of bindings) await binding.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};
