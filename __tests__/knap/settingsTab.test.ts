/**
 * Two rows and a strip, and each of them says the right thing in each state.
 *
 * The screen exists because the commands were the only way in, and somebody
 * asked to try the beta opens Settings first. What is pinned here is the shape
 * it settled on: no Change button, no Problems row, a Cloud vault row that is
 * a name, and a strip that belongs to that row rather than floating above it.
 */

import {
	KnapSettingsTab,
	barSentence,
	dashboardHelp,
	dashboardUrl,
	hasFold,
	hasRetry,
	headCount,
	signOutNotice,
	statusFacts,
} from "../../src/knap/KnapSettingsTab";
import { INITIALIZING, OFFLINE, PROBLEM, SYNCING, UP_TO_DATE } from "../../src/syncStatus";

type Row = {
	name: string;
	desc: string;
	buttons: string[];
	press?: () => void;
	/** The info button beside the switch, if the row has one. */
	extras?: string[];
	/** Pressing that info button, kept apart from the row's own button. */
	pressExtra?: () => void;
	/** The switch itself: what it shows, and how to flip it. */
	toggle?: { value: boolean; flip: (on: boolean) => void };
};

/** What the plugin said in the corner. `var` so the mock factory can hoist it. */
var notices: string[] = [];

/** Whatever the screen built by hand, flattened to what it says and does. */
interface FakeEl {
	cls: string;
	text: string;
	hidden: boolean;
	rows?: Row[];
	type?: string;
	children: FakeEl[];
	attrs: Record<string, string>;
	listeners: Array<() => void>;
	createDiv(spec?: { cls?: string; text?: string }): FakeEl;
	createSpan(spec?: { cls?: string; text?: string }): FakeEl;
	createEl(tag: string, spec?: { cls?: string; text?: string }): FakeEl;
	addClass(cls: string): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	addEventListener(name: string, run: () => void): void;
	insertBefore(node: FakeEl, before: FakeEl): void;
}

function el(cls = "", text = ""): FakeEl {
	const node: FakeEl = {
		cls,
		text,
		hidden: false,
		rows: [],
		children: [],
		attrs: {},
		listeners: [],
		createDiv: (spec = {}) => {
			const child = el(spec.cls ?? "", spec.text ?? "");
			// One list for the whole tree: the Cloud vault row is drawn into a
			// block of its own now, and a test asking what the rows say should
			// not have to know which element each was drawn into.
			child.rows = node.rows;
			node.children.push(child);
			return child;
		},
		createSpan: (spec = {}) => node.createDiv(spec),
		createEl: (_tag, spec = {}) => node.createDiv(spec),
		addClass: (added) => {
			node.cls = `${node.cls} ${added}`.trim();
		},
		setAttribute: (name, value) => {
			node.attrs[name] = value;
		},
		getAttribute: (name) => node.attrs[name] ?? null,
		addEventListener: (_name, run) => node.listeners.push(run),
		empty: () => {
			node.children.splice(0, node.children.length);
		},
		insertBefore: (child, before) => {
			const from = node.children.indexOf(child);
			if (from >= 0) node.children.splice(from, 1);
			const at = node.children.indexOf(before);
			node.children.splice(at < 0 ? node.children.length : at, 0, child);
		},
	};
	return node;
}

/** Every node under one, so a test can look for a class without walking. */
function flatten(node: FakeEl): FakeEl[] {
	return [node, ...node.children.flatMap(flatten)];
}

function find(root: FakeEl, cls: string): FakeEl | undefined {
	return flatten(root).find((node) => node.cls.split(" ").includes(cls));
}

