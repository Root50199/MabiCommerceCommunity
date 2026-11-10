import {
	ApiError, CONSENT_VERSION, catalog, exactKeys, object,
	queryInteger, readJson, requireCondition, scanInput, uuid,
} from "./validation";
import {
	authenticate, bearer, cleanup, hash, PUBLIC_SCAN_COLUMNS, publicRows,
	rateLimit, secret, storeScan, type BackendEnv,
} from "./storage";

const METHODS: Record<string, string> = {
	"/health": "GET",
	"/v1/privacy": "GET",
	"/v1/catalog": "GET",
	"/v1/installations": "POST",
	"/v1/scan-tickets": "POST",
	"/v1/scans": "POST",
	"/v1/sync": "GET",
	"/v1/latest": "GET",
	"/v1/history": "GET",
	"/v1/stats": "GET",
	"/v1/admin/revoke": "POST",
	"/v1/installation": "DELETE",
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
	});
}

function requestIp(request: Request, env: BackendEnv): string {
	const hostname = new URL(request.url).hostname;
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
	if (env.DEPLOYMENT_MODE === "local") {
		if (!local) throw new ApiError(403, "local_only");
		return "127.0.0.1";
	}
	// Only Cloudflare's edge-owned header is trusted; never X-Forwarded-For.
	const ip = request.headers.get("CF-Connecting-IP");
	if (!ip) throw new ApiError(503, "client_address_unavailable");
	return ip;
}

