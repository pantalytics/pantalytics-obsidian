/**
 * Where everybody's cursor is in one note, on awareness and nowhere else.
 *
 * A cursor is not a fact about a vault: it is true for as long as somebody
 * is looking at a line and false a second later, so it rides awareness, the
 * y-protocol's side channel, and never enters the document. Knap's server
 * forwards it, hands it to a device that opens the note later, and drops it
 * when the socket closes, all without writing a byte (ADR-0076 in the admin
 * repository, measured in its `scripts/spikes/cursor_presence/`).
 *
 * Positions travel as Yjs **relative** positions rather than offsets. An
 * offset is only true against one version of the text: somebody typing
 * above your caret would drag it a word to the left on every other screen.
 * A relative position names the character the caret sits on, so it stays
 * put while the note moves under it, which is the whole trick behind a
 * cursor that reads as another person rather than as a jumping artefact.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

/** The awareness field holding a caret or a selection. */
export const CURSOR_FIELD = "cursor";
/** The awareness field naming who is holding it. */
export const USER_FIELD = "user";

/** Where a device's selection starts and ends. Equal ends mean a caret. */
export interface CursorState {
	anchor: unknown;
	head: unknown;
}

/** Who somebody is, as far as a caret needs to say. */
export interface CursorUser {
	name: string;
	color: string;
	/**
	 * Set by the server on the caret it draws for an AI writing through the
	 * MCP (ADR-0108 in the admin repository). Its name stays on screen, since
	 * nobody hovers over a caret that is gone in five seconds.
	 */
	ai?: boolean;
}

/** One other person's cursor, resolved against the text we are holding. */
export interface RemoteCursor extends CursorUser {
	clientId: number;
	ai: boolean;
	/** The lower of anchor and head, in editor offsets. */
	from: number;
	/** The higher of the two. Equal to `from` for a caret. */
	to: number;
	/** Where the caret itself is drawn: the head end of the selection. */
	head: number;
}

/**
 * Caret colours, picked so that two people rarely collide and nobody gets a
 * colour the editor already uses for its own selection.
 */
const PALETTE = [
	"#e07a5f",
	"#3d85c6",
	"#2a9d8f",
	"#9c6ade",
	"#d1495b",
	"#e6a817",
	"#5c8001",
	"#0f7b9f",
];

/** The same name gets the same colour on every device, without agreeing on one. */
export function colorFor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	}
	return PALETTE[hash % PALETTE.length];
}

/** Say who is typing here. Cheap to repeat: awareness only sends changes. */
export function publishUser(awareness: Awareness, name: string): void {
	const clean = name.trim();
	if (!clean) return;
	const current = (awareness.getLocalState() ?? {})[USER_FIELD] as CursorUser | undefined;
	if (current?.name === clean) return;
	awareness.setLocalStateField(USER_FIELD, { name: clean, color: colorFor(clean) });
}

/**
 * Put this editor's selection on awareness, or take it off.
 *
 * `null` is how a device says it is no longer looking: the editor lost focus,
 * the note was closed, or the socket is going. Every one of those has to
 * remove the caret, because a caret nobody is behind is worse than no caret,
 * and it is the same field either way rather than a second "left" message.
 *
 * Repeated calls with an unchanged selection are dropped. Awareness sends an
 * update to every device in the note on every set, and a selection is
 * recomputed on every keystroke, every scroll and every repaint.
 */
export function publishCursor(
	awareness: Awareness,
	text: Y.Text,
	selection: { anchor: number; head: number } | null,
): void {
	const local = (awareness.getLocalState() ?? {})[CURSOR_FIELD] as CursorState | undefined;
	if (selection === null) {
		if (local != null) awareness.setLocalStateField(CURSOR_FIELD, null);
		return;
	}
	const anchor = Y.createRelativePositionFromTypeIndex(text, selection.anchor);
	const head = Y.createRelativePositionFromTypeIndex(text, selection.head);
	if (local) {
		const same =
			Y.compareRelativePositions(Y.createRelativePositionFromJSON(local.anchor), anchor) &&
			Y.compareRelativePositions(Y.createRelativePositionFromJSON(local.head), head);
		if (same) return;
	}
	awareness.setLocalStateField(CURSOR_FIELD, {
		// Explicitly widened: relativePositionToJSON is typed `any`, and an
		// awareness field is somebody else's data the moment it is sent.
		anchor: Y.relativePositionToJSON(anchor) as unknown,
		head: Y.relativePositionToJSON(head) as unknown,
	});
}

/** Stop claiming a cursor in this note, without waiting for the socket. */
export function withdrawCursor(awareness: Awareness): void {
	awareness.setLocalStateField(CURSOR_FIELD, null);
}

/**
 * Everybody else's cursor, in offsets this editor can draw at.
 *
 * A position that will not resolve is skipped rather than guessed at: it
 * belongs to text this device has not received yet, and a caret drawn at a
 * guessed offset points at somebody else's sentence. Positions past the end
 * of the text are skipped for the same reason, which is the case a device
 * that is mid-sync produces.
 */
export function readCursors(awareness: Awareness, text: Y.Text): RemoteCursor[] {
	const doc = text.doc;
	if (!doc) return [];
	const length = text.length;
	const found: RemoteCursor[] = [];
	awareness.getStates().forEach((state, clientId) => {
		if (clientId === doc.clientID) return;
		const cursor = (state as Record<string, unknown>)[CURSOR_FIELD] as CursorState | null;
		if (!cursor || cursor.anchor == null || cursor.head == null) return;
		const anchor = resolve(cursor.anchor, text, doc);
		const head = resolve(cursor.head, text, doc);
		if (anchor === null || head === null || anchor > length || head > length) return;
		const user = ((state as Record<string, unknown>)[USER_FIELD] ?? {}) as Partial<CursorUser>;
		const name = user.name?.trim() || "Someone else";
		found.push({
			clientId,
			name,
			color: user.color || colorFor(name),
			ai: user.ai === true,
			from: Math.min(anchor, head),
			to: Math.max(anchor, head),
			head,
		});
	});
	return found;
}

function resolve(position: unknown, text: Y.Text, doc: Y.Doc): number | null {
	const absolute = Y.createAbsolutePositionFromRelativePosition(
		Y.createRelativePositionFromJSON(position),
		doc,
	);
	if (!absolute || absolute.type !== text) return null;
	return absolute.index;
}
