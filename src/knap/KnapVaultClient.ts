/**
 * One linked cloud vault, live: the tree, the notes an editor has open, and
 * a small pool of sockets that every other note takes its turn in.
 *
 * A local vault is linked to at most one cloud vault (ADR-0066), so a client
 * holds exactly one of these. Two documents earn a socket of their own and
 * keep it: the tree, because that is how creates, moves and deletes travel,
 * and a note somebody has open in an editor, because a caret cannot live on
 * a socket that comes and goes. Every other note borrows one.
 *
 * The pool is not tidiness. Chromium allows 255 websockets per renderer and
 * then queues the 256th handshake in silence rather than failing it, and
 * Obsidian is one renderer for every vault window on the machine. Measured
 * on 2026-08-31: a vault of 2612 notes filled to 297 and stopped there, with
 * 258 established connections that never moved again, and a second vault
 * opened in the same Obsidian got its tree socket and nothing else, which
 * reached the person as "could not reach server" over a sign-in that had
 * worked (issue #115).
 *
 * The wire is untouched. This is which sockets exist and for how long.
 *
 * The WebSocket implementation is injected: Obsidian hands in the platform's,
 * tests hand in `ws` or one of their own. y-websocket syncs same-process docs
 * over a BroadcastChannel behind the server's back, which phase 0 caught as a
 * false pass, so it is off everywhere and the wire is the only path.
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

import { RetryLater, withTimeout } from "./deadline";
import type { KnapServer } from "./KnapServer";
import { listenForNotices, type ServerNotice } from "./notices";
import { TREE_DOC_ID, TreeDoc } from "./TreeDoc";

/**
 * How many notes may hold a socket at once, beside the tree and whatever an
 * editor has open.
 *
 * Low on purpose. The ceiling to stay under is 255 per renderer, and the
 * things sharing it are not this vault's business: a second vault in the
 * same Obsidian, a popout window, a phone that is stricter than any desktop
 * browser. Eight leaves a linked vault costing about ten sockets while it
 * fills, so a machine can hold a dozen of them and still be nowhere near the
 * ceiling. It is also enough concurrency to matter: a fill runs eight notes
 * deep instead of one, and the round trips overlap.
 *
 * Raising it buys a faster fill and spends the headroom that this whole
 * change is about, so it stays a constant with a reason rather than a
 * setting somebody can turn into the bug again.
 */
export const NOTE_SOCKET_CAP = 8;

/** How long one note may take to sync before its turn is given up. */
const NOTE_SYNC_TIMEOUT_MS = 20_000;

/** How long to wait for what a note wrote to leave the socket. */
const FLUSH_TIMEOUT_MS = 10_000;

/** How often to look at what is still queued on the socket. */
const FLUSH_POLL_MS = 20;

/** One note's document while somebody is using it. */
export interface NoteHandle {
	doc: Y.Doc;
	provider: WebsocketProvider;
}

/** A note held open for an editor. `release` hands it back to the pool. */
export interface PinnedNote extends NoteHandle {
	text: Y.Text;
	release: () => void;
}

/**
 * y-websocket types its WebSocketPolyfill option as the DOM's WebSocket
 * constructor; ws's client satisfies the wire but not that lib typing, so
 * the seam is typed by shape rather than by name.
 */
export type WebSocketImpl = { new (url: string | URL, protocols?: string | string[]): unknown };

/** Who are you: this credential opens nothing here any more. */
export const CLOSE_UNAUTHENTICATED = 4401;
/** Not your vault: the credential is fine, the membership has gone. */
export const CLOSE_FORBIDDEN = 4403;

interface PoolEntry {
	doc: Y.Doc;
	provider: WebsocketProvider;
	/** Resolves once the first sync with the server has completed. */
	synced: Promise<void>;
	/** Ends that wait when the socket goes down before the sync arrives. */
	failSynced: (error: Error) => void;
	/** Editors holding this note. Above zero, the pool leaves it alone. */
	pins: number;
	/** Pieces of work borrowing it right now. */
	leases: number;
	/** Bumped on every borrow, so the smallest is the least recently used. */
	used: number;
}

