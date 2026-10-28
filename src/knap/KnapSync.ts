/**
 * The orchestrator: sign-in, the link, and the running binding, as state.
 *
 * A local vault is linked to at most one cloud vault, linking replaces
 * rather than appends, and Unlink ends the link without deleting anything
 * on either side (ADR-0066, ADR-0047). This class is that sentence as
 * code: `link` tears down whatever ran before it starts the new binding,
 * and `unlink` stops the sockets and clears the remembered vault while the
 * sign-in survives, because the account and the link are different facts.
 *
 * `signOut` is the other direction of the same distinction: the account
 * goes, and the link goes with it, because a link is to a cloud vault of
 * the account that is leaving. Holding one without a token would be a
 * settings row that says this vault syncs with something it can no longer
 * reach, and that is how a device ends up showing somebody else's folders.
 *
 * Unlink and sign out also throw away what this device remembered of the
 * cloud vault's tree. Both say on screen that nothing is deleted anywhere,
 * and a kept record would make a later relink start by deleting whatever
 * was removed here in between. No memory means no deletions, which is what
 * linking has always done.
 *
 * Persistence goes through two callbacks rather than a settings object, so
 * the host (Obsidian's data.json in production, a dict in tests) stays out
 * of the engine.
 */

import type { SyncDot, SyncWord } from "../syncStatus";
import { UP_TO_DATE, syncDot, syncWord } from "../syncStatus";
import { TREE_SYNC_FAILED, TREE_SYNC_TIMEOUT_MS, withTimeout } from "./deadline";
import type { LinkFacts, LinkReporter } from "./linkSteps";
import type { LinkChooser, LinkDiff } from "./linkSteps";
import { diffSides, isMerge, linkCounts, mergeRefusal, needsChoice, removalsFor } from "./linkSteps";
import type { SettingsLoss } from "./linkCompare";
import { hasHotkeys, pluginCount, settingsLoss } from "./linkCompare";
import { CONFIG_DIR, isSyncedConfig } from "./configPaths";
import type { AttachmentTransport, Refusal } from "./AttachmentBinding";
import { AttachmentBinding } from "./AttachmentBinding";
import type { ConfigBases, ConfigStore } from "./ConfigBinding";
import { ConfigBinding } from "./ConfigBinding";
import type { LiveNoteHandle } from "./knapEditor";
import type { LiveDrawingHandle } from "./ObsidianDrawings";
import { conflictLabelFor, personLabel } from "./person";
import { generateHash } from "../hashing";
import type { TreeDoc } from "./TreeDoc";
import { isHidden, normalize } from "./TreeDoc";
import type { FileStore, Pass, SeenTree } from "./VaultBinding";
import { VaultBinding } from "./VaultBinding";
import type { CloudVault, Fetch } from "./KnapServer";
import { KnapServer } from "./KnapServer";
import { KnapVaultClient } from "./KnapVaultClient";
import type { WebSocketImpl } from "./KnapVaultClient";
import { knapCredential, knapFault } from "./faultSink";
import type { ServerNotice } from "./notices";
import { SignInFlow } from "./SignInFlow";

/** What a link rejects with when the person cancelled the choice. */
export const LINK_CANCELLED = "Nothing was linked.";

/**
 * Asked when a link would replace this device's own settings with the cloud
 * vault's (ADR-0107). True goes ahead; false is a cancel.
 */
export type SettingsConfirm = (loss: SettingsLoss) => Promise<boolean>;

export interface KnapLink {
	token: string;
	cloudVaultId: string;
	cloudVaultName: string;
	/**
	 * Whether this device has been all the way through a first pass over
	 * this cloud vault.
	 *
	 * Persisted rather than held in memory, because the whole point of the
	 * word it drives is that a first sync is long enough for somebody to
	 * quit Obsidian in the middle of it. A restart that forgot would come
	 * back up saying Syncing over a vault that is still half here.
	 *
	 * Absent on a link made before this existed, which reads as not yet
	 * done: one extra honest Initializing, and it clears the first time the
	 * vault falls quiet.
	 */
	initialized?: boolean;
	/**
	 * Whether the settings pass that makes a link has run over this link.
	 *
	 * It is what tells a first link from an ordinary start, and the two are
	 * opposites: a link takes the cloud vault's settings and sends none of
	 * its own, while a start sends up whatever somebody changed here
	 * (ADR-0099). Held in the settings rather than in memory because
	 * quitting Obsidian in the middle of a first pass would otherwise come
	 * back as an ordinary start, and push the settings this device was
	 * about to give up into everybody else's vault.
	 *
	 * **Absent means done, and only `false` means pending.** A link made
	 * before this existed has been running as an ordinary start for weeks,
	 * so reading it as a first link would adopt over somebody's own
	 * arrangements on the next restart. `link()` writes the `false`.
	 */
	settingsInitialized?: boolean;
}

/**
 * Everything the status bar reads, in one call.
 *
 * One reading rather than five getters, because the screen and the mark in
 * the corner of the window must never disagree, and two callers asking four
 * questions each is how they start to. Whatever it says was true at one
 * instant.
 */
