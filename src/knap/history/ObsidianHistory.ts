/**
 * Where a note's history meets Obsidian: the corner's menu, the sidebar, the
 * version tab, the file menu, a command, and on a phone a button in each
 * note's header.
 *
 * The corner of the window used to open Settings. It opens a menu now: how
 * the vault is and since when, who changed the open note last and when it
 * was made, and the way into its versions. A phone has no corner, so the
 * same icon in the same colour sits in the note's own header there, and a
 * tap opens the versions in the right drawer.
 */

import { MarkdownView, Menu, Notice, Platform, Plugin, TFile } from "obsidian";

import { PLUGIN_ID } from "../../pluginId";
import { PROBLEM, SIGNED_OUT, UP_TO_DATE } from "../../syncStatus";
import type { KnapSync } from "../KnapSync";
import type { VersionId } from "../KnapServer";
import { cornerItems } from "./cornerMenu";
import { FRESH_MS, HistoryService } from "./HistoryService";
import { VersionHistoryView, VIEW_HISTORY } from "./VersionHistoryView";
import { VersionView, VIEW_VERSION } from "./VersionView";
import { createdAt, lastChange, madeBy, shortDate, statusLine, versionWho } from "./words";

/** How long the corner's menu waits for a history it does not have, before it opens without it. */
const MENU_WAIT_MS = 600;

/** What the plugin gets back: the corner's click. */
export interface NoteHistoryUi {
	/**
	 * Open the corner's menu. False when there is nothing to say yet, signed
	 * out or not linked, and the corner opens Settings, where the way on is.
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

	if (Platform.isMobile) {
		headerActions(host, service, () => void openHistory(app.workspace.getActiveFile()?.path));
	}

	const openCornerMenu = (evt: MouseEvent): boolean => {
		if (!service.linked || sync.status().word === SIGNED_OUT) return false;
		const file = app.workspace.getActiveFile();
		const note = file && file.extension === "md" && service.hasNote(file.path) ? file : null;
		const show = () => {
			const now = Date.now();
			const status = sync.status();
			const history = note ? service.peek(note.path) : undefined;
			const last = history ? lastChange(history.activity, now) : null;
			const menu = new Menu();
			const items = cornerItems({
				status: statusLine(status.word, status.upToDateAt, now, status.word === UP_TO_DATE),
				problem: status.word === PROBLEM,
				note: file && file.extension === "md"
					? {
							lastChanged: last ? `${last.who}, ${last.when}` : null,
							created: shortDate(createdAt(file.stat.ctime, history?.versions), now),
							synced: note !== null,
						}
					: null,
			});
			for (const entry of items) {
				menu.addItem((item) => {
					item.setTitle(entry.title);
					if (entry.kind === "info") item.setDisabled(true);
					if (entry.kind === "history") {
						item.setIcon("history").onClick(() => void openHistory(file?.path));
					}
					if (entry.kind === "retry") {
						item.setIcon("refresh-cw").onClick(() => {
							sync.retry().catch((error: Error) => new Notice(error.message));
						});
					}
				});
			}
			menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
		};
		// A history asked for in the last half minute is used as it is; one
		// that is not gets a short wait, so the menu opens with who changed
		// the note when the server is quick, and without it when it is not.
		if (!note || service.peek(note.path, FRESH_MS) !== undefined || !service.canReach()) {
			show();
			return true;
		}
		const wait = new Promise((resolve) => window.setTimeout(resolve, MENU_WAIT_MS));
		void Promise.race([service.history(note.path).catch(() => null), wait]).then(show);
		return true;
	};

	return { openCornerMenu };
}

/**
 * The corner's icon on a phone, in each note's header: the same mark, in the
 * same colour as the vault's state, and a tap opens the versions.
 */
function headerActions(host: Plugin, service: HistoryService, open: () => void): void {
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
			const icon = view.addAction(PLUGIN_ID, "Version history", open);
			icon.addClass("knap-action");
			icons.push(icon);
		}
		paint();
	};
	host.registerEvent(host.app.workspace.on("layout-change", add));
	host.app.workspace.onLayoutReady(add);
	host.registerInterval(window.setInterval(paint, 1000));
}