jest.mock("obsidian", () => {
	class Setting {
		private row: Row = { name: "", desc: "", buttons: [], extras: [] };
		constructor(container: { rows?: Row[] }) {
			container.rows?.push(this.row);
		}
		setName(name: string) {
			this.row.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.row.desc = desc;
			return this;
		}
		setHeading() {
			return this;
		}
		addButton(build: (b: unknown) => void) {
			const button = {
				setButtonText: (text: string) => {
					this.row.buttons.push(text);
					return button;
				},
				setCta: () => button,
				onClick: (run: () => void) => {
					this.row.press = run;
					return button;
				},
			};
			build(button);
			return this;
		}
		addExtraButton(build: (b: unknown) => void) {
			const button = {
				setIcon: (icon: string) => {
					this.row.extras?.push(icon);
					return button;
				},
				setTooltip: () => button,
				onClick: (run: () => void) => {
					this.row.pressExtra = run;
					return button;
				},
			};
			build(button);
			return this;
		}
		addToggle(build: (t: unknown) => void) {
			const toggle = {
				setValue: (value: boolean) => {
					this.row.toggle = { value, flip: () => undefined };
					return toggle;
				},
				onChange: (run: (on: boolean) => void) => {
					if (this.row.toggle) this.row.toggle.flip = run;
					return toggle;
				},
			};
			build(toggle);
			return this;
		}
	}
	class PluginSettingTab {
		containerEl: unknown;
		constructor(
			public app: unknown,
			public plugin: unknown,
		) {}
	}
	return {
		Setting,
		PluginSettingTab,
		Notice: class {
			constructor(message: string) {
				notices.push(message);
			}
		},
		App: class {},
		setIcon: () => {},
		Modal: class {
			contentEl = { empty: () => undefined };
			constructor(public app: unknown) {}
			open() {}
			close() {}
		},
	};
});

interface FakeState {
	signedIn: boolean;
	linked: null | { id: string; name: string };
	status?: Partial<ReturnType<typeof baseStatus>>;
}

function baseStatus() {
	return {
		word: UP_TO_DATE as string,
		dot: "ok" as string,
		vaultName: "",
		notes: 0,
		attachments: 0,
		problems: 0,
		up: 0,
		down: 0,
		files: { up: 0, down: 0 },
		checked: { notes: { done: 0, total: 0 }, attachments: { done: 0, total: 0 } },
	};
}

/** A pass at start, part way through its notes. */
function partWay(done: number, notes: number, attachments = 0) {
	return {
		notes: { done, total: notes },
		attachments: { done: 0, total: attachments },
	};
}

/** A stand-in KnapSync that remembers whether it was signed out. */
function fakeSync(state: FakeState) {
	let signedIn = state.signedIn;
	let linked = state.linked;
	const retried: string[] = [];
	let settle: (() => void) | null = null;
	let breaks: ((error: Error) => void) | null = null;
	return {
		retried,
		/** Move the vault on, the way a socket does behind the screen's back. */
		becomes(status: Partial<ReturnType<typeof baseStatus>>) {
			state.status = { ...(state.status ?? {}), ...status };
		},
		/** Let a retry that is being held finish. */
		finishRetry() {
			settle?.();
			settle = null;
		},
		/** End the held retry the way an unreachable server ends one. */
		failRetry(message: string) {
			breaks?.(new Error(message));
			settle = null;
			breaks = null;
		},
		get signedIn() {
			return signedIn;
		},
		get linked() {
			return linked
				? { cloudVaultId: linked.id, cloudVaultName: linked.name, token: "t" }
				: null;
		},
		status: () => ({
			...baseStatus(),
			vaultName: linked?.name ?? "",
			...(state.status ?? {}),
		}),
		retry: () => {
			retried.push("retry");
			// Held open until the test says so, because the half-minute a real
			// retry can take is the whole reason the button says anything.
			return new Promise<void>((resolve, reject) => {
				settle = resolve;
				breaks = reject;
			});
		},
		unlink: async () => {
			linked = null;
		},
		signOut: async () => {
			signedIn = false;
			linked = null;
			return { endedRemotely: true };
		},
	};
}

function drawWith(sync: ReturnType<typeof fakeSync>) {
	const rows: Row[] = [];
	const container = Object.assign(el("container"), {
		rows,
		empty: () => {
			rows.splice(0, rows.length);
		},
	});
	const plugin = { app: {}, registerInterval: (id: number) => id };
	const actions = { signIn: async () => {}, pickAndLink: async () => {} };
	const opened: string[] = [];
	const tab = new KnapSettingsTab(
		plugin as never,
		sync as never,
		actions as never,
		"https://next.knap.test",
		(url: string) => opened.push(url),
	);
	tab.containerEl = container as never;
	tab.display();
	open.push(tab);
	return { rows, container: container as unknown as FakeEl, tab, opened };
}

