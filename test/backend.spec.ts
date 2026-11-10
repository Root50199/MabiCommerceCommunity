import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { cleanup, hash, rateLimit, storeScanBatch } from "../src/storage";
import { catalog, CONSENT_VERSION, IP_RETENTION_MS, MAX_BODY_BYTES, MAX_BATCH_BYTES, type Scan } from "../src/validation";

interface Installation {
	installationId: string;
	token: string;
}

interface Stored {
	sequence: number;
	receivedAt: number;
	duplicate: boolean;
}

interface Observation {
	sequence: number;
	receivedAt: number;
	mode: string;
	productId: number;
	sourcePostId: number;
	sourcePrice: number | null;
	stock: number;
	prices: Scan["prices"];
}

interface Sync {
	observations: Observation[];
	nextCursor: number;
	revision: number;
	hasMore: boolean;
}

function request(path: string, method = "GET", body?: unknown, token?: string): Promise<Response> {
	return SELF.fetch(`http://localhost${path}`, {
		method,
		headers: {
			"X-Community-Format": "normalized-v1",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function register(): Promise<Installation> {
	const response = await request("/v1/installations", "POST", { consentVersion: CONSENT_VERSION, acceptPrivacy: true });
	expect(response.status).toBe(201);
	return response.json<Installation>();
}

async function scanFor(token: string, mode: Scan["mode"] = "trade", stock = 123): Promise<Scan> {
	const product = catalog.products.find((p) => p.mode === mode);
	if (!product) throw new Error("Missing test product");
	const response = await request("/v1/scan-tickets", "POST", {}, token);
	expect(response.status).toBe(201);
	const ticket = await response.json<{ scanId: string; expiresAt: number }>();
	expect(ticket.expiresAt).toBeGreaterThan(Date.now());
	const prices = catalog.posts.filter((post) => post.canSell && post.id !== product.postId &&
		(mode !== "group" || catalog.products.some((p) => p.postId === post.id && p.mode === "group")))
		.map((post) => ({ postId: post.id, salePrice: 120, profit: mode === "barter" ? null : 20 }));
	return { scanId: ticket.scanId, mode, productId: product.id, sourcePostId: product.postId, sourcePrice: mode === "barter" ? null : 100, stock, prices };
}

async function submit(installation: Installation, scan?: Scan): Promise<Stored> {
	const response = await request("/v1/scans", "POST", scan ?? await scanFor(installation.token), installation.token);
	expect(response.status).toBe(201);
	return response.json<Stored>();
}

async function revoke(installationId: string): Promise<Response> {
	return request("/v1/admin/revoke", "POST", { installationId }, env.ADMIN_TOKEN);
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM private_ip_logs"),
		env.DB.prepare("DELETE FROM quotes"),
		env.DB.prepare("DELETE FROM scans"),
		env.DB.prepare("DELETE FROM scan_tickets"),
		env.DB.prepare("DELETE FROM installations"),
		env.DB.prepare("DELETE FROM rate_limits"),
		env.DB.prepare("UPDATE moderation SET revision = 0"),
	]);
});

describe("Reviewed observations and versioned provenance", () => {
	it("keeps a maximal batch within the free-tier database query budget", async () => {
		const installation = await register();
		const template = await scanFor(installation.token);
		let prepared = 0;
		const session = env.DB.withSession("first-primary");
		const db = new Proxy(session, {
			get(target, key) {
				if (key === "prepare") return (sql: string) => { prepared++; return target.prepare(sql); };
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const scans = Array.from({ length: 16 }, () => ({ ...template, scanId: crypto.randomUUID() }));
		const receipts = await storeScanBatch(db, installation.installationId, scans, "127.0.0.1", Date.now());
		expect(receipts).toHaveLength(16);
		expect(prepared).toBeLessThanOrEqual(35); // Leaves room for authentication, rate limiting and cleanup.
	});

	it("rolls back all new goods if a conflicting ID races the precheck", async () => {
		const installation = await register();
		const template = await scanFor(installation.token);
		const scans = [0, 1].map(() => ({ ...template, scanId: crypto.randomUUID() }));
		const session = env.DB.withSession("first-primary");
		const db = new Proxy(session, {
			get(target, key) {
				if (key === "batch") return async (statements: D1PreparedStatement[]) => {
					await env.DB.prepare(`INSERT INTO scans(id, installation_id, received_at, payload_hash,
						mode, product_id, source_post_id, source_price, stock)
						VALUES (?, ?, ?, 'different-payload', ?, ?, ?, ?, ?)`)
						.bind(scans[1].scanId, installation.installationId, Date.now(), template.mode,
							template.productId, template.sourcePostId, template.sourcePrice, template.stock).run();
					return target.batch(statements);
				};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(storeScanBatch(db, installation.installationId, scans, "127.0.0.1", Date.now()))
			.rejects.toMatchObject({ status: 409, code: "scan_conflict" });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(1);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans WHERE id = ?").bind(scans[0].scanId).first("n")).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBe(0);
	});

	it("accepts a whole outpost in one authenticated request without per-scan tickets and deduplicates retries", async () => {
		const installation = await register();
		const template = await scanFor(installation.token);
		await env.DB.prepare("DELETE FROM scan_tickets").run();
		const products = catalog.products.filter((p) => p.mode === template.mode && p.postId === template.sourcePostId);
		const scans = products.map((p) => ({ ...template, scanId: crypto.randomUUID(), productId: p.id }));
		const response = await request("/v1/scan-batches", "POST", { scans }, installation.token);
		expect(response.status).toBe(201);
		const body = await response.json<{ receipts: (Stored & { scanId: string })[] }>();
		expect(body.receipts).toHaveLength(scans.length);
		expect(body.receipts.map((r) => r.scanId)).toEqual(scans.map((s) => s.scanId));
		expect(body.receipts.every((r) => !r.duplicate)).toBe(true);
		const retry = await request("/v1/scan-batches", "POST", { scans }, installation.token);
		expect(retry.status).toBe(200);
		const repeated = await retry.json<typeof body>();
		expect(repeated.receipts.map((r) => r.sequence)).toEqual(body.receipts.map((r) => r.sequence));
		expect(repeated.receipts.every((r) => r.duplicate)).toBe(true);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(scans.length);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scan_tickets").first("n")).toBe(0);
		const latest = await (await request("/v1/latest")).json<{ observations: Observation[] }>();
		expect(latest.observations).toHaveLength(scans.length);
	});

	it("validates every batch good before writing and keeps authentication, bounds and conflicts explicit", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		scan.scanId = crypto.randomUUID();
		const other = catalog.products.find((p) => p.mode === scan.mode && p.postId === scan.sourcePostId && p.id !== scan.productId)!;
		const second = { ...scan, scanId: crypto.randomUUID(), productId: other.id };
		const invalid = { ...second, prices: second.prices.map((p, index) => ({ ...p, profit: index === 0 ? 999 : p.profit })) };
		expect((await request("/v1/scan-batches", "POST", { scans: [scan, invalid] }, installation.token)).status).toBe(400);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
		for (const scans of [[], [scan, scan], Array.from({ length: 17 }, () => scan),
			[scan, { ...second, mode: "barter" }]]) {
			expect((await request("/v1/scan-batches", "POST", { scans }, installation.token)).status).toBe(400);
		}
		expect((await request("/v1/scan-batches", "POST", { scans: [scan] })).status).toBe(401);
		expect((await request("/v1/scan-batches", "POST", { scans: [scan] }, installation.token)).status).toBe(201);
		expect((await request("/v1/scan-batches", "POST", { scans: [{ ...scan, stock: 99 }, second] }, installation.token)).status).toBe(409);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(1);
		const another = await register();
		expect((await request("/v1/scan-batches", "POST", { scans: [scan] }, another.token)).status).toBe(409);
		await revoke(installation.installationId);
		expect((await request("/v1/scan-batches", "POST", { scans: [second] }, installation.token)).status).toBe(401);
	});

	it("keeps normalized reviewed provenance and Barter semantics in batches", async () => {
		const installation = await register();
		for (const mode of ["trade", "group", "barter"] as const) {
			const scan = await scanFor(installation.token, mode);
			scan.scanId = crypto.randomUUID();
			scan.priceBasis = "normalized-v1";
			scan.observedSourcePrice = scan.sourcePrice;
			scan.purchaseDiscountPercent = 0;
			scan.review = { sourceManual: false, stockManual: true, manualPostIds: [scan.prices[0].postId] };
			scan.prices[0].profit = null;
			expect((await request("/v1/scan-batches", "POST", { scans: [scan] }, installation.token)).status).toBe(201);
		}
		const response = await SELF.fetch("http://localhost/v1/latest", { headers: { "X-Community-Format": "normalized-v2" } });
		const body = await response.json<{ observations: (Observation & { review: Scan["review"] })[] }>();
		expect(body.observations).toHaveLength(3);
		expect(body.observations.every((scan) => scan.review?.stockManual && scan.prices[0].profit === null)).toBe(true);
	});

	it("bounds actual batch bytes and charges the existing write allowance per good", async () => {
		const installation = await register();
		const template = await scanFor(installation.token);
		const products = catalog.products.filter(p => p.mode === template.mode && p.postId === template.sourcePostId);
		const scans = products.map(p => ({ ...template, scanId: crypto.randomUUID(), productId: p.id }));
		const large = await SELF.fetch("http://localhost/v1/scan-batches", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
			body: JSON.stringify({ scans }) + " ".repeat(MAX_BATCH_BYTES),
		});
		expect(large.status).toBe(413);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
		const key = `write:${installation.installationId}:${Math.floor(Date.now() / 60_000)}`;
		await env.DB.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").bind(60 - scans.length, key).run();
		expect((await request("/v1/scan-batches", "POST", { scans }, installation.token)).status).toBe(201);
		expect(await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first("count")).toBe(60);
		const throttled = await request("/v1/scan-batches", "POST",
			{ scans: scans.map(scan => ({ ...scan, scanId: crypto.randomUUID() })) }, installation.token);
		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(scans.length);
	});

	it("stores reviewed edits, nullable observed profits and returns them only to v2 readers", async () => {
		const installation = await register();
		const automatic = await scanFor(installation.token);
		await submit(installation, automatic);
		const reviewed = await scanFor(installation.token);
		reviewed.priceBasis = "normalized-v1";
		reviewed.observedSourcePrice = 100;
		reviewed.purchaseDiscountPercent = 0;
		reviewed.prices[0].salePrice = 135;
		reviewed.prices[0].profit = null;
		reviewed.review = { sourceManual: false, stockManual: true, manualPostIds: [reviewed.prices[0].postId] };
		const receipt = await submit(installation, reviewed);
		const duplicate = await request("/v1/scans", "POST", reviewed, installation.token);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({ sequence: receipt.sequence, duplicate: true });
		const readV2 = (path: string) => SELF.fetch(`http://localhost${path}`, {
			headers: { "X-Community-Format": "normalized-v2" },
		});
		for (const path of ["/v1/latest", "/v1/sync",
			`/v1/history?mode=${reviewed.mode}&productId=${reviewed.productId}`]) {
			const body = await (await readV2(path)).json<{ observations: (Observation & { review?: Scan["review"] })[] }>();
			const observation = body.observations.find((o) => o.sequence === receipt.sequence);
			expect(observation?.review).toEqual(reviewed.review);
			expect(observation?.prices[0]).toMatchObject({ salePrice: 135, profit: null });
			const old = await (await request(path)).json<{ observations: Observation[] }>();
			expect(old.observations.some((o) => o.sequence === receipt.sequence)).toBe(false);
			expect(old.observations.length).toBeGreaterThan(0);
		}
		const stored = await env.DB.prepare("SELECT review_json FROM scans WHERE sequence = ?")
			.bind(receipt.sequence).first<{ review_json: string }>();
		expect(JSON.parse(stored!.review_json)).toEqual(reviewed.review);
	});

	it("requires explicit reviewed metadata for missing profits and rejects malformed provenance", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		scan.priceBasis = "normalized-v1";
		scan.observedSourcePrice = 100;
		scan.purchaseDiscountPercent = 0;
		scan.prices[0].profit = null;
		expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(400);
		scan.review = { sourceManual: false, stockManual: false, manualPostIds: [999999] };
		expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(400);
		scan.review.manualPostIds = [];
		scan.prices[1].profit = 19;
		expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(400);
		scan.prices[1].profit = 20;
		await submit(installation, scan);
	});

	it("supports reviewed Barter without a fabricated source and keeps all destinations required", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token, "barter");
		scan.priceBasis = "normalized-v1";
		scan.observedSourcePrice = null;
		scan.purchaseDiscountPercent = 0;
		scan.review = { sourceManual: false, stockManual: false, manualPostIds: [] };
		const removed = scan.prices.pop()!;
		expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(400);
		scan.prices.push(removed);
		await submit(installation, scan);
	});
});

describe("Consent and credentials", () => {
	it("publishes the agreed retention policy without collecting visitor data", async () => {
		const response = await request("/v1/privacy");
		expect(await response.json()).toMatchObject({
			consentVersion: CONSENT_VERSION, privateIpRetentionDays: 30, observationRetention: "indefinite",
			installationAssociationRetentionDays: 30, installationAssociationExpiryScope: "post_migration_observations",
		});
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs").first("n")).toBe(0);
	});

	it("requires explicit current consent and disallows personal fields", async () => {
		for (const body of [
			{ consentVersion: CONSENT_VERSION, acceptPrivacy: false },
			{ consentVersion: "old", acceptPrivacy: true },
			{ consentVersion: CONSENT_VERSION, acceptPrivacy: true, characterName: "no" },
		]) expect((await request("/v1/installations", "POST", body)).status).toBe(400);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM installations").first("n")).toBe(0);
	});

	it("returns a random ID and one-time credential, stores only its hash, and keeps IPs private", async () => {
		const registration = await register();
		expect(registration.installationId).toMatch(/^[a-f0-9-]{36}$/);
		expect(registration.token).toMatch(/^[a-f0-9]{64}$/);
		const stored = await env.DB.prepare("SELECT * FROM installations").first();
		expect(stored?.token_hash).toBe(await hash(registration.token));
		expect(JSON.stringify(stored)).not.toContain(registration.token);
		const log = await env.DB.prepare("SELECT ip, action FROM private_ip_logs").first();
		expect(log).toEqual({ ip: "127.0.0.1", action: "register" });
		expect((await request("/v1/scan-tickets", "POST", {})).status).toBe(401);
		expect((await request("/v1/scan-tickets", "POST", {}, "b".repeat(64))).status).toBe(401);
	});

	it("limits registrations atomically without storing rejected installations", async () => {
		const responses = await Promise.all(Array.from({ length: 8 }, () =>
			request("/v1/installations", "POST", { consentVersion: CONSENT_VERSION, acceptPrivacy: true })));
		expect(responses.filter((r) => r.status === 201)).toHaveLength(5);
		expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
		expect(responses.find((r) => r.status === 429)?.headers.get("Retry-After")).toMatch(/^\d+$/);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM installations").first("n")).toBe(5);
	});

	it("blocks public hosts while the backend is local-only", async () => {
		const response = await SELF.fetch("https://example.com/v1/installations", { method: "POST" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "local_only" });
	});
});

describe("Scan acceptance", () => {
	it.each(["trade", "group", "barter"] as const)("stores normalized %s prices with observed cross-check metadata", async (mode) => {
		const installation = await register();
		const original = await scanFor(installation.token, mode);
		const scan: Scan = {
			...original, priceBasis: "normalized-v1",
			observedSourcePrice: mode === "barter" ? null : 93,
			purchaseDiscountPercent: mode === "barter" ? 0 : 7,
			prices: original.prices.map((p) => ({ ...p, profit: mode === "barter" ? null : 27 })),
		};
		const receipt = await submit(installation, scan);
		const latest = await (await request("/v1/latest")).json<{ observations: Record<string, unknown>[]; nextCursor: number }>();
		expect(latest.nextCursor).toBe(receipt.sequence);
		expect(latest.observations[0]).toMatchObject({
			sourcePrice: scan.sourcePrice, observedSourcePrice: scan.observedSourcePrice,
			purchaseDiscountPercent: scan.purchaseDiscountPercent, priceBasis: "normalized-v1",
		});
		const legacy = await (await SELF.fetch("http://localhost/v1/latest")).json<{ observations: Record<string, unknown>[] }>();
		expect(legacy).not.toHaveProperty("nextCursor");
		expect(legacy.observations[0]).not.toHaveProperty("priceBasis");
		expect(legacy.observations[0].sourcePrice).toBe(scan.observedSourcePrice);
	});

	it("validates decimal hundredths and rejects inconsistent normalization and raw profits", async () => {
		const installation = await register();
		const original = await scanFor(installation.token);
		const scan = { ...original, priceBasis: "normalized-v1", observedSourcePrice: 99,
			purchaseDiscountPercent: 1.01, prices: original.prices.map((p) => ({ ...p, profit: 21 })) };
		for (const bad of [
			{ ...scan, sourcePrice: 101 }, { ...scan, prices: original.prices },
			{ ...scan, purchaseDiscountPercent: 1.001 }, { ...scan, purchaseDiscountPercent: 100 },
		]) expect((await request("/v1/scans", "POST", bad, installation.token)).status).toBe(400);
		expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(201);
	});

	it("keeps the original legacy retry identity when optional legacy metadata is serialized", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		const accepted = await submit(installation, scan);
		const retry = await (await request("/v1/scans", "POST", { ...scan,
			priceBasis: "legacy", observedSourcePrice: null, purchaseDiscountPercent: null }, installation.token)).json<Stored>();
		expect(retry).toEqual({ ...accepted, duplicate: true });
	});

	it.each(["trade", "group", "barter"] as const)("accepts complete %s observations and server-orders them", async (mode) => {
		const installation = await register();
		const scan = await scanFor(installation.token, mode, 0);
		const before = Date.now();
		const stored = await submit(installation, scan);
		expect(stored.receivedAt).toBeGreaterThanOrEqual(before);
		expect(stored.receivedAt).toBeLessThanOrEqual(Date.now());
		expect(stored.duplicate).toBe(false);
		const sync = await (await request("/v1/sync")).json<Sync>();
		expect(sync.observations).toEqual([{
			sequence: stored.sequence, receivedAt: stored.receivedAt, mode,
			productId: scan.productId, sourcePostId: scan.sourcePostId,
			sourcePrice: scan.sourcePrice, stock: 0, prices: scan.prices,
			priceBasis: "legacy", observedSourcePrice: null, purchaseDiscountPercent: null,
		}]);
		expect(sync.nextCursor).toBe(stored.sequence);
		const text = JSON.stringify(sync);
		for (const privateValue of [installation.installationId, installation.token, "127.0.0.1", "token_hash", "payload_hash"])
			expect(text).not.toContain(privateValue);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs WHERE action = 'scan'").first("n")).toBe(1);
	});

	it("deduplicates retries, including concurrent submissions, without changing receipt time", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		const responses = await Promise.all([
			request("/v1/scans", "POST", scan, installation.token),
			request("/v1/scans", "POST", { ...scan, prices: [...scan.prices].reverse() }, installation.token),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
		const stored = await responses[0].json<Stored>();
		const retry = await (await request("/v1/scans", "POST", scan, installation.token)).json<Stored>();
		expect(retry).toEqual({ ...stored, duplicate: true });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(1);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs WHERE action = 'scan'").first("n")).toBe(1);
		expect((await request("/v1/scans", "POST", { ...scan, stock: 124 }, installation.token)).status).toBe(409);
	});

	it("requires a fresh server ticket, bound to the installation", async () => {
		const one = await register();
		const two = await register();
		const scan = await scanFor(one.token);
		expect((await request("/v1/scans", "POST", scan, two.token)).status).toBe(409);
		await env.DB.prepare("UPDATE scan_tickets SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, scan.scanId).run();
		const expired = await request("/v1/scans", "POST", scan, one.token);
		expect(expired.status).toBe(409);
		expect(await expired.json()).toEqual({ error: "scan_ticket_expired_or_unknown" });
		expect((await request("/v1/scans", "POST", { ...scan, scanId: crypto.randomUUID() }, one.token)).status).toBe(409);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
	});

	it("resolves concurrent conflicting submissions with exactly one stored observation", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		const responses = await Promise.all([
			request("/v1/scans", "POST", scan, installation.token),
			request("/v1/scans", "POST", { ...scan, stock: 44 }, installation.token),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(1);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBe(scan.prices.length);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs WHERE action = 'scan'").first("n")).toBe(1);
	});

	it("checks ticket expiry after the full upload arrives, not before a slow request body", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					now += 61_000;
					controller.enqueue(new TextEncoder().encode(JSON.stringify(scan)));
					controller.close();
				},
			}, { highWaterMark: 0 });
			const response = await worker.fetch(new Request("http://localhost/v1/scans", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
				body,
			}), env);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "scan_ticket_expired_or_unknown" });
			expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});

	it("rejects incomplete, conflicting, duplicated, fractional, negative and noncatalog data without partial writes", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		const cases = [
			{ ...scan, prices: scan.prices.slice(1) },
			{ ...scan, prices: [...scan.prices, scan.prices[0]] },
			{ ...scan, prices: [{ ...scan.prices[0], profit: 21 }, ...scan.prices.slice(1)] },
			{ ...scan, prices: [{ ...scan.prices[0], postId: scan.sourcePostId }, ...scan.prices.slice(1)] },
			{ ...scan, sourcePostId: 999 },
			{ ...scan, mode: "group" },
			{ ...scan, productId: 999999 },
			{ ...scan, sourcePrice: 0 },
			{ ...scan, stock: -1 },
			{ ...scan, stock: 1.5 },
			{ ...scan, stock: 1_000_000_001 },
			{ ...scan, prices: [{ ...scan.prices[0], salePrice: -1 }, ...scan.prices.slice(1)] },
		];
		for (const body of cases)
			expect((await request("/v1/scans", "POST", body, installation.token)).status).toBe(400);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs WHERE action = 'scan'").first("n")).toBe(0);
		await submit(installation, scan);
	});

	it("rejects unapproved payload fields instead of collecting them", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		for (const field of ["screenshot", "ocrText", "capturedAt", "weeklyAllowance", "origin"])
			expect((await request("/v1/scans", "POST", { ...scan, [field]: "not allowed" }, installation.token)).status).toBe(400);
	});

	it("allows an optional cross-checked Smuggler quote except on Group", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		await submit(installation, { ...scan, prices: [...scan.prices, { postId: 0, salePrice: 125, profit: 25 }] });
		const group = await scanFor(installation.token, "group");
		expect((await request("/v1/scans", "POST", { ...group, prices: [...group.prices, { postId: 0, salePrice: 125, profit: 25 }] }, installation.token)).status).toBe(400);
	});

	it("requires real sale-only Barter fields, never invented source prices or profits", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token, "barter");
		expect((await request("/v1/scans", "POST", { ...scan, sourcePrice: 100 }, installation.token)).status).toBe(400);
		expect((await request("/v1/scans", "POST", {
			...scan, prices: scan.prices.map(p => ({ ...p, profit: 20 })),
		}, installation.token)).status).toBe(400);
		await submit(installation, scan);
		const latest = await (await request("/v1/latest")).json<Sync>();
		expect(latest.observations[0].sourcePrice).toBeNull();
		expect(latest.observations[0].prices.every(p => p.profit === null)).toBe(true);
		const trade = await scanFor(installation.token);
		expect((await request("/v1/scans", "POST", { ...trade, sourcePrice: null }, installation.token)).status).toBe(400);
	});

	it("enforces the actual byte limit, content type, and valid JSON", async () => {
		const installation = await register();
		for (const [headers, body, status] of [
			[{ "Content-Type": "text/plain" }, "{}", 415],
			[{ "Content-Type": "application/json" }, "{", 400],
			[{ "Content-Type": "application/json" }, `"${"x".repeat(MAX_BODY_BYTES)}"`, 413],
			[{ "Content-Type": "application/json", "Content-Encoding": "gzip" }, "{}", 415],
		] as const) {
			const response = await SELF.fetch("http://localhost/v1/scans", {
				method: "POST", headers: { ...headers, Authorization: `Bearer ${installation.token}` }, body,
			});
			expect(response.status).toBe(status);
		}
	});

	it("rolls back the scan and quotes if its private-log write fails", async () => {
		const installation = await register();
		const scan = await scanFor(installation.token);
		await env.DB.exec("CREATE TRIGGER reject_scan_log BEFORE INSERT ON private_ip_logs WHEN NEW.action = 'scan' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
		try {
			expect((await request("/v1/scans", "POST", scan, installation.token)).status).toBe(500);
			expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(0);
			expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBe(0);
		} finally {
			await env.DB.exec("DROP TRIGGER reject_scan_log");
		}
		await submit(installation, scan);
	});
});

