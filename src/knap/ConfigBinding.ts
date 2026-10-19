/**
 * The third binding: Obsidian's own settings, and the plugins under them.
 *
 * `VaultBinding` is notes, `AttachmentBinding` is everything else in the
 * vault, and this is the config directory, which is in neither because
 * Obsidian does not put it in the vault's file index at all. Measured
 * 2026-09-05 (`scripts/spikes/obsidian_config_events/` in the server repo):
 * `vault.getFiles()` yields nothing under `.obsidian`, `adapter.list` reads
 * it, and `vault.on("raw")` fires for the app's own writes to it, so this
 * binding needs its own store and its own event source. Everything after that
 * is the attachment rules, because a settings file behaves like an attachment:
 * bytes, a hash, and no merge.
 *
 * The rules, and where they differ from the attachment ones:
 *
 * - **No conflict copy.** Notes and attachments keep both sides. A file called
 *   `appearance (conflict from iPhone).json` inside `.obsidian` is litter in a
 *   folder a person cannot open from Obsidian, so the newer write simply wins.
 * - **Nothing to turn on.** This binding starts wherever the host has a config
 *   directory at all, so a vault is its notes and how it is set up on every
 *   device that holds it (ADR-0096). One consequence is worth knowing before
 *   reading the rest: the settings belong to the vault, so everybody in a
 *   shared vault gets the same theme, hotkeys and plugins, and the carve-outs
 *   in `configPaths.ts` are the whole of what stays personal.
 * - **`manifest.json` goes last** when a plugin folder arrives, so a folder
 *   whose `main.js` is still in flight is not a plugin that half exists.
 * - **Nothing is enabled here.** A plugin that arrives is on disk and in the
 *   roster; Obsidian starts it at the next start, from `community-plugins.json`
 *   which travelled with it. Obsidian Sync needs a restart for community
 *   plugins too, and running somebody else's code the instant it lands is a
 *   decision no sync client should make on its own.
 * - **Our own folder never travels**, in either direction, and that is in
 *   `configPaths.ts` rather than here so the server can hold the same list. It
 *   is what keeps a second person in a vault from being signed in as the first.
 */

import { generateHash } from "../hashing";
import type { AttachmentEntry, TreeDoc } from "./TreeDoc";
import { normalize } from "./TreeDoc";
import type { Backlog, Pass } from "./VaultBinding";
import { isSyncedConfig, manifestLast, pluginFolderOf, withOurselves } from "./configPaths";
import { TREE_SYNC_FAILED, TREE_SYNC_TIMEOUT_MS, withTimeout } from "./deadline";