/** Every screen a test opened, so its tick stops with the test. */
const open: KnapSettingsTab[] = [];

afterEach(() => {
	while (open.length) open.pop()?.hide();
	notices.length = 0;
});

function drawFor(state: FakeState) {
	return drawWith(fakeSync(state));
}

describe("the screen, signed out", () => {
	it("offers signing in, and the way out to the dashboard", () => {
		// Nothing about this vault, because there is no account to have one
		// under yet. The dashboard is there because that is where a first
		// cloud vault gets made.
		const { rows } = drawFor({ signedIn: false, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toEqual(["Sign in", "Open"]);
	});

	it("names the server this build talks to, without its scheme", () => {
		const { container } = drawFor({ signedIn: false, linked: null });
		expect(find(container, "knap-server")?.text).toBe("next.knap.test");
	});

	it("draws no status bar, because there is nothing to report yet", () => {
		const { container } = drawFor({ signedIn: false, linked: null });
		expect(find(container, "knap-status")).toBeUndefined();
	});
});

describe("the screen, signed in", () => {
	it("offers choosing a cloud vault, and no unlink yet", () => {
		const { rows } = drawFor({ signedIn: true, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toContain("Choose...");
		expect(rows.flatMap((r) => r.buttons)).not.toContain("Unlink");
		expect(rows.find((r) => r.name === "Cloud vault")?.desc).toContain("Not linked");
	});

	it("draws no bar until there is a link, because it has no vault to be about", () => {
		// The bar settled on Up to date over a vault that syncs with nothing,
		// which is #40's lie in a new place. The Cloud vault row underneath
		// says Not linked, and that is both truer and the way out.
		const { container } = drawFor({ signedIn: true, linked: null });
		expect(find(container, "knap-status")).toBeUndefined();
	});

	it("draws the bar once a cloud vault is linked", () => {
		const { container } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		expect(find(container, "knap-status")).toBeDefined();
	});

	it("names the linked vault and offers only unlink beside it", () => {
		// No Change: linking somewhere else is Unlink and then Choose, which
		// is what happens underneath either way.
		const { rows } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		const vault = rows.find((r) => r.name === "Cloud vault");
		expect(vault?.desc).toBe("Work notes");
		expect(vault?.buttons).toEqual(["Unlink"]);
	});

	it("says the name and nothing else on that row", () => {
		// #116's sentence about a delete travelling both ways moved to the
		// screen that links. This row is read every week about a decision
		// somebody took once.
		const { rows } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		expect(rows.find((r) => r.name === "Cloud vault")?.desc).not.toContain("deletes it in the");
	});

	it("puts the account above the vault, and the strip under the vault", () => {
		const { rows, container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
		});
		// Account, then the vault, then the way out. The order is what each
		// row depends on: who, then which vault, then the page that reports on
		// it. There is still no row about how much of the vault travels.
		expect(rows.map((r) => r.name)).toEqual(["Account", "Cloud vault", "Pantalytics dashboard"]);
		// Inside the vault's own block rather than beside it: one border round
		// both, so the strip cannot be read as a third subject.
		const block = find(container, "knap-vault");
		expect(block).toBeDefined();
		expect(find(block as never, "knap-status")).toBeDefined();
	});

	it("has no row for problems, in any state", () => {
		for (const problems of [0, 3]) {
			const { rows } = drawFor({
				signedIn: true,
				linked: { id: "v1", name: "Work notes" },
				status: { problems, word: problems ? PROBLEM : UP_TO_DATE, dot: "error" },
			});
			expect(rows.map((r) => r.name)).toEqual([
				"Account",
				"Cloud vault",
				"Pantalytics dashboard",
			]);
		}
	});

	it("offers a way back out in both signed-in states", () => {
		for (const linked of [null, { id: "v1", name: "Work notes" }]) {
			const { rows } = drawFor({ signedIn: true, linked });
			expect(rows.find((r) => r.name === "Account")?.buttons).toEqual(["Sign out"]);
		}
	});

	it("signs out when the button is pressed, and comes back offering sign in", async () => {
		const sync = fakeSync({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		const { rows } = drawWith(sync);

		rows.find((r) => r.name === "Account")?.press?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(rows.flatMap((r) => r.buttons)).toEqual(["Sign in", "Open"]);
		expect(rows.map((r) => r.desc).join(" ")).not.toContain("Work notes");
	});
});

describe("the settings switch that is not there", () => {
	// The switch is gone, and with it the two ways it could be wrong: off on
	// one device and on on another, and a person having to know that settings
	// are a thing you opt into. A vault is its notes and how it is set up.
	it("has no row, linked or not", () => {
		for (const linked of [null, { id: "v1", name: "Work notes" }]) {
			const { rows } = drawWith(fakeSync({ signedIn: true, linked }));
			expect(rows.map((row) => row.name)).not.toContain("Sync settings");
		}
	});

	it("leaves no switch anywhere on the screen", () => {
		const { rows } = drawWith(
			fakeSync({ signedIn: true, linked: { id: "v1", name: "Work notes" } }),
		);
		expect(rows.filter((row) => row.toggle !== undefined)).toEqual([]);
	});
});

describe("the bar", () => {
	it("wears the word, the dot and the size, and not the vault's name", () => {
		// The row a hairline above spells the name out. Saying it again within
		// a thumb of itself is what #125 took out of the fold.
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: UP_TO_DATE, dot: "ok", vaultName: "Work notes", notes: 1202 },
		});
		expect(find(container, "knap-status-word")?.text).toBe("Up to date");
		expect(find(container, "knap-dot-ok")).toBeDefined();
		expect(find(container, "knap-status-count")?.text).toBe("1,202 notes");
		expect(find(container, "knap-status-head")?.text).not.toContain("Work notes");
	});

	it("counts one note as a note", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "260812_RH_Obsidian_vault" },
			status: { word: UP_TO_DATE, dot: "ok", vaultName: "260812_RH_Obsidian_vault", notes: 1 },
		});
		expect(find(container, "knap-status-count")?.text).toBe("1 note");
	});

	it("does not open at all when the fold would be empty", () => {
		// A vault whose tree has not been read yet counts nothing, has nothing
		// stuck and nothing to retry. A head that opens onto an empty strip is
		// worse than a head that does not open (#125).
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: UP_TO_DATE, dot: "ok", vaultName: "Work notes" },
		});
		const head = find(container, "knap-status-head");
		expect(head?.getAttribute("aria-expanded")).toBeNull();
		expect(head?.listeners).toEqual([]);
		expect(find(container, "knap-status-chevron")).toBeUndefined();
	});

	it("wears a chevron when it opens, because a phone has no hover to find it with", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: SYNCING, dot: "working", vaultName: "Work notes", notes: 3 },
		});
		expect(find(container, "knap-status-chevron")).toBeDefined();
	});

	it("starts folded, and opens when the head is pressed", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: SYNCING, dot: "working", vaultName: "Work notes", notes: 3 },
		});
		const head = find(container, "knap-status-head");
		const body = find(container, "knap-status-body");

		expect(body?.hidden).toBe(true);
		expect(head?.getAttribute("aria-expanded")).toBe("false");

		head?.listeners.forEach((run) => run());

		expect(body?.hidden).toBe(false);
		expect(head?.getAttribute("aria-expanded")).toBe("true");
	});

	it("puts the head above the body, whatever order they were built in", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
		});
		const block = find(container, "knap-status");
		expect(block?.children[0].cls).toContain("knap-status-head");
	});

	it("retries when the button under Problem is pressed", async () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: PROBLEM, dot: "error", vaultName: "Work notes", problems: 3 },
		});
		const { container } = drawWith(sync);
		find(container, "knap-status-retry")?.listeners.forEach((run) => run());
		await Promise.resolve();
		expect(sync.retried).toEqual(["retry"]);
	});

	// A retry waits as long as the tree takes, which is up to half a minute.
	// A button that says nothing for that long is a button somebody presses
	// again, and then reports as one that cannot be clicked at all.
	it("says it is going while it goes, and refuses to go twice", async () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: OFFLINE, dot: "wait", vaultName: "Work notes" },
		});
		const { container } = drawWith(sync);
		find(container, "knap-status-retry")?.listeners.forEach((run) => run());
		await Promise.resolve();

		const going = find(container, "knap-status-retry");
		expect(going?.text).toBe("Trying...");
		expect(going?.disabled).toBe(true);

		going?.listeners.forEach((run) => run());
		expect(sync.retried).toEqual(["retry"]);

		sync.finishRetry();
		await Promise.resolve();
		expect(find(container, "knap-status-retry")?.text).toBe("Try again");
	});

	it("says out loud what went wrong, instead of swallowing it", async () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: OFFLINE, dot: "wait", vaultName: "Work notes" },
		});
		const { container } = drawWith(sync);
		find(container, "knap-status-retry")?.listeners.forEach((run) => run());
		await Promise.resolve();

		sync.failRetry("Could not reach the server. Nothing was changed; try again.");
		await Promise.resolve();
		await Promise.resolve();

		expect(notices).toEqual(["Could not reach the server. Nothing was changed; try again."]);
		expect(find(container, "knap-status-retry")?.text).toBe("Try again");
	});
});

