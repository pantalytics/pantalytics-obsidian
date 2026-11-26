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
	it("says it in the dashboard's words", () => {
		expect(madeBy({ actor_kind: "typed", actor_email: "a@b" })).toBe("Typed in Obsidian");
		expect(madeBy({ actor_kind: "tool", actor_email: "a@b" })).toBe("Written by AI for a@b");
		expect(madeBy({ actor_kind: "tool", actor_email: null })).toBe("Written by AI");
		expect(madeBy({ actor_kind: "panel", actor_email: "daniel@acme.nl" })).toBe(
			"Put back by daniel@acme.nl",
		);
		expect(madeBy({ actor_kind: "panel", actor_email: null })).toBe("Put back");
		expect(madeBy({ actor_kind: null, actor_email: null })).toBe("Not recorded");
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
	it("groups newest first under Today, Yesterday and the date", () => {
		const groups = groupVersions(
			[
				version("v4", at(26, 14, 2), "typed", "daniel@acme.nl"),
				version("v3", at(26, 9, 30), "tool", null),
				version("v2", at(25, 18, 0), "panel", "eva@acme.nl"),
				version("v1", at(12, 8, 0), null, null),
			],
			NOW,
		);
		expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "12 Nov"]);
		expect(groups[0].rows).toEqual([
			{ id: "v4", at: at(26, 14, 2), time: "14:02", who: "Daniel", how: "Typed in Obsidian" },
			{ id: "v3", at: at(26, 9, 30), time: "09:30", who: "", how: "Written by AI" },
		]);
		expect(groups[1].rows[0].how).toBe("Put back by eva@acme.nl");
		expect(groups[2].rows[0].how).toBe("Not recorded");
	});

	it("names the person only on a typed version, since the how already holds the address", () => {
		const [group] = groupVersions([version("v5", at(26, 10, 0), "tool", "daniel@acme.nl")], NOW);
		expect(group.rows[0]).toMatchObject({ who: "", how: "Written by AI for daniel@acme.nl" });
	});

	it("is empty for no versions", () => {
		expect(groupVersions([], NOW)).toEqual([]);
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