/** What this binding needs from the config directory. Obsidian's adapter fits. */
export interface ConfigStore {
	/** Every file under the config directory, vault paths, recursive. */
	list(): Promise<string[]>;
	read(path: string): Promise<ArrayBuffer | null>;
	write(path: string, content: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	/**
	 * Every change to a file anywhere in the vault, by path. Obsidian's `raw`
	 * event, which is whole-vault: the filtering is this binding's job.
	 */
	onRawChange(callback: (path: string) => void): () => void;
	/**
	 * Tell Obsidian to read the plugin folder again. Called after a plugin's
	 * files land, because Obsidian does not notice a folder that appears while
	 * it is running. Nothing is enabled by it.
	 */
	refreshPlugins(): Promise<void>;
}

/** What it needs from the wire. `KnapServer`'s file routes satisfy it. */
export interface ConfigTransport {
	upload(path: string, content: ArrayBuffer): Promise<{ sha256: string; size: number }>;
	download(path: string): Promise<ArrayBuffer>;
	remove(path: string): Promise<void>;
}

/** What it needs from the tree. `KnapVaultClient`'s `TreeDoc` satisfies it. */
export interface ConfigDocs {
	tree(): TreeDoc;
	treeSynced(): Promise<void>;
}

/**
 * What this device last agreed with: per settings path, the hash of the cloud
 * copy it last took or sent (ADR-0106). Kept in our own folder, which never
 * travels, because it is a fact about this device and no other.
 */
export interface ConfigBases {
	load(): Promise<Map<string, string>>;
	save(bases: Map<string, string>): Promise<void>;
}

/** Told when a settings file cannot travel, so a screen can say so. */
export type Refusal = (path: string, reason: string) => void;

/**
 * How long to wait after a change before reading the file.
 *
 * Obsidian writes a settings file in one go, but `raw` fires more than once
 * for one save: six events for one accent colour in the spike. Waiting a
 * moment turns a burst into one read, and the hash check would have made the
 * repeats no-ops anyway, so this is about not spending the upstream twice.
 */
const SETTLE_MS = 400;

/**
 * How long to wait before telling Obsidian to re-read its plugin folder.
 *
 * A plugin arriving is a dozen files. Reloading the roster once at the end of
 * that is one pass; reloading per file is a dozen.
 */
const ROSTER_MS = 1500;

export class ConfigBinding {
	private stopRaw: (() => void) | null = null;
	private stopTree: (() => void) | null = null;
	private queue: Promise<void> = Promise.resolve();
	private outstanding = { up: 0, down: 0 };
	private pass: Pass = { done: 0, total: 0 };
	private settling = new Map<string, number>();
	private rosterTimer: number | null = null;
	private stopped = false;
	private agreed = new Map<string, string>();

	constructor(
		private readonly store: ConfigStore,
		private readonly docs: ConfigDocs,
		private readonly transport: ConfigTransport,
		private readonly refused: Refusal = () => undefined,
		/**
		 * True on the pass that makes a link, false on every later start.
		 * It is the whole difference between joining a cloud vault and
		 * coming back to one, and only the first of those may adopt.
		 */
		private readonly linking = false,
		/** Told once when this device took the cloud vault's settings. */
		private readonly adopted: () => void = () => undefined,
		/** Where the agreed hashes live between starts. None: the cloud wins every start. */
		private readonly bases: ConfigBases | null = null,
	) {}

	async start(): Promise<void> {
		this.stopped = false;
		await this.enqueue(() => this.reconcileAll());
		this.stopRaw = this.store.onRawChange((path) => {
			// `raw` is a whole-vault event: every note write reaches it too.
			// The other two bindings own those, and our own plugin folder is
			// nobody's.
			if (!isSyncedConfig(path)) return;
			this.settle(path);
		});
		this.stopTree = this.docs.tree().onAttachmentChange((change) => {
			void this.enqueue(async () => {
				const arriving = manifestLast(
					[...change.added.keys()].filter((path) => isSyncedConfig(path)),
				);
				for (const path of arriving) {
					const entry = change.added.get(path) as AttachmentEntry;
					await this.carry("down", () => this.pull(path, entry));
				}
				for (const path of change.removed.keys()) {
					// A path in both halves changed rather than left.
					if (change.added.has(path)) continue;
					if (!isSyncedConfig(path)) continue;
					await this.store.remove(path);
				}
				for (const path of change.removed.keys()) {
					if (!change.added.has(path)) this.agreed.delete(normalize(path));
				}
				if (arriving.some((path) => pluginFolderOf(path))) this.refreshRoster();
				await this.saveBases();
			});
		});
	}

	stop(): void {
		this.stopped = true;
		this.stopRaw?.();
		this.stopTree?.();
		this.stopRaw = null;
		this.stopTree = null;
		for (const timer of this.settling.values()) window.clearTimeout(timer);
		this.settling.clear();
		if (this.rosterTimer !== null) window.clearTimeout(this.rosterTimer);
		this.rosterTimer = null;
	}

	/** Wait for everything queued so far. Tests and shutdown use it. */
	flush(): Promise<void> {
		return this.enqueue(async () => undefined);
	}

	get backlog(): Backlog {
		return { ...this.outstanding };
	}

	get checked(): Pass {
		return { ...this.pass };
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work, work);
		return this.queue;
	}