describe("Latest values, history, incremental sync and moderation", () => {
	it("keeps every observation, pages by server sequence, and selects latest by receipt order", async () => {
		const installation = await register();
		const first = await submit(installation, await scanFor(installation.token, "trade", 123));
		const second = await submit(installation, await scanFor(installation.token, "trade", 99));
		const latest = await (await request("/v1/latest")).json<Sync>();
		expect(latest.observations.map((s) => s.stock)).toEqual([99]);
		const page1 = await (await request("/v1/sync?limit=1")).json<Sync>();
		expect(page1.observations.map((s) => s.sequence)).toEqual([first.sequence]);
		expect(page1.hasMore).toBe(true);
		const page2 = await (await request(`/v1/sync?cursor=${page1.nextCursor}&revision=${page1.revision}&limit=1`)).json<Sync>();
		expect(page2.observations.map((s) => s.sequence)).toEqual([second.sequence]);
		expect(page2.hasMore).toBe(false);
		const empty = await (await request(`/v1/sync?cursor=${page2.nextCursor}&revision=${page2.revision}`)).json<Sync>();
		expect(empty.observations).toEqual([]);
		expect(empty.nextCursor).toBe(second.sequence);
		const productId = latest.observations[0].productId;
		const history = await (await request(`/v1/history?mode=trade&productId=${productId}&limit=1`))
			.json<{ observations: Observation[]; nextBefore: number | null }>();
		expect(history.observations.map((s) => s.stock)).toEqual([99]);
		expect(history.nextBefore).toBe(second.sequence);
		const older = await (await request(`/v1/history?mode=trade&productId=${productId}&before=${history.nextBefore}`))
			.json<{ observations: Observation[]; nextBefore: number | null }>();
		expect(older.observations.map((s) => s.stock)).toEqual([123]);
		expect(older.nextBefore).toBeNull();
		expect(await (await request("/v1/stats")).json()).toMatchObject({ acceptedScans: 2, contributors: 1 });
	});

	it("revokes credentials, excludes all contributions, restores prior good data, and invalidates caches", async () => {
		const good = await register();
		const bad = await register();
		const goodScan = await submit(good, await scanFor(good.token, "trade", 50));
		const badScan = await submit(bad, await scanFor(bad.token, "trade", 999));
		const pending = await scanFor(bad.token);
		expect((await request("/v1/admin/revoke", "POST", { installationId: bad.installationId })).status).toBe(401);
		expect((await revoke(bad.installationId)).status).toBe(200);
		expect((await request("/v1/scan-tickets", "POST", {}, bad.token)).status).toBe(401);
		expect((await request("/v1/scans", "POST", pending, bad.token)).status).toBe(401);
		const latest = await (await request("/v1/latest")).json<Sync>();
		expect(latest.revision).toBe(1);
		expect(latest.observations.map((s) => s.sequence)).toEqual([goodScan.sequence]);
		const stale = await request(`/v1/sync?cursor=${badScan.sequence}&revision=0`);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ error: "sync_reset_required", revision: 1 });
		const reset = await (await request("/v1/sync?cursor=0&revision=1")).json<Sync>();
		expect(reset.observations.map((s) => s.stock)).toEqual([50]);
		expect(reset.nextCursor).toBe(badScan.sequence);
		expect(reset.hasMore).toBe(false);
		const history = await (await request(`/v1/history?mode=trade&productId=${latest.observations[0].productId}`)).json<Sync>();
		expect(history.observations.map((s) => s.stock)).toEqual([50]);
		expect(await (await request("/v1/stats")).json()).toMatchObject({ acceptedScans: 1, contributors: 1 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first("n")).toBe(2);
		expect(await (await revoke(bad.installationId)).json()).toMatchObject({ revision: 1 });
	});

	it("allows an installation to withdraw itself", async () => {
		const installation = await register();
		await submit(installation);
		expect((await request("/v1/installation", "DELETE", undefined, installation.token)).status).toBe(200);
		expect((await (await request("/v1/latest")).json<Sync>()).observations).toEqual([]);
		expect((await request("/v1/scan-tickets", "POST", {}, installation.token)).status).toBe(401);
	});

	it("requires valid bounded cursors and revision tokens", async () => {
		for (const path of [
			"/v1/sync?cursor=1", "/v1/sync?cursor=-1", "/v1/sync?cursor=9007199254740992",
			"/v1/sync?limit=201", "/v1/sync?limit=0", "/v1/sync?cursor=1&revision=0",
			"/v1/sync?limit=1&limit=2", "/v1/sync?unexpected=1",
			"/v1/history?mode=trade&productId=1", "/v1/history?mode=trade",
		]) expect((await request(path)).status).toBe(400);
	});
});