export class KnapVaultClient {
	private open = new Map<string, PoolEntry>();
	private treeDoc: TreeDoc | null = null;
	private clock = 0;
	private destroyed = false;
	/** Work waiting for a socket to come free. */
	private waiting: (() => void)[] = [];
	private closeWatchers: ((docId: string) => void)[] = [];
	private refusedWith = 0;

	constructor(
		private readonly server: KnapServer,
		private readonly vaultId: string,
		private readonly token: string,
		private readonly deviceName: string,
		private readonly webSocket?: WebSocketImpl,
		private readonly onRefused?: (code: number) => void,
		/**
		 * What this device counts in its local vault, so the server can put
		 * "1773 of 2611 notes" on a screen instead of a done-state nobody
		 * verified. Two integers and nothing else leaves this device. Null
		 * while the count has not been taken; sockets opened then say nothing.
		 */
		private readonly localCounts?: () => { notes: number; attachments: number } | null,
		/**
		 * Told when the server says something went wrong on its side
		 * (ADR-0095). Only the tree socket carries these, so this is called
		 * once per notice however many notes this vault has open. Last in the
		 * list because everything before it was already being passed
		 * positionally by callers that do not care about notices.
		 */
		private readonly onNotice?: (notice: ServerNotice) => void,
		/**
		 * What this device is ("mac", "iphone", ...), so a note's history can
		 * say whether an edit came from a desktop or a phone (ADR-0115 in the
		 * admin repository). One word, nothing else.
		 */
		private readonly platform?: string,
	) {}

	/**
	 * The close code the server refused us with, or 0 while we are welcome.
	 *
	 * Sticky on purpose. A refusal is a fact about this link rather than about
	 * the socket that carried it, and the screen asks long after that socket
	 * has gone.
	 */
	get refused(): number {
		return this.refusedWith;
	}

	/** The vault's tree, connected. The first call opens the socket. */
	tree(): TreeDoc {
		if (!this.treeDoc) {
			this.treeDoc = new TreeDoc(this.entryFor(TREE_DOC_ID).doc);
		}
		return this.treeDoc;
	}

	/** Resolves once the tree has had its first sync with the server. */
	treeSynced(): Promise<void> {
		return this.entryFor(TREE_DOC_ID).synced;
	}

	/**
	 * Whether this device can reach the vault right now.
	 *
	 * Read off the tree's socket rather than a flag of our own, because the
	 * tree is open for as long as the link is and y-websocket already knows.
	 * A second flag would be a second thing to keep true. Nothing open yet
	 * counts as not connected: the status is asked before start() finishes.
	 */
	get connected(): boolean {
		return this.open.get(TREE_DOC_ID)?.provider.wsconnected ?? false;
	}

	/** Whether the tree has finished its first exchange with the server. */
	get settled(): boolean {
		return this.open.get(TREE_DOC_ID)?.provider.synced ?? false;
	}

	/** How many sockets this vault is holding, the tree included. */
	get socketCount(): number {
		return this.open.size;
	}

	/**
	 * Borrow one note's document for the length of `use`.
	 *
	 * What the caller gets is a document that has finished its first sync,
	 * on a socket that stays up until `use` has returned and everything it
	 * wrote has left this process. Waits for a turn when the pool is full,
	 * and gives up on a note that cannot sync rather than waiting on it
	 * forever, because a note that hangs used to take every note behind it
	 * down with it.
	 */
	async withNote<T>(docId: string, use: (note: NoteHandle) => Promise<T>): Promise<T> {
		const entry = await this.acquire(docId);
		try {
			await withTimeout(
				entry.synced,
				NOTE_SYNC_TIMEOUT_MS,
				"This note did not sync in time. It will be tried again.",
			);
			const result = await use({ doc: entry.doc, provider: entry.provider });
			await this.flushed(entry);
			return result;
		} finally {
			entry.leases -= 1;
			entry.used = ++this.clock;
			this.wake();
		}
	}

