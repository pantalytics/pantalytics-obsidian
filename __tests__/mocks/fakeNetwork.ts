/**
 * The server, as far as a socket can tell, and a vault on disk in memory.
 *
 * Shared by every test that needs a real `WebsocketProvider` over a real
 * y-protocol exchange rather than a fake provider that decides for itself
 * whether it has synced. It lives under `mocks/` because jest treats every
 * other file under `__tests__` as a suite, and this one holds no claims.
 *
 * The ceiling is the point of the network half: a renderer gets 255 sockets
 * and the 256th handshake does not fail, it waits in a queue nobody answers
 * (issue #115, measured 2026-08-31). So above the ceiling this goes quiet
 * exactly the way the real one did.
 */

import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";

import type { FileEvent, FileStore } from "../../src/knap/VaultBinding";

/** What one renderer gets. Above it Chromium queues rather than refuses. */
export const SOCKET_CEILING = 255;

const messageSync = 0;
const messageAwareness = 1;

function awarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
	return encoding.toUint8Array(encoder);
}

/**
 * The server, as far as a socket can tell: one document per room, and every
 * update relayed to the other sockets in that room.
 */
export class FakeNetwork {
	/** Sockets open right now, across every vault in this process. */
	live = 0;
	/** The most that were ever open at one instant. The claim of this file. */
	peak = 0;
	/** Sockets that asked for a connection above the ceiling and got silence. */
	refused = 0;
	/**
	 * Whether the server is reachable. Down, every handshake fails the way a
	 * refused connection does: an error, then a close, no open in between.
	 * That is what a laptop that starts on a train sees, and what a deploy
	 * in progress looks like from the plugin.
	 */
	down = false;
	/** How many times a room has been connected to, ever. */
	opens = new Map<string, number>();
	/** What the room's document held when its last socket closed. */
	closedWith = new Map<string, string>();
	docs = new Map<string, Y.Doc>();
	sockets = new Map<string, Set<FakeSocket>>();
	private awarenesses = new Map<string, Awareness>();

	/**
	 * Who is in a room and where their caret is, as the server keeps it: it
	 * forwards every awareness message to the rest of the room, greets a
	 * socket that joins with everybody already there, and drops a socket's
	 * people when it closes (knap_server/sync.py in the admin repository).
	 */
	awareness(room: string): Awareness {
		let awareness = this.awarenesses.get(room);
		if (!awareness) {
			awareness = new Awareness(this.doc(room));
			// The server has no caret of its own.
			awareness.setLocalState(null);
			this.awarenesses.set(room, awareness);
		}
		return awareness;
	}

	doc(room: string): Y.Doc {
		let doc = this.docs.get(room);
		if (!doc) {
			doc = new Y.Doc();
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				for (const socket of this.sockets.get(room) ?? []) {
					if (socket !== origin) socket.deliver(update);
				}
			});
			this.docs.set(room, doc);
		}
		return doc;
	}

	text(room: string): string {
		// eslint-disable-next-line @typescript-eslint/no-base-to-string
		return this.doc(room).getText("content").toString();
	}

	/** The WebSocket implementation to hand a client. */
	get socket(): { new (url: string | URL): unknown } {
		const network = this;
		return class Bound extends FakeSocket {
			constructor(url: string | URL) {
				super(network, String(url));
			}
		};
	}
}

export class FakeSocket {
	static readonly OPEN = 1;
	readonly OPEN = 1;
	binaryType = "arraybuffer";
	readyState = 0;
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	private readonly room: string;
	/** Awareness clients this socket introduced, dropped when it closes. */
	private readonly people = new Set<number>();