	private async carry<T>(kind: "up" | "down", work: () => Promise<T>): Promise<T> {
		this.outstanding[kind] += 1;
		try {
			return await work();
		} finally {
			this.outstanding[kind] -= 1;
		}
	}

	/** One read per burst of events on a path. */
	private settle(path: string): void {
		const clean = normalize(path);
		const existing = this.settling.get(clean);
		if (existing) window.clearTimeout(existing);
		this.settling.set(
			clean,
			window.setTimeout(() => {
				this.settling.delete(clean);
				if (this.stopped) return;
				void this.enqueue(() => this.onLocalChange(clean));
			}, SETTLE_MS),
		);
	}

	private refreshRoster(): void {
		if (this.rosterTimer !== null) window.clearTimeout(this.rosterTimer);
		this.rosterTimer = window.setTimeout(() => {
			this.rosterTimer = null;
			if (this.stopped) return;
			void this.store.refreshPlugins().catch(() => undefined);
		}, ROSTER_MS);
	}

	// -- link time -----------------------------------------------------------

	/**
	 * Both sides, once, at start.
	 *
	 * The same wait the other two bindings make and for the same reason: a
	 * device that reconciled against a tree it had not received yet would
	 * decide the cloud vault had no settings and push its own over them.
	 */
	private async reconcileAll(): Promise<void> {
		await withTimeout(this.docs.treeSynced(), TREE_SYNC_TIMEOUT_MS, TREE_SYNC_FAILED);
		const tree = this.docs.tree();
		const recorded = new Map(
			[...tree.attachments()].filter(([path]) => isSyncedConfig(path)),
		);
		const local = (await this.store.list()).filter((path) => isSyncedConfig(path));
		// A link starts from nothing agreed: the record belongs to whatever
		// this device was linked to before, if anything.
		const agreed = this.linking ? new Map<string, string>() : await this.loadBases();

		// **A device joining a cloud vault that already has settings adopts
		// them, and sends nothing of its own** (ADR-0099). Overlapping files
		// were always the cloud's, because every recorded path is pulled
		// below; what leaked was the rest. A joiner with Templater installed
		// pushed Templater onto everybody in the vault at link time, because
		// a file the tree had never heard of counted as new work from here
		// rather than as this device's own arrangements.
		//
		// Only on the pass that makes the link. On a later start a file that
		// is here and not up there is one somebody made, and removing it
		// would be this binding deleting settings for a living.
		const adopt = this.linking && recorded.size > 0;
		if (adopt) {
			for (const path of local) {
				if (!recorded.has(normalize(path))) await this.store.remove(path);
			}
			this.adopted();
		}
		const unrecorded = adopt ? [] : local.filter((path) => !recorded.has(normalize(path)));
		// Here, not up there, and this device once agreed it was up there:
		// another device removed it while this one was away.
		for (const path of unrecorded) {
			if (agreed.has(normalize(path))) await this.store.remove(path);
		}
		const up = unrecorded.filter((path) => !agreed.has(normalize(path)));
		const down = manifestLast(
			[...recorded.keys()].filter((path) => !local.includes(path)),
		);

		this.outstanding.up += up.length;
		this.outstanding.down += down.length;
		this.pass = { done: 0, total: up.length + recorded.size };

		for (const path of up) {
			try {
				await this.push(path);
			} finally {
				this.outstanding.up -= 1;
				this.pass.done += 1;
			}
		}
		// Everything recorded, not only what is missing: a file that is here
		// with different bytes is what the hash comparison in `pull` is for.
		for (const path of manifestLast([...recorded.keys()])) {
			const entry = recorded.get(path) as AttachmentEntry;
			const missing = down.includes(path);
			try {
				await this.meet(path, entry, agreed.get(path));
			} finally {
				if (missing) this.outstanding.down -= 1;
				this.pass.done += 1;
			}
		}
		if ([...recorded.keys()].some((path) => pluginFolderOf(path))) this.refreshRoster();
		await this.saveBases();
	}