	/**
	 * Hold a note open for an editor, above the pool and outside its count.
	 *
	 * An editor never queues behind a fill: it says which note it is showing
	 * and gets it. A note the pool already has open is promoted rather than
	 * reopened, which is the point. The document, the socket and the sync
	 * that has already happened are the ones it was using a moment ago, so
	 * nothing re-syncs and no text goes through a second first exchange.
	 *
	 * `release` gives it back to the pool, where it stays open until the
	 * pool needs the socket for something else.
	 */
	pin(docId: string): PinnedNote {
		const entry = this.entryFor(docId);
		entry.pins += 1;
		entry.used = ++this.clock;
		let released = false;
		return {
			doc: entry.doc,
			provider: entry.provider,
			text: entry.doc.getText("content"),
			release: () => {
				if (released) return;
				released = true;
				entry.pins -= 1;
				entry.used = ++this.clock;
				// One pin fewer is one pooled socket more, and somebody may
				// be waiting for exactly that.
				this.wake();
			},
		};
	}

	/**
	 * Told when a note's socket goes down, so whoever was watching that
	 * document can let go of it. The pool closes notes on its own schedule,
	 * and an observer on a document nobody is syncing any more is a callback
	 * that will never fire and a document that cannot be collected.
	 */
	onNoteClosed(callback: (docId: string) => void): () => void {
		this.closeWatchers.push(callback);
		return () => {
			this.closeWatchers = this.closeWatchers.filter((watcher) => watcher !== callback);
		};
	}

	/** Close one document's socket, keeping the vault linked. */
	close(docId: string): void {
		const entry = this.open.get(docId);
		if (!entry) return;
		this.open.delete(docId);
		if (docId === TREE_DOC_ID) {
			this.treeDoc = null;
		}
		entry.provider.destroy();
		// Anybody still waiting for this document's first sync is waiting for
		// something that has stopped being on its way.
		entry.failSynced(new RetryLater("This note's connection closed before it synced."));
		// Watchers first, so whoever was following this document lets go of a
		// document that is still whole, and then the document itself.
		for (const watcher of [...this.closeWatchers]) watcher(docId);
		entry.doc.destroy();
	}

	/** Unlink or shutdown: every socket down, nothing deleted anywhere. */
	destroy(): void {
		// Set before the closing, because work that was already in flight is
		// not cancelled by any of this and would otherwise be handed a fresh
		// socket to a vault this device has just unlinked from.
		this.destroyed = true;
		for (const docId of [...this.open.keys()]) {
			this.close(docId);
		}
		this.wake();
	}

	/**
	 * Stop knocking, and tell whoever is listening why.
	 *
	 * `destroy` does the whole teardown already: it bars new sockets, closes
	 * the open ones, fails every wait for a first sync that is no longer
	 * coming, and wakes whatever was queued for a turn in the pool. Without
	 * that last part a device taken out of a vault mid-edit froze rather than
	 * stopped, because the binding's queue is serial and was waiting on a sync
	 * that had lost its socket.
	 *
	 * Once only: a vault with the tree and eight notes open produces nine of
	 * these in the same instant.
	 */
	private refuse(code: number): void {
		if (this.refusedWith) return;
		this.refusedWith = code;
		this.destroy();
		this.onRefused?.(code);
	}

	// -- the pool ------------------------------------------------------------

	private async acquire(docId: string): Promise<PoolEntry> {
		for (;;) {
			const existing = this.open.get(docId);
			if (existing) {
				existing.leases += 1;
				existing.used = ++this.clock;
				return existing;
			}
			if (this.makeRoom()) {
				const entry = this.entryFor(docId);
				entry.leases += 1;
				entry.used = ++this.clock;
				return entry;
			}
			await this.slot();
		}
	}

	/**
	 * Whether a note may open a socket now, closing the one that has gone
	 * unused longest if it may not.
	 *
	 * Only pooled notes are counted: the tree and the notes an editor is
	 * holding are not the pool's to close, and they are what the cap is kept
	 * low for in the first place.
	 */
	private makeRoom(): boolean {
		const pooled = [...this.open.entries()].filter(
			([docId, entry]) => docId !== TREE_DOC_ID && entry.pins === 0,
		);
		if (pooled.length < NOTE_SOCKET_CAP) return true;
		let oldest: [string, PoolEntry] | null = null;
		for (const candidate of pooled) {
			if (candidate[1].leases > 0) continue;
			if (!oldest || candidate[1].used < oldest[1].used) oldest = candidate;
		}
		if (!oldest) return false;
		this.close(oldest[0]);
		return true;
	}

