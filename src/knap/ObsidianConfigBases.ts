/**
 * What this device last agreed with about its settings, kept beside
 * `knap-seen.json` in the plugin's own folder (ADR-0106).
 *
 * Its own file rather than a field in `knap-seen.json`, because the notes'
 * record is rewritten by a different binding on a different rhythm, and two
 * writers of one file is a lost update waiting for a busy afternoon.
 *
 * The cloud vault's id is written beside the hashes and checked on the way
 * back in, as the notes' record does: hashes agreed with one cloud vault say
 * nothing about another. Anything unreadable loads as empty, which is the
 * state before records existed: the cloud wins that start, and nothing is
 * deleted on either side.
 */

import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";

import type { ConfigBases } from "./ConfigBinding";

interface Stored {
	cloudVaultId: string;
	files: Record<string, string>;
}

export class ObsidianConfigBases implements ConfigBases {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly path: string,
		private readonly cloudVaultId: string,
	) {}

	async load(): Promise<Map<string, string>> {
		try {
			const stored = JSON.parse(
				await this.adapter.read(normalizePath(this.path)),
			) as Stored;
			if (stored.cloudVaultId !== this.cloudVaultId) return new Map();
			return new Map(Object.entries(stored.files ?? {}));
		} catch {
			return new Map();
		}
	}

	async save(bases: Map<string, string>): Promise<void> {
		const stored: Stored = {
			cloudVaultId: this.cloudVaultId,
			files: Object.fromEntries(bases),
		};
		await this.adapter.write(normalizePath(this.path), JSON.stringify(stored));
	}
}
