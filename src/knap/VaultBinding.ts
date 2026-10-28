/**
 * The binding: local files on one side, live documents on the other.
 *
 * This is the engine of phase 2, and it is deliberately blind to both ends.
 * Files come through a `FileStore` (Obsidian in production, memory in
 * tests), documents through a `VaultDocs` (a `KnapVaultClient` in
 * production, linked in-memory docs in tests), so every rule in here runs
 * under jest and the same code ships.
 *
 * The rules, and there are few:
 *
 * - A local edit becomes a minimal splice on the note's Text: common prefix
 *   and suffix stay untouched, so concurrent edits elsewhere in the note
 *   merge instead of being steamrolled. Never a replacement (ADR-0010).
 * - A remote edit becomes a file write, and a tree change becomes a create,
 *   a rename or a removal on disk.
 * - Both directions are idempotent instead of bookkept: an event that finds
 *   file and document already equal does nothing, which is what breaks
 *   every echo loop without a ledger of "writes that were ours".
 * - A note that differs on the two sides is settled three ways, against the
 *   text this device last agreed with (its base). Only the file moved: it is
 *   spliced into the document. Only the document moved: it is written to the
 *   file. Both moved, or no base: the cloud text keeps the path and the local
 *   text survives beside it as a conflict copy. A file is never diffed
 *   against a document it never held, because that diff deletes everything
 *   the file does not have (issue #169). Nothing is ever silently lost.
 * - A note's document is borrowed and handed back, never held. Only the tree
 *   and the notes an editor has open keep a socket of their own, and every
 *   other note takes its turn in a small pool, because a browser has 255
 *   sockets and a vault has thousands of notes (issue #115). The cost is
 *   real and worth writing down: a note nobody has open here stops hearing
 *   somebody else's edit the moment it arrives, and catches up the next time
 *   this binding reconciles or the next time anything touches that note.
 * - A note deleted here is deleted in the cloud vault, and the other way
 *   round, whether or not the plugin was running when it happened. That is
 *   what the `SeenTree` is for: without a record of what this device last
 *   agreed with, a missing file and a note that never arrived look the
 *   same, and every restart undid both sides\' deletes.
 */

import * as Y from "yjs";

import { buildConflictCopyPath } from "../conflictCopyPath";
import { generateHash } from "../hashing";
import { knapFault } from "./faultSink";
import { TREE_SYNC_FAILED, TREE_SYNC_TIMEOUT_MS, withTimeout } from "./deadline";
import { TreeDoc, isNote, normalize } from "./TreeDoc";
import {
	ELEMENTS,
	canonical,
	ingestDrawing,
	isDrawing,
	parseDrawing,
	renderDocument,
	textOfDocument,
} from "./drawing";

export interface FileEvent {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
}

/**
 * What the two bindings need from a vault's files. Obsidian adapts to this.
 *
 * Text and bytes are separate methods rather than one that guesses, because
 * the two callers are separate engines: `VaultBinding` reads a note as a
 * string it can splice, `AttachmentBinding` reads a PNG as bytes it can
 * hash. `onChange` reports every file, notes and attachments alike, and each
 * binding ignores the half that is not its own.
 */
