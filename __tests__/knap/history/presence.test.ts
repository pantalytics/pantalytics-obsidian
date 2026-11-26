/** Who else is in a note, for the restore question. */

import { editorsIn, presenceLine } from "../../../src/knap/history/presence";

describe("who has a note open", () => {
	it("names other editors once, leaving out this device, AI carets and sockets without an editor", () => {
		const states = new Map<number, Record<string, unknown>>([
			[1, { user: { name: "Me", color: "#000" } }],
			[2, { user: { name: "Daniel", color: "#111" } }],
			[3, { user: { name: "Daniel", color: "#111" } }],
			[4, { user: { name: "Daniel's AI", color: "#222", ai: true } }],
			[5, { device: { name: "Laptop on desktop" } }],
			[6, { user: { name: "  " } }],
		]);
		expect(editorsIn(states, 1)).toEqual(["Daniel"]);
	});

	it("says one line, or nothing when nobody is there", () => {
		expect(presenceLine([])).toBeNull();
		expect(presenceLine(["Daniel"])).toBe("Daniel has this note open.");
		expect(presenceLine(["Daniel", "Eva"])).toBe("Daniel and Eva have this note open.");
		expect(presenceLine(["Daniel", "Eva", "Jo"])).toBe("Daniel and 2 others have this note open.");
	});
});