export interface KnapStatus {
	word: SyncWord;
	dot: SyncDot;
	/** The cloud vault this local one is linked to, or "" when it is not. */
	vaultName: string;
	/** Notes the tree holds. Zero until the tree has been read. */
	notes: number;
	/** Attachments the tree holds, counted the same way and at the same time. */
	attachments: number;
	/** Pieces of work that failed and stayed failed. */
	problems: number;
	/** Notes this device still has to send to the cloud vault. */
	up: number;
	/** Notes the cloud vault lists that are not on this device yet. */
	down: number;
	/** Attachments still to go up, and still to come down. */
	files: { up: number; down: number };
	/**
	 * How far the pass at start has got, notes and attachments apart.
	 *
	 * The four gauges above count what moves, and a restart over a vault
	 * that is already here moves nothing: every note is opened, compared and
	 * closed, which on a few thousand notes is minutes with every gauge at
	 * zero. This is the number that moves through that, so a screen can say
	 * *412 of 2,505* rather than Syncing over nothing.
	 */
	checked: { notes: Pass; attachments: Pass };
}

/** Notes and attachments together: what the corner, with room for two numbers, reads. */
export function checkedCounts(status: Pick<KnapStatus, "checked">): Pass {
	return {
		done: status.checked.notes.done + status.checked.attachments.done,
		total: status.checked.notes.total + status.checked.attachments.total,
	};
}

/** Whether the pass at start is still going: something found, not all of it through. */
export function checking(status: Pick<KnapStatus, "checked">): boolean {
	const { done, total } = checkedCounts(status);
	return total > 0 && done < total;
}

export interface KnapSyncOptions {
	serverUrl: string;
	deviceName: string;
	fetchFn: Fetch;
	files: FileStore;
	load: () => KnapLink | null;
	save: (value: KnapLink | null) => Promise<void>;
	/** Injected in tests; Obsidian's platform WebSocket by default. */
	webSocket?: WebSocketImpl;
	/**
	 * Told when an attachment cannot travel, so the host can put it on
	 * screen. A file over the ceiling is the common case, and somebody who
	 * is never told will find out when the photo is missing on their phone.
	 */
	onRefused?: Refusal;
	/** Where this device remembers a cloud vault's tree, if anywhere. */
	makeSeen?: (cloudVaultId: string) => SeenTree;
	/** Where this device remembers which settings it last agreed with, if anywhere. */
	makeConfigBases?: (cloudVaultId: string) => ConfigBases;
	/**
	 * Obsidian's own settings directory, when this host has one.
	 *
	 * Absent in tests that only care about notes, and absent is the same as
	 * the switch being off: no third binding is built.
	 */
	config?: ConfigStore;
	/**
	 * Told when the server refuses this device the vault it has linked:
	 * somebody took this account out of it, or the vault was deleted.
	 *
	 * The link is not torn down for them. Nothing local is wrong, every note
	 * is still on this disk, and a plugin that silently unlinked would turn
	 * somebody else's administrative act into a change to this machine. The
	 * sockets stop and the host says so; what to do about it is a person's
	 * call.
	 */
	onLostVault?: (vaultName: string) => void;
	/**
	 * Told when the server says something went wrong on its side (ADR-0095):
	 * a note whose name its search copy will not hold, an attachment it does
	 * not have. Nothing local is broken when one of these arrives; what it
	 * costs is that an AI cannot see that note, which is the whole reason
	 * somebody put the vault on a server.
	 */
	onNotice?: (notice: ServerNotice) => void;

	/**
	 * Told when linking took the cloud vault's settings over this device's
	 * own, which is what joining a vault that already has some does. It
	 * replaces a theme, hotkeys and plugins, so it is said out loud rather
	 * than found later (ADR-0099).
	 */
	onAdopted?: (cloudVaultName: string) => void;
}

export class KnapSync {
	readonly server: KnapServer;
	readonly flow: SignInFlow;
	private client: KnapVaultClient | null = null;
	private binding: VaultBinding | null = null;
	private attachments: AttachmentBinding | null = null;
	private settings: ConfigBinding | null = null;
	/** This account's address, as the server has it. Empty until start. */
	private person = "";
	/** Whether the server has refused this device the vault it linked. */
	private lost = false;
	/** What this vault holds on this disk, taken once per start. */
	private counts: { notes: number; attachments: number } | null = null;
	/** Whether this device is still in its first pass over the cloud vault. */
	private firstSync = false;
	/**
	 * Whether a reconciliation is running right now.
	 *
	 * The backlog gauges are the ordinary answer to "is anything moving", and
	 * they are zero for the moment between the bindings being built and the
	 * reconciliation having decided how much there is to do. A status read in
	 * that gap said Up to date over a vault whose whole contents were about to
	 * arrive, which is #40's lie in its smallest form and, worse, was enough
	 * to clear the flag below before the first pass had begun.
	 */
	private filling = false;
	/** Set while the record of that is being written, so it is written once. */
	private settling = false;

