/**
 * A note's history, as the views ask for it: one place that holds the link,
 * the token and a short cache, so the corner's menu, the sidebar and the
 * version view all read the same answer.
 *
 * Every read and the restore go to the server. Restore in particular is
 * never a write to the local file: the server keeps the current text as a
 * version first and puts the old text into the live note as a change, which
 * reaches every device through sync. A restore written to a file here is one
 * a stale device in Obsidian Sync can write straight back over.
 */

import { KnapServerError, type NoteHistory, type VersionId, type VersionText } from "../KnapServer";
import type { KnapSync } from "../KnapSync";
import { OFFLINE, SIGNED_OUT } from "../../syncStatus";

/** How long a history answer is good for the corner's menu. */
export const FRESH_MS = 30_000;

/** What a failed call says, in one sentence. */
export function failureText(error: unknown, otherwise: string): string {
	return error instanceof KnapServerError ? error.message : otherwise;
}

export class HistoryService {
	private cache = new Map<string, { at: number; history: NoteHistory | null }>();
	private listeners = new Set<() => void>();

	constructor(readonly sync: KnapSync) {}

	/** Whether this vault is linked, so a note in it can have a history. */
	get linked(): boolean {
		return this.sync.linked !== null;
	}

	/** Whether a call to the server can be made right now. */
	canReach(): boolean {
		if (!this.sync.linked) return false;
		const word = this.sync.status().word;
		return word !== OFFLINE && word !== SIGNED_OUT;
	}

	/** Whether the cloud vault holds this path as a note. */
	hasNote(path: string): boolean {
		return this.sync.docIdFor(path) !== null;
	}

	/** A cached answer no older than `maxAgeMs`, or undefined. */
	peek(path: string, maxAgeMs: number = FRESH_MS): NoteHistory | null | undefined {
		const hit = this.cache.get(path);
		if (!hit || Date.now() - hit.at > maxAgeMs) return undefined;
		return hit.history;
	}

	/** The note's history; null when there is none yet. Throws when the server will not say. */
	async history(path: string): Promise<NoteHistory | null> {
		const linked = this.sync.linked;
		const docId = this.sync.docIdFor(path);
		if (!linked || !docId) return null;
		const history = await this.sync.server.noteHistory(linked.token, linked.cloudVaultId, docId);
		this.cache.set(path, { at: Date.now(), history });
		return history;
	}

	async version(versionId: VersionId): Promise<VersionText> {
		const linked = this.need();
		return this.sync.server.version(linked.token, linked.cloudVaultId, versionId);
	}

	async restore(versionId: VersionId, path: string): Promise<void> {
		const linked = this.need();
		await this.sync.server.restore(linked.token, linked.cloudVaultId, versionId);
		this.cache.delete(path);
		for (const listener of [...this.listeners]) listener();
	}

	/** Told after a restore, so whoever shows a history reloads it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Who else has this note open in an editor now. */
	othersIn(path: string): string[] {
		return this.sync.othersInNote(path);
	}

	private need() {
		const linked = this.sync.linked;
		if (!linked) throw new KnapServerError("This vault is not linked.", 0);
		return linked;
	}
}
