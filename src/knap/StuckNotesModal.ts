/**
 * The notes that would not sync, and what to do about each
 * (odoo-mcp-pro-admin#706).
 *
 * Settings says only that there are some, on a row with a chevron. This is
 * the screen behind it, built the way an iPhone settings screen is: a list,
 * a row per note, and a page per note one tap further in. The list can try
 * them all again at once; a note's page can try that one again or open it.
 */

import { type App, Modal, setIcon } from "obsidian";

export interface StuckNote {
	path: string;
	reason: string;
}

export interface StuckNotesActions {
	/** The notes still stuck, read fresh each time the screen is drawn. */
	stuck(): StuckNote[];
	retryAll(): Promise<void>;
	retryNote(path: string): Promise<void>;
	openNote(path: string): void;
}

/** "Clients/Acme/Renewal.md" as its name and the folder it is in. */
export function nameOf(path: string): { name: string; folder: string } {
	const clean = path.replace(/\.md$/, "");
	const cut = clean.lastIndexOf("/");
	return cut < 0
		? { name: clean, folder: "" }
		: { name: clean.slice(cut + 1), folder: clean.slice(0, cut) };
}

export class StuckNotesModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private readonly actions: StuckNotesActions,
	) {
		super(app);
	}

	onOpen(): void {
		this.showList();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	showList(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("knap-stuck");
		this.setTitle("Could not sync");
		const notes = this.actions.stuck();
		if (notes.length === 0) {
			el.createDiv({ cls: "knap-stuck-empty", text: "Every note is in sync." });
			return;
		}
		const all = el.createEl("button", {
			cls: "mod-cta knap-stuck-all",
			text: this.busy ? "Trying..." : `Try all ${notes.length} again`,
		});
		all.disabled = this.busy;
		all.addEventListener("click", () => this.run(() => this.actions.retryAll(), () => this.showList()));

		const list = el.createDiv({ cls: "knap-stuck-list" });
		for (const note of notes) {
			const { name } = nameOf(note.path);
			const row = list.createEl("button", { cls: "knap-stuck-row" });
			const text = row.createDiv({ cls: "knap-stuck-text" });
			text.createDiv({ cls: "knap-stuck-name", text: name });
			text.createDiv({ cls: "knap-stuck-reason", text: note.reason });
			setIcon(row.createSpan({ cls: "knap-stuck-chevron" }), "chevron-right");
			row.addEventListener("click", () => this.showNote(note.path));
		}
	}

	showNote(path: string): void {
		const el = this.contentEl;
		el.empty();
		const note = this.actions.stuck().find((n) => n.path === path);
		const back = el.createEl("button", { cls: "knap-stuck-back" });
		setIcon(back.createSpan(), "chevron-left");
		back.createSpan({ text: "Could not sync" });
		back.addEventListener("click", () => this.showList());

		const { name, folder } = nameOf(path);
		this.setTitle(name);
		if (folder) el.createDiv({ cls: "knap-stuck-folder", text: folder });
		if (!note) {
			el.createDiv({ cls: "knap-stuck-done", text: "This note is in sync now." });
			return;
		}
		el.createDiv({ cls: "knap-stuck-why", text: note.reason });
		const buttons = el.createDiv({ cls: "knap-stuck-buttons" });
		const retry = buttons.createEl("button", {
			cls: "mod-cta",
			text: this.busy ? "Trying..." : "Try again",
		});
		retry.disabled = this.busy;
		retry.addEventListener("click", () =>
			this.run(() => this.actions.retryNote(path), () => this.showNote(path)),
		);
		const open = buttons.createEl("button", { text: "Open note" });
		open.addEventListener("click", () => {
			this.actions.openNote(path);
			this.close();
		});
	}

	private run(work: () => Promise<void>, redraw: () => void): void {
		if (this.busy) return;
		this.busy = true;
		redraw();
		void work()
			.catch(() => undefined)
			.finally(() => {
				this.busy = false;
				redraw();
			});
	}
}
