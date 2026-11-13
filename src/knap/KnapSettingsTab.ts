/**
 * The one screen the rebuilt client has: an account, a cloud vault, and how
 * that vault is doing.
 *
 * It exists because the commands were the only way in, and a command palette
 * is where somebody looks after they already know the thing is there. Asked to
 * try the beta, the first thing a person does is open Settings and look for a
 * button, and in a beta build the relay's own tab is hidden, so they found
 * nothing at all.
 *
 * **Three rows and a strip, in the order they depend on each other**: Account is
 * who, Cloud vault is what this vault syncs with, the strip under it is how
 * that vault is going, and Pantalytics dashboard is the way out to the page where a
 * colleague gets let in and an AI gets connected. The strip was the first thing on the screen until
 * 2026-09-02, floating above the two rows as if it were a third subject; it is
 * a fact about one cloud vault, so it now sits inside that row's block, sharing
 * its border, and it appears only where there is a link.
 *
 * The Cloud vault row is a name and nothing else. The sentence about a delete
 * travelling both ways moved to the screen that links (#116 put it here, and
 * where it belongs is where somebody is choosing rather than on a row they
 * read every week).
 * There is no server field (ADR-0033), no scope picker (ADR-0043), and no
 * second kind of member to set (ADR-0034). There is also no Change button:
 * linking somewhere else is Unlink and then Choose, which is what happens
 * underneath either way, and a third button to say so is a third button.
 *
 * The strip is the only thing on the screen that folds. That is the hierarchy:
 * the dot and the word are always out, the size sits beside them, and the
 * counts behind them come out when somebody asks. Nothing deeper is kept here
 * at all. What went wrong in detail is on the server, and the device only ever
 * tells it four content-free facts (ADR-0071).
 *
 * Signed in, there is always a way back out. A screen that can only sign in is
 * one a person cannot hand their laptop on from, and the only alternative was
 * uninstalling the plugin, which leaves the token alive anyway.
 */