/**
 * The bar is a reading, not an event. A screen drawn once at open told
 * somebody Offline over a link that connected a second later, and went on
 * telling them until they closed Settings and came back.
 */
describe("the bar, a second later", () => {
	it("reads the vault again rather than staying as it was drawn", () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: OFFLINE, dot: "wait", vaultName: "Work notes" },
		});
		const { container, tab } = drawWith(sync);
		expect(find(container, "knap-status-word")?.text).toBe(OFFLINE);

		sync.becomes({ word: UP_TO_DATE, dot: "ok", notes: 12 });
		tab.paint();

		expect(find(container, "knap-status-word")?.text).toBe(UP_TO_DATE);
		expect(find(container, "knap-status-count")?.text).toBe("12 notes");
	});

	it("leaves the fold as the person left it", () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: OFFLINE, dot: "wait", vaultName: "Work notes" },
		});
		const { container, tab } = drawWith(sync);
		find(container, "knap-status-head")?.listeners.forEach((run) => run());
		expect(find(container, "knap-status-body")?.hidden).toBe(false);

		sync.becomes({ word: PROBLEM, dot: "error", problems: 2 });
		tab.paint();

		expect(find(container, "knap-status-body")?.hidden).toBe(false);
		expect(find(container, "knap-status-head")?.getAttribute("aria-expanded")).toBe("true");
	});
});

