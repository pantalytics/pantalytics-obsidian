/**
 * What linking looks like while it happens.
 *
 * Pressing a vault in the picker used to do this: the picker closed, the
 * screen behind it sat unchanged, and somewhere between one second and four
 * minutes later a notice said *Linked*. The wait is the reconciliation, and
 * it is honest work, but nothing on screen said so, so the only reading
 * available to a person was that the button had not done anything.
 *
 * This is the same act with its steps out. Nine rows, each going from
 * waiting to running to a number, and the two that matter are near the end:
 * what has to come down, and what has to go up. Those two are the answer to
 * how long the next part is going to take.
 *
 * **It closes itself on the last step**, because the modal is about the link
 * and the link is made by then. What happens after it is the first sync, and
 * the bar on the screen behind has a word for that (Initializing) and a
 * sentence under it saying to leave Obsidian open. Holding a modal open over
 * a job that takes minutes would be a second place saying the same thing, and
 * a person cannot use their vault behind it.
 *
 * The drawing is deliberately thin. Which steps there are, what they are
 * called and what each of them shows is `linkSteps.ts`, which is pure and
 * tested; this file turns rows into elements and knows nothing else.
 */

import { Menu, Modal, setIcon, type App } from "obsidian";

import type { LinkChoice, LinkDiff, LinkFacts, LinkRow, LinkStep } from "./linkSteps";
import { BOTH_WAYS, KEEP_BOTH_SAY, choiceSay, linkRows, replaceConfirm } from "./linkSteps";
import type { Side, SideBySide, SettingsLoss } from "./linkCompare";
import { USE_CLOUD_SETTINGS, barSegments, settingsAsk, sideBySide } from "./linkCompare";

/** The four count rows the comparison replaces once it can be drawn. */
const COUNTED: LinkStep[] = ["cloudNotes", "cloudAttachments", "localNotes", "localAttachments"];

/** How long the finished list stays up, so the last line can be read. */
const CLOSE_AFTER_MS = 900;

export class LinkProgressModal extends Modal {
	private rowsEl: HTMLElement | null = null;
	private noteEl: HTMLElement | null = null;
	private done: LinkStep | null = null;
	private facts: LinkFacts = {};
	private failed = false;
	private closing: number | null = null;
	private choosing: ((choice: LinkChoice | null) => void) | null = null;
	private confirming: ((go: boolean) => void) | null = null;

	constructor(
		app: App,
		private readonly vaultName: string,
		/** A plugin's name from its id, where this device knows it. */
		private readonly pluginName: (id: string) => string = (id) => id,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("knap-link");
		contentEl.createEl("h2", { text: `Linking to ${this.vaultName}` });
		// What the link means from here on, on the screen that makes it.
		contentEl.createDiv({ cls: "knap-link-say", text: BOTH_WAYS });
		this.rowsEl = contentEl.createDiv({ cls: "knap-link-steps" });
		this.noteEl = contentEl.createDiv({ cls: "knap-link-note" });
		this.paint();
	}

	onClose(): void {
		// Closing the modal while it asks is a cancel.
		this.answer(null);
		this.settle(false);
		if (this.closing !== null) window.clearTimeout(this.closing);
		this.closing = null;
		this.rowsEl = null;
		this.noteEl = null;
		this.contentEl.empty();
	}

	/** One step finished. The last one closes the modal after a beat. */
	step(step: LinkStep, facts: LinkFacts): void {
		this.done = step;
		this.facts = { ...facts };
		this.paint();
		if (step === "linked" && this.closing === null) {
			this.closing = window.setTimeout(() => this.close(), CLOSE_AFTER_MS);
		}
	}

	/**
	 * It did not work. The list stays where it stopped, with the step that
	 * failed marked, and the sentence goes under it: a modal that vanished
	 * would leave the failure to a notice in the corner, over a screen that
	 * still says Not linked and does not say why.
	 */
	fail(message: string): void {
		this.failed = true;
		this.paint(message);
	}

	/**
	 * Both sides hold notes and they are not the same (ADR-0105). The list
	 * stays where it stopped and the choice goes under it: Keep both is the
	 * button, because it deletes nothing, and the two ways that make one
	 * side the same as the other are its menu, each with a confirmation.
	 */
	choose(diff: LinkDiff): Promise<LinkChoice | null> {
		return new Promise((resolve) => {
			this.choosing = resolve;
			this.paint();
			this.paintChoice(diff);
		});
	}

	/**
	 * The cloud vault's settings would replace this device's own (ADR-0107).
	 * Named, before anything is written. Cancel, or go ahead with the cloud
	 * vault's; there is no third way that sends this device's settings up.
	 */
	confirmSettings(loss: SettingsLoss): Promise<boolean> {
		return new Promise((resolve) => {
			this.confirming = resolve;
			this.paint();
			const note = this.noteEl;
			if (!note) return;
			const ask = settingsAsk(this.vaultName, loss, this.pluginName);
			note.empty();
			note.createEl("h3", { cls: "knap-link-confirm", text: ask.title });
			note.createDiv({ cls: "knap-link-say", text: ask.body });
			if (ask.removed) note.createDiv({ cls: "knap-link-say knap-link-removed", text: ask.removed });
			if (ask.added) note.createDiv({ cls: "knap-link-say", text: ask.added });
			const buttons = note.createDiv({ cls: "knap-modal-buttons" });
			buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
			const go = buttons.createEl("button", { cls: "mod-warning", text: USE_CLOUD_SETTINGS });
			go.onclick = () => this.settle(true);
		});
	}

