/**
 * The words of a note's history: the dashboard's, and the same every time.
 * Local time throughout, built with `new Date(y, m, d, h, min)`, so the tests
 * hold in any time zone.
 */

import type { NoteActivity, NoteVersion } from "../../../src/knap/KnapServer";
import {
	ago,
	createdAt,
	dayLabel,
	groupVersions,
	typedBy,
	lastChange,
	madeBy,
	personName,
	shortDate,
	statusLine,
	versionWhen,
} from "../../../src/knap/history/words";

const at = (d: number, h: number, min: number, month = 10, year = 2026) =>
	new Date(year, month, d, h, min).getTime();
const NOW = at(26, 15, 0);

function version(id: string, ms: number, kind: NoteVersion["actor_kind"], email: string | null): NoteVersion {
	return {
		id,
		path: "Plans.md",
		ts: ms / 1000,
		sha256: "",
		actor_kind: kind,
		actor_subject: null,
		actor_email: email,
	};
}

describe("how a version was made", () => {
	it("says what the version holds: the note after typing, or before an AI edit or a restore", () => {
		expect(madeBy({ actor_kind: "typed" })).toBe("Typed in Obsidian");
		expect(madeBy({ actor_kind: "tool" })).toBe("Before an AI edit");
		expect(madeBy({ actor_kind: "panel" })).toBe("Before a restore");
		expect(madeBy({ actor_kind: null })).toBe("Not recorded");
	});
});

describe("a person's name", () => {
	it("is the part before the @, in words", () => {
		expect(personName("daniel@acme.nl")).toBe("Daniel");
		expect(personName("daniel.jansen@acme.nl")).toBe("Daniel Jansen");
		expect(personName("")).toBe("");
		expect(personName(null)).toBe("");
	});
});