describe("Retention and failure behavior", () => {
	it("enforces the exact write threshold and starts a fresh server-time rate bucket", async () => {
		const db = env.DB.withSession("first-primary");
		const now = 120_000;
		await env.DB.prepare("INSERT INTO rate_limits(key, count, expires_at) VALUES ('write:test:2', 59, 180000)").run();
		await rateLimit(db, "write:test", 60, 60_000, now);
		await expect(rateLimit(db, "write:test", 60, 60_000, now)).rejects.toMatchObject({
			status: 429, code: "rate_limited", headers: { "Retry-After": "60" },
		});
		await rateLimit(db, "write:test", 60, 60_000, now + 60_000);
		expect(await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'write:test:3'").first("count")).toBe(1);
	});

	it("expires new association links and unused credentials at exactly 30 days without hiding history", async () => {
		const installation = await register();
		const scan = await submit(installation);
		const stored = await env.DB.prepare("SELECT received_at, association_expires_at FROM scans WHERE sequence = ?")
			.bind(scan.sequence).first<{ received_at: number; association_expires_at: number }>();
		expect(stored?.association_expires_at).toBe(Number(stored?.received_at) + IP_RETENTION_MS);
		const expiry = stored!.association_expires_at;
		await cleanup(env.DB, expiry - 1);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(scan.sequence).first("installation_id"))
			.toBe(installation.installationId);
		await cleanup(env.DB, expiry);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(scan.sequence).first("installation_id")).toBeNull();
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM installations").first("n")).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs").first("n")).toBe(0);
		expect((await request("/v1/scan-tickets", "POST", {}, installation.token)).status).toBe(401);
		const latest = await (await request("/v1/latest")).json<{ observations: Observation[] }>();
		expect(latest.observations.map(row => row.sequence)).toContain(scan.sequence);
		const sync = await (await request("/v1/sync?cursor=0")).json<Sync>();
		expect(sync.observations.map(row => row.sequence)).toContain(scan.sequence);
		const product = catalog.products.find(p => p.mode === "trade")!;
		const history = await (await request(`/v1/history?mode=trade&productId=${product.id}`)).json<{ observations: Observation[] }>();
		expect(history.observations.map(row => row.sequence)).toContain(scan.sequence);
		expect(await (await request("/v1/stats")).json()).toMatchObject({ acceptedScans: 1, contributors: 0 });
		await cleanup(env.DB, expiry);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBeGreaterThan(0);
	});

	it("retains pre-migration links and installations while expiring new links on the same installation", async () => {
		const installation = await register();
		const old = await submit(installation);
		await env.DB.batch([
			env.DB.prepare("UPDATE scans SET association_expires_at = NULL WHERE sequence = ?").bind(old.sequence),
			env.DB.prepare("UPDATE installations SET expires_at = NULL WHERE id = ?").bind(installation.installationId),
		]);
		const recent = await submit(installation);
		const expiry = Number(await env.DB.prepare("SELECT association_expires_at FROM scans WHERE sequence = ?").bind(recent.sequence).first("association_expires_at"));
		await cleanup(env.DB, expiry);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(old.sequence).first("installation_id")).toBe(installation.installationId);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(recent.sequence).first("installation_id")).toBeNull();
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM installations").first("n")).toBe(1);
	});

	it("does not expire newer links and never resurrects revoked scans after anonymization", async () => {
		const installation = await register();
		const older = await submit(installation);
		const newer = await submit(installation);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("UPDATE scans SET association_expires_at = ? WHERE sequence = ?").bind(now + 60_000, older.sequence),
			env.DB.prepare("UPDATE scans SET association_expires_at = ? WHERE sequence = ?").bind(now + IP_RETENTION_MS, newer.sequence),
		]);
		expect((await revoke(installation.installationId)).status).toBe(200);
		await cleanup(env.DB, now + 60_000);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(older.sequence).first("installation_id")).toBeNull();
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(newer.sequence).first("installation_id")).toBe(installation.installationId);
		expect(await (await request("/v1/latest")).json()).toMatchObject({ observations: [], revision: 1 });
		expect(await (await request("/v1/sync?cursor=0")).json()).toMatchObject({ observations: [], revision: 1 });
		expect(await (await request("/v1/stats")).json()).toMatchObject({ acceptedScans: 0, contributors: 0 });
	});

	it("captures legacy-writer revocation before association expiry", async () => {
		const installation = await register();
		const scan = await submit(installation);
		await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?").bind(Date.now(), installation.installationId).run();
		expect(await env.DB.prepare("SELECT hidden FROM scans WHERE sequence = ?").bind(scan.sequence).first("hidden")).toBe(1);
		await cleanup(env.DB, Date.now() + IP_RETENTION_MS + 1);
		expect(await env.DB.prepare("SELECT installation_id FROM scans WHERE sequence = ?").bind(scan.sequence).first("installation_id")).toBeNull();
		expect(await (await request("/v1/latest")).json()).toMatchObject({ observations: [] });
	});

	it("expires private IPs at exactly 30 days but preserves individual historical prices indefinitely", async () => {
		const installation = await register();
		const scan = await submit(installation);
		const now = Date.now();
		await env.DB.prepare("UPDATE scans SET received_at = ?").bind(now - 400 * 86_400_000).run();
		await env.DB.prepare("UPDATE private_ip_logs SET received_at = ? WHERE action = 'register'")
			.bind(now - IP_RETENTION_MS).run();
		await env.DB.prepare("UPDATE private_ip_logs SET received_at = ? WHERE action = 'scan'")
			.bind(now - IP_RETENTION_MS + 1).run();
		await cleanup(env.DB, now);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ip_logs").first("n")).toBe(1);
		await worker.scheduled({ scheduledTime: now, cron: "*/15 * * * *", noRetry() {} }, env);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans WHERE sequence = ?").bind(scan.sequence).first("n")).toBe(1);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes").first("n")).toBeGreaterThan(0);
	});

	it("fails closed when moderation is not configured", async () => {
		const response = await worker.fetch(new Request("http://localhost/v1/admin/revoke", {
			method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
		}), { ...env, ADMIN_TOKEN: undefined });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "moderation_not_configured" });
	});

	it("reports database failures explicitly without leaking request data", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await env.DB.exec("ALTER TABLE moderation RENAME TO moderation_unavailable");
			const response = await worker.fetch(new Request("http://localhost/v1/latest"), env);
			expect(response.status).toBe(500);
			const body = await response.json<{ error: string; requestId: string }>();
			expect(body.error).toBe("internal_error");
			expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
			expect(log).toHaveBeenCalledWith("backend_failure", { requestId: body.requestId, errorType: "Error" });
		} finally {
			await env.DB.exec("ALTER TABLE moderation_unavailable RENAME TO moderation");
			log.mockRestore();
		}
	});
});