	constructor(private readonly options: KnapSyncOptions) {
		this.server = new KnapServer(options.serverUrl, options.fetchFn);
		this.flow = new SignInFlow(this.server, options.deviceName);
	}

	get linked(): KnapLink | null {
		const stored = this.options.load();
		return stored && stored.cloudVaultId ? stored : null;
	}

	get signedIn(): boolean {
		return Boolean(this.options.load()?.token);
	}

	get running(): boolean {
		return this.binding !== null;
	}

	/**
	 * What to put on the screen and in the corner of the window.
	 *
	 * Nothing here decides for itself whether things are healthy. It reads
	 * the token, the link, the socket and the queue's failure count, and
	 * hands them to `syncWord`, which owns the order those facts win in.
	 *
	 * A vault with no link is Paused rather than Up to date: nothing is
	 * moving, nothing is going to, and green over it would say the notes
	 * were safe somewhere they have never been.
	 *
	 * Syncing is "linked, connected, and the tree has not settled yet". Once
	 * the tree has been through its first exchange there is nothing this side
	 * is waiting for, and a spinner that never stops is worse than no spinner.
	 */
	status(): KnapStatus {
		const linked = this.linked;
		const connected = this.client?.connected ?? false;
		const problems = this.binding?.problems ?? 0;
		const backlog = this.binding?.backlog ?? { up: 0, down: 0 };
		const files = this.attachments?.backlog ?? { up: 0, down: 0 };
		const word = syncWord({
			signedIn: this.signedIn,
			// Signed in with nowhere to sync to is not up to date, it is
			// standing still: nothing is moving and nothing is going to
			// until somebody picks a cloud vault. Green over that vault is
			// the same lie #40 was about, and #42 already settled the word
			// for a vault waiting to be told which cloud vault it belongs
			// to. The screen says Not linked in full; the corner of the
			// window has one word to do it in.
			paused: !linked,
			// The tree settling is the socket's half of it. The backlog is the
			// notes' half, and it is the half that lasts: a tree settles in
			// seconds over a vault whose bodies are hours away, and green over
			// that is exactly the lie #40 was about.
			syncing:
				this.filling ||
				(Boolean(this.client) && !this.client?.settled) ||
				backlog.up + backlog.down + files.up + files.down > 0,
			// Which way the notes are going, so the word can say Uploading or
			// Downloading rather than the general Syncing (ADR-0089). Notes
			// and attachments together, because the word is about direction
			// and both kinds travel the same road.
			up: backlog.up + files.up,
			down: backlog.down + files.down,
			// Not linked is not offline: there is no socket because there is
			// nothing to open one to, and saying Offline would send somebody
			// to check their wifi over a vault they never linked.
			connected: linked ? connected : undefined,
			stuck: problems,
			lost: this.lost,
			// The first pass over a newly linked vault, which is the one a
			// person must not close Obsidian in the middle of (ADR-0090).
			initial: this.firstSync,
		});
		// A vault that has fallen quiet has finished its first pass, and this
		// is where that becomes true: the word above is the only reader of
		// the flag, and this is the moment it stopped mattering. Written to
		// the settings once, so a restart mid-fill still says Initializing
		// and a restart after one does not.
		if (this.firstSync && word === UP_TO_DATE) {
			this.firstSync = false;
			void this.rememberInitialized();
			void this.recount();
		}
		return {
			word,
			dot: syncDot(word),
			vaultName: linked?.cloudVaultName ?? "",
			notes: this.client ? this.client.tree().entries().size : 0,
			attachments: this.client ? this.client.tree().attachments().size : 0,
			problems,
			up: backlog.up,
			down: backlog.down,
			files,
			checked: this.checked(),
		};
	}

	/**
	 * How far the pass at start has got, by kind of file.
	 *
	 * The two halves run one after the other, notes first, and the attachment
	 * half does not know its own size until it starts. Read as it stands, the
	 * total would sit at the note count for the whole of the first half and
	 * then grow, which drops a bar that had just filled back to most of the
	 * way. So while the fill is on and the attachment half has not begun, its
	 * total is what the tree records, which is what that half will count
	 * once it does, give or take the files that are only here.
	 */
	private checked(): KnapStatus["checked"] {
		const notes = this.binding?.checked ?? { done: 0, total: 0 };
		let attachments = this.attachments?.checked ?? { done: 0, total: 0 };
		if (this.filling && attachments.total === 0 && this.client) {
			attachments = { done: 0, total: this.client.tree().attachments().size };
		}
		return { notes, attachments };
	}

	/** Sign in: browser out, deep link back, token kept. No link yet. */
	async signIn(openUrl: (url: string) => void): Promise<void> {
		const token = await this.flow.begin(openUrl);
		const previous = this.options.load();
		await this.options.save({
			token,
			cloudVaultId: previous?.cloudVaultId ?? "",
			cloudVaultName: previous?.cloudVaultName ?? "",
		});
	}