	private settle(go: boolean): void {
		const resolve = this.confirming;
		if (!resolve) return;
		this.confirming = null;
		this.noteEl?.empty();
		this.paint();
		resolve(go);
	}

	private answer(choice: LinkChoice | null): void {
		const resolve = this.choosing;
		if (!resolve) return;
		this.choosing = null;
		this.noteEl?.empty();
		this.paint();
		resolve(choice);
	}

	private paintChoice(diff: LinkDiff): void {
		const note = this.noteEl;
		if (!note) return;
		note.empty();
		note.createDiv({ cls: "knap-link-choice-say", text: choiceSay(this.vaultName) });
		note.createDiv({ cls: "knap-link-say", text: KEEP_BOTH_SAY });
		const buttons = note.createDiv({ cls: "knap-modal-buttons" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const split = buttons.createDiv({ cls: "knap-link-split" });
		const keep = split.createEl("button", { cls: "mod-cta", text: "Keep both" });
		keep.onclick = () => this.answer("both");
		const more = split.createEl("button", { cls: "mod-cta", attr: { "aria-label": "Other ways" } });
		setIcon(more, "chevron-down");
		more.onclick = (event) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Use the cloud vault's notes")
					.onClick(() => this.paintConfirm(diff, "cloud")),
			);
			menu.addItem((item) =>
				item.setTitle("Use this device's notes").onClick(() => this.paintConfirm(diff, "device")),
			);
			menu.showAtMouseEvent(event);
		};
	}

	private paintConfirm(diff: LinkDiff, choice: LinkChoice): void {
		const note = this.noteEl;
		const ask = replaceConfirm(choice, this.vaultName, diff);
		if (!note || !ask) return;
		note.empty();
		note.createEl("h3", { cls: "knap-link-confirm", text: ask.title });
		note.createDiv({ cls: "knap-link-say", text: ask.body });
		const buttons = note.createDiv({ cls: "knap-modal-buttons" });
		buttons.createEl("button", { text: "Back" }).onclick = () => this.paintChoice(diff);
		const replace = buttons.createEl("button", { cls: "mod-warning", text: "Replace" });
		replace.onclick = () => this.answer(choice);
	}

	private paint(problem = ""): void {
		const rows = this.rowsEl;
		if (!rows) return;
		rows.empty();
		const paused = this.choosing !== null || this.confirming !== null;
		const picture = sideBySide(this.facts);
		for (const row of linkRows(this.done, this.facts, this.failed, paused)) {
			// Once both sides are counted and compared, the two columns say
			// what the four count rows did, and say it at a glance.
			if (picture && COUNTED.includes(row.step)) {
				if (row.step === "cloudNotes") this.drawPicture(rows, picture);
				continue;
			}
			this.drawRow(rows, row);
		}
		const note = this.noteEl;
		if (!note) return;
		note.empty();
		if (problem) {
			note.createDiv({ cls: "knap-link-problem", text: problem });
			note.createDiv({
				cls: "knap-link-say",
				text: "Nothing was changed. Your notes are all still on this device.",
			});
		}
	}

	/** The two sides next to each other, and the notes as one bar. */
	private drawPicture(parent: HTMLElement, picture: SideBySide): void {
		const box = parent.createDiv({ cls: "knap-link-picture" });
		const columns = box.createDiv({ cls: "knap-link-sides" });
		this.drawSide(columns, "Cloud vault", picture.cloud);
		this.drawSide(columns, "This device", picture.local);
		const segments = barSegments(picture.bar);
		if (segments.length === 0) return;
		const bar = box.createDiv({ cls: "knap-link-bar", attr: { role: "img" } });
		bar.setAttr(
			"aria-label",
			segments.map((segment) => `${segment.label}: ${segment.count}`).join(", "),
		);
		const legend = box.createDiv({ cls: "knap-link-legend" });
		for (const segment of segments) {
			const part = bar.createDiv({ cls: `knap-link-seg knap-link-seg-${segment.key}` });
			part.style.flexGrow = String(segment.count);
			const key = legend.createSpan({ cls: "knap-link-key" });
			key.createSpan({ cls: `knap-link-swatch knap-link-seg-${segment.key}` });
			key.createSpan({ text: `${segment.label} ${segment.count.toLocaleString("en-US")}` });
		}
	}

	private drawSide(parent: HTMLElement, title: string, side: Side): void {
		const column = parent.createDiv({ cls: "knap-link-side" });
		column.createDiv({ cls: "knap-link-side-title", text: title });
		const line = (label: string, count: number) => {
			const row = column.createDiv({ cls: "knap-link-side-row" });
			row.createSpan({ text: label });
			row.createSpan({ cls: "knap-link-value", text: count.toLocaleString("en-US") });
		};
		line("Notes", side.notes);
		line("Attachments", side.attachments);
		if (side.plugins !== undefined) line("Plugins", side.plugins);
	}

	private drawRow(parent: HTMLElement, row: LinkRow): void {
		const el = parent.createDiv({ cls: `knap-link-step knap-link-${row.state}` });
		const mark = el.createSpan({ cls: "knap-link-mark" });
		// Three marks and one blank. A waiting step gets nothing rather than
		// an empty circle, because eight circles at once reads as eight
		// things going wrong.
		if (row.state === "done") setIcon(mark as HTMLElement, "check");
		if (row.state === "doing") setIcon(mark as HTMLElement, "loader");
		if (row.state === "failed") setIcon(mark as HTMLElement, "x");
		el.createSpan({ cls: "knap-link-label", text: row.label });
		el.createSpan({ cls: "knap-link-value", text: row.value });
	}
}