export interface FileStore {
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer | null>;
	writeBinary(path: string, content: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	listNotes(): Promise<string[]>;
	/** Every file in the vault that is not a note. */
	listAttachments(): Promise<string[]>;
	onChange(callback: (event: FileEvent) => void): () => void;
}

/** One note's document, for as long as somebody is holding it. */
export interface NoteDoc {
	doc: Y.Doc;
}

/** What the binding needs from the wire. KnapVaultClient satisfies it. */
export interface VaultDocs {
	tree(): TreeDoc;
	/**
	 * Resolves once the tree has had its first sync with the server.
	 *
	 * Opening the tree's socket hands back a document immediately, and for a
	 * moment that document is empty. Reconciling against it is how a note
	 * that already exists in the cloud gets a second document minted for it.
	 */
	treeSynced(): Promise<void>;
	/**
	 * Borrow one note's document for the length of `use`.
	 *
	 * A borrow rather than a getter, because a note's socket is not this
	 * binding's to keep: there are 255 of them per Obsidian and thousands of
	 * notes in a vault (issue #115). What the caller is promised is a
	 * document that has synced before `use` runs and a socket that stays up
	 * until everything `use` wrote has left the process. Whoever hands one
	 * over decides when it closes after that.
	 */
	withNote<T>(docId: string, use: (note: NoteDoc) => Promise<T>): Promise<T>;
	/**
	 * Told when a note's document goes down, so this binding can stop
	 * watching a document that will never change again.
	 */
	onNoteClosed(callback: (docId: string) => void): () => void;
}

/**
 * What this device last agreed with: path -> document id, as the tree read
 * the moment the binding had finished applying it to the disk.
 *
 * It is the base of a three-way comparison, and it is the only thing that
 * can tell a note somebody deleted here from a note that has not arrived
 * yet. A device that has none behaves the way linking always has: nothing
 * is deleted on either side, both sides merge.
 *
 * Per cloud vault, and local to the device. `forget` is what unlink and
 * sign out call, so a later relink starts from no memory and keeps their
 * promise that nothing is deleted anywhere.
 */
export interface SeenTree {
	load(): Promise<Map<string, string>>;
	/**
	 * Document id -> sha256 of the text this device last agreed with for that
	 * note: the base of the three-way comparison in `converge`. A note with no
	 * base is one this device cannot vouch for, and that never splices.
	 */
	loadBases(): Promise<Map<string, string>>;
	save(entries: Map<string, string>, bases: Map<string, string>): Promise<void>;
	forget(): Promise<void>;
}

/**
 * Notes still to move, by direction, with edits deliberately absent.
 *
 * Three things move notes and only two of them can be counted (ADR-0088).
 * `up` is notes this device holds that the cloud vault has not got yet, `down`
 * is notes the cloud vault lists that have no file here. They are disjoint
 * sets, which is what makes them addable: a note is missing from one side or
 * the other, never both.
 *
 * An edit to a note both sides already have is the third thing, and it is not
 * in here. It has no denominator, it is over in under a second, and a number
 * beside the icon that goes 1, 0, 1, 0 while somebody types is what makes the
 * corner of the window unreadable.
 */
export interface Backlog {
	up: number;
	down: number;
}

/**
 * How far the pass at start has got: pieces of work finished, of the pieces
 * it found. Zero and zero before the tree has been read, equal once it is
 * through.
 */
export interface Pass {
	done: number;
	total: number;
}

const CONTENT = "content";

/**
 * How many notes a fill works on at once.
 *
 * One at a time is one round trip at a time, and a vault of a few thousand
 * notes would still be arriving tomorrow. This is a queue width and not a
 * socket count: how many sockets exist is the client's business, and it caps
 * them at the same number, so a note that finds the pool full waits for a
 * turn instead of opening the 256th socket Chromium never answers.
 */
const FILL_WIDTH = 8;

/** How long a drawing's document has to be quiet before its file follows. */
export const DRAWING_WRITE_DELAY_MS = 1000;

/** Y.Text implements toString; the lint rule cannot see that through AbstractType. */
function textOf(content: Y.Text): string {
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text has a real toString
	return content.toString();
}

/**
 * The note as a file: its Text, or for a drawing the file the Text and the
 * element map stand for together (ADR-0109).
 */
function noteText(doc: Y.Doc, path: string): string {
	return isDrawing(path) ? renderDocument(doc) : textOf(doc.getText(CONTENT));
}

/** The same sha256 the server's mirror writes into the tree. */
function hashOf(text: string): Promise<string> {
	return generateHash(new TextEncoder().encode(text));
}

export class VaultBinding {
	private stopFileEvents: (() => void) | null = null;
	private stopTreeEvents: (() => void) | null = null;
	private stopNoteCloses: (() => void) | null = null;
	private noteObservers = new Map<string, () => void>();
	/** A drawing's file write waiting for its document to go quiet, by id. */
	private drawingWrites = new Map<string, number>();
	private queue: Promise<void> = Promise.resolve();
	private failures = 0;
	/** Work taken on and not finished, by direction. Never edits. */
	private outstanding = { up: 0, down: 0 };
	/** The pass at start, counted as it goes. */
	private pass: Pass = { done: 0, total: 0 };
	/** Paths an open editor is holding, which this binding leaves alone. */
	private held = new Set<string>();
	/** Set whenever this device changed the tree, cleared when it is saved. */
	private seenDirty = false;
	/**
	 * Per document id, the sha256 of the text file and document last held
	 * together on this device. Kept for the life of the binding and written
	 * down beside the tree, so a restart still knows which side moved.
	 */
	private bases = new Map<string, string>();
	/** Set whenever a base changed, cleared when it is saved. */
	private basesDirty = false;
	/**
	 * Documents this device made for a note of its own since it started.
	 * When two devices make a note at one path at once, the tree keeps one
	 * document there, and only the device whose document lost owes the
	 * world a copy of it. Every other device was only ever holding it.
	 */
	private minted = new Set<string>();

	constructor(
		private readonly files: FileStore,
		private readonly docs: VaultDocs,
		private readonly conflictLabel = () => `conflict ${new Date().toISOString().slice(0, 10)}`,
		private readonly seen: SeenTree | null = null,
		private readonly drawingWriteDelayMs = DRAWING_WRITE_DELAY_MS,
	) {}