	/** A turn, when one comes free. */
	private slot(): Promise<void> {
		return new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	private wake(): void {
		const waiting = this.waiting;
		this.waiting = [];
		for (const resolve of waiting) resolve();
	}

	/**
	 * Wait for what this note wrote to leave the process before its socket
	 * can be closed.
	 *
	 * y-websocket sends every local update the moment it is made, so the
	 * only thing between a splice and the server is the socket's own send
	 * buffer. A close with bytes still in it is an update nobody will ever
	 * see again, because the document goes with it.
	 *
	 * A socket that went down while the note was being written has not sent
	 * anything, and saying so is the honest outcome: the caller counts it as
	 * a failure, the file stays on the disk it came from, and the next
	 * reconciliation pushes it again.
	 */
	private async flushed(entry: PoolEntry): Promise<void> {
		const deadline = Date.now() + FLUSH_TIMEOUT_MS;
		for (;;) {
			const socket = entry.provider.ws;
			if (!entry.provider.wsconnected || !socket) {
				throw new RetryLater("The connection dropped before this note was sent.");
			}
			if (!socket.bufferedAmount) return;
			if (Date.now() > deadline) {
				throw new RetryLater("This note could not be sent in time. It will be tried again.");
			}
			await new Promise<void>((resolve) => window.setTimeout(resolve, FLUSH_POLL_MS));
		}
	}

	/** The open entry for a document, opening the socket if there is none. */
	private entryFor(docId: string): PoolEntry {
		const existing = this.open.get(docId);
		if (existing) return existing;
		if (this.destroyed) {
			throw new Error("This vault is not linked any more.");
		}

		const doc = new Y.Doc();
		const params: Record<string, string> = { token: this.token, device: this.deviceName };
		if (this.platform) params.platform = this.platform;
		const counts = this.localCounts?.();
		if (counts) {
			params.notes = String(counts.notes);
			params.attachments = String(counts.attachments);
		}
		const provider = new WebsocketProvider(this.server.syncUrl(this.vaultId), docId, doc, {
			params,
			WebSocketPolyfill: this.webSocket as typeof WebSocket | undefined,
			disableBc: true,
		});
		provider.awareness.setLocalStateField("device", { name: this.deviceName });
		// The server sends notices down the tree socket and nowhere else, so
		// this is the one place that listens for them.
		if (docId === TREE_DOC_ID && this.onNotice) {
			listenForNotices(provider, this.onNotice);
		}

		// A refusal, not an outage. y-websocket treats every close the same and
		// reconnects with backoff forever, which for somebody who was taken out
		// of a vault is a device that goes on knocking and never says so. The
		// close code is the only thing that tells the two apart, and nothing
		// here read it until two people shared a vault.
		provider.on("connection-close", (event: unknown) => {
			const code = (event as { code?: number } | null)?.code ?? 0;
			if (code === CLOSE_UNAUTHENTICATED || code === CLOSE_FORBIDDEN) {
				this.refuse(code);
			}
		});

		let failSynced: (error: Error) => void = () => undefined;
		const synced = new Promise<void>((resolve, reject) => {
			failSynced = reject;
			if (provider.synced) {
				resolve();
				return;
			}
			provider.once("synced", () => resolve());
		});
		// A first sync that will now never come is worth saying out loud to
		// whoever is waiting on it, and worth saying to nobody at all when
		// nobody is: an unhandled rejection in Obsidian's console is a bug
		// report about a vault somebody unlinked on purpose.
		void synced.catch(() => undefined);

		// The tree is pinned for the life of the link: it is how every create,
		// move and delete travels, and a pool that could close it would take
		// the vault's index down to make room for one note.
		const entry: PoolEntry = {
			doc,
			provider,
			synced,
			failSynced,
			pins: docId === TREE_DOC_ID ? 1 : 0,
			leases: 0,
			used: ++this.clock,
		};
		this.open.set(docId, entry);
		return entry;
	}
}
