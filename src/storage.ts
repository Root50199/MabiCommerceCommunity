import { ApiError, IP_RETENTION_MS, type Scan } from "./validation";

export interface BackendEnv extends Env {
	ADMIN_TOKEN?: string;
}

export async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bearer(request: Request): string {
	const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") ?? "");
	if (!match) throw new ApiError(401, "unauthorized");
	return match[1];
}

export async function authenticate(request: Request, db: D1DatabaseSession): Promise<string> {
	const tokenHash = await hash(bearer(request));
	const installation = await db.prepare(
		"SELECT id FROM installations WHERE token_hash = ? AND revoked_at IS NULL",
	).bind(tokenHash).first<{ id: string }>();
	if (!installation) throw new ApiError(401, "unauthorized");
	return installation.id;
}

export async function rateLimit(db: D1DatabaseSession, key: string, limit: number, windowMs: number, now: number): Promise<void> {
	const bucket = Math.floor(now / windowMs);
	const result = await db.prepare(
		`INSERT INTO rate_limits(key, count, expires_at) VALUES (?, 1, ?)
		 ON CONFLICT(key) DO UPDATE SET count = count + 1
		 WHERE count < ? RETURNING count`,
	).bind(`${key}:${bucket}`, (bucket + 1) * windowMs, limit).first();
	if (!result) throw new ApiError(429, "rate_limited", { "Retry-After": String(Math.ceil(((bucket + 1) * windowMs - now) / 1000)) });
}

export async function cleanup(db: D1Database | D1DatabaseSession, now: number): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM private_ip_logs WHERE received_at <= ?").bind(now - IP_RETENTION_MS),
		db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
		db.prepare("DELETE FROM scan_tickets WHERE expires_at <= ?").bind(now),
		db.prepare(`UPDATE scans SET installation_id = NULL
			WHERE association_expires_at <= ? AND installation_id IS NOT NULL`).bind(now),
		db.prepare(`DELETE FROM installations WHERE expires_at <= ?
			AND NOT EXISTS (SELECT 1 FROM scans WHERE installation_id = installations.id)
			AND NOT EXISTS (SELECT 1 FROM private_ip_logs WHERE installation_id = installations.id)
			AND NOT EXISTS (SELECT 1 FROM scan_tickets WHERE installation_id = installations.id)`).bind(now),
	]);
}

export async function storeScan(db: D1DatabaseSession, installationId: string, scan: Scan, ip: string, now: number): Promise<{ sequence: number; receivedAt: number; duplicate: boolean }> {
	const payloadHash = await hash(JSON.stringify(scan));
	const existing = await db.prepare("SELECT sequence, received_at, payload_hash, installation_id FROM scans WHERE id = ?")
		.bind(scan.scanId).first<{ sequence: number; received_at: number; payload_hash: string; installation_id: string | null }>();
	if (existing) {
		if (existing.installation_id !== installationId || existing.payload_hash !== payloadHash)
			throw new ApiError(409, "scan_conflict");
		return { sequence: existing.sequence, receivedAt: existing.received_at, duplicate: true };
	}
	// All writes commit together. The unique ticket ID prevents concurrent double submissions.
	const results = await db.batch<{ sequence: number; received_at: number; payload_hash: string; installation_id: string | null }>([
		db.prepare(`INSERT INTO scans(id, installation_id, received_at, payload_hash, mode, product_id, source_post_id, source_price, stock,
			price_basis, observed_source_price, purchase_discount_percent, review_json)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM installations
			WHERE id = ? AND revoked_at IS NULL
			AND EXISTS (SELECT 1 FROM scan_tickets WHERE id = ? AND installation_id = ? AND expires_at > ?)
			ON CONFLICT(id) DO NOTHING`)
			.bind(scan.scanId, installationId, now, payloadHash, scan.mode, scan.productId, scan.sourcePostId, scan.sourcePrice, scan.stock,
				scan.priceBasis ?? "legacy", scan.observedSourcePrice ?? null, scan.purchaseDiscountPercent ?? null,
				scan.review ? JSON.stringify(scan.review) : null,
				installationId, scan.scanId, installationId, now),
		...scan.prices.map((price) => db.prepare(
			`INSERT INTO quotes(scan_sequence, post_id, sale_price, profit)
			 SELECT sequence, ?, ?, ? FROM scans WHERE id = ? AND installation_id = ? AND payload_hash = ?
			 ON CONFLICT(scan_sequence, post_id) DO NOTHING`,
		).bind(price.postId, price.salePrice, price.profit, scan.scanId, installationId, payloadHash)),
		db.prepare(`INSERT INTO private_ip_logs(scan_sequence, installation_id, received_at, ip, action)
			SELECT sequence, ?, ?, ?, 'scan' FROM scans WHERE id = ? AND installation_id = ? AND payload_hash = ?
			ON CONFLICT(scan_sequence) DO NOTHING`)
			.bind(installationId, now, ip, scan.scanId, installationId, payloadHash),
		db.prepare("DELETE FROM scan_tickets WHERE id = ? AND installation_id = ?").bind(scan.scanId, installationId),
		db.prepare("SELECT sequence, received_at, payload_hash, installation_id FROM scans WHERE id = ?").bind(scan.scanId),
	]);
	const stored = results.at(-1)?.results[0];
	if (!stored) throw new ApiError(409, "scan_ticket_expired_or_unknown");
	if (stored.installation_id !== installationId || stored.payload_hash !== payloadHash)
		throw new ApiError(409, "scan_conflict");
	return { sequence: Number(stored.sequence), receivedAt: Number(stored.received_at), duplicate: results[0].meta.changes === 0 };
}

export const PUBLIC_SCAN_COLUMNS = `s.sequence, s.received_at AS receivedAt, s.mode, s.product_id AS productId,
	s.source_post_id AS sourcePostId, s.source_price AS sourcePrice, s.stock,
	s.price_basis AS priceBasis, s.observed_source_price AS observedSourcePrice,
	s.purchase_discount_percent AS purchaseDiscountPercent,
	s.review_json AS reviewJson,
	json((SELECT json_group_array(json_object('postId', post_id, 'salePrice', sale_price, 'profit', profit))
		FROM (SELECT post_id, sale_price, profit FROM quotes WHERE scan_sequence = s.sequence ORDER BY post_id))) AS prices`;

export function publicRows(rows: Record<string, unknown>[], normalized = false, reviewed = false): Record<string, unknown>[] {
	return rows.map((row) => {
		const { priceBasis, observedSourcePrice, purchaseDiscountPercent, reviewJson, ...legacy } = row;
		return {
			...legacy,
			sourcePrice: normalized || priceBasis !== "normalized-v1" ? row.sourcePrice : observedSourcePrice,
			...(normalized ? { priceBasis, observedSourcePrice, purchaseDiscountPercent } : {}),
			...(reviewed && reviewJson ? { review: JSON.parse(String(reviewJson)) as unknown } : {}),
			prices: JSON.parse(String(row.prices)) as unknown,
		};
	});
}
