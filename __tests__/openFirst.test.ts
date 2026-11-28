import { compareFilePaths, openFirst } from "../src/FolderSort";

const queue = () =>
	[
		"/Daily/2026-11-27.md",
		"/Clients/Acme/renewal.md",
		"/Poem 2026.md",
		"/Clients/Beta/notes.md",
	].map((path) => ({ path }));

describe("openFirst", () => {
	it("left alone, a note in the vault's root goes last", () => {
		const paths = queue().sort(compareFilePaths).map((i) => i.path);
		expect(paths[paths.length - 1]).toBe("/Poem 2026.md");
	});

	it("the open note goes first, named as Obsidian names it", () => {
		const open = new Set(["Poem 2026.md"]);
		const paths = queue()
			.sort(openFirst((p) => open.has(p)))
			.map((i) => i.path);
		expect(paths[0]).toBe("/Poem 2026.md");
	});

	it("several open notes go first, and the rest keep path order", () => {
		const open = new Set(["Poem 2026.md", "Daily/2026-11-27.md"]);
		const sorted = queue().sort(openFirst((p) => open.has(p)));
		const rest = queue()
			.filter((i) => !open.has(i.path.slice(1)))
			.sort(compareFilePaths);
		expect(new Set(sorted.slice(0, 2).map((i) => i.path))).toEqual(
			new Set(["/Poem 2026.md", "/Daily/2026-11-27.md"]),
		);
		expect(sorted.slice(2)).toEqual(rest);
	});

	it("with nothing open it is exactly the old order", () => {
		const before = queue().sort(compareFilePaths);
		expect(queue().sort(openFirst(() => false))).toEqual(before);
	});
});
