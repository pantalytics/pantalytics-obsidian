/**
 * The HTTP half of the new client, against a hand-rolled fetch.
 *
 * The real server's answers are pinned by knap-mcp-admin's own suite; what
 * these tests hold still is what the plugin sends and how it reads answers,
 * so a drifting field name fails here rather than on somebody's laptop.
 */

import { KnapServer, KnapServerError } from "../../src/knap/KnapServer";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		const key = Object.keys(routes).find((route) => url.includes(route));
		if (!key) return new Response("not found", { status: 404 });
		return routes[key](init);
	};
	return { fetchFn, calls };
}

describe("KnapServer", () => {
	it("asks the dashboard for a note's read-only link, and says what it refused", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/admin/api/vault-note-link": (init) => {
				const body = JSON.parse(String(init?.body));
				return body.path === "Plans/Q4.md"
					? new Response(JSON.stringify({ link: "https://knap.test/admin/read/abc" }), {
							status: 200,
						})
					: new Response(JSON.stringify({ error: "There is no note at 'x' in this vault." }), {
							status: 404,
						});
			},
		});
		const server = new KnapServer("https://knap.test/", fetchFn);

		expect(await server.noteLink("tok", "v1", "Plans/Q4.md")).toBe(
			"https://knap.test/admin/read/abc",
		);
		expect(calls[0].url).toBe("https://knap.test/admin/api/vault-note-link");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			vault_id: "v1",
			path: "Plans/Q4.md",
			on: true,
		});
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		await expect(server.noteLink("tok", "v1", "x")).rejects.toThrow(/no note at/);
	});

	it("exchanges a handoff code for a token, and refuses a reused one", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/auth/plugin/exchange": (init) => {
				const body = JSON.parse(String(init?.body));
				return body.code === "eenmalig"
					? new Response(JSON.stringify({ token: "knap_abc" }), { status: 200 })
					: new Response("{}", { status: 400 });
			},
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		expect(await server.exchange("eenmalig", "Laptop")).toBe("knap_abc");
		expect(JSON.parse(String(calls[0].init?.body)).device).toBe("Laptop");

		await expect(server.exchange("eenmalig-maar-op", "Laptop")).rejects.toThrow(
			/already used or has expired/,
		);
	});

	it("hands the token back on sign out, and takes a dead one for done", async () => {
		const seen: string[] = [];
		const { fetchFn, calls } = fakeFetch({
			"/auth/plugin/signout": (init) => {
				seen.push((init?.headers as Record<string, string>).Authorization);
				return new Response(null, { status: 204 });
			},
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		await server.signOut("knap_abc");
		expect(calls[0].init?.method).toBe("POST");
		expect(seen).toEqual(["Bearer knap_abc"]);

		// A token the server already forgot is the outcome, not a failure.
		const gone = fakeFetch({
			"/auth/plugin/signout": () => new Response("{}", { status: 401 }),
		});
		await expect(new KnapServer("https://knap.test", gone.fetchFn).signOut("oud")).resolves
			.toBeUndefined();
	});

	it("says the sign out did not land when the server breaks", async () => {
		const { fetchFn } = fakeFetch({
			"/auth/plugin/signout": () => new Response("{}", { status: 500 }),
		});
		const server = new KnapServer("https://knap.test", fetchFn);
		await expect(server.signOut("knap_abc")).rejects.toThrow(/did not land/);
	});

	it("lists vaults in the plugin's shape", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/api/vaults": () =>
				new Response(
					JSON.stringify({
						vaults: [{ id: "v1", name: "Demo" }],
					}),
					{ status: 200 },
				),
		});
		const server = new KnapServer("https://knap.test/", fetchFn);

		const vaults = await server.listVaults("knap_abc");
		// A server older than the Sync settings switch says nothing, and
		// settings travelled everywhere before it existed.
		expect(vaults).toEqual([{ id: "v1", name: "Demo", syncSettings: true }]);
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer knap_abc",
		);
	});

	it("carries the vault's Sync settings switch from the panel", async () => {
		const { fetchFn } = fakeFetch({
			"/api/vaults": () =>
				new Response(
					JSON.stringify({
						vaults: [
							{ id: "v1", name: "Work", syncSettings: false },
							{ id: "v2", name: "Home", syncSettings: true },
						],
					}),
					{ status: 200 },
				),
		});
		const vaults = await new KnapServer("https://knap.test", fetchFn).listVaults("knap_abc");
		expect(vaults.map((v) => v.syncSettings)).toEqual([false, true]);
	});

	it("says sign in again on a dead token", async () => {
		const { fetchFn } = fakeFetch({
			"/api/vaults": () => new Response("{}", { status: 401 }),
		});
		const server = new KnapServer("https://knap.test", fetchFn);
		await expect(server.listVaults("knap_oud")).rejects.toThrow(/Sign in again/);
	});

	it("builds the socket and file addresses the server serves", () => {
		const server = new KnapServer("https://knap.example", async () => new Response(""));
		expect(server.syncUrl("v1")).toBe("wss://knap.example/sync/v1");
		expect(server.signInUrl()).toBe("https://knap.example/auth/plugin/start?plugin=pantalytics");
	});

	it("round-trips an attachment and verifies nothing itself", async () => {
		const bytes = new TextEncoder().encode("pdf!").buffer;
		const { fetchFn, calls } = fakeFetch({
			"/files/v1/Bijlagen/scan%20maandag.pdf": (init) =>
				init?.method === "PUT"
					? new Response(JSON.stringify({ sha256: "abc", size: 4 }), { status: 200 })
					: new Response(new Uint8Array(bytes)),
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		const answer = await server.uploadFile("t", "v1", "Bijlagen/scan maandag.pdf", bytes);
		expect(answer.sha256).toBe("abc");
		// Path segments travel encoded, slashes stay structural.
		expect(calls[0].url).toContain("/files/v1/Bijlagen/scan%20maandag.pdf");

		const back = await server.downloadFile("t", "v1", "Bijlagen/scan maandag.pdf");
		expect(new TextDecoder().decode(back)).toBe("pdf!");
	});

	it("wraps failures in one error type with the status attached", async () => {
		const { fetchFn } = fakeFetch({});
		const server = new KnapServer("https://knap.test", fetchFn);
		try {
			await server.downloadFile("t", "v1", "weg.png");
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(KnapServerError);
			expect((error as KnapServerError).status).toBe(404);
		}
	});

	it("asks the server what it accepts rather than carrying its own numbers", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/api/limits": () =>
				new Response(
					JSON.stringify({ max_attachment_bytes: 104857600, max_vault_bytes: 10737418240 }),
					{ status: 200 },
				),
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		expect(await server.limits("t")).toEqual({
			maxAttachmentBytes: 104857600,
			maxVaultBytes: 10737418240,
		});
		// The field names are the server's, and this is where a rename in the
		// other repository shows up.
		expect(calls[0].url).toBe("https://knap.test/api/limits");
	});

	it("keeps a full vault and an oversized file apart in what it says", async () => {
		// Both come back from the same route, and they are different problems
		// with different answers: one file to leave behind, or a vault to
		// clear out. "The upload did not land" is neither of them.
		const cases: [number, RegExp][] = [
			[413, /larger than the cloud vault takes/],
			[507, /vault is full/],
			[500, /did not land/],
		];
		for (const [status, expected] of cases) {
			const server = new KnapServer(
				"https://knap.test",
				async () => new Response("{}", { status }),
			);
			await expect(server.uploadFile("t", "v1", "foto.png", new ArrayBuffer(8))).rejects.toThrow(
				expected,
			);
		}
	});
});