	handleDeepLink(params: Record<string, string>): boolean {
		return this.flow.handleDeepLink(params);
	}

	async listVaults(): Promise<CloudVault[]> {
		const stored = this.options.load();
		if (!stored?.token) {
			throw new Error("Sign in first.");
		}
		return this.server.listVaults(stored.token);
	}

	/**
	 * Link this local vault to one cloud vault. Replaces, never appends.
	 *
	 * `report` is told as each of the nine steps finishes, so the screen can
	 * say what is being counted and what it found rather than sitting on a
	 * spinner for however long the tree takes (ADR-0090). It is optional
	 * because the command palette links too, and a notice is all that entry
	 * point has room for.
	 */
	async link(
		vault: CloudVault,
		report?: LinkReporter,
		choose?: LinkChooser,
		confirmSettings?: SettingsConfirm,
	): Promise<void> {
		const stored = this.options.load();
		if (!stored?.token) {
			throw new Error("Sign in first.");
		}
		this.stop();
		// A fresh link starts with no record of what this device last agreed
		// with. A record left over would read a note the choice below just
		// took off this disk as one deleted here, and delete it in the cloud.
		try {
			await this.options.makeSeen?.(vault.id).forget();
		} catch {
			// The same as forgetSeen: nothing to say and nothing to do.
		}
		await this.options.save({
			token: stored.token,
			cloudVaultId: vault.id,
			cloudVaultName: vault.name,
			// A fresh link has not been through a first pass, whatever the
			// last vault this device was linked to had been through.
			initialized: false,
			settingsInitialized: false,
		});
		// The one entry point that checks: a link is being made here, so
		// this is the only moment comparing the two sides means anything.
		// Every later start runs over a link that was already allowed, and
		// by then both sides hold the same notes on purpose (ADR-0098).
		await this.start(report, true, choose, confirmSettings);
	}

	/** End the link. Stops the syncing, deletes nothing on either side. */
	async unlink(): Promise<void> {
		this.stop();
		await this.forgetSeen();
		const stored = this.options.load();
		if (stored) {
			await this.options.save({ ...stored, cloudVaultId: "", cloudVaultName: "" });
		}
	}

	/**
	 * End the sign-in on this device: sockets down, token handed back, and
	 * everything this vault remembered about the account forgotten.
	 *
	 * The local half always happens, network or no network. Somebody
	 * pressing this on a train is signing out, and a plugin that refused
	 * because it could not reach anything would leave them signed in with
	 * an error on screen. `endedRemotely` says which of the two it was, so
	 * the screen can be honest about a token that may still be live.
	 */
	async signOut(): Promise<{ endedRemotely: boolean }> {
		this.stop();
		this.flow.cancel(new Error("Signed out before this sign-in finished."));
		await this.forgetSeen();
		const stored = this.options.load();
		let endedRemotely = true;
		if (stored?.token) {
			try {
				await this.server.signOut(stored.token);
			} catch {
				// Swallowed on purpose: whatever went wrong out there does
				// not change what happens here, and the only thing the
				// screen needs from it is that it did not land.
				endedRemotely = false;
			}
		}
		await this.options.save(null);
		knapCredential("");
		return { endedRemotely };
	}

	/**
	 * Bring the link up, if there is one. Safe to call at plugin load.
	 *
	 * A start somebody is watching, which is the link modal, gives up on the
	 * tree after a deadline, because a person is looking at a screen that
	 * has to end. A start nobody is watching waits for as long as the link
	 * exists. Until 2026-09-02 it too gave up after half a minute, and
	 * Obsidian opened on a train, or during a deploy, was a vault that never
	 * came up: the notice said it would retry at the next sign-in, nothing
	 * did, and once the server was back the status read Up to date over a
	 * binding that had never been built. The socket underneath reconnects on
	 * its own the whole time, so the honest thing is to wait on it, and the
	 * word on screen says Offline while it does.
	 */
	/**
	 * Compare both sides path by path. Notes compare against the hash the
	 * server's mirror wrote into the tree, attachments against their entry.
	 */
	private async compare(
		tree: TreeDoc,
		localNotes: string[],
		localAttachments: string[],
	): Promise<LinkDiff> {
		const cloud = new Map<string, string | undefined>();
		const notes = new Set(localNotes);
		for (const [path, docId] of tree.entries()) {
			cloud.set(normalize(path), tree.hashFor(docId));
			notes.add(normalize(path));
		}
		for (const [path, entry] of tree.attachments()) {
			if (!isHidden(path)) cloud.set(normalize(path), entry.hash);
		}
		const { files } = this.options;
		return diffSides(cloud, [...localNotes, ...localAttachments], notes, async (path) => {
			if (notes.has(path)) {
				const text = await files.read(path);
				return text === null ? null : generateHash(new TextEncoder().encode(text));
			}
			const bytes = await files.readBinary(path);
			return bytes === null ? null : generateHash(bytes);
		});
	}