import { Notice, type Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";

import {
	DOWNLOADING,
	INITIALIZING,
	OFFLINE,
	PROBLEM,
	UPLOADING,
	syncCounts,
	syncInstruction,
} from "../syncStatus";
import {
	checkedCounts,
	checking,
	type KnapStatus,
	type KnapSync,
} from "./KnapSync";

/**
 * What to say after a sign-out. One sentence, two entry points: this button
 * and the command in the palette, which must not drift apart into two
 * accounts of the same act.
 */
export function signOutNotice(endedRemotely: boolean): string {
	return endedRemotely
		? "Signed out. Nothing was deleted, anywhere."
		: "Signed out here only. Pantalytics could not be reached, so it may still count this device as signed in.";
}

/** The last row, and the only one that is there whatever the vault is doing. */
export const TOTAL = "Total";

/** The first row while the pass at start is going: how far it has got. */
export const CHECKED = "Checked";

/**
 * What the head says at its far end.
 *
 * The size of the vault, except while the pass at start is going, when it is
 * how far that pass has got: *412 of 2,505*. A restart over a vault that is
 * already here opens every note, compares it and closes it, and on a few
 * thousand notes that is minutes with nothing on the move. The head said
 * *Syncing* beside *2,505 notes* through all of it, which reads as 2,505
 * notes still to go and gives no way to tell a pass that is going from one
 * that is stuck. A number that climbs once a second answers both.
 *
 * Notes and attachments together, the way the corner says it, because the
 * head has room for one number. The row behind the fold keeps them apart.
 */
export function headCount(status: KnapStatus): string {
	if (checking(status)) {
		const { done, total } = checkedCounts(status);
		return syncCounts(done, total);
	}
	if (status.notes > 0) return `${count(status.notes)} note${status.notes === 1 ? "" : "s"}`;
	return "";
}

/**
 * The facts behind the fold, for one reading.
 *
 * Pure, and exported, because it is the half of the strip worth pinning in a
 * test: which facts appear depends on the word, and a fact that appears with
 * nothing to say is the sort of empty row this screen exists to be rid of.
 *
 * Three kinds of row, in the order somebody reads them. The two directions
 * are named the way the words above them are (ADR-0089), because a person
 * watching *Uploading* wants the same word on the line that counts it. Then
 * Total: what the cloud vault holds, which nothing else on this screen says
 * and which is the one number that can be held against Knap's own page.
 *
 * **The vault's name is not here**, because the row a hairline above carries
 * it. That was #125's repetition, and moving the strip under that row would
 * have brought it back.
 */
export function statusFacts(status: KnapStatus): Array<[string, string]> {
	const facts: Array<[string, string]> = [];
	// The pass at start, by kind, while it is going. The two halves run one
	// after the other, so the row names the one that is under way, and the
	// half that is through says so in one word rather than as a fraction
	// of itself.
	const checked = checkedText(status);
	if (checked) facts.push([CHECKED, checked]);
	// The corner has room for two numbers and adds the two kinds of file
	// together to get them. This is the screen with room to keep them apart,
	// and attachments are worth keeping apart: one photo is a hundred notes'
	// worth of bytes, so a single number sits still and then jumps (ADR-0088).
	const going = pieces(status.up, status.files.up);
	if (going) facts.push([UPLOADING, going]);
	const coming = pieces(status.down, status.files.down);
	if (coming) facts.push([DOWNLOADING, coming]);
	if (status.problems > 0) {
		facts.push([
			"Could not sync",
			`${status.problems} change${status.problems === 1 ? "" : "s"}`,
		]);
	}
	const held = pieces(status.notes, status.attachments);
	if (held) facts.push([TOTAL, held]);
	return facts;
}

/** "412 of 2,505 notes", then "all notes, 12 of 338 attachments"; empty once through. */
function checkedText(status: KnapStatus): string {
	if (!checking(status)) return "";
	const { notes, attachments } = status.checked;
	const parts: string[] = [];
	if (notes.total > 0) {
		parts.push(
			notes.done < notes.total
				? `${syncCounts(notes.done, notes.total)} notes`
				: "all notes",
		);
	}
	if (attachments.total > 0 && notes.done >= notes.total) {
		parts.push(`${syncCounts(attachments.done, attachments.total)} attachments`);
	}
	return parts.join(", ");
}

/** "412 notes, 3 attachments", or as much of it as is above zero. */
function pieces(notes: number, files: number): string {
	const parts: string[] = [];
	if (notes > 0) parts.push(`${count(notes)} note${notes === 1 ? "" : "s"}`);
	if (files > 0) parts.push(`${count(files)} attachment${files === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function count(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * The one sentence this screen still says, and only under one word.
 *
 * Every other word's instruction went on 2026-09-02: they told somebody to
 * wait, over a strip whose counts already say what is being waited for.
 * Initializing keeps its own, because it is the one asking for something a
 * person would not otherwise do (ADR-0090): leave Obsidian open.
 */
export function barSentence(word: KnapStatus["word"]): string {
	return word === INITIALIZING ? syncInstruction(word) : "";
}

/**
 * Whether the strip has anything folded away at all.
 *
 * Almost always, now that Total is behind it: a linked vault holds notes, and
 * that count is what somebody opens the fold for. It stays a question rather
 * than a constant because a vault whose tree has not been read yet counts
 * nothing, and a head that opens onto an empty strip is worse than a head that
 * does not open.
 */
export function hasFold(status: KnapStatus): boolean {
	return Boolean(barSentence(status.word)) || statusFacts(status).length > 0 || hasRetry(status);
}

/** Only the two words a person can do something about get a button here. */
export function hasRetry(status: KnapStatus): boolean {
	return status.word === PROBLEM || status.word === OFFLINE;
}

/**
 * Where Open lands: the Vaults page of the Pantalytics dashboard, which lists
 * every cloud vault of the workspace with its devices. Since the cutover of
 * 2026-10-13 a vault has no page of its own there, so the link is the same
 * whether this vault is linked or not.
 */
export function dashboardUrl(serverUrl: string): string {
	const base = serverUrl.replace(/\/+$/, "");
	return `${base}/admin/vaults`;
}

/**
 * The two sentences behind the (i), and everything this row says beyond its
 * own name.
 *
 * It names the address because the button leaves Obsidian, and a button that
 * opens a browser owes somebody the host it is about to open. The rest is what
 * is worth going there for: the two things Obsidian deliberately cannot do
 * (ADR-0031, ADR-0034).
 */
export function dashboardHelp(serverUrl: string): string {
	return `Opens ${hostOf(serverUrl)} in your browser. Add people to your workspace, connect your AI over MCP.`;
}

/** The two acts the buttons perform, so the screen shares them with the commands. */
export interface SignInActions {
	/** Starts the browser half and resolves when the deep link comes back. */
	signIn(): Promise<void>;
	/** Offers the account's cloud vaults and links the one that is picked. */
	pickAndLink(): Promise<void>;
}

export class KnapSettingsTab extends PluginSettingTab {
	/** The plugin. The tick below is its to own, so an unload takes it. */
	private readonly owner: Plugin;
	/** Where the bar is drawn, so a tick can redraw it and nothing else. */
	private statusEl: HTMLElement | null = null;
	/** Whether the fold is open. A field, so a redraw does not close it. */
	private open = false;
	/** Whether the (i) under the dashboard row is showing. A field, for the same reason. */
	private helpOpen = false;
	/** What the bar last said, so a tick that changes nothing draws nothing. */
	private said = "";
	/** Set while a retry is in flight, so the button can say it is going. */
	private trying = false;
	/** The tick, while this screen is on. */
	private ticker: number | null = null;

	/**
	 * ``plugin`` is the real plugin, not a stand-in. Obsidian registers the tab
	 * against it, and handing it an object that merely looks like one threw
	 * during onload, which took everything registered after that call with it,
	 * the ribbon icon included.
	 */
	constructor(
		plugin: Plugin,
		private readonly sync: KnapSync,
		private readonly actions: SignInActions,
		private readonly serverUrl: string,
		/** How a page gets opened. Injected so a test can watch where it went. */
		private readonly openPage: (url: string) => void = (url) => {
			window.open(url);
		},
	) {
		super(plugin.app, plugin);
		this.owner = plugin;
	}

	/** The screen is closed: the tick stops with it. */
	hide(): void {
		this.stopTick();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// Redrawn from scratch, so whatever the bar was drawn into has gone
		// and the tick has nothing to paint until this pass makes a new slot.
		this.stopTick();
		this.statusEl = null;
		this.said = "";

		// The server, once, quietly, where a plugin's own subtitle goes. It
		// belongs on the screen because a beta build talks to somewhere other
		// than the release does, and nowhere near a button, because it is not
		// a choice (ADR-0033).
		containerEl.createDiv({ cls: "knap-server", text: hostOf(this.serverUrl) });

		if (!this.sync.signedIn) {
			new Setting(containerEl)
				.setName("Account")
				.setDesc("Not signed in. Signing in opens your browser and comes back here.")
				.addButton((button) =>
					button
						.setButtonText("Sign in")
						.setCta()
						.onClick(() => {
							void this.actions
								.signIn()
								.then(() => {
									new Notice("Signed in. Now link this vault.");
									this.display();
								})
								.catch((error: Error) => new Notice(error.message));
						}),
				);
			// The dashboard is worth a row even here: it is where somebody
			// makes their first cloud vault, and where the sign-in they are
			// about to do lands anyway.
			this.drawDashboard(containerEl);
			return;
		}

		const linked = this.sync.linked;

		new Setting(containerEl)
			.setName("Account")
			.setDesc("Signed in.")
			.addButton((button) =>
				button.setButtonText("Sign out").onClick(() => {
					void this.sync.signOut().then(({ endedRemotely }) => {
						new Notice(signOutNotice(endedRemotely));
						this.display();
					});
				}),
			);

		// The row and the strip under it are one object, so they are drawn
		// into one block: a border around both, and a hairline between them.
		// Two separate cards with a gap read as two subjects, which is what
		// the strip floating above the rows used to say.
		const block = containerEl.createDiv({ cls: "knap-vault" });

		const vault = new Setting(block)
			.setName("Cloud vault")
			// The name, and nothing else. Everything a person can do about it
			// is the button beside it.
			.setDesc(linked ? linked.cloudVaultName : "Not linked.");

		if (linked) {
			vault.addButton((button) =>
				button.setButtonText("Unlink").onClick(() => {
					void this.sync.unlink().then(() => {
						new Notice("Unlinked. Nothing was deleted, anywhere.");
						this.display();
					});
				}),
			);
			// The strip only exists once there is a link. Before that it has
			// no vault to be about, and the words are all wrong for it:
			// nothing is syncing, so it settled on Up to date, over a vault
			// that was going nowhere. That is #40's lie in a new place, and
			// the row above it already says Not linked, which is both truer
			// and the way out.
			this.statusEl = block.createDiv({ cls: "knap-status-slot" });
			this.paint();
			this.startTick();
			this.drawDashboard(containerEl);
			return;
		}

		vault.addButton((button) =>
			button
				.setButtonText("Choose...")
				.setCta()
				.onClick(() => {
					void this.actions
						.pickAndLink()
						.then(() => this.display())
						.catch((error: Error) => new Notice(error.message));
				}),
		);
		this.drawDashboard(containerEl);
	}

	/**
	 * The way out to Knap's own page, as one row with one line of text on it.
	 *
	 * Last on the screen, because it is the only control here that leaves
	 * Obsidian, and everything above it is about this vault. It is a row of
	 * its own rather than a link hung off the address at the top: that line is
	 * faint text nobody clicks, and hiding the one way to the invite field
	 * behind it is how #158's beta testers ended up asking how to add a
	 * colleague.
	 *
	 * **The (i) toggles, it does not hover.** Settings get touched on a phone,
	 * where there is no hover to discover anything with, and the same reason
	 * put a chevron on the status strip (#125).
	 */
	private drawDashboard(containerEl: HTMLElement): void {
		const block = containerEl.createDiv({ cls: "knap-dash" });
		new Setting(block)
			// No description. What is on the other side of the button is two
			// sentences, and two sentences under a row somebody reads every
			// week is two sentences they read every week.
			.setName("Pantalytics dashboard")
			.addExtraButton((button) =>
				button
					.setIcon("info")
					.setTooltip("What the dashboard is for")
					.onClick(() => {
						this.helpOpen = !this.helpOpen;
						help.hidden = !this.helpOpen;
					}),
			)
			.addButton((button) =>
				button.setButtonText("Open").onClick(() => {
					this.openPage(dashboardUrl(this.serverUrl));
				}),
			);
		const help = block.createDiv({
			cls: "knap-dash-help",
			text: dashboardHelp(this.serverUrl),
		});
		help.hidden = !this.helpOpen;
	}

	/**
	 * The tick, at a second, which is what the corner of the window ticks at.
	 *
	 * The bar is a reading and not an event: the socket comes up and goes down
	 * without telling anybody, and a screen drawn once when Settings opened
	 * went on saying whatever was true at that instant. Somebody who opened
	 * this screen while the link was still connecting was told *Offline* over
	 * a vault that had been syncing for a minute, and the only way out of it
	 * was to close Settings and come back.
	 */
	private startTick(): void {
		if (this.ticker !== null) return;
		const timer = window.setInterval(() => this.paint(), 1000);
		this.ticker = timer;
		// The plugin owns it, so an unload with Settings open takes it too.
		this.owner.registerInterval(timer);
	}

	private stopTick(): void {
		if (this.ticker === null) return;
		window.clearInterval(this.ticker);
		this.ticker = null;
	}

	/**
	 * Draw the bar, if what it has to say has changed since the last pass.
	 *
	 * Gated on the words rather than drawn every second, for two reasons. A
	 * redraw between a mouse going down and coming up eats the click on the
	 * button underneath, which is the one control this bar has. And the fold
	 * is a person's decision, so it is held here rather than in the DOM the
	 * redraw throws away.
	 */
	paint(): void {
		const slot = this.statusEl;
		if (!slot) return;
		const status = this.sync.status();
		const said = JSON.stringify([status, this.trying]);
		if (said === this.said) return;
		this.said = said;
		slot.empty();
		this.drawStatus(slot, status);
	}

	/**
	 * The button under Problem and Offline, and what it owes whoever pressed
	 * it.
	 *
	 * A retry takes as long as the tree takes to sync, which is up to half a
	 * minute before it gives up. Until this it said nothing for that whole
	 * time and then swallowed the failure, so the one control on the bar
	 * behaved exactly like a button that does nothing: press it, watch the
	 * fold snap shut, read *Offline* again. It says it is going while it
	 * goes, and says what went wrong when it does.
	 */
	private tryAgain(): void {
		if (this.trying) return;
		this.trying = true;
		this.paint();
		void this.sync.retry().then(
			() => {
				this.trying = false;
				// Nothing is asserted here about how it went. A socket is not
				// up the instant start() returns, and the tick says what is
				// true a second later rather than this saying it early.
				this.paint();
			},
			(error: Error) => {
				this.trying = false;
				new Notice(error.message);
				this.paint();
			},
		);
	}

	/**
	 * The strip: a dot, a word, how big the vault is, and the counts folded
	 * away behind them.
	 *
	 * Drawn by hand rather than as a Setting because a Setting is a name, a
	 * description and controls on the right, and this is none of those. It sits
	 * under the Cloud vault row because it is a fact about that vault, and
	 * inside its block because a gap would make it a fourth thing on a screen
	 * with three things on it.
	 *
	 * **The head is a button only when something is folded behind it** (#125),
	 * which since Total went behind the fold is nearly always.
	 *
	 * The head carries the count and not the name. The row a hairline above
	 * spells the name out, and saying it twice within a thumb of itself is
	 * what #125 took out of the fold in the first place.
	 */
	private drawStatus(containerEl: HTMLElement, status: KnapStatus): void {
		const block = containerEl.createDiv({ cls: "knap-status" });
		const folds = hasFold(status);
		// A fold that is no longer there is not a fold somebody left open.
		if (!folds) this.open = false;

		const body = block.createDiv({ cls: "knap-status-body" });
		body.hidden = !this.open;

		const head = folds
			? block.createEl("button", { cls: "knap-status-head knap-status-opens" })
			: block.createDiv({ cls: "knap-status-head" });
		if (folds) (head as HTMLButtonElement).type = "button";
		head.createSpan({ cls: `knap-dot knap-dot-${status.dot}` });
		head.createSpan({ cls: "knap-status-word", text: status.word });
		const detail = head.createSpan({ cls: "knap-status-detail" });
		const said = headCount(status);
		if (said) {
			detail.createSpan({ cls: "knap-status-count", text: said });
		}

		if (folds) {
			// A touch screen has no hover to discover the fold with, so the
			// chevron is the only thing that says the bar opens (#125).
			const chevron = head.createSpan({ cls: "knap-status-chevron" });
			setIcon(chevron as HTMLElement, "chevron-down");
			head.setAttribute("aria-expanded", String(this.open));
			head.addEventListener("click", () => {
				this.open = !this.open;
				head.setAttribute("aria-expanded", String(this.open));
				body.hidden = !this.open;
			});
		}
		// The head is written after the body so the click handler can close
		// over it, and moved above it here, where the reader expects it.
		block.insertBefore(head, body);

		const instruction = barSentence(status.word);
		if (instruction) {
			body.createDiv({ cls: "knap-status-say", text: instruction });
		}
		for (const [key, value] of statusFacts(status)) {
			// The total is ruled off from the rows above it: those are what is
			// still moving, and it is what is there when nothing is.
			const row = body.createDiv({
				cls: key === TOTAL ? "knap-status-fact knap-status-total" : "knap-status-fact",
			});
			row.createSpan({ cls: "knap-status-key", text: key });
			row.createSpan({ cls: "knap-status-value", text: value });
		}
		if (hasRetry(status)) {
			const retry = body.createEl("button", {
				cls: "knap-status-retry",
				text: this.trying ? "Trying..." : "Try again",
			});
			retry.type = "button";
			retry.disabled = this.trying;
			retry.addEventListener("click", () => this.tryAgain());
		}
	}
}

/** The address without its scheme, because nobody reads https to a person. */
function hostOf(serverUrl: string): string {
	try {
		return new URL(serverUrl).host;
	} catch {
		return serverUrl;
	}
}