async function revoke(db: D1DatabaseSession, installationId: string, now: number): Promise<Response> {
	const results = await db.batch<Record<string, unknown>>([
		db.prepare("UPDATE installations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, installationId),
		db.prepare("UPDATE moderation SET revision = revision + 1 WHERE singleton = 1 AND changes() > 0"),
		db.prepare("DELETE FROM scan_tickets WHERE installation_id = ?").bind(installationId),
		db.prepare("SELECT revoked_at FROM installations WHERE id = ?").bind(installationId),
		db.prepare("SELECT revision FROM moderation WHERE singleton = 1"),
	]);
	if (!results[3].results.length) throw new ApiError(404, "installation_not_found");
	return json({ revoked: true, revision: results[4].results[0].revision });
}

function queryKeys(url: URL, allowed: string[]): void {
	const keys = [...url.searchParams.keys()];
	requireCondition(keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length, "invalid_query");
}

async function route(request: Request, env: BackendEnv): Promise<Response> {
	const url = new URL(request.url);
	const reviewed = request.headers.get("X-Community-Format") === "normalized-v2";
	const normalized = reviewed || request.headers.get("X-Community-Format") === "normalized-v1";
	const method = METHODS[url.pathname];
	if (!method) throw new ApiError(404, "not_found");
	if (request.method !== method) throw new ApiError(405, "method_not_allowed", { Allow: method });
	const ip = requestIp(request, env);
	if (url.pathname === "/health")
		return json({ service: "mabicommerce-community", status: "ok", apiVersion: 1 });
	if (url.pathname === "/v1/privacy") return json({
		consentVersion: CONSENT_VERSION,
		sharing: "explicit_opt_in",
		privateIpRetentionDays: 30,
		observationRetention: "indefinite",
		installationAssociationRetentionDays: 30,
		installationAssociationExpiryScope: "post_migration_observations",
		reviewedScanSharing: "confirmed_complete_scans_with_manual_edit_flags",
		collected: ["random installation ID", "structured prices and observed post stock", "server receipt time", "private IP address"],
		prohibited: ["screenshots", "raw OCR text", "character names", "hardware IDs", "personal weekly allowance"],
		revocation: "Credentials and still-linked contributions are disabled; anonymized history cannot be linked back. Historical records remain stored.",
	});
	if (url.pathname === "/v1/catalog") return json(catalog);

	const db = env.DB.withSession("first-primary");
	const now = Date.now();
	// Also prune on API use: local development does not automatically execute cron.
	await cleanup(db, now);
	const ipHash = await hash(ip);
	await rateLimit(db, `request:${ipHash}`, 240, 60_000, now);
	if (url.pathname === "/v1/installations") {
		const input = object(await readJson(request));
		exactKeys(input, ["consentVersion", "acceptPrivacy"]);
		requireCondition(input.acceptPrivacy === true && input.consentVersion === CONSENT_VERSION, "consent_required");
		await rateLimit(db, `register:${ipHash}`, 5, 3_600_000, now);
		const installationId = crypto.randomUUID();
		const token = secret();
		await db.batch([
			db.prepare("INSERT INTO installations(id, token_hash, consent_version, created_at) VALUES (?, ?, ?, ?)")
				.bind(installationId, await hash(token), CONSENT_VERSION, now),
			db.prepare("INSERT INTO private_ip_logs(installation_id, received_at, ip, action) VALUES (?, ?, ?, 'register')")
				.bind(installationId, now, ip),
		]);
		return json({ installationId, token, consentVersion: CONSENT_VERSION }, 201);
	}
	if (url.pathname === "/v1/admin/revoke") {
		if (!env.ADMIN_TOKEN || !/^[0-9a-f]{64}$/.test(env.ADMIN_TOKEN))
			throw new ApiError(503, "moderation_not_configured");
		if (await hash(bearer(request)) !== await hash(env.ADMIN_TOKEN))
			throw new ApiError(401, "unauthorized");
		const input = object(await readJson(request));
		exactKeys(input, ["installationId"]);
		return revoke(db, uuid(input.installationId), now);
	}
	if (["/v1/scan-tickets", "/v1/scans", "/v1/installation"].includes(url.pathname)) {
		const installationId = await authenticate(request, db);
		if (url.pathname === "/v1/installation") return revoke(db, installationId, now);
		await rateLimit(db, `write:${installationId}`, 60, 60_000, now);
		if (url.pathname === "/v1/scan-tickets") {
			const input = object(await readJson(request));
			exactKeys(input, []);
			const scanId = crypto.randomUUID();
			const expiresAt = Date.now() + 60_000;
			await db.prepare(`INSERT INTO scan_tickets(id, installation_id, expires_at)
				SELECT ?, ?, ? FROM installations WHERE id = ? AND revoked_at IS NULL`)
				.bind(scanId, installationId, expiresAt, installationId).run();
			return json({ scanId, expiresAt }, 201);
		}
		const scan = scanInput(await readJson(request));
		const stored = await storeScan(db, installationId, scan, ip, Date.now());
		return json(stored, stored.duplicate ? 200 : 201);
	}
	if (url.pathname === "/v1/sync") {
		queryKeys(url, ["cursor", "revision", "limit"]);
		const cursor = queryInteger(url, "cursor", 0);
		const limit = queryInteger(url, "limit", 100, 1, 200);
		const revision = queryInteger(url, "revision", -1);
		requireCondition(cursor === 0 || revision >= 0, "revision_required");
		const results = await db.batch<Record<string, unknown>>([
			db.prepare("SELECT revision FROM moderation WHERE singleton = 1"),
			db.prepare("SELECT COALESCE(MAX(sequence), 0) AS watermark FROM scans"),
			db.prepare(`SELECT ${PUBLIC_SCAN_COLUMNS} FROM scans s
				LEFT JOIN installations i ON i.id = s.installation_id
				WHERE s.sequence > ? AND s.hidden = 0 AND i.revoked_at IS NULL
				AND (? OR s.review_json IS NULL) ORDER BY s.sequence LIMIT ?`).bind(cursor, reviewed ? 1 : 0, limit),
		]);
		const currentRevision = Number(results[0].results[0].revision);
		if (revision !== -1 && revision !== currentRevision)
			return json({ error: "sync_reset_required", revision: currentRevision }, 409);
		const watermark = Number(results[1].results[0].watermark);
		requireCondition(cursor <= watermark, "cursor_ahead");
		const rows = results[2].results;
		const nextCursor = rows.length < limit ? watermark : Number(rows.at(-1)?.sequence);
		return json({ observations: publicRows(rows, normalized, reviewed), nextCursor, revision: currentRevision, hasMore: nextCursor < watermark });
	}
	if (url.pathname === "/v1/latest") {
		queryKeys(url, []);
		const results = await db.batch<Record<string, unknown>>([
			db.prepare("SELECT revision FROM moderation WHERE singleton = 1"),
			db.prepare("SELECT COALESCE(MAX(sequence), 0) AS watermark FROM scans"),
			db.prepare(`WITH products AS (
				SELECT json_extract(value, '$.mode') AS mode, json_extract(value, '$.id') AS id FROM json_each(?)
			) SELECT ${PUBLIC_SCAN_COLUMNS} FROM products p JOIN scans s ON s.sequence = (
				SELECT s2.sequence FROM scans s2 LEFT JOIN installations i ON i.id = s2.installation_id
				WHERE s2.mode = p.mode AND s2.product_id = p.id AND s2.hidden = 0 AND i.revoked_at IS NULL
				AND (? OR s2.review_json IS NULL)
				ORDER BY s2.sequence DESC LIMIT 1
			) ORDER BY s.sequence`).bind(JSON.stringify(catalog.products), reviewed ? 1 : 0),
		]);
		return json({ observations: publicRows(results[2].results, normalized, reviewed), revision: results[0].results[0].revision,
			...(normalized ? { nextCursor: results[1].results[0].watermark } : {}) });
	}
	if (url.pathname === "/v1/history") {
		queryKeys(url, ["mode", "productId", "before", "limit"]);
		const mode = url.searchParams.get("mode");
		const productId = queryInteger(url, "productId", 0, 1, 1_000_000);
		requireCondition(catalog.products.some((p) => p.mode === mode && p.id === productId), "unknown_product");
		const before = queryInteger(url, "before", Number.MAX_SAFE_INTEGER, 1);
		const limit = queryInteger(url, "limit", 100, 1, 200);
		const results = await db.batch<Record<string, unknown>>([
			db.prepare("SELECT revision FROM moderation WHERE singleton = 1"),
			db.prepare(`SELECT ${PUBLIC_SCAN_COLUMNS} FROM scans s LEFT JOIN installations i ON i.id = s.installation_id
				WHERE s.mode = ? AND s.product_id = ? AND s.sequence < ? AND s.hidden = 0 AND i.revoked_at IS NULL
				AND (? OR s.review_json IS NULL)
				ORDER BY s.sequence DESC LIMIT ?`).bind(mode, productId, before, reviewed ? 1 : 0, limit + 1),
		]);
		const rows = results[1].results;
		const page = rows.slice(0, limit);
		return json({
			observations: publicRows(page, normalized, reviewed),
			nextBefore: rows.length > limit ? page.at(-1)?.sequence : null,
			revision: results[0].results[0].revision,
		});
	}
	if (url.pathname === "/v1/stats") {
		queryKeys(url, []);
		const results = await db.batch<Record<string, unknown>>([
			db.prepare("SELECT revision FROM moderation WHERE singleton = 1"),
			db.prepare(`SELECT COUNT(*) AS acceptedScans, COUNT(DISTINCT s.installation_id) AS contributors
				FROM scans s LEFT JOIN installations i ON i.id = s.installation_id WHERE s.hidden = 0 AND i.revoked_at IS NULL`),
		]);
		return json({ ...results[1].results[0], revision: results[0].results[0].revision });
	}
	throw new ApiError(404, "not_found");
}

export default {
	async fetch(request: Request, env: BackendEnv): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			if (error instanceof ApiError) return json({ error: error.code }, error.status, error.headers);
			const requestId = crypto.randomUUID();
			// Never log request bodies, tokens, IPs, or database error messages.
			console.error("backend_failure", { requestId, errorType: error instanceof Error ? error.name : "unknown" });
			return json({ error: "internal_error", requestId }, 500);
		}
	},
	async scheduled(_controller: ScheduledController, env: BackendEnv): Promise<void> {
		await cleanup(env.DB, Date.now());
	},
} satisfies ExportedHandler<BackendEnv>;