	/**
	 * Both sides' settings, for the comparison and the question (ADR-0107).
	 * Null without a config directory. `adopting` is whether this pass takes
	 * the cloud vault's settings, which is the only time anything is lost.
	 */
	private async settingsPicture(
		tree: TreeDoc,
		adopting: boolean,
	): Promise<{ cloudPlugins: number; localPlugins: number; loss: SettingsLoss | null } | null> {
		const config = this.options.config;
		if (!config) return null;
		const cloud = [...tree.attachments().keys()].filter((path) => isSyncedConfig(path));
		const local = (await config.list()).filter((path) => isSyncedConfig(path));
		let loss: SettingsLoss | null = null;
		if (adopting) {
			const hotkeys = `${CONFIG_DIR}/hotkeys.json`;
			const bytes = await config.read(hotkeys);
			const text = bytes === null ? null : new TextDecoder().decode(bytes);
			const theirs = tree.attachmentFor(hotkeys)?.hash;
			const ours = bytes === null ? null : await generateHash(bytes);
			loss = settingsLoss(cloud, local, hasHotkeys(text) && ours !== theirs);
		}
		return { cloudPlugins: pluginCount(cloud), localPlugins: pluginCount(local), loss };
	}

	private tellMoves(plan: ReturnType<typeof linkCounts>, facts: LinkFacts, tell: LinkReporter): void {
		facts.downloadNotes = plan.downloadNotes;
		facts.downloadAttachments = plan.downloadAttachments;
		tell("toDownload", facts);
		facts.uploadNotes = plan.uploadNotes;
		facts.uploadAttachments = plan.uploadAttachments;
		tell("toUpload", facts);
	}

