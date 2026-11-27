/**
 * Where a note's history meets Obsidian: the corner's menu, the sidebar, the
 * version tab, the file menu, a command, and on a phone a button in each
 * note's header.
 *
 * The corner of the window opens a small panel in two blocks: how the vault
 * is (signed in, linked, moving or not), and how the open note is (synced or
 * not, who changed it last, when it was made, its versions). A phone has no
 * corner, so the same icon in the same colour sits in the note's own header
 * there, and a tap opens the same panel as a sheet.
 */

import { MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";

import { PLUGIN_ID } from "../../pluginId";
import { SIGNED_OUT } from "../../syncStatus";
import { checkedCounts, type KnapSync } from "../KnapSync";
import type { VersionId } from "../KnapServer";
import { cornerPanel, type NoteInput } from "./cornerPanel";
import { CornerPanelView } from "./cornerPanelView";
import { FRESH_MS, HistoryService } from "./HistoryService";
import { VersionHistoryView, VIEW_HISTORY } from "./VersionHistoryView";
import { VersionView, VIEW_VERSION } from "./VersionView";
import { createdAt, lastChange, madeBy, versionWho } from "./words";

/** What the plugin gets back: the corner's click. */
export interface NoteHistoryUi {
	/**
	 * Open the corner's panel, or close it when it is open. False when there
	 * is nothing to say yet, signed out or not linked, and the corner opens
	 * Settings, where the way on is.
	 */
	openCornerMenu(evt: MouseEvent): boolean;
}

export function followHistory(host: Plugin, sync: KnapSync): NoteHistoryUi {
	const app = host.app;
	const service = new HistoryService(sync);

	const historyLeaf = () => app.workspace.getLeavesOfType(VIEW_HISTORY)[0] ?? null;

	/** Open the sidebar, on this note when one is named. */
	const openHistory = async (path?: string) => {
		let leaf = historyLeaf();
		if (!leaf) {
			const side = app.workspace.getRightLeaf(false);
			if (!side) return;
			await side.setViewState({ type: VIEW_HISTORY, active: true });
			leaf = side;
		}
		await app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (path && view instanceof VersionHistoryView) view.show(path);
	};

	/** Open one version in the main area, reusing the version tab if one is open. */
	const openVersion = (path: string, versionId: VersionId) => {
		const history = service.peek(path, Infinity);
		const versions = history?.versions ?? [];
		const index = versions.findIndex((v) => String(v.id) === String(versionId));
		const version = index >= 0 ? versions[index] : undefined;
		const who = version ? versionWho(version, versions[index + 1]?.ts ?? 0, history?.activity ?? []) : "";
		const leaf = app.workspace.getLeavesOfType(VIEW_VERSION)[0] ?? app.workspace.getLeaf("tab");
		void leaf
			.setViewState({
				type: VIEW_VERSION,
				active: true,
				state: { path, versionId, how: version ? (who ? `${who} · ${madeBy(version)}` : madeBy(version)) : undefined },
			})
			.then(() => app.workspace.revealLeaf(leaf));
	};

	host.registerView(VIEW_HISTORY, (leaf) => new VersionHistoryView(leaf, service, openVersion));
	host.registerView(VIEW_VERSION, (leaf) => new VersionView(leaf, service));

	const hasHistory = (file: unknown): file is TFile =>
		file instanceof TFile && file.extension === "md" && service.linked;

	host.registerEvent(
		app.workspace.on("file-menu", (menu, file) => {
			if (!hasHistory(file)) return;
			menu.addItem((item) =>
				item
					.setTitle("Version history")
					.setIcon("history")
					.onClick(() => void openHistory(file.path)),
			);
		}),
	);

	host.addCommand({
		id: "open-version-history",
		name: "Open version history",
		checkCallback: (checking) => {
			if (!service.linked) return false;
			if (!checking) void openHistory(app.workspace.getActiveFile()?.path);
			return true;
		},
	});

	/** The note whose history was last asked for, so a tick asks once per note. */
	let asked = "";

	/**
	 * Who changed the note last comes off its history. The panel opens at
	 * once and fills it in when the server answers, also for a note opened
	 * while the panel is up, so a slow server never holds it back.
	 */
	const askHistory = (path: string) => {
		if (path === asked || service.peek(path, FRESH_MS) !== undefined || !service.canReach()) return;
		asked = path;
		void service
			.history(path)
			.catch(() => null)
			.then(() => panel.render());
	};

	/** What the panel says right now: the vault, and the open file when there is one. */
	const readPanel = () => {
		const now = Date.now();
		const status = sync.status();
		const file = app.workspace.getActiveFile();
		let note: NoteInput | null = null;
		// Notes only: an attachment's failures are counted on the vault, not
		// per file, so a word about one would be a guess.
		if (file && file.extension === "md") {
			const facts = sync.noteSync(file.path);
			if (facts.inCloud) askHistory(file.path);
			// Any age: an older answer about who changed it is still true,
			// and offline there is no newer one to ask for.
			const history = facts.inCloud ? service.peek(file.path, Infinity) : undefined;
			const last = history ? lastChange(history.activity, now) : null;
			note = {
				facts,
				lastChanged: last ? `${last.who}, ${last.when}` : null,
				created: createdAt(file.stat.ctime, history?.versions),
				history: facts.inCloud,
			};
		}
		const vault = {
			word: status.word,
			dot: status.dot,
			up: status.up + status.files.up,
			down: status.down + status.files.down,
			checked: checkedCounts(status),
			problems: status.problems,
			upToDateAt: status.upToDateAt,
		};
		return cornerPanel(vault, note, now);
	};

	const panel = new CornerPanelView(readPanel, {
		history: () => void openHistory(app.workspace.getActiveFile()?.path),
		retryVault: () => {
			sync.retry().catch((error: Error) => new Notice(error.message));
		},
		retryNote: () => {
			const path = app.workspace.getActiveFile()?.path;
			if (path) sync.retryNote(path).catch((error: Error) => new Notice(error.message));
		},
	});
	host.register(() => panel.close());

	/** Open the panel, or close it when it is open. */
	const openPanel = (anchor: HTMLElement | null, sheet = false): boolean => {
		if (panel.isOpen) {
			panel.close();
			return true;
		}
		if (!service.linked || sync.status().word === SIGNED_OUT) return false;
		asked = "";
		panel.open(anchor, sheet);
		return true;
	};

	const openCornerMenu = (evt: MouseEvent): boolean =>
		openPanel(evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null);

	if (Platform.isMobile) {
		headerActions(host, service, (evt) => {
			if (openPanel(evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null, true)) return;
			const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
			setting?.open();
			setting?.openTabById(host.manifest.id);
		});
	}

	return { openCornerMenu };
}

/**
 * The corner's icon on a phone, in each note's header: the same mark, in the
 * same colour as the vault's state, and a tap opens the same panel as a sheet.
 */
function headerActions(host: Plugin, service: HistoryService, open: (evt: MouseEvent) => void): void {
	const sync = service.sync;
	const done = new WeakSet<MarkdownView>();
	let icons: HTMLElement[] = [];
	const paint = () => {
		icons = icons.filter((icon) => icon.isConnected);
		const dot = sync.status().dot;
		for (const icon of icons) {
			for (const name of ["ok", "working", "wait", "error"]) {
				icon.toggleClass(`knap-action-${name}`, name === dot);
			}
		}
	};
	const add = () => {
		for (const leaf of host.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			// Only in a linked vault: a vault that syncs nowhere has no history.
			if (!(view instanceof MarkdownView) || done.has(view) || !service.linked) continue;
			done.add(view);
			const icon = view.addAction(PLUGIN_ID, "Sync", open);
			icon.addClass("knap-action");
			icons.push(icon);
		}
		paint();
	};
	host.registerEvent(host.app.workspace.on("layout-change", add));
	host.app.workspace.onLayoutReady(add);
	host.registerInterval(window.setInterval(paint, 1000));
}