	/**
	 * Link: reconcile both sides once, then follow both event streams.
	 * Everything runs through one queue, so a burst of events cannot
	 * interleave two half-finished reconciliations.
	 */
	async start(): Promise<void> {
		// Before anything opens a document: a note whose socket the client
		// closed is a note this binding may not go on watching, and the entry
		// has to go too, or the next borrow of that note finds itself already
		// watched and nothing observes the document that replaced it.
		this.stopNoteCloses = this.docs.onNoteClosed((docId) => this.unobserveNote(docId));
		await this.enqueue(() => this.reconcileAll());
		this.stopFileEvents = this.files.onChange((event) => {
			// The store reports both kinds, and each binding takes its own.
			// A delete is the exception and may not be filtered on the path:
			// deleting a folder names the folder, not the notes in it, so a
			// filter that let only `.md` through would drop the one event
			// that takes those notes out of the tree.
			if (!isNote(event.path) && event.type !== "delete") return;
			void this.enqueue(() => this.onFileEvent(event));
		});
		this.stopTreeEvents = this.docs.tree().onChange((change) => {
			void this.enqueue(async () => {
				this.seenDirty = true;
				for (const [path, docId] of change.added) {
					// A document this binding already watches is the echo of
					// its own push coming back through the tree, not a note
					// arriving from somewhere else, and putting it on the
					// down gauge would count every upload twice.
					// A path in both halves is the same name pointed at another
					// document, which is how two notes made at one path at
					// once settle.
					const previous = change.removed.get(path);
					if (this.noteObservers.has(docId)) {
						await this.bindNote(path, docId, previous);
					} else {
						await this.carry("down", () => this.bindNote(path, docId, previous));
					}
				}
				for (const [path, docId] of change.removed) {
					// A move announces itself as removed+added under one id, and
					// the added half above already wrote the new file, so the old
					// path goes either way. Only a note that left the tree for
					// good stops being watched.
					//
					// A path in both halves is not a departure: it is the same
					// note pointed at a different document. Removing the file
					// there deletes a note nobody deleted, and the delete event
					// that follows takes the path out of the tree on every
					// device. Measured on production 2026-08-31.
					if (!change.added.has(path)) {
						await this.files.remove(path);
					}
					if (this.docs.tree().pathFor(docId) === undefined) {
						this.unobserveNote(docId);
					}
				}
			});
		});
	}

	stop(): void {
		this.stopFileEvents?.();
		this.stopTreeEvents?.();
		this.stopNoteCloses?.();
		for (const stop of this.noteObservers.values()) stop();
		this.noteObservers.clear();
		for (const timer of this.drawingWrites.values()) window.clearTimeout(timer);
		this.drawingWrites.clear();
	}

	/** Wait for everything queued so far; tests and shutdown use it. */
	flush(): Promise<void> {
		return this.enqueue(async () => undefined);
	}

	/**
	 * How many pieces of work failed since this binding started.
	 *
	 * The status bar needs to be able to say *Problem*, and the only place
	 * that knows a push or a bind went wrong is the queue every one of them
	 * runs through. Counting here rather than at each call site means a new
	 * kind of work is counted the day it is added, without anybody
	 * remembering to.
	 */
	get problems(): number {
		return this.failures;
	}

	/**
	 * Notes still to move, by direction.
	 *
	 * Counted where the work is decided rather than where it runs: a fill
	 * works eight notes at a time, so a gauge that went up as each one started
	 * would say eight over a vault of three thousand. What is wanted is how
	 * many are still to come, so the whole set is counted the moment it is
	 * known and each note takes itself off as it lands.
	 */
	get backlog(): Backlog {
		return { ...this.outstanding };
	}

	/**
	 * How far the pass at start has got.
	 *
	 * The two gauges above count what moves, and on a restart over a vault
	 * that is already here nothing moves: every note is opened, compared and
	 * closed again, which on a few thousand notes is minutes of work with
	 * both gauges at zero. The screen said Syncing over that with no number
	 * beside it, and a person watching had no way to tell a pass that was
	 * going from one that was stuck. This counts every piece of the pass,
	 * the compares included, so the screen can say how far along it is.
	 */
	get checked(): Pass {
		return { ...this.pass };
	}

	/** Run `work`, with this note on the gauge for as long as it takes. */
	private async carry<T>(kind: "up" | "down", work: () => Promise<T>): Promise<T> {
		this.outstanding[kind] += 1;
		try {
			return await work();
		} finally {
			this.outstanding[kind] -= 1;
		}
	}

	/**
	 * Keep following one note's document, so its file keeps up with it.
	 *
	 * A drawing open in the Excalidraw view is bound live (LiveDrawing), but
	 * the text around its scene still travels through the file, and a note
	 * that matched the cloud at start was never opened by this binding at
	 * all. The note is pinned by whoever calls this, so the observer stays
	 * until the pin goes.
	 */
	follow(path: string): Promise<void> {
		const clean = normalize(path);
		return this.enqueue(async () => {
			const docId = this.docs.tree().docIdFor(clean);
			if (!docId || this.noteObservers.has(docId)) return;
			await this.docs.withNote(docId, async ({ doc }) => this.observeNote(clean, docId, doc));
		});
	}

	/**
	 * Stand down for one note, because an editor is bound to it directly.
	 *
	 * Two writers on one note is one too many. While a note is open,
	 * `LiveNote` puts every keystroke into the document as it is typed and
	 * every remote change into the editor, and Obsidian saves the file the
	 * way it saves any file somebody is typing in. If this binding also
	 * wrote that file it would overwrite the editor's unsaved buffer, and if
	 * it also pushed the file's `modify` events it would splice a copy that
	 * is a save behind, which deletes whatever arrived in the meantime.
	 *
	 * Returns the release, which is also the catch-up: the file may be a
	 * couple of seconds behind the document when the editor lets go, and it
	 * is written from the document once here rather than waiting for the
	 * next change to that note.
	 */
	hold(path: string): () => void {
		const clean = normalize(path);
		this.held.add(clean);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.held.delete(clean);
			void this.enqueue(() => this.writeFromDocument(clean));
		};
	}