	constructor(
		private readonly network: FakeNetwork,
		url: string,
	) {
		this.room = new URL(url).pathname;
		network.live += 1;
		network.peak = Math.max(network.peak, network.live);
		network.opens.set(this.room, (network.opens.get(this.room) ?? 0) + 1);
		if (network.live > SOCKET_CEILING) {
			// The bug this file is about: no error, no close, no handshake.
			network.refused += 1;
			return;
		}
		if (network.down) {
			setTimeout(() => {
				if (this.readyState !== 0) return;
				this.readyState = 3;
				network.live -= 1;
				this.onerror?.({});
				this.onclose?.({ code: 1006 });
			}, 0);
			return;
		}
		const room = network.sockets.get(this.room) ?? new Set<FakeSocket>();
		room.add(this);
		network.sockets.set(this.room, room);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.onopen?.();
			const awareness = network.awareness(this.room);
			const present = [...awareness.getStates().keys()];
			if (present.length > 0) this.deliver(awarenessMessage(awareness, present), true);
		}, 0);
	}

	/**
	 * Send, with a buffer that drains a turn later, the way a real one does.
	 * A client that closes without waiting for it loses whatever was in it.
	 */
	send(data: Uint8Array): void {
		if (this.readyState !== 1) return;
		this.bufferedAmount += data.byteLength;
		const copy = data.slice();
		setTimeout(() => {
			this.bufferedAmount -= copy.byteLength;
			if (this.readyState !== 1) return;
			this.receive(copy);
		}, 0);
	}

	private receive(data: Uint8Array): void {
		const decoder = decoding.createDecoder(data);
		const encoder = encoding.createEncoder();
		const type = decoding.readVarUint(decoder);
		if (type === messageAwareness) {
			const update = decoding.readVarUint8Array(decoder);
			const awareness = this.network.awareness(this.room);
			const before = new Set(awareness.getStates().keys());
			applyAwarenessUpdate(awareness, update, this);
			for (const client of awareness.getStates().keys()) {
				if (!before.has(client)) this.people.add(client);
			}
			for (const socket of this.network.sockets.get(this.room) ?? []) {
				if (socket !== this) socket.deliver(data, true);
			}
			return;
		}
		if (type !== messageSync) return;
		encoding.writeVarUint(encoder, messageSync);
		syncProtocol.readSyncMessage(decoder, encoder, this.network.doc(this.room), this);
		if (encoding.length(encoder) > 1) this.deliver(encoding.toUint8Array(encoder), true);
	}

	/** A message from the server. `framed` says it is already a sync message. */
	deliver(payload: Uint8Array, framed = false): void {
		let message = payload;
		if (!framed) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeUpdate(encoder, payload);
			message = encoding.toUint8Array(encoder);
		}
		const bytes = message.slice();
		setTimeout(() => {
			if (this.readyState !== 1) return;
			this.onmessage?.({
				data: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
			});
		}, 0);
	}

	close(): void {
		if (this.readyState === 3) return;
		const wasOpen = this.readyState === 1;
		this.readyState = 3;
		this.network.live -= 1;
		this.network.sockets.get(this.room)?.delete(this);
		if (wasOpen) this.network.closedWith.set(this.room, this.network.text(this.room));
		if (this.people.size > 0) {
			const awareness = this.network.awareness(this.room);
			const gone = [...this.people];
			removeAwarenessStates(awareness, gone, this);
			const message = awarenessMessage(awareness, gone);
			for (const socket of this.network.sockets.get(this.room) ?? []) socket.deliver(message, true);
		}
		this.onclose?.({});
	}
}

/** The note half of a vault on disk, in memory. */
export class MemoryFiles implements FileStore {
	map = new Map<string, string>();
	/** The attachment half. Notes are text; everything else is bytes. */
	bytes = new Map<string, ArrayBuffer>();

	async read(path: string): Promise<string | null> {
		return this.map.has(path) ? (this.map.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		this.map.set(path, text);
	}
	async remove(path: string): Promise<void> {
		this.map.delete(path);
		this.bytes.delete(path);
	}
	async rename(from: string, to: string): Promise<void> {
		this.map.set(to, this.map.get(from) ?? "");
		this.map.delete(from);
	}
	async readBinary(path: string): Promise<ArrayBuffer | null> {
		return this.bytes.get(path) ?? null;
	}
	async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		this.bytes.set(path, content);
	}
	async listNotes(): Promise<string[]> {
		return [...this.map.keys()].filter((path) => path.endsWith(".md"));
	}
	async listAttachments(): Promise<string[]> {
		return [...this.bytes.keys()];
	}
	onChange(_callback: (event: FileEvent) => void): () => void {
		return () => undefined;
	}
}

/** The room a document lives in, as the fake network keys it. */
export const roomOf = (vaultId: string, docId: string): string =>
	`/sync/${vaultId}/${docId}`;