	async start(
		report?: LinkReporter,
		linking = false,
		choose?: LinkChooser,
		confirmSettings?: SettingsConfirm,
	): Promise<void> {
		const stored = this.linked;
		if (!stored || this.binding) {
			return;
		}
		const tell: LinkReporter = report ?? (() => undefined);
		const facts: LinkFacts = {};
		// Who we are, for the caret and the conflict copies. Asked once per
		// start rather than per label, and never fatal: an address we could
		// not fetch leaves both falling back to the device name, which is
		// what they said before this existed.
		// Whose device this is, before anything can fail: a fault raised in
		// this start may say more because of it (ADR-0095).
		knapCredential(stored.token);
		this.person = await this.whoAmI(stored.token);
		this.lost = false;
		// A link that has never finished a pass is still in its first one,
		// and so is one whose settings predate this field.
		this.firstSync = stored.initialized !== true;
		// What this vault holds on this disk, counted once per start. The
		// number rides along on every socket so the server can say "1773 of
		// 2611 notes" while a fill is behind, instead of a bare count that
		// reads as complete. Stale within a session is fine: the local total
		// barely moves, and every restart takes it fresh. The exception is a
		// first fill, which recount() catches when it ends.
		//
		// Taken before the first socket opens, which is why the two local
		// steps are reported after the two cloud ones despite happening
		// first: the socket carries these numbers, so they have to exist
		// before it does.
		const localNotes = (await this.options.files.listNotes()).map(normalize);
		const localAttachments = (await this.options.files.listAttachments()).map(normalize);
		this.counts = { notes: localNotes.length, attachments: localAttachments.length };
		this.client = new KnapVaultClient(
			this.server,
			stored.cloudVaultId,
			stored.token,
			this.options.deviceName,
			this.options.webSocket,
			() => this.loseVault(stored.cloudVaultName),
			() => this.counts,
			this.options.onNotice,
		);
		// The tree, before anything is counted against it. Both bindings make
		// this same wait for the same reason, and making it here as well costs
		// nothing (it is the same already-settled promise by then) and buys
		// the screen a Connecting step that ends when the connection is real.
		const client = this.client;
		const treeSynced = client.treeSynced();
		try {
			await (report
				? withTimeout(treeSynced, TREE_SYNC_TIMEOUT_MS, TREE_SYNC_FAILED)
				: treeSynced);
		} catch (error) {
			// The wait ends on its own when the client goes: an unlink, a sign
			// out or a retry while the server was still away. None of those
			// is a failure of this start, so none of them is reported as one.
			if (this.client !== client) return;
			knapFault("link", error);
			throw error;
		}
		if (this.client !== client) return;
		tell("connecting", facts);
		const tree = this.client.tree();
		const cloudNotes = tree.entries();
		// Settings ride in the attachment map too, and they are not what a
		// person counts as attachments, nor what the notes choice is about.
		const cloudAttachments = new Map(
			[...tree.attachments()].filter(([path]) => !isHidden(path)),
		);
		facts.cloudNotes = cloudNotes.size;
		tell("cloudNotes", facts);
		facts.cloudAttachments = cloudAttachments.size;
		tell("cloudAttachments", facts);
		facts.localNotes = localNotes.length;
		tell("localNotes", facts);
		facts.localAttachments = localAttachments.length;
		tell("localAttachments", facts);
		// The four counts are in, and this is the last moment nothing has been
		// written. A link compares both sides first. When both hold notes and
		// they are not the same, the person picks: keep both, or make one
		// side the same as the other (ADR-0105). Without anybody to ask, it
		// is refused as before (ADR-0098): the link comes off again and every
		// file on this disk is untouched.
		// Asked at most once per start, whichever of the two places below
		// asks first.
		let travel: Promise<boolean> | null = null;
		const settingsTravel = () =>
			(travel ??= this.options.config
				? this.settingsTravel(stored.token, stored.cloudVaultId)
				: Promise.resolve(false));
		let cloudSide = { notes: [...cloudNotes.keys()], attachments: [...cloudAttachments.keys()] };
		let localSide = { notes: localNotes, attachments: localAttachments };
		if (linking) {
			const diff = await this.compare(tree, localNotes, localAttachments);
			if (this.client !== client) return;
			const different = diff.different.filter((path) => diff.notes.has(path)).length;
			facts.differentNotes = different;
			facts.differentAttachments = diff.different.length - different;
			facts.onlyCloudNotes = diff.onlyCloud.filter((path) => diff.notes.has(path)).length;
			facts.onlyLocalNotes = diff.onlyLocal.filter((path) => diff.notes.has(path)).length;
			const settings = (await settingsTravel())
				? await this.settingsPicture(tree, stored.settingsInitialized === false)
				: null;
			if (this.client !== client) return;
			if (settings) {
				facts.cloudPlugins = settings.cloudPlugins;
				facts.localPlugins = settings.localPlugins;
			}
			tell("different", facts);
			// Settings first, because the notes choice below deletes and this
			// question must come while nothing has been written (ADR-0107).
			if (settings?.loss && confirmSettings) {
				if (choose) this.tellMoves(linkCounts(cloudSide, localSide), facts, tell);
				if (!(await confirmSettings(settings.loss))) {
					await this.unlink();
					throw new Error(LINK_CANCELLED);
				}
				if (this.client !== client) return;
			}
			if (isMerge(facts) && needsChoice(diff)) {
				// The rows are the scan: what differs, and what is on one side
				// only, counted as Keep both would move it. The choice may
				// change the two move rows, and they are told again below.
				if (choose) this.tellMoves(linkCounts(cloudSide, localSide), facts, tell);
				const choice = choose ? await choose(diff) : null;
				if (choice === null) {
					await this.unlink();
					throw new Error(
						choose ? LINK_CANCELLED : mergeRefusal(stored.cloudVaultName, facts),
					);
				}
				if (this.client !== client) return;
				const gone = removalsFor(choice, diff);
				for (const path of gone.local) await this.options.files.remove(path);
				if (gone.cloud.length > 0) {
					tree.doc.transact(() => {
						for (const path of gone.cloud) {
							if (!tree.remove(path)) tree.removeAttachment(path);
						}
					});
				}
				const without = (paths: string[], drop: string[]) => {
					const dropped = new Set(drop);
					return paths.filter((path) => !dropped.has(normalize(path)));
				};
				cloudSide = {
					notes: without(cloudSide.notes, gone.cloud),
					attachments: without(cloudSide.attachments, gone.cloud),
				};
				localSide = {
					notes: without(localNotes, gone.local),
					attachments: without(localAttachments, gone.local),
				};
			}
		}
		this.tellMoves(linkCounts(cloudSide, localSide), facts, tell);
		this.binding = new VaultBinding(
			this.options.files,
			this.client,
			() => conflictLabelFor(this.person, this.options.deviceName, new Date()),
			this.options.makeSeen?.(stored.cloudVaultId) ?? null,
		);
		this.attachments = new AttachmentBinding(
			this.options.files,
			this.client,
			this.transportFor(stored.token, stored.cloudVaultId),
			this.options.onRefused,
			() => conflictLabelFor(this.person, this.options.deviceName, new Date()),
		);
		// Two conditions: whether this host can carry settings at all, and
		// the vault's own Sync settings switch, which is set on its page in
		// the panel and nowhere here. Asked once per start, so turning it off
		// reaches a device at its next start.
		const travels = await settingsTravel();
		this.settings =
			this.options.config && travels
				? new ConfigBinding(
						this.options.config,
						this.client,
						this.transportFor(stored.token, stored.cloudVaultId),
						this.options.onRefused,
						// Not the `linking` argument: a link whose first pass
						// died halfway is still a first link on the next
						// start, and this is the flag that survives the quit.
						stored.settingsInitialized === false,
						() => this.options.onAdopted?.(stored.cloudVaultName),
						this.options.makeConfigBases?.(stored.cloudVaultId) ?? null,
					)
				: null;
		// Set before the screen is told, so a status read on the back of that
		// report sees a vault that is filling rather than one that is quiet.
		this.filling = true;
		// The link exists here, and this is where the screen is told so: both
		// bindings are built over a tree that has synced, and everything after
		// this line is the first pass itself.
		//
		// **Said before the fill rather than after it**, which is the whole
		// point. `binding.start()` waits for the entire reconciliation, and on
		// a vault of a few thousand notes that is minutes. Until this, linking
		// resolved at the far end of that wait: the picker closed, nothing
		// happened, and the notice saying it had worked arrived long after the
		// person had gone looking for what went wrong (ADR-0090).
		tell("linked", facts);
		try {
			// Notes first. Both wait for the same tree to sync, and a vault
			// whose notes are already arriving is the one somebody is looking
			// at.
			await this.binding.start();
			await this.attachments.start();
			// Last, and on purpose. Somebody who has just linked is waiting
			// for their notes, and a plugin folder is megabytes in front of
			// the note they opened Obsidian to read.
			await this.settings?.start();
			// The settings half is over, whichever way it ran, so every later
			// start over this link is an ordinary one. Not while the vault
			// has the switch off: the pass has not happened, and a device
			// that joined then still adopts the vault's settings the first
			// time they travel, rather than pushing its own over everybody's.
			if (this.settings || !this.options.config) {
				await this.rememberSettingsInitialized();
			}
		} finally {
			this.filling = false;
		}
	}