	/**
	 * One recorded path at start, settled against what this device last
	 * agreed with rather than by the cloud winning outright (ADR-0106).
	 *
	 * If the cloud copy is still the one this device last agreed with, the
	 * cloud has not moved, so whatever differs here was done here while the
	 * plugin was not running: Obsidian's own writes before we load, a plugin
	 * turned on, a setting changed offline. That goes up. Anything else is the
	 * cloud's: it moved, or both moved and the cloud wins as it always has,
	 * or there is no record and the cloud wins as it did before records.
	 */
	private async meet(path: string, entry: AttachmentEntry, base?: string): Promise<void> {
		if (base !== undefined && base === entry.hash) {
			const local = await this.store.read(path);
			if (local === null) await this.forget(path);
			else await this.push(path, local);
			return;
		}
		await this.pull(path, entry);
	}

	// -- this device to the cloud vault --------------------------------------

	private async onLocalChange(path: string): Promise<void> {
		const content = await this.store.read(path);
		if (content === null) {
			await this.forget(path);
		} else {
			await this.carry("up", () => this.push(path, content));
		}
		await this.saveBases();
	}

	private async push(path: string, known?: ArrayBuffer): Promise<void> {
		const clean = normalize(path);
		const content = known ?? (await this.store.read(clean));
		if (content === null) return; // gone again before we got to it

		const hash = await generateHash(content);
		const tree = this.docs.tree();
		// The idempotent check, and the one that breaks the echo: this
		// binding's own writes come back as `raw` events and land here with
		// the hash already recorded.
		if (tree.attachmentFor(clean)?.hash === hash) {
			this.agreed.set(clean, hash);
			return;
		}

		try {
			await this.transport.upload(clean, content);
		} catch (error) {
			this.refused(clean, messageOf(error));
			return;
		}
		tree.setAttachment(clean, { hash, size: content.byteLength });
		this.agreed.set(clean, hash);
	}

	/** A settings file deleted here leaves the cloud vault with it. */
	private async forget(path: string): Promise<void> {
		const tree = this.docs.tree();
		this.agreed.delete(normalize(path));
		if (!tree.removeAttachment(path)) return;
		try {
			await this.transport.remove(path);
		} catch (error) {
			// Another device removing the same file first is ordinary in a
			// vault with two people in it, not a sentence worth a screen.
			this.refused(path, messageOf(error));
		}
	}

	// -- the cloud vault to this device --------------------------------------

	private async pull(path: string, entry: AttachmentEntry): Promise<void> {
		const local = await this.store.read(path);
		if (local !== null && (await generateHash(local)) === entry.hash) {
			this.agreed.set(normalize(path), entry.hash);
			return;
		}

		let content: ArrayBuffer;
		try {
			content = await this.transport.download(path);
		} catch (error) {
			this.refused(path, messageOf(error));
			return;
		}
		// No conflict copy. Both sides are settings, the newer write wins,
		// and a second copy of `appearance.json` beside the first is a file
		// nobody can see and Obsidian would not read.
		const kept = withOurselves(path, content);
		await this.store.write(path, kept);
		this.agreed.set(normalize(path), entry.hash);
		// The roster arrived without us in it and was put right here, so the
		// cloud copy is put right too, rather than switching us off on the
		// next device that takes it.
		if (kept !== content) await this.push(path, kept);
	}

	// -- what this device last agreed with -----------------------------------

	private async loadBases(): Promise<Map<string, string>> {
		if (!this.bases) return new Map();
		try {
			this.agreed = await this.bases.load();
		} catch {
			// Unreadable is the same as absent: the cloud wins, as before.
			this.agreed = new Map();
		}
		return new Map(this.agreed);
	}

	private async saveBases(): Promise<void> {
		if (!this.bases) return;
		try {
			await this.bases.save(new Map(this.agreed));
		} catch {
			// Losing the record costs the next start one cloud-wins pass.
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