describe("what the fold holds", () => {
	it("leaves out every fact it has nothing to say about", () => {
		expect(statusFacts({ ...baseStatus() } as never)).toEqual([]);
	});

	it("does not repeat the vault's name the row above already carries", () => {
		// Three copies of one name on a phone screen was #125: in the head,
		// behind the fold, and on the Cloud vault row. The count is a different
		// fact and stays, as the total.
		expect(statusFacts({ ...baseStatus(), vaultName: "Work notes", notes: 1202 } as never)).toEqual(
			[["Total", "1,202 notes"]],
		);
	});

	it("counts one stuck change as a change, not as changes", () => {
		expect(statusFacts({ ...baseStatus(), problems: 1 } as never)).toEqual([
			["Could not sync", "1 change"],
		]);
	});

	it("folds the total away under every word, and nothing when nothing is counted", () => {
		expect(hasFold({ ...baseStatus(), word: UP_TO_DATE, notes: 1202 } as never)).toBe(true);
		expect(hasFold({ ...baseStatus(), word: UP_TO_DATE, problems: 2 } as never)).toBe(true);
		expect(hasFold({ ...baseStatus(), word: SYNCING } as never)).toBe(false);
		expect(hasFold({ ...baseStatus(), word: OFFLINE } as never)).toBe(true);
	});

	it("says one sentence, under the one word that asks for something", () => {
		// Every other word told somebody to wait, over rows that already say
		// what is being waited for. Initializing asks them to leave Obsidian
		// open, which is not what they would otherwise do (ADR-0090).
		expect(barSentence(INITIALIZING as never)).toContain("Leave Obsidian open");
		expect(barSentence(SYNCING as never)).toBe("");
		expect(barSentence(OFFLINE as never)).toBe("");
		expect(barSentence(UP_TO_DATE as never)).toBe("");
	});

	it("offers the button only for the two words a person can act on", () => {
		expect(hasRetry({ ...baseStatus(), word: PROBLEM } as never)).toBe(true);
		expect(hasRetry({ ...baseStatus(), word: OFFLINE } as never)).toBe(true);
		expect(hasRetry({ ...baseStatus(), word: UP_TO_DATE } as never)).toBe(false);
		expect(hasRetry({ ...baseStatus(), word: SYNCING } as never)).toBe(false);
	});
});