	/**
	 * Write down that this device has been through a first pass.
	 *
	 * Never fatal, and never retried: the cost of losing this write is one
	 * more Initializing after the next restart, which is a word rather than a
	 * wrong outcome. The guard is against the settings being written every
	 * second, because the reader of the flag is a status the screen ticks.
	 */
	private async rememberInitialized(): Promise<void> {
		if (this.settling) return;
		this.settling = true;
		try {
			const stored = this.options.load();
			if (stored?.cloudVaultId) {
				await this.options.save({ ...stored, initialized: true });
			}
		} catch {
			// See above.
		} finally {
			this.settling = false;
		}
	}

	/**
	 * Count this disk again once a first pass is through.
	 *
	 * The count at start was taken before the fill, so on a vault that came
	 * down empty it says 1 for the rest of the session (#181). Sockets opened
	 * from here on carry the new number. Never fatal: a failed count leaves
	 * the old one, which the next restart replaces anyway.
	 */
	private async recount(): Promise<void> {
		try {
			const notes = await this.options.files.listNotes();
			const attachments = await this.options.files.listAttachments();
			this.counts = { notes: notes.length, attachments: attachments.length };
		} catch {
			// See above.
		}
	}

	/**
	 * Write down that the settings pass is behind this link.
	 *
	 * Once, at the end of the first pass, and never fatal for the same
	 * reason `rememberInitialized` is not. Losing this write costs one more
	 * pass that reads the cloud vault as the source, which is the same
	 * outcome the first one reached.
	 */
	private async rememberSettingsInitialized(): Promise<void> {
		try {
			const stored = this.options.load();
			if (stored?.cloudVaultId && stored.settingsInitialized === false) {
				await this.options.save({ ...stored, settingsInitialized: true });
			}
		} catch {
			// See above.
		}
	}

	/**
	 * Whether the linked vault's settings travel, by its switch in the panel.
	 *
	 * Off when the answer cannot be had. Settings are last-write-wins across
	 * everybody in the vault, so a device that guessed on would push its
	 * theme over theirs; a device that guessed off syncs its settings one
	 * start later. A vault missing from the list is one this account can no
	 * longer open, and the socket says so in its own words.
	 */
	private async settingsTravel(token: string, vaultId: string): Promise<boolean> {
		try {
			const vaults = await this.server.listVaults(token);
			return vaults.find((v) => v.id === vaultId)?.syncSettings === true;
		} catch (error) {
			knapFault("link", error);
			return false;
		}
	}

	/**
	 * This account's address, or "" when the server will not say.
	 *
	 * Swallowed on purpose. Both callers have a fallback that predates this
	 * route, and a link that would not come up because a label could not be
	 * fetched would be a worse plugin than one whose carets say
	 * `MacBook-Pro-2`.
	 */
	private async whoAmI(token: string): Promise<string> {
		try {
			return (await this.server.me(token)).email;
		} catch (error) {
			knapFault("auth", error);
			return "";
		}
	}

	/**
	 * The server has refused this device the vault: somebody took this
	 * account out of it, or the vault is gone.
	 *
	 * The client has already stopped its sockets by the time this runs. What
	 * is left is to stop the bindings, so no local edit queues up against a
	 * vault this device can no longer reach, and to tell the host. The stored
	 * link stays: every note is still on this disk, and unlinking on somebody
	 * else's say-so is not this plugin's call to make.
	 */
	private loseVault(vaultName: string): void {
		if (this.lost) return;
		this.lost = true;
		this.binding?.stop();
		this.attachments?.stop();
		this.settings?.stop();
		this.binding = null;
		this.attachments = null;
		this.settings = null;
		this.options.onLostVault?.(vaultName);
	}

	/** The file routes, bound to one vault and one token. */
	private transportFor(token: string, vaultId: string): AttachmentTransport {
		const server = this.server;
		return {
			upload: (path, content) => server.uploadFile(token, vaultId, path, content),
			download: (path) => server.downloadFile(token, vaultId, path),
			remove: (path) => server.deleteFile(token, vaultId, path),
			limits: () => server.limits(token),
		};
	}

