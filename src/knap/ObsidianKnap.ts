/**
 * Where the rebuilt client meets Obsidian, behind the build-time switch.
 *
 * `KNAP_SERVER_URL` is an esbuild define, empty in every ordinary build.
 * Empty means this whole file registers nothing and the plugin behaves
 * exactly as before; set, it adds the protocol handler and four commands,
 * and one test vault can point at the new server while everything else
 * stays where it is. That is the switch phase 2's plan asks for, and it is
 * build-time on purpose: no screen offers a server field (ADR-0033).
 *
 * Every release ships with it set and no local build does, which is why the
 * Obsidian wire end to end has never driven the plugin people install. Issue
 * #167 carries that, and the measurement behind it.
 *
 * The screen words hold: sign in, cloud vault, link, unlink, sync. Nothing
 * here says server, relay or share to a person.
 */

import { Notice, Platform, Plugin, SuggestModal, editorInfoField } from "obsidian";

import { reportFault, setFaultCredential } from "../faults";
import { setFaultSink } from "./faultSink";

import type { CloudVault } from "./KnapServer";
import type { ServerNotice } from "./notices";
import { knapLiveEditing } from "./knapEditor";
import { KnapSync } from "./KnapSync";
import type { KnapLink } from "./KnapSync";
import { ObsidianConfigBases } from "./ObsidianConfigBases";
import { ObsidianConfigStore } from "./ObsidianConfigStore";
import { ObsidianFileStore } from "./ObsidianFileStore";
import { ObsidianSeenTree } from "./ObsidianSeenTree";
import { KnapSettingsTab, dashboardUrl, signOutNotice } from "./KnapSettingsTab";
import { LinkProgressModal } from "./LinkProgressModal";
import { SIGNIN_ACTION } from "./SignInFlow";
import { obsidianFetch } from "./obsidianFetch";

declare const KNAP_SERVER_URL: string;

/** What ObsidianKnap needs from the plugin: commands, the handler, settings. */
export interface KnapHost extends Plugin {
	getKnapLink(): KnapLink | null;
	saveKnapLink(value: KnapLink | null): Promise<void>;
}

/**
 * What the picker offers: the account's cloud vaults, and making one.
 *
 * Making one is in the list rather than beside it because it is the answer
 * to the same question, and a person with no cloud vaults yet was previously
 * told *No cloud vaults yet, make one in the Knap panel first* and left in
 * Obsidian with nothing to press. It sits last, under everything real, so it
 * is a way out rather than a competing choice.
 */
export type VaultChoice = { kind: "vault"; vault: CloudVault } | { kind: "new" };

/** The one entry that is not a vault. Exported so tests can name it. */
export const NEW_VAULT_CHOICE: VaultChoice = { kind: "new" };

/**
 * Filter the vaults by what was typed, and always end with the way out.
 *
 * The new-vault row survives every query on purpose. Somebody typing the name
 * of a vault that does not exist yet is exactly the person who needs it, and a
 * list that empties out under them answers with nothing at all.
 */
export function vaultChoices(vaults: CloudVault[], query: string): VaultChoice[] {
	const needle = query.toLowerCase();
	const matches = vaults.filter((vault) => vault.name.toLowerCase().includes(needle));
	return [...matches.map((vault) => ({ kind: "vault" as const, vault })), NEW_VAULT_CHOICE];
}

/**
 * What the box at the top says while the list is being fetched, and after.
 *
 * The state of the fetch goes in the placeholder rather than into the list,
 * because a row that says *Asking Pantalytics* is a row somebody can select.
 * This way there is never an unselectable entry, and the list is only ever
 * things that can be chosen.
 */
export function pickerPlaceholder(state: "loading" | "ready" | "failed"): string {
	switch (state) {
		case "loading":
			return "Asking Pantalytics...";
		case "failed":
			return "Could not reach Pantalytics. Your notes are safe here.";
		default:
			return "Search cloud vaults...";
	}
}

class CloudVaultPickModal extends SuggestModal<VaultChoice> {
	private vaults: CloudVault[] = [];
	private state: "loading" | "ready" | "failed" = "loading";

	constructor(
		host: KnapHost,
		private readonly list: () => Promise<CloudVault[]>,
		private readonly onPick: (vault: CloudVault) => void,
		private readonly onMake: () => void,
	) {
		super(host.app);
		this.setPlaceholder(pickerPlaceholder("loading"));
	}

	/**
	 * The list is fetched every time the picker opens, and that is the whole
	 * answer to the gap between the two windows: somebody who has just made a
	 * cloud vault in the browser closes this, opens it again, and it is there.
	 * No refresh button, no polling, no message telling them to reopen it.
	 */
	onOpen(): void {
		super.onOpen();
		this.list().then(
			(vaults) => {
				this.vaults = vaults;
				this.settle("ready");
			},
			() => this.settle("failed"),
		);
	}