	private async writeFromDocument(path: string): Promise<void> {
		const tree = this.docs.tree();
		const docId = tree.docIdFor(path);
		if (!docId) return;
		await this.docs.withNote(docId, async ({ doc }) => {
			const at = tree.pathFor(docId) ?? path;
			const text = noteText(doc, at);
			if ((await this.readNote(at)) !== text) {
				await this.files.write(at, text);
			}
			await this.agree(docId, text);
		});
	}

	/**
	 * Record that file and document hold `text` together on this device.
	 *
	 * Called only at a moment where that is known, never guessed: after a
	 * write from the document, after a splice into it, and wherever the two
	 * were compared and found equal. A base that is older than it could be is
	 * safe, because it only ever sends a note down the conflict-copy route.
	 */
	private async agree(docId: string, text: string): Promise<void> {
		this.agreeHash(docId, await hashOf(text));
	}

	private agreeHash(docId: string, hash: string): void {
		if (this.bases.get(docId) === hash) return;
		this.bases.set(docId, hash);
		this.basesDirty = true;
	}

	/**
	 * A held note was saved by Obsidian. The editor already put every keystroke
	 * into the document, so there is nothing to push, but when the file and the
	 * document are equal that is a base worth keeping: without it, a restart
	 * after an evening of typing in an open note would find both sides moved.
	 */
	private async agreeIfSame(path: string): Promise<void> {
		const docId = this.docs.tree().docIdFor(path);
		if (!docId) return;
		await this.docs.withNote(docId, async ({ doc }) => {
			const text = noteText(doc, path);
			if ((await this.readNote(path)) === text) await this.agree(docId, text);
		});
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const counted = async () => {
			try {
				await work();
			} catch (error) {
				this.failures += 1;
				// Rethrown, not swallowed. The rejection is what keeps
				// rememberTree below off the failure path, and the queue's own
				// handler is what keeps one failure from stopping the next unit.
				throw error;
			}
		};
		// The record is written only where `work` returned: a unit that threw
		// half way leaves the disk and the tree disagreeing, and remembering
		// that as agreed is how the next start deletes what it failed to
		// write. Work still runs on both settle paths, so one failure does
		// not wedge the queue.
		this.queue = this.queue.then(counted, counted).then(() => this.rememberTree());
		return this.queue;
	}

	/**
	 * Write down the tree this device now agrees with. Failing is survivable.
	 *
	 * Agreed with means on this disk, and the two are not the same thing. This
	 * used to save the tree whole, so a device whose fill did not finish wrote
	 * down every path in it, the notes it had not managed to download
	 * included. `reconcileAll` reads that back as "the file is gone and the
	 * record says I had it", which is its sentence for a note somebody deleted
	 * while the plugin was off, and deletes it in the cloud vault and on every
	 * other device. Measured 2026-09-05: a phone whose first fill kept dying
	 * deleted the four newest notes in the vault, the ones made after it last
	 * got anywhere, off every device. They came back off an hourly backup.
	 *
	 * So the record is the tree narrowed to what is actually here. A path this
	 * device never fetched is simply not in it, and the next pass downloads it
	 * rather than deleting it, which is the safe direction and the true one.
	 */
	private async rememberTree(): Promise<void> {
		if ((!this.seenDirty && !this.basesDirty) || !this.seen) return;
		const treeWas = this.seenDirty;
		this.seenDirty = false;
		this.basesDirty = false;
		try {
			const onDisk = new Set((await this.files.listNotes()).map(normalize));
			const agreed = new Map<string, string>();
			const bases = new Map<string, string>();
			for (const [path, docId] of this.docs.tree().entries()) {
				if (!onDisk.has(path)) continue;
				agreed.set(path, docId);
				// Only notes that are here keep a base, so the record does
				// not grow with every note this vault ever held.
				const base = this.bases.get(docId);
				if (base !== undefined) bases.set(docId, base);
			}
			await this.seen.save(agreed, bases);
		} catch (error) {
			knapFault("tree", error);
			// A record that could not be written is a record that stays
			// older than it is, and older is the safe direction: every
			// deletion below needs the record to positively say so, and a
			// stale base only ever ends in a conflict copy.
			this.seenDirty = treeWas;
			this.basesDirty = true;
		}
	}

	// -- link time -----------------------------------------------------------