	/**
	 * The live note behind one vault path, for an editor to bind to.
	 *
	 * Null in every case where binding would be a guess: no link, a note the
	 * cloud vault has never heard of, or a socket that has not finished its
	 * first sync. That last one matters more than it looks. A document that
	 * is still syncing is empty, and an editor bound to an empty document
	 * reads it as a note nobody has typed in and offers the file's text to
	 * fill it, so the note would arrive a moment later and be merged with a
	 * copy of itself. The editor asks again once `whenSynced` says the
	 * document is there, and by then the answer is a real document.
	 *
	 * Pinning is what keeps the note out of the socket pool for as long as
	 * the editor has it. A note that is already open in the pool, which is
	 * what a note somebody opens during a fill usually is, is promoted where
	 * it stands: same document, same socket, same sync, nothing repeated.
	 */
	openNote(path: string): LiveNoteHandle | null {
		const clean = normalize(path);
		if (!this.client || !this.binding) return null;
		const docId = this.client.tree().docIdFor(clean);
		if (!docId) return null;
		const note = this.client.pin(docId);
		if (!note.provider.synced) {
			// Handed straight back, so a note the editor did not take is a
			// note the pool may still close.
			note.release();
			return null;
		}
		const unhold = this.binding.hold(clean);
		return {
			text: note.text,
			awareness: note.provider.awareness,
			// What the other people in this note see beside the caret. The
			// device name is the fallback, not the answer: it reads fine on
			// your own second laptop and names nobody to a colleague.
			who: personLabel(this.person, this.options.deviceName),
			// The file is caught up from the document first, and only then
			// does the note go back into the pool, where it stays open until
			// the pool needs the socket for something else.
			release: () => {
				unhold();
				note.release();
			},
		};
	}

	/**
	 * The live document behind one drawing, for an open Excalidraw view to
	 * bind to (ADR-0109). Null where `openNote` would say null, for the same
	 * reasons.
	 *
	 * Unlike a note in an editor, the file binding does not stand down: the
	 * text around a drawing's scene still travels through the file, so the
	 * binding is asked to follow the note instead, for as long as it is pinned.
	 */
	openDrawing(path: string): LiveDrawingHandle | null {
		const clean = normalize(path);
		if (!this.client || !this.binding) return null;
		const docId = this.client.tree().docIdFor(clean);
		if (!docId) return null;
		const note = this.client.pin(docId);
		if (!note.provider.synced) {
			note.release();
			return null;
		}
		void this.binding.follow(clean);
		return {
			doc: note.doc,
			awareness: note.provider.awareness,
			who: personLabel(this.person, this.options.deviceName),
			release: () => note.release(),
		};
	}

	/**
	 * Call `ready` once the note behind `path` has finished its first sync, so
	 * an editor that `openNote` turned away can ask again straight away.
	 *
	 * Waiting for the editor's next update was not enough. On 2026-09-20 a
	 * phone opened a note whose socket synced a moment later, nothing updated
	 * the editor in between, and the person typed into an empty page that
	 * the document never filled (issue #169). Held open while it waits, so
	 * the pool cannot close the socket it is waiting on. Returns the cancel,
	 * which an editor that closes or moves to another note must call.
	 */
	whenSynced(path: string, ready: () => void): () => void {
		const docId = this.client?.tree().docIdFor(normalize(path));
		if (!this.client || !docId) return () => undefined;
		const note = this.client.pin(docId);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			note.provider.off("synced", onSynced);
			note.release();
		};
		const onSynced = (synced: boolean) => {
			if (!synced || done) return;
			finish();
			ready();
		};
		if (note.provider.synced) {
			// Never inside the caller's own update: CodeMirror refuses a
			// dispatch while one is running.
			void Promise.resolve().then(() => onSynced(true));
		} else {
			note.provider.on("synced", onSynced);
		}
		return finish;
	}

	/**
	 * Forget the tree this device remembered. Never fatal: the caller is
	 * unlinking or signing out, and a record that outlives it costs a relink
	 * that deletes nothing, which is the same thing the record not existing
	 * would have done.
	 */
	private async forgetSeen(): Promise<void> {
		const id = this.options.load()?.cloudVaultId;
		if (!id || !this.options.makeSeen) return;
		try {
			await this.options.makeSeen(id).forget();
		} catch {
			// Nothing to say and nothing to do: see above.
		}
	}

	/**
	 * Take the link down and bring it straight back up.
	 *
	 * What the button under Problem and Offline does. The failure count lives
	 * on the binding, so a fresh binding starts at zero, which is the honest
	 * reading: the word goes back to whatever is true after the retry rather
	 * than staying red on the strength of what already happened.
	 */
	async retry(): Promise<void> {
		this.stop();
		await this.start();
	}

	stop(): void {
		this.filling = false;
		this.settings?.stop();
		this.settings = null;
		this.attachments?.stop();
		this.attachments = null;
		this.binding?.stop();
		this.binding = null;
		this.client?.destroy();
		this.client = null;
	}
}
