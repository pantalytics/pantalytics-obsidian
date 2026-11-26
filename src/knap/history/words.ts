/**
 * The words of a note's history, the same ones the dashboard uses.
 *
 * How a version was made is `made_by` in the admin repository's
 * `vault_history.py`, word for word, so a person moving between Obsidian and
 * the dashboard reads one history and not two. Everything here is pure and
 * takes `now`, so the tests pin it without a clock.
 */

import type { NoteActivity, NoteVersion, VersionId } from "../KnapServer";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How a version was made, in the dashboard's words. */
export function madeBy(version: Pick<NoteVersion, "actor_kind" | "actor_email">): string {
	switch (version.actor_kind) {
		case "typed":
			return "Typed in Obsidian";
		case "tool":
			return version.actor_email ? `Written by AI for ${version.actor_email}` : "Written by AI";
		case "panel":
			return version.actor_email ? `Put back by ${version.actor_email}` : "Put back";
		default:
			return "Not recorded";
	}
}

/**
 * A person's name from an address: the part before the @, in words.
 * `daniel.jansen@acme.nl` is *Daniel Jansen*. Empty for no address.
 */
export function personName(email: string | null | undefined): string {
	const local = (email ?? "").split("@")[0].trim();
	if (!local) return "";
	return local
		.split(/[._-]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function two(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** The time of day, 14:02. */
export function clock(ms: number): string {
	const at = new Date(ms);
	return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** A date, 12 Nov, with the year when it is not this year's. */
export function shortDate(ms: number, now: number): string {
	const at = new Date(ms);
	const year = at.getFullYear() !== new Date(now).getFullYear() ? ` ${at.getFullYear()}` : "";
	return `${at.getDate()} ${MONTHS[at.getMonth()]}${year}`;
}

/** Midnight before `ms`, local time. */
function dayStart(ms: number): number {
	const at = new Date(ms);
	return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** Today, Yesterday, or the date. */
export function dayLabel(ms: number, now: number): string {
	const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	return shortDate(ms, now);
}

/**
 * When a note was created, as best this device can say: the file's own date,
 * or the oldest version when that is earlier. A note that arrived through
 * sync carries the day it landed here, which the history can correct.
 */
export function createdAt(fileCtime: number, versions: readonly NoteVersion[] | undefined): number {
	const oldest = versions && versions.length > 0 ? versions[versions.length - 1].ts * 1000 : Infinity;
	return Math.min(fileCtime, oldest);
}

/** How long ago, short: just now, 3 min ago, 2 h ago, yesterday, 4 days ago, 12 Nov. */
export function ago(ms: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - ms) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 30) return `${days} days ago`;
	return shortDate(ms, now);
}

/** One row of the sidebar: when, who, how. */
export interface VersionRow {
	id: VersionId;
	/** Epoch milliseconds. */
	at: number;
	time: string;
	who: string;
	how: string;
}

/** A day's heading and the versions under it, newest first. */
export interface VersionGroup {
	label: string;
	rows: VersionRow[];
}

/** The versions, grouped Today / Yesterday / by date, in the order given (newest first). */
export function groupVersions(versions: readonly NoteVersion[], now: number): VersionGroup[] {
	const groups: VersionGroup[] = [];
	for (const version of versions) {
		const at = version.ts * 1000;
		const label = dayLabel(at, now);
		let group = groups[groups.length - 1];
		if (!group || group.label !== label) {
			group = { label, rows: [] };
			groups.push(group);
		}
		group.rows.push({
			id: version.id,
			at,
			time: clock(at),
			// The address is in the how already for an AI's version and one
			// put back, so it is not said twice on one row.
			who: version.actor_kind === "typed" ? personName(version.actor_email) : "",
			how: madeBy(version),
		});
	}
	return groups;
}

/** When a version was made, as a title says it: today at 14:02, 12 Nov at 09:15. */
export function versionWhen(ms: number, now: number): string {
	const day = dayLabel(ms, now);
	const lead = day === "Today" || day === "Yesterday" ? day.toLowerCase() : day;
	return `${lead} at ${clock(ms)}`;
}

/**
 * Who changed a note last and when, off the newest activity row: the name in
 * the address, else the device. Null when the server recorded none.
 */
export function lastChange(
	activity: readonly NoteActivity[],
	now: number,
): { who: string; when: string } | null {
	const newest = activity[0];
	if (!newest) return null;
	const person = personName(newest.actor_email);
	// An AI's edit is the AI's, on somebody's behalf: naming the person alone
	// would say they typed it.
	const who =
		newest.kind === "tool"
			? person
				? `AI for ${person}`
				: "AI"
			: person || (newest.device ?? "").trim() || "Someone";
	return { who, when: ago(newest.ts * 1000, now) };
}

/**
 * The corner's first line: the word, and when the vault was last up to date.
 * *Up to date, just now* while it is; *Offline, since 14:02* while it is not;
 * the word alone when it has not been up to date since Obsidian started.
 */
export function statusLine(word: string, upToDateAt: number, now: number, upToDate: boolean): string {
	if (upToDate) return `${word}, just now`;
	if (!upToDateAt) return word;
	const when = dayStart(upToDateAt) === dayStart(now) ? clock(upToDateAt) : shortDate(upToDateAt, now);
	return `${word}, since ${when}`;
}
