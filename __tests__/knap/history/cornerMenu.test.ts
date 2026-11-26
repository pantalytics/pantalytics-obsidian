/** Which lines the corner's menu holds, and when. */

import { cornerItems } from "../../../src/knap/history/cornerMenu";

const note = { lastChanged: "Daniel, 3 min ago", created: "12 Nov", synced: true };

describe("the corner's menu", () => {
	it("holds only the status line with no note open", () => {
		expect(cornerItems({ status: "Up to date, just now", problem: false, note: null })).toEqual([
			{ kind: "info", title: "Up to date, just now" },
		]);
	});

	it("says who changed the note, when it was made, and opens its versions", () => {
		expect(cornerItems({ status: "Up to date, just now", problem: false, note })).toEqual([
			{ kind: "info", title: "Up to date, just now" },
			{ kind: "info", title: "Last changed: Daniel, 3 min ago" },
			{ kind: "info", title: "Created: 12 Nov" },
			{ kind: "history", title: "Version history" },
		]);
	});

	it("leaves out what it does not know, and history for a note the cloud vault lacks", () => {
		const items = cornerItems({
			status: "Offline, since 14:02",
			problem: false,
			note: { lastChanged: null, created: "12 Nov", synced: false },
		});
		expect(items.map((i) => i.title)).toEqual(["Offline, since 14:02", "Created: 12 Nov"]);
	});

	it("offers Try again under Problem only, last, and never Settings", () => {
		const items = cornerItems({ status: "Problem", problem: true, note });
		expect(items[items.length - 1]).toEqual({ kind: "retry", title: "Try again" });
		expect(items.map((i) => i.title)).not.toContain("Settings");
		expect(cornerItems({ status: "Offline", problem: false, note }).some((i) => i.kind === "retry")).toBe(
			false,
		);
	});
});