describe("the pass at start", () => {
	// A restart over a vault that is already here compares every note and
	// moves none, so both directions read zero for minutes. The head said
	// Syncing beside 2,505 notes through all of it, which reads as 2,505
	// still to go and says nothing about whether it is getting anywhere.
	it("puts how far it has got in the head, in place of the size", () => {
		const status = { ...baseStatus(), word: SYNCING, notes: 2505, checked: partWay(412, 2505) };
		expect(headCount(status as never)).toBe("412 of 2,505");
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status,
		});
		expect(find(container, "knap-status-count")?.text).toBe("412 of 2,505");
	});

	it("adds notes and attachments together in the head, the way the corner does", () => {
		expect(
			headCount({ ...baseStatus(), word: SYNCING, checked: partWay(412, 2505, 338) } as never),
		).toBe("412 of 2,843");
	});

	it("goes back to the size once the pass is through", () => {
		const through = { notes: { done: 2505, total: 2505 }, attachments: { done: 338, total: 338 } };
		expect(headCount({ ...baseStatus(), notes: 2505, checked: through } as never)).toBe(
			"2,505 notes",
		);
		// And before it has found anything, which is the moment after a link
		// comes up: no number is better than 0 of 0.
		expect(headCount({ ...baseStatus(), notes: 2505 } as never)).toBe("2,505 notes");
	});

	it("keeps the two kinds apart behind the fold, naming the half under way", () => {
		expect(
			statusFacts({ ...baseStatus(), word: SYNCING, notes: 2505, checked: partWay(412, 2505, 338) } as never),
		).toEqual([
			["Checked", "412 of 2,505 notes"],
			["Total", "2,505 notes"],
		]);
		// The notes are through and the attachments are being hashed.
		expect(
			statusFacts({
				...baseStatus(),
				word: SYNCING,
				checked: { notes: { done: 2505, total: 2505 }, attachments: { done: 12, total: 338 } },
			} as never),
		).toEqual([["Checked", "all notes, 12 of 338 attachments"]]);
	});

	it("sits above the directions, because it is the pass they are part of", () => {
		expect(
			statusFacts({ ...baseStatus(), word: INITIALIZING, down: 2093, checked: partWay(412, 2505) } as never),
		).toEqual([
			["Checked", "412 of 2,505 notes"],
			["Downloading", "2,093 notes"],
		]);
	});

	it("opens the fold for it, so a person can see what the number is", () => {
		expect(hasFold({ ...baseStatus(), word: SYNCING, checked: partWay(1, 3) } as never)).toBe(true);
	});
});

describe("the sign-out notice", () => {
	it("says nothing was deleted when the server heard it", () => {
		expect(signOutNotice(true)).toContain("Nothing was deleted");
	});

	it("admits the token may still be live when it did not", () => {
		expect(signOutNotice(false)).toContain("may still count this device");
	});
});