	private async reconcileAll(): Promise<void> {
		// Wait for the tree before deciding anything is missing from it.
		// Measured on production 2026-08-31: a device that reconciled against
		// an empty tree minted a fresh document for a path that already had
		// one, and the note ended up with two documents and no name.
		//
		// Bounded, because a socket that never syncs would otherwise leave
		// the Link button waiting with nothing on screen. Giving up here is
		// better than reconciling against a tree that never arrived: the
		// caller gets a sentence it can show, and the next start tries again.
		await withTimeout(
			this.docs.treeSynced(),
			TREE_SYNC_TIMEOUT_MS,
			TREE_SYNC_FAILED,
		);
		const tree = this.docs.tree();
		const local = new Set((await this.files.listNotes()).map(normalize));
		const remote = tree.entries();
		const seen = (await this.seen?.load()) ?? new Map<string, string>();
		for (const [docId, hash] of (await this.seen?.loadBases()) ?? new Map<string, string>()) {
			if (!this.bases.has(docId)) this.bases.set(docId, hash);
		}

		// A vault whose files have not been indexed yet reads exactly like a
		// vault somebody emptied, and only one of those two is worth acting
		// on. The plugin starts the binding after the layout is ready for
		// this reason; this is the second lock on the same door, because the
		// cost of being wrong here is every note in the cloud vault.
		const emptied = local.size === 0 && seen.size > 0;

		// The work is sorted before any of it runs, because the gauge the
		// corner of the window reads is how many notes are still to move, and
		// the waves below only ever know about eight at a time.
		const missingThere: string[] = [];
		let up: string[] = [];
		for (const path of local) {
			if (remote.has(path)) continue;
			// In the tree when this device last looked and not now: deleted or
			// renamed in the cloud vault while this device was away.
			(seen.has(path) ? missingThere : up).push(path);
		}
		const missingHere: [string, string][] = [];
		const bind: [string, string][] = [];
		for (const [path, docId] of remote) {
			if (!local.has(path) && !emptied && seen.get(path) === docId) {
				// The same note, at the same path, as this device last had
				// it on disk, and the file is gone: deleted or renamed here
				// while the plugin was not running. Without the record this
				// downloaded the note back, every time, on every device.
				missingHere.push([path, docId]);
				continue;
			}
			bind.push([path, docId]);
		}

		// A note that left the cloud vault's tree while this device was away.
		// Renamed there: the file follows it, and an edit made here meanwhile
		// is settled at the new name like any other. Deleted there: the
		// delete travels, unless this device wrote in the note since it last
		// agreed with the cloud. Then the note goes back up, because a delete
		// says nothing about words its author never saw.
		const gone: string[] = [];
		for (const path of missingThere) {
			const docId = seen.get(path) as string;
			const moved = tree.pathFor(docId);
			if (moved !== undefined && !local.has(moved)) {
				await this.files.rename(path, moved);
				local.delete(path);
				local.add(moved);
				continue;
			}
			if (await this.untouchedHere(path, docId)) gone.push(path);
			else up.push(path);
		}

		// A note that left this disk while the plugin was off. The same text
		// under a new name is a rename, and the tree follows it. Anything else
		// is a delete, and it travels, unless somebody wrote in the note in the
		// cloud since this device last agreed with it.
		const deletedHere: [string, string][] = [];
		if (missingHere.length > 0) {
			const upByHash = new Map<string, string | null>();
			for (const path of up) {
				const text = await this.readNote(path);
				if (text === null) continue;
				const hash = await hashOf(text);
				upByHash.set(hash, upByHash.has(hash) ? null : path);
			}
			for (const [path, docId] of missingHere) {
				const base = this.bases.get(docId);
				const renamed = base === undefined ? undefined : upByHash.get(base);
				if (renamed) {
					tree.move(path, renamed);
					this.seenDirty = true;
					up = up.filter((candidate) => candidate !== renamed);
					upByHash.set(base as string, null);
					bind.push([renamed, docId]);
					continue;
				}
				deletedHere.push([path, docId]);
			}
		}

		// A note the tree lists that is already on the disk is a bind, not a
		// download: it opens the document and writes nothing. Counting those
		// would put the whole vault on the gauge at every start.
		const down = new Set(bind.filter(([path]) => !local.has(path)).map(([path]) => path));
		this.outstanding.up += up.length;
		this.outstanding.down += down.size;
		// Everything the pass is about to do, counted before any of it runs,
		// so the first reading already says how much there is.
		this.pass = {
			done: 0,
			total: gone.length + deletedHere.length + up.length + bind.length,
		};

		// Each half runs several notes deep. The tree above is read first and
		// in full, so what each note does is its own business and the width
		// only decides how many are waiting for a socket at once.
		await this.inWaves(gone, (path) => this.files.remove(path));
		await this.inWaves(deletedHere, async ([path, docId]) => {
			if (await this.untouchedThere(path, docId)) {
				tree.remove(path);
				this.seenDirty = true;
			} else {
				await this.bindNote(path, docId);
			}
		});
		await this.inWaves(up, async (path) => {
			try {
				await this.pushNote(path);
			} finally {
				this.outstanding.up -= 1;
			}
		});
		await this.inWaves(bind, async ([path, docId]) => {
			try {
				if (await this.sameAsCloud(path, docId)) return;
				await this.bindNote(path, docId);
			} finally {
				if (down.has(path)) this.outstanding.down -= 1;
			}
		});
	}

	/**
	 * Whether the file on disk is the note as the server last mirrored it.
	 *
	 * The tree carries a hash per note, written by the server's mirror, and a
	 * file that hashes to the same thing needs no socket: nothing to fetch,
	 * nothing to push, and nothing to compare. This is what turns a restart
	 * over a vault that is already here from minutes of opening every note
	 * into seconds of reading every file. Measured before it: 2,505 notes,
	 * eight sockets at a time, about five minutes with nothing moving.
	 *
	 * Only ever answers yes on a match. A note the server has not hashed yet
	 * takes the long road, and so does one whose file cannot be read.
	 */
	private async sameAsCloud(path: string, docId: string): Promise<boolean> {
		const cloud = this.docs.tree().hashFor(docId);
		if (cloud === undefined) return false;
		const text = await this.readNote(path);
		if (text === null) return false;
		if ((await hashOf(text)) !== cloud) return false;
		// The file is a text the cloud held, so it is a base: whatever moves
		// on either side from here is a move from this.
		this.agreeHash(docId, cloud);
		return true;
	}

