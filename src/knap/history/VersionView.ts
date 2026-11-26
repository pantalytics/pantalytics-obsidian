/**
 * One version of a note, read-only, in a tab of its own.
 *
 * The version's text with what differs from the note as it is now marked in
 * place: struck through is what Restore would take out, highlighted is what
 * it would bring back (`diffMarks.ts`). Two buttons, Close and Restore, and
 * Restore is the only one in the accent colour.
 *
 * Restore asks first, and says so when somebody else has the note open,
 * because their screen is the one that changes under them. It goes to the
 * server and never to the file here (`HistoryService`).
 */

import {
	App,
	ItemView,
	Modal,
	Notice,
	TFile,
	setTooltip,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";

import { PLUGIN_ID } from "../../pluginId";
import type { VersionText } from "../KnapServer";
import { markChanges } from "./diffMarks";
import { failureText, type HistoryService } from "./HistoryService";
import { presenceLine } from "./presence";
import { madeBy, versionWhen } from "./words";

export const VIEW_VERSION = `${PLUGIN_ID}-version`;

interface VersionState {
	path: string;
	versionId: string;
	/** How it was made, as the history said; the version endpoint does not say. */
	how?: string;
}

/** The question before a restore. Resolves true for Restore. */
class RestoreModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly when: string,
		private readonly others: string | null,
		private readonly done: (restore: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`Restore the version of ${this.when}?`);
		if (this.others) this.contentEl.createEl("p", { text: this.others });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons
			.createEl("button", { cls: "mod-cta", text: "Restore" })
			.addEventListener("click", () => {
				this.answer(true);
				this.close();
			});
	}

	onClose(): void {
		this.answer(false);
		this.contentEl.empty();
	}

	private answer(value: boolean): void {
		if (this.answered) return;
		this.answered = true;
		this.done(value);
	}
}

export class VersionView extends ItemView {
	private state: VersionState | null = null;
	private version: VersionText | null = null;
	private restoreButton: HTMLButtonElement | null = null;
	/** Holds the tooltip: a disabled button takes no pointer, its wrapper does. */
	private restoreWrap: HTMLElement | null = null;
	private restoring = false;
	/** Whether the tooltip was last set for a reachable server; null before the first paint. */
	private restoreTip: boolean | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly service: HistoryService,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_VERSION;
	}

	getDisplayText(): string {
		const name = this.state?.path.split("/").pop()?.replace(/\.md$/, "");
		return name ?? "Version";
	}

	getIcon(): string {
		return "history";
	}

	getState(): Record<string, unknown> {
		return this.state ? { ...this.state } : {};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = state as Partial<VersionState> | null;
		if (next?.path && next.versionId) {
			this.state = { path: next.path, versionId: next.versionId, how: next.how };
			await this.fetchVersion();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("knap-version");
		// Whether Restore can be pressed follows the connection.
		this.registerInterval(window.setInterval(() => this.paintRestore(), 1000));
	}

	private async fetchVersion(): Promise<void> {
		const state = this.state;
		if (!state) return;
		this.version = null;
		this.contentEl.empty();
		let version: VersionText;
		try {
			version = await this.service.version(state.versionId);
		} catch (error) {
			if (state !== this.state) return;
			this.contentEl.createDiv({
				cls: "knap-history-muted",
				text: failureText(error, "Could not reach Pantalytics."),
			});
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(state.path);
		const current = file instanceof TFile ? await this.app.vault.read(file) : "";
		if (state !== this.state) return;
		this.version = version;
		this.draw(version, current);
	}

	private draw(version: VersionText, current: string): void {
		const el = this.contentEl;
		el.empty();
		const head = el.createDiv({ cls: "knap-version-head" });
		const words = head.createDiv();
		words.createDiv({ cls: "knap-version-when", text: capital(versionWhen(version.ts * 1000, Date.now())) });
		const how = this.state?.how ?? madeBy({ actor_kind: null, actor_email: null });
		words.createDiv({ cls: "knap-history-muted", text: how });
		const buttons = head.createDiv({ cls: "knap-version-buttons" });
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.leaf.detach());
		this.restoreTip = null;
		this.restoreWrap = buttons.createSpan({ cls: "knap-version-restore" });
		this.restoreButton = this.restoreWrap.createEl("button", { cls: "mod-cta", text: "Restore" });
		this.restoreButton.addEventListener("click", () => this.askRestore());
		this.paintRestore();

		const body = el.createDiv({ cls: "knap-version-text" });
		for (const mark of markChanges(version.text, current)) {
			if (mark.kind === "same") body.appendText(mark.text);
			else if (mark.kind === "added") body.createEl("ins", { cls: "knap-mark-added", text: mark.text });
			else body.createEl("del", { cls: "knap-mark-removed", text: mark.text });
		}
	}

	private paintRestore(): void {
		const button = this.restoreButton;
		const wrap = this.restoreWrap;
		if (!button || !wrap) return;
		const reachable = this.service.canReach();
		if (button.disabled === (this.restoring || !reachable) && this.restoreTip === reachable) return;
		button.disabled = this.restoring || !reachable;
		this.restoreTip = reachable;
		setTooltip(wrap, reachable ? "" : "Restore needs a connection.");
	}

	private askRestore(): void {
		const state = this.state;
		const version = this.version;
		if (!state || !version || this.restoring) return;
		const when = versionWhen(version.ts * 1000, Date.now());
		const others = presenceLine(this.service.othersIn(state.path));
		new RestoreModal(this.app, when, others, (yes) => {
			if (yes) void this.restore(state, version);
		}).open();
	}

	private async restore(state: VersionState, version: VersionText): Promise<void> {
		this.restoring = true;
		this.paintRestore();
		try {
			await this.service.restore(version.id, state.path);
			new Notice("Restored");
			this.leaf.detach();
		} catch (error) {
			new Notice(failureText(error, "Restore needs a connection."));
		} finally {
			this.restoring = false;
			this.paintRestore();
		}
	}
}

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