describe("the breakdown behind the fold", () => {
	// The corner has room for two numbers and adds notes and attachments
	// together to get them. This screen keeps them apart (ADR-0088).
	it("names both directions the way the words above them are, and both kinds of file", () => {
		// Uploading and Downloading, not "To the cloud vault": somebody
		// watching the word wants the same word on the line counting it.
		expect(
			statusFacts({
				...baseStatus(),
				word: SYNCING,
				up: 412,
				down: 2567,
				files: { up: 3, down: 0 },
				notes: 2979,
				attachments: 148,
			} as never),
		).toEqual([
			["Uploading", "412 notes, 3 attachments"],
			["Downloading", "2,567 notes"],
			["Total", "2,979 notes, 148 attachments"],
		]);
	});

	it("says only the direction that has something in it", () => {
		expect(
			statusFacts({ ...baseStatus(), word: SYNCING, files: { up: 1, down: 0 } } as never),
		).toEqual([["Uploading", "1 attachment"]]);
	});

	it("keeps the total last, under the failures as well", () => {
		// The two directions and the failures are what is moving or stuck; the
		// total is what is there when nothing is, so it is ruled off at the end.
		expect(
			statusFacts({ ...baseStatus(), word: PROBLEM, problems: 1, notes: 12 } as never),
		).toEqual([
			["Could not sync", "1 change"],
			["Total", "12 notes"],
		]);
	});

	it("a vault with nothing moving still says how much it holds", () => {
		expect(
			statusFacts({ ...baseStatus(), notes: 12, attachments: 4, vaultName: "Work" } as never),
		).toEqual([["Total", "12 notes, 4 attachments"]]);
	});
});

describe("the dashboard row", () => {
	it("is one name, one button, and nothing else out loud", () => {
		const { rows } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work" } });
		const row = rows.find((r) => r.name === "Pantalytics dashboard");
		expect(row?.desc).toBe("");
		expect(row?.buttons).toEqual(["Open"]);
		expect(row?.extras).toEqual(["info"]);
	});

	it("keeps the two sentences folded away until the (i) is pressed", () => {
		const { rows, container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work" },
		});
		const help = find(container, "knap-dash-help");
		expect(help?.hidden).toBe(true);
		expect(help?.text).toBe(
			"Opens next.knap.test in your browser. Add people to your workspace, connect your AI over MCP.",
		);
		rows.find((r) => r.name === "Pantalytics dashboard")?.pressExtra?.();
		expect(help?.hidden).toBe(false);
	});

	it("stays open across a redraw, because closing it was nobody's decision", () => {
		const { rows, container, tab } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work" },
		});
		rows.find((r) => r.name === "Pantalytics dashboard")?.pressExtra?.();
		tab.display();
		expect(find(container, "knap-dash-help")?.hidden).toBe(false);
	});

	it("opens the Vaults page, linked or not, because a vault has no page of its own", () => {
		const linked = drawFor({ signedIn: true, linked: { id: "v 1", name: "Work" } });
		linked.rows.find((r) => r.name === "Pantalytics dashboard")?.press?.();
		expect(linked.opened).toEqual(["https://next.knap.test/admin/vaults"]);

		const unlinked = drawFor({ signedIn: true, linked: null });
		unlinked.rows.find((r) => r.name === "Pantalytics dashboard")?.press?.();
		expect(unlinked.opened).toEqual(["https://next.knap.test/admin/vaults"]);
	});

	it("names the host it is about to open, and never a note or a path", () => {
		// The row leaves Obsidian, so it owes somebody the address. Nothing
		// else: no vault name, no folder (ADR-0003 is about telemetry, and the
		// same discipline is why this sentence is fixed).
		expect(dashboardHelp("https://next.knap.test/")).toBe(
			"Opens next.knap.test in your browser. Add people to your workspace, connect your AI over MCP.",
		);
	});

	it("does not double the slash a server address may come with", () => {
		expect(dashboardUrl("https://next.knap.test/")).toBe(
			"https://next.knap.test/admin/vaults",
		);
	});
});
