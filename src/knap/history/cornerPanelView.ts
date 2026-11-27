/**
 * The panel behind the corner of the window, drawn.
 *
 * Not an Obsidian `Menu`: a menu draws a line that is not a command greyed
 * out, and every line here is a fact to read. It borrows the menu's surface
 * (`--background-secondary`, its border and shadow) so it reads as
 * Obsidian's. On a phone there is no corner, and the same panel comes up from
 * the bottom as a sheet.
 *
 * It redraws once a second while open, off `read()`, so the counts move and a
 * Last changed that arrives late is filled in where it belongs.
 */

import { setIcon } from "obsidian";

import type { SyncDot } from "../../syncStatus";
import type { CornerPanel } from "./cornerPanel";

export interface CornerActions {
	history(): void;
	retryVault(): void;
	retryNote(): void;
}

export class CornerPanelView {
	private el: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private timer = 0;
	private stops: Array<() => void> = [];
	/** What was last drawn, so a tick that changes nothing rebuilds nothing under a finger. */
	private drawn = "";

	constructor(
		private readonly read: () => CornerPanel,
		private readonly actions: CornerActions,
	) {}

	get isOpen(): boolean {
		return this.el !== null;
	}

	/**
	 * Open above `anchor`, or as a sheet from the bottom. The anchor is kept
	 * either way, so a press on it closes the panel rather than reopening it.
	 */
	open(anchor: HTMLElement | null, sheet = false): void {
		this.close();
		this.anchor = anchor;
		const el = document.body.createDiv({ cls: "knap-corner" });
		el.setAttribute("role", "dialog");
		el.setAttribute("aria-label", "Sync");
		this.el = el;
		if (anchor && !sheet) {
			const rect = anchor.getBoundingClientRect();
			el.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
			el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
		} else {
			el.addClass("knap-corner-sheet");
		}
		this.render();
		this.timer = window.setInterval(() => this.render(), 1000);

		const outside = (evt: PointerEvent) => {
			const target = evt.target as Node | null;
			if (target && (el.contains(target) || this.anchor?.contains(target))) return;
			this.close();
		};
		const escape = (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation();
			this.close();
		};
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape, true);
		this.stops.push(
			() => document.removeEventListener("pointerdown", outside, true),
			() => document.removeEventListener("keydown", escape, true),
		);
	}

	close(): void {
		window.clearInterval(this.timer);
		for (const stop of this.stops.splice(0)) stop();
		this.el?.remove();
		this.el = null;
		this.anchor = null;
		this.drawn = "";
	}

	render(): void {
		const el = this.el;
		if (!el) return;
		const panel = this.read();
		// Rebuilt only when something changed: a button replaced between
		// press and release never gets its click.
		const text = JSON.stringify(panel);
		if (text === this.drawn) return;
		this.drawn = text;
		el.empty();

		const vault = el.createDiv({ cls: "knap-corner-block" });
		vault.createDiv({ cls: "knap-corner-name", text: "Vault" });
		line(vault, panel.vault.dot, panel.vault.word, panel.vault.when);
		if (panel.vault.problem) {
			again(vault, panel.vault.problem, () => this.act(() => this.actions.retryVault()));
		}

		const note = panel.note;
		if (!note) return;
		const block = el.createDiv({ cls: "knap-corner-block" });
		block.createDiv({ cls: "knap-corner-name", text: "Note" });
		line(block, note.dot, note.word, "");
		if (note.reason) again(block, note.reason, () => this.act(() => this.actions.retryNote()));
		const facts = block.createDiv({ cls: "knap-corner-facts" });
		if (note.lastChanged) {
			facts.createSpan({ cls: "knap-corner-key", text: "Last changed" });
			facts.createSpan({ text: note.lastChanged });
		}
		facts.createSpan({ cls: "knap-corner-key", text: "Created" });
		facts.createSpan({ text: note.created });
		if (note.history) {
			const link = el.createEl("button", { cls: "knap-corner-link" });
			link.createSpan({ text: "Version history" });
			setIcon(link.createSpan({ cls: "knap-corner-chevron" }), "chevron-right");
			link.addEventListener("click", () => this.act(() => this.actions.history()));
		}
	}

	private act(run: () => void): void {
		this.close();
		run();
	}
}

function line(parent: HTMLElement, dot: SyncDot, word: string, when: string): void {
	const row = parent.createDiv({ cls: "knap-corner-line" });
	row.createSpan({ cls: `knap-corner-dot knap-corner-dot-${dot}` });
	row.createSpan({ text: word });
	if (when) row.createSpan({ cls: "knap-corner-when", text: when });
}

function again(parent: HTMLElement, text: string, onClick: () => void): void {
	const row = parent.createDiv({ cls: "knap-corner-again" });
	row.createSpan({ text });
	const button = row.createEl("button", { text: "Try again" });
	button.addEventListener("click", onClick);
}
