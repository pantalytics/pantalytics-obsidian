/**
 * The sidebar: one note's versions, following whichever note is open.
 *
 * The note's name, when it was created, and its versions grouped by day,
 * each one a time, a person and how it was made. A version opens in the main
 * area, where it can be read against the note and put back. Nothing here
 * changes anything.
 *
 * A quick answer never shows a loading line: it waits a moment before saying
 * it is loading, so the list replaces the last one rather than flickering
 * through a third state on the way.
 */

import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";

import { PLUGIN_ID } from "../../pluginId";
import type { NoteHistory, VersionId } from "../KnapServer";
import { failureText, type HistoryService } from "./HistoryService";
import { createdAt, groupVersions, shortDate } from "./words";

export const VIEW_HISTORY = `${PLUGIN_ID}-version-history`;

/** How long an answer may take before the view says it is loading. */
const QUIET_MS = 400;

export class VersionHistoryView extends ItemView {
	private path: string | null = null;
	/** Bumped per load, so an answer that arrives late does not overwrite a newer one. */
	private loadCount = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly service: HistoryService,
		private readonly openVersion: (path: string, versionId: VersionId) => void,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_HISTORY;
	}

	getDisplayText(): string {
		return "Version history";
	}

	getIcon(): string {
		return "history";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("knap-history");
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.show(file.path);
			}),
		);
		this.register(this.service.onChange(() => this.reload()));
		const active = this.app.workspace.getActiveFile();
		this.show(active?.path ?? this.path);
	}

	/** Show this note's history. The same note again is a reload. */
	show(path: string | null): void {
		this.path = path;
		void this.fetchHistory();
	}

	reload(): void {
		void this.fetchHistory();
	}

	private async fetchHistory(): Promise<void> {
		const mine = ++this.loadCount;
		const path = this.path;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!path || !(file instanceof TFile) || file.extension !== "md") {
			this.draw(null, () => undefined);
			return;
		}
		const head = (el: HTMLElement, history?: NoteHistory | null) => {
			const created = createdAt(file.stat.ctime, history?.versions);
			el.createDiv({ cls: "knap-history-title", text: file.basename });
			el.createDiv({ cls: "knap-history-muted", text: `Created ${shortDate(created, Date.now())}` });
		};
		const quiet = window.setTimeout(() => {
			if (mine === this.loadCount) this.draw(head, (el) => this.muted(el, "Loading..."));
		}, QUIET_MS);
		try {
			const history = await this.service.history(path);
			if (mine !== this.loadCount) return;
			this.draw((el) => head(el, history), (el) => this.drawVersions(el, path, history));
		} catch (error) {
			if (mine !== this.loadCount) return;
			const text = failureText(error, "Could not reach Pantalytics.");
			this.draw(head, (el) => this.muted(el, text));
		} finally {
			window.clearTimeout(quiet);
		}
	}

	private draw(head: ((el: HTMLElement) => void) | null, body: (el: HTMLElement) => void): void {
		const el = this.contentEl;
		el.empty();
		if (!head) {
			this.muted(el, "No note open.");
			return;
		}
		head(el);
		body(el);
	}

	private drawVersions(el: HTMLElement, path: string, history: NoteHistory | null): void {
		const groups = groupVersions(history?.versions ?? [], Date.now(), history?.activity ?? []);
		if (groups.length === 0) {
			this.muted(el, "No versions yet.");
			return;
		}
		for (const group of groups) {
			el.createDiv({ cls: "knap-history-day", text: group.label });
			for (const row of group.rows) {
				const item = el.createDiv({ cls: "knap-history-row tree-item-self is-clickable" });
				item.createDiv({ cls: "knap-history-time", text: row.time });
				item.createDiv({
					cls: "knap-history-muted",
					text: row.who ? `${row.who} · ${row.how}` : row.how,
				});
				item.addEventListener("click", () => this.openVersion(path, row.id));
			}
		}
	}

	private muted(el: HTMLElement, text: string): void {
		el.createDiv({ cls: "knap-history-muted knap-history-note", text });
	}
}