	private settle(state: "loading" | "ready" | "failed"): void {
		this.state = state;
		this.setPlaceholder(pickerPlaceholder(state));
		// Obsidian rebuilds the list from the input's own event, so this is
		// how a suggest modal redraws without reaching into its internals.
		this.inputEl.dispatchEvent(new Event("input"));
	}

	getSuggestions(query: string): VaultChoice[] {
		return vaultChoices(this.state === "ready" ? this.vaults : [], query);
	}

	renderSuggestion(choice: VaultChoice, el: HTMLElement): void {
		if (choice.kind === "new") {
			el.addClass("knap-pick-new");
			el.createDiv({ text: "New cloud vault" });
			el.createDiv({ cls: "knap-pick-aside", text: "opens Pantalytics in your browser" });
			return;
		}
		// The name and nothing else. There is one kind of person in a vault,
		// so there is no access level to qualify it with.
		el.createDiv({ text: choice.vault.name });
	}

	onChooseSuggestion(choice: VaultChoice): void {
		if (choice.kind === "new") {
			this.onMake();
			return;
		}
		this.onPick(choice.vault);
	}
}

/**
 * Wire the beta in. Returns null (and does nothing) when the build carries
 * no server address, which is every build but the beta's.
 */
export function registerKnapBeta(host: KnapHost): KnapSync | null {
	const serverUrl = typeof KNAP_SERVER_URL === "string" ? KNAP_SERVER_URL : "";
	if (!serverUrl) {
		return null;
	}

	// The sync layer files its faults through an injected sink so that nothing
	// in src/knap has to import Obsidian (see faultSink.ts). This is the one
	// place that connects the two, and it is set before anything can fail.
	setFaultSink({ report: reportFault, credential: setFaultCredential });

	const device = `${host.app.vault.getName()} on ${Platform.isMobileApp ? "phone" : "desktop"}`;
	const sync = new KnapSync({
		serverUrl,
		deviceName: device,
		fetchFn: obsidianFetch,
		files: new ObsidianFileStore(host.app.vault, host.app.fileManager),
		load: () => host.getKnapLink(),
		save: (value) => host.saveKnapLink(value),
		onRefused: (path, reason) => new Notice(`${path}: ${reason}`),
		// Joining a cloud vault that already has settings replaces the theme,
		// hotkeys and plugins on this device with the ones up there. It is
		// the one part of linking that changes something a person set up
		// themselves, so it is said rather than discovered (ADR-0099).
		onAdopted: (cloudVaultName) =>
			new Notice(
				`This device now uses ${cloudVaultName}'s settings: its theme, ` +
					"hotkeys and plugins. Your notes were not touched. Plugins that " +
					"arrived start the next time you open Obsidian.",
				0,
			),
		// The server had a problem with something in this vault (ADR-0095).
		// Nothing local is broken, so this is a sentence and not an alarm;
		// info levels stay off screen, because a person opening Obsidian to
		// write does not need this server's running commentary.
		onNotice: (notice: ServerNotice) => {
			if (notice.level === "info") return;
			new Notice(notice.text, notice.level === "error" ? 0 : undefined);
		},
		// Somebody took this account out of the vault, or deleted it. Said
		// once, and said plainly: the sentence has to answer "where did my
		// notes go" before somebody goes looking for them, because the honest
		// answer is that they did not go anywhere.
		onLostVault: (vaultName) =>
			new Notice(
				`This vault has stopped syncing with ${vaultName}. Your notes are ` +
					`all still here. Ask whoever looks after ${vaultName} to add you ` +
					`again, or unlink in settings.`,
				0,
			),
		config: new ObsidianConfigStore(host.app),
		makeSeen: (cloudVaultId) =>
			new ObsidianSeenTree(
				host.app.vault.adapter,
				`${host.app.vault.configDir}/plugins/${host.manifest.id}/knap-seen.json`,
				cloudVaultId,
			),
		makeConfigBases: (cloudVaultId) =>
			new ObsidianConfigBases(
				host.app.vault.adapter,
				`${host.app.vault.configDir}/plugins/${host.manifest.id}/knap-config-seen.json`,
				cloudVaultId,
			),
	});

	const signIn = () => sync.signIn((url) => window.open(url));

	/**
	 * Open the picker, and let it do the asking.
	 *
	 * The fetch used to happen out here, which meant an account with no cloud
	 * vaults and a laptop with no connection both ended as a notice in the
	 * corner with nothing to press. Inside, the same two cases are a list with
	 * a way out and a line in the search box.
	 *
	 * The promise settles when the person has finished with the picker one way
	 * or another, including by closing it, so the screen redraws either way.
	 */
	const pickAndLink = () =>
		new Promise<void>((resolve) => {
			new CloudVaultPickModal(
				host,
				() => sync.listVaults(),
				(vault) => {
					// The picker hands over to the progress modal, which is
					// what the person watches from here. It reports each step,
					// closes itself when the link is made, and stays up with
					// the failing step marked when one is not.
					// Installed plugins by name, for the settings question.
					const manifests = (
						host.app as unknown as {
							plugins?: { manifests?: Record<string, { name?: string }> };
						}
					).plugins?.manifests;
					const progress = new LinkProgressModal(
						host.app,
						vault.name,
						(id) => manifests?.[id]?.name ?? id,
					);
					progress.open();
					let settled = false;
					sync
						.link(
							vault,
							(step, facts) => {
								progress.step(step, facts);
								// The link exists at this step and the first sync
								// runs on behind it, so this is where the screen
								// underneath is redrawn. Waiting for the whole
								// fill would be a settings screen that still says
								// Not linked over a vault that is filling up.
								if (step === "linked" && !settled) {
									settled = true;
									new Notice(
										`Linked. This vault now syncs with ${vault.name}. ` +
											"Leave Obsidian open while it fills up.",
									);
									resolve();
								}
							},
							(diff) => progress.choose(diff),
							(loss) => progress.confirmSettings(loss),
						)
						.catch((error: Error) => {
							// The modal is where this is read, so it is not
							// also thrown at whoever opened the picker: the
							// caller's only answer to a rejection is a notice
							// in the corner saying what the screen in front of
							// it already says. Resolving redraws the settings
							// screen, which still says Not linked, correctly.
							progress.fail(error.message);
							if (settled) return;
							settled = true;
							resolve();
						});
				},
				() => {
					// This build's own server, not the old stack's page: the
					// panel that knows about these vaults is served by the
					// process the plugin already talks to (ADR-0073).
					window.open(dashboardUrl(serverUrl));
					new Notice("Make one in your browser, then choose it here.");
					resolve();
				},
			).open();
		});

	host.addSettingTab(new KnapSettingsTab(host, sync, { signIn, pickAndLink }, serverUrl));

	// Live editing and the cursors on it, for whichever note an editor is
	// showing. Which file that is is Obsidian's answer to give, so it comes
	// in as a function and the extension itself stays testable.
	host.registerEditorExtension(
		knapLiveEditing(sync, (state) => state.field(editorInfoField, false)?.file?.path ?? null),
	);

	host.registerObsidianProtocolHandler(SIGNIN_ACTION, (params) => {
		const fed = sync.handleDeepLink(params as unknown as Record<string, string>);
		if (!fed) {
			// A sign-in that was started somewhere other than here: the link
			// arrives, nothing is waiting for it, and the code is dropped. It
			// used to be dropped in silence, which reads exactly like the
			// plugin being broken -- the browser said it worked and Obsidian
			// said nothing at all.
			new Notice("That sign-in did not start here. Run sign in (beta) and try again.");
		}
	});

	host.addCommand({
		id: "knap-beta-sign-in",
		name: "Sign in (beta)",
		callback: () => {
			signIn()
				.then(() => new Notice("Signed in. Now link this vault."))
				.catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-link-vault",
		name: "Link this vault (beta)",
		callback: () => {
			pickAndLink().catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-sign-out",
		name: "Sign out (beta)",
		callback: () => {
			void sync
				.signOut()
				.then(({ endedRemotely }) => new Notice(signOutNotice(endedRemotely)));
		},
	});

	host.addCommand({
		id: "knap-beta-unlink",
		name: "Unlink from the cloud vault (beta)",
		callback: () => {
			void sync.unlink().then(() => new Notice("Unlinked. Nothing was deleted, anywhere."));
		},
	});

	// A vault that was linked before this start comes back up on its own,
	// and not one moment before the layout is ready. The first thing the
	// binding does is ask Obsidian which notes this vault holds, and a vault
	// that has not finished loading answers that with too few. Since a note
	// missing from disk is now read as a note somebody deleted, starting
	// early would take the rest of the vault out of the cloud with it.
	//
	// A server that cannot be reached is not a failure here: the start
	// waits for it, the status says Offline meanwhile, and the vault comes
	// up when the server does. What is left to catch is the kind of thing
	// that will not fix itself.
	host.app.workspace.onLayoutReady(() => {
		void sync.start().catch(() => {
			new Notice(
				"Pantalytics could not bring your cloud vault up. Your notes are safe here; " +
					"open Settings and press Try again.",
			);
		});
	});
	return sync;
}