	/**
	 * Whether the file at `path` is still the text this device last agreed
	 * on for `docId`. No base is no answer, and no answer keeps the file.
	 */
	private async untouchedHere(path: string, docId: string): Promise<boolean> {
		const base = this.bases.get(docId);
		const text = await this.readNote(path);
		return base !== undefined && text !== null && (await hashOf(text)) === base;
	}

	/**
	 * Whether the cloud's text for `docId` is still the one this device last
	 * agreed on. Read off the document, never off the tree's hash: the
	 * mirror writes that a flush later, and a hash that still matches the
	 * base over an edit nobody has mirrored yet would delete that edit.
	 */
	private async untouchedThere(path: string, docId: string): Promise<boolean> {
		const base = this.bases.get(docId);
		if (base === undefined) return false;
		return this.docs.withNote(docId, async ({ doc }) => {
			return (await hashOf(noteText(doc, path))) === base;
		});
	}

	/**
	 * Run `work` over `items`, a few at a time, counting what fails instead
	 * of stopping.
	 *
	 * One note that cannot be reached is one note, not a link that failed.
	 * The file it came from is still on the disk, the next start tries it
	 * again, and the count is what puts Problem on the screen in the
	 * meantime. A fill of a few thousand notes that gave up on the first
	 * refusal is how somebody ends up restarting Obsidian to make progress.
	 */
	private async inWaves<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < items.length) {
				const item = items[next++];
				try {
					await work(item);
				} catch (error) {
					// The count is what the screen reads; the fault is what
					// says which note and why, on a server somebody can look
					// at. Before ADR-0095 a note that would not sync was a
					// number on a card and nothing else, anywhere.
					this.failures += 1;
					knapFault("sync", error);
				} finally {
					// Done or failed, this piece is behind us either way.
					this.pass.done += 1;
				}
			}
		};
		const width = Math.max(1, Math.min(FILL_WIDTH, items.length));
		await Promise.all(Array.from({ length: width }, () => worker()));
	}

	// -- local to remote ------------------------------------------------------

	private async onFileEvent(event: FileEvent): Promise<void> {
		const tree = this.docs.tree();
		if (event.type === "rename" && event.oldPath) {
			const from = normalize(event.oldPath);
			if (tree.docIdFor(from) !== undefined) {
				tree.move(from, event.path);
				this.seenDirty = true;
				return;
			}
			await this.pushCounted(event.path);
			return;
		}
		if (event.type === "delete") {
			const path = normalize(event.path);
			if (!path.endsWith(".md")) {
				// A folder. Obsidian deletes the notes inside it, and the
				// tree has to lose them too, or they come back down onto the
				// disk they were just deleted from.
				for (const docId of tree.removeUnder(path)) {
					this.unobserveNote(docId);
					this.seenDirty = true;
				}
				return;
			}
			const docId = tree.docIdFor(path);
			if (tree.remove(path)) this.seenDirty = true;
			if (docId) this.unobserveNote(docId);
			return;
		}
		// A note an editor is holding writes itself, keystroke by keystroke;
		// the save event that arrives a second later says nothing newer.
		if (this.held.has(normalize(event.path))) {
			await this.agreeIfSame(normalize(event.path));
			return;
		}
		// create and modify converge: bring the document to the file's text.
		await this.pushCounted(event.path);
	}

	/**
	 * Push, and put it on the gauge only when it is a note going up for the
	 * first time. A path the tree already knows is an edit, and an edit is
	 * never counted (ADR-0088).
	 */
	private async pushCounted(path: string): Promise<void> {
		if (this.docs.tree().docIdFor(normalize(path)) !== undefined) {
			return this.pushNote(path);
		}
		return this.carry("up", () => this.pushNote(path));
	}

	/**
	 * Bring the document to what this device holds, if this device is the one
	 * that moved. `converge` decides; see there.
	 */
	private async pushNote(path: string): Promise<void> {
		const clean = normalize(path);
		// Belt and braces: the event stream is filtered already, but
		// reconcileAll and the conflict-copy path both call in directly.
		if (!isNote(clean)) return;
		if ((await this.files.read(clean)) === null) return; // gone again before we got to it

		const tree = this.docs.tree();
		const known = tree.docIdFor(clean);
		const docId = tree.ensureNote(clean);
		if (known === undefined) {
			this.seenDirty = true;
			this.minted.add(docId);
		}
		const copy = await this.docs.withNote(docId, async ({ doc }) => {
			// Read inside the borrow, not before it: the wait for a socket can
			// be long, and the file that decides is the file as it is now.
			const fileText = await this.readNote(clean);
			const conflict =
				fileText === null ? null : await this.converge(clean, docId, doc, fileText);
			this.observeNote(clean, docId, doc);
			return conflict;
		});
		if (copy) await this.pushNote(copy);
	}

	/**
	 * Settle one note whose file and document may differ, three ways.
	 *
	 * The base is the text this device last held on both sides. Against it:
	 *
	 * | file vs base | document vs base | what happens                        |
	 * |--------------|------------------|-------------------------------------|
	 * | same         | moved            | the document is written to the file |
	 * | moved        | same             | the file is spliced into the document |
	 * | moved        | moved, or no base | the document keeps the path, the file becomes a conflict copy |
	 *
	 * The third row never splices, and that is the fix for issue #169: an
	 * empty file on a phone was diffed against a full document it had never
	 * held, and the difference was every character of the note. Two cases in
	 * that row do not make a copy, because a copy of them keeps nothing: an
	 * empty file is filled from the document, and an empty document is filled
	 * from the file, which is what a note minted a moment ago looks like.
	 *
	 * Returns the conflict copy's path when one was written, for the caller
	 * to push once it has handed this note's socket back.
	 */
	private async converge(
		path: string,
		docId: string,
		doc: Y.Doc,
		fileText: string,
		previous?: string,
	): Promise<string | null> {
		if (isDrawing(path)) {
			const settled = await this.convergeDrawing(path, docId, doc, fileText);
			if (settled !== undefined) return settled;
		}
		const content = doc.getText(CONTENT);
		const docText = textOf(content);
		if (fileText === docText) {
			await this.agree(docId, docText);
			return null;
		}
		const base = this.bases.get(docId);
		if (base !== undefined) {
			if ((await hashOf(docText)) === base) {
				// Only this device moved: its edit goes up as a difference.
				splice(content, docText, fileText, doc);
				await this.agree(docId, fileText);
				return null;
			}
			if ((await hashOf(fileText)) === base) {
				// Only the cloud moved: this file is just old.
				await this.files.write(path, docText);
				await this.agree(docId, docText);
				return null;
			}
		}
		if (fileText === "") {
			// An empty file this device cannot vouch for is what a fill that
			// was killed halfway leaves behind, and on 2026-09-05 a phone
			// turned 57 of them into 57 empty notes. It is filled, never
			// pushed, and a copy of nothing preserves nothing.
			await this.files.write(path, docText);
			await this.agree(docId, docText);
			return null;
		}
		if (docText === "") {
			// A minted note nobody typed in yet: the local text is the note. A
			// note somebody deliberately emptied looks exactly the same from
			// here and nothing can tell them apart, so this goes the way that
			// cannot lose anything.
			splice(content, "", fileText, doc);
			await this.agree(docId, fileText);
			return null;
		}
		if (
			previous !== undefined &&
			previous !== docId &&
			!this.minted.has(previous) &&
			this.bases.get(previous) === (await hashOf(fileText))
		) {
			// The path now names another document, and the file is the one it
			// named before, untouched here. That text belongs to the device
			// that made it, which keeps its copy; a second copy from here
			// would only be the same words under another person's name.
			await this.files.write(path, docText);
			await this.agree(docId, docText);
			return null;
		}
		// Both sides wrote, or this device cannot say which one did. The
		// cloud text wins the path; the local text survives beside it, named
		// for what happened.
		const conflict = buildConflictCopyPath(path, this.conflictLabel());
		await this.files.write(conflict, fileText);
		await this.files.write(path, docText);
		await this.agree(docId, docText);
		return conflict;
	}

	/**
	 * Settle a drawing, element by element (ADR-0109).
	 *
	 * The three ways above are for text, where two edits to one note can only
	 * be kept apart by a copy. A drawing's elements merge by Excalidraw's own
	 * rule instead, so both people's strokes stay in the drawing and no copy
	 * is made for them. Only the text around the scene still settles the old
	 * way: when both sides changed it, the cloud's text keeps the drawing and
	 * this device's file goes beside it as a copy, as for any note.
	 *
	 * Undefined for a file that is not a drawing any more (somebody turned it
	 * into a plain note), which then takes the road every note takes.
	 */
	private async convergeDrawing(
		path: string,
		docId: string,
		doc: Y.Doc,
		fileText: string,
	): Promise<string | null | undefined> {
		const docText = renderDocument(doc);
		if (fileText === docText) {
			await this.agree(docId, docText);
			return null;
		}
		const base = this.bases.get(docId);
		if (fileText === "" || (base !== undefined && (await hashOf(fileText)) === base)) {
			// Only the cloud moved, or this is a fill cut off halfway. The
			// file's elements still count where they beat the map's, as in
			// observeNote; its text does not.
			ingestDrawing(doc, fileText, false);
			const next = renderDocument(doc);
			await this.files.write(path, next);
			await this.agree(docId, next);
			return null;
		}
		const incoming = parseDrawing(fileText);
		if (!incoming) return undefined;
		const docMoved =
			docText !== "" && (base === undefined || (await hashOf(docText)) !== base);
		const clash = docMoved && textOfDocument(doc) !== incoming.text;
		ingestDrawing(doc, fileText, !clash);
		const merged = renderDocument(doc);
		if (merged !== fileText) await this.files.write(path, merged);
		await this.agree(docId, merged);
		if (!clash) return null;
		const copy = buildConflictCopyPath(path, this.conflictLabel());
		await this.files.write(copy, fileText);
		return copy;
	}

	/**
	 * A note's file as the binding compares it. A drawing reads in its one
	 * form, so the Excalidraw plugin saving it compressed is not an edit.
	 */
	private async readNote(path: string): Promise<string | null> {
		const text = await this.files.read(path);
		return text !== null && isDrawing(path) ? canonical(text) : text;
	}

	// -- remote to local ------------------------------------------------------

	/**
	 * Take one note from the cloud onto disk, and start watching it.
	 *
	 * The three-way choice below is why this is one method rather than a
	 * download at link time and a simpler one for notes that arrive later.
	 * A note can turn up in the tree at a path where an unsynced local file
	 * already sits: somebody wrote it on this laptop while another device
	 * made a note of the same name. Writing the cloud text over it would be
	 * the one thing this binding promises never to do.
	 */
	private async bindNote(path: string, docId: string, previous?: string): Promise<void> {
		const copy = await this.docs.withNote(docId, async ({ doc }) => {
			const fileText = await this.readNote(path);
			let conflict: string | null = null;
			if (fileText === null) {
				const docText = noteText(doc, path);
				await this.files.write(path, docText);
				await this.agree(docId, docText);
			} else {
				conflict = await this.converge(path, docId, doc, fileText, previous);
			}
			this.observeNote(path, docId, doc);
			return conflict;
		});
		// The copy is a note of its own and needs a document of its own, so it
		// is pushed after this note has handed its socket back rather than
		// from inside: a borrow that waits on a second borrow is how a pool
		// this small deadlocks. Explicitly, because this can run before the
		// event stream is on.
		if (copy) await this.pushNote(copy);
	}

	/**
	 * Follow one note's document for as long as it stays open.
	 *
	 * The text is read the moment the change arrives rather than when the
	 * write comes up in the queue, because by then the document may have been
	 * handed back and closed. What was observed is what gets written, and a
	 * second change writes again, so the last one still wins.
	 */
	private observeNote(path: string, docId: string, doc: Y.Doc): void {
		if (this.noteObservers.has(docId)) return;
		const content = doc.getText(CONTENT);
		const drawing = isDrawing(path);
		const observer = () => {
			if (drawing) {
				// Somebody drawing live sends a few changes a second, and
				// every one of them would be a file write here and a reload in
				// the open view. The view already has them (LiveDrawing); the
				// file only has to follow, once things go quiet.
				window.clearTimeout(this.drawingWrites.get(docId));
				this.drawingWrites.set(
					docId,
					window.setTimeout(() => {
						this.drawingWrites.delete(docId);
						if (this.noteObservers.has(docId)) write(noteText(doc, this.docs.tree().pathFor(docId) ?? path));
					}, this.drawingWriteDelayMs),
				);
				return;
			}
			write(noteText(doc, this.docs.tree().pathFor(docId) ?? path));
		};
		const write = (text: string) => {
			void this.enqueue(async () => {
				const current = this.docs.tree().pathFor(docId) ?? path;
				// An open editor already has this change and owns the file.
				if (this.held.has(current)) return;
				const fileText = await this.readNote(current);
				if (fileText === text) {
					await this.agree(docId, text);
					return;
				}
				const base = this.bases.get(docId);
				if (
					fileText !== null &&
					fileText !== "" &&
					base !== undefined &&
					(await hashOf(fileText)) !== base
				) {
					// This device changed the file and the change has not reached
					// the document yet. Its own modify event is in this queue and
					// settles the note three ways; writing the cloud text here
					// first would put it over that edit.
					return;
				}
				let next = text;
				// Only while the socket is up: the pool may have closed this
				// note between the change and this turn, and a write into a
				// closed document goes nowhere.
				const open = this.noteObservers.has(docId);
				if (open && isDrawing(current) && fileText !== null && ingestDrawing(doc, fileText, false)) {
					// Two people who moved one element at once both set it, and
					// the map kept whichever set it keeps, not the one
					// Excalidraw's rule picks. An element in this file that
					// beats the map's goes back in; it is a no-op otherwise,
					// and the same rule on every device settles the element.
					next = renderDocument(doc);
				}
				await this.files.write(current, next);
				await this.agree(docId, next);
			});
		};
		content.observe(observer);
		// A drawing's elements live beside the Text, and a stroke from
		// somebody else changes only them.
		const elements = isDrawing(path) ? doc.getMap(ELEMENTS) : null;
		elements?.observe(observer);
		this.noteObservers.set(docId, () => {
			content.unobserve(observer);
			elements?.unobserve(observer);
		});
	}

	private unobserveNote(docId: string): void {
		window.clearTimeout(this.drawingWrites.get(docId));
		this.drawingWrites.delete(docId);
		this.noteObservers.get(docId)?.();
		this.noteObservers.delete(docId);
	}
}

/**
 * Bring a Y.Text from `oldText` to `newText` as one minimal splice.
 * Indices are UTF-16 code units, which is what both JS strings and Y.Text
 * count, so the boundary arithmetic is one system end to end.
 */
export function splice(content: Y.Text, oldText: string, newText: string, doc: Y.Doc): void {
	if (oldText === newText) return;
	let prefix = 0;
	const limit = Math.min(oldText.length, newText.length);
	while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}
	doc.transact(() => {
		const deleteLen = oldText.length - prefix - suffix;
		if (deleteLen > 0) content.delete(prefix, deleteLen);
		const middle = newText.slice(prefix, newText.length - suffix);
		if (middle) content.insert(prefix, middle);
	});
}