describe("times", () => {
	it("says how long ago, shortly", () => {
		expect(ago(NOW - 20_000, NOW)).toBe("just now");
		expect(ago(NOW + 60_000, NOW)).toBe("just now");
		expect(ago(NOW - 3 * 60_000, NOW)).toBe("3 min ago");
		expect(ago(NOW - 2 * 3_600_000, NOW)).toBe("2 h ago");
		expect(ago(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
		expect(ago(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
		expect(ago(at(12, 9, 0, 9), NOW)).toBe("12 Oct");
	});

	it("names the day, and the year only when it is another", () => {
		expect(dayLabel(at(26, 0, 1), NOW)).toBe("Today");
		expect(dayLabel(at(25, 23, 59), NOW)).toBe("Yesterday");
		expect(dayLabel(at(12, 9, 0), NOW)).toBe("12 Nov");
		expect(shortDate(at(12, 9, 0, 10, 2025), NOW)).toBe("12 Nov 2025");
		expect(versionWhen(at(26, 14, 2), NOW)).toBe("today at 14:02");
		expect(versionWhen(at(12, 9, 5), NOW)).toBe("12 Nov at 09:05");
	});
});

describe("the versions, by day", () => {
	const typing = (started: number, ts: number, email: string | null, platform: string | null, device = "Laptop") => ({
		started: started / 1000,
		ts: ts / 1000,
		kind: "device" as const,
		subject: null,
		device,
		platform,
		actor_email: email,
	});

	it("groups newest first and names who typed from the edit rows, never from the version", () => {
		const groups = groupVersions(
			[
				version("v4", at(26, 14, 2), "typed", null),
				version("v3", at(26, 9, 30), "tool", "rutger@pantalytics.com"),
				version("v2", at(25, 18, 0), "panel", "eva@acme.nl"),
				version("v1", at(12, 8, 0), null, null),
			],
			NOW,
			[typing(at(26, 13, 50), at(26, 14, 1), "daniel@acme.nl", "iphone")],
		);
		expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "12 Nov"]);
		expect(groups[0].rows).toEqual([
			{ id: "v4", at: at(26, 14, 2), time: "14:02", who: "Daniel on iPhone", how: "Typed in Obsidian" },
			{ id: "v3", at: at(26, 9, 30), time: "09:30", who: "Rutger", how: "Before an AI edit" },
		]);
		expect(groups[1].rows[0]).toMatchObject({ who: "Eva", how: "Before a restore" });
		expect(groups[2].rows[0]).toMatchObject({ who: "", how: "Not recorded" });
	});

	it("names nobody on a typed version when no edit row covers its stretch", () => {
		const [group] = groupVersions(
			[version("v2", at(26, 14, 0), "typed", null), version("v1", at(26, 10, 0), "typed", null)],
			NOW,
			[typing(at(26, 9, 0), at(26, 9, 30), "daniel@acme.nl", "mac")],
		);
		expect(group.rows.map((r) => r.who)).toEqual(["", "Daniel on Mac"]);
	});

	it("is empty for no versions", () => {
		expect(groupVersions([], NOW)).toEqual([]);
	});
});

describe("who typed a stretch", () => {
	it("lists each device once, and falls back to the device name without an address", () => {
		const rows = [
			{ started: 100, ts: 150, kind: "device" as const, subject: null, device: "Work Mac", platform: "mac", actor_email: null },
			{ started: 120, ts: 160, kind: "device" as const, subject: null, device: "x", platform: "iphone", actor_email: "daniel@acme.nl" },
			{ started: 130, ts: 170, kind: "device" as const, subject: null, device: "x", platform: "iphone", actor_email: "daniel@acme.nl" },
			{ started: 140, ts: 180, kind: "tool" as const, subject: "s", device: null, platform: null, actor_email: "rutger@pantalytics.com" },
		];
		expect(typedBy(rows, 90, 200)).toBe("Work Mac on Mac, Daniel on iPhone");
		expect(typedBy(rows, 200, 300)).toBe("");
	});
});

describe("who changed a note last", () => {
	const row = (over: Partial<NoteActivity>): NoteActivity => ({
		started: 0,
		ts: (NOW - 3 * 60_000) / 1000,
		kind: "device",
		subject: null,
		device: "MacBook",
		platform: "mac",
		actor_email: "daniel@acme.nl",
		...over,
	});

	it("is the newest activity row, by name, else by device", () => {
		expect(lastChange([row({}), row({ actor_email: "eva@acme.nl" })], NOW)).toEqual({
			who: "Daniel",
			when: "3 min ago",
		});
		expect(lastChange([row({ actor_email: null })], NOW)?.who).toBe("MacBook");
		expect(lastChange([row({ kind: "tool" })], NOW)?.who).toBe("AI for Daniel");
		expect(lastChange([row({ kind: "tool", actor_email: null })], NOW)?.who).toBe("AI");
		expect(lastChange([], NOW)).toBeNull();
	});
});

describe("when a note was created", () => {
	it("is the file's date, or the oldest version when that is earlier", () => {
		const versions = [version("v2", at(20, 9, 0), "typed", null), version("v1", at(3, 9, 0), "typed", null)];
		expect(createdAt(at(26, 8, 0), versions)).toBe(at(3, 9, 0));
		expect(createdAt(at(1, 8, 0), versions)).toBe(at(1, 8, 0));
		expect(createdAt(at(1, 8, 0), undefined)).toBe(at(1, 8, 0));
	});
});

describe("the status line", () => {
	it("says just now while up to date, and since when otherwise", () => {
		expect(statusLine("Up to date", NOW, NOW, true)).toBe("Up to date, just now");
		expect(statusLine("Offline", at(26, 14, 2), NOW, false)).toBe("Offline, since 14:02");
		expect(statusLine("Offline", at(20, 14, 2), NOW, false)).toBe("Offline, since 20 Nov");
		expect(statusLine("Signed out", 0, NOW, false)).toBe("Signed out");
	});
});
