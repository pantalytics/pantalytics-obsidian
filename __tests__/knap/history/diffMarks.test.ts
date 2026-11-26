/** A version against the note as it is: what Restore would bring back and take out. */

import { hasChanges, markChanges } from "../../../src/knap/history/diffMarks";

describe("marking a version's changes", () => {
	it("marks what the version has as added and what only the note has as removed", () => {
		const marks = markChanges("The plan is cheap.", "The plan is expensive.");
		expect(marks).toEqual([
			{ kind: "same", text: "The plan is " },
			{ kind: "removed", text: "expensive" },
			{ kind: "added", text: "cheap" },
			{ kind: "same", text: "." },
		]);
		expect(hasChanges(marks)).toBe(true);
	});

	it("puts the version's whole text back together from what is not removed", () => {
		const version = "Line one\nLine two kept\nA new line\n";
		const current = "Line one\nLine two\n";
		const marks = markChanges(version, current);
		expect(marks.filter((m) => m.kind !== "removed").map((m) => m.text).join("")).toBe(version);
		expect(marks.filter((m) => m.kind !== "added").map((m) => m.text).join("")).toBe(current);
	});

	it("marks nothing for the same text", () => {
		const marks = markChanges("same", "same");
		expect(marks).toEqual([{ kind: "same", text: "same" }]);
		expect(hasChanges(marks)).toBe(false);
	});
});
