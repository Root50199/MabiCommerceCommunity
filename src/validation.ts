import catalog from "./catalog.json";

export const CONSENT_VERSION = "2026-11-09";
export const IP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 16_384;
export const MAX_BATCH_SCANS = 16;
export const MAX_BATCH_BYTES = 65_536;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly headers: Record<string, string> = {},
	) {
		super(code);
	}
}

export function requireCondition(condition: unknown, code = "invalid_request"): asserts condition {
	if (!condition) throw new ApiError(400, code);
}

export function object(value: unknown): Record<string, unknown> {
	requireCondition(typeof value === "object" && value !== null && !Array.isArray(value));
	return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: string[]): void {
	requireCondition(Object.keys(value).length === keys.length && keys.every((key) => key in value));
}

export function integer(value: unknown, min: number, max: number): number {
	requireCondition(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
	return value;
}

export function uuid(value: unknown): string {
	requireCondition(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
	return value;
}

export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
	if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
		throw new ApiError(415, "json_required");
	if (request.headers.has("Content-Encoding")) throw new ApiError(415, "encoded_body_not_supported");
	if (!request.body) throw new ApiError(400, "invalid_json");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new ApiError(413, "body_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof TypeError)
			throw new ApiError(400, "invalid_json");
		throw error;
	}
}

export interface Scan {
	scanId: string;
	mode: "trade" | "group" | "barter";
	productId: number;
	sourcePostId: number;
	sourcePrice: number | null;
	stock: number;
	prices: { postId: number; salePrice: number; profit: number | null }[];
	priceBasis?: "normalized-v1";
	observedSourcePrice?: number | null;
	purchaseDiscountPercent?: number;
	review?: { sourceManual: boolean; stockManual: boolean; manualPostIds: number[] };
}

export function scanInput(input: unknown): Scan {
	const value = object(input);
	const normalized = value.priceBasis === "normalized-v1";
	const extendedLegacy = value.priceBasis === "legacy" && value.observedSourcePrice === null && value.purchaseDiscountPercent === null;
	exactKeys(value, ["scanId", "mode", "productId", "sourcePostId", "sourcePrice", "stock", "prices",
		...(normalized || extendedLegacy ? ["priceBasis", "observedSourcePrice", "purchaseDiscountPercent"] : []),
		...("review" in value ? ["review"] : [])]);
	let review: Scan["review"];
	if ("review" in value) {
		requireCondition(normalized, "review_requires_normalized_prices");
		const metadata = object(value.review);
		exactKeys(metadata, ["sourceManual", "stockManual", "manualPostIds"]);
		requireCondition(typeof metadata.sourceManual === "boolean" && typeof metadata.stockManual === "boolean" &&
			Array.isArray(metadata.manualPostIds) && metadata.manualPostIds.length <= 13, "invalid_review");
		const manualPostIds = metadata.manualPostIds.map((id: unknown) => integer(id, 0, 1_000_000)).sort((a, b) => a - b);
		requireCondition(new Set(manualPostIds).size === manualPostIds.length, "invalid_review");
		review = { sourceManual: metadata.sourceManual, stockManual: metadata.stockManual, manualPostIds };
	}
	const scanId = uuid(value.scanId);
	const mode = value.mode;
	requireCondition(mode === "trade" || mode === "group" || mode === "barter");
	const productId = integer(value.productId, 1, 1_000_000);
	const sourcePostId = integer(value.sourcePostId, 1, 1_000_000);
	requireCondition(catalog.products.some((p) => p.id === productId && p.mode === mode && p.postId === sourcePostId), "unknown_product");
	if (mode === "barter") requireCondition(value.sourcePrice === null, "barter_sale_only");
	const sourcePrice = mode === "barter" ? null : integer(value.sourcePrice, 1, 1_000_000_000);
	let observedSourcePrice = sourcePrice;
	let purchaseDiscountPercent = 0;
	if (normalized) {
		requireCondition(typeof value.purchaseDiscountPercent === "number" &&
			Number.isFinite(value.purchaseDiscountPercent) && value.purchaseDiscountPercent >= 0 &&
			value.purchaseDiscountPercent <= 99 &&
			Math.round(value.purchaseDiscountPercent * 100) / 100 === value.purchaseDiscountPercent, "invalid_discount");
		purchaseDiscountPercent = value.purchaseDiscountPercent;
		if (mode === "barter") {
			requireCondition(value.observedSourcePrice === null && purchaseDiscountPercent === 0, "barter_sale_only");
		} else {
			observedSourcePrice = integer(value.observedSourcePrice, 1, 1_000_000_000);
			// Integer hundredths avoid binary floating-point half-price normalization drift.
			const numerator = observedSourcePrice * 10000;
			const divisor = 10000 - Math.round(purchaseDiscountPercent * 100);
			requireCondition(sourcePrice === Math.floor((2 * numerator + divisor) / (2 * divisor)), "normalization_mismatch");
		}
	}
	const stock = integer(value.stock, 0, 1_000_000_000);
	requireCondition(Array.isArray(value.prices) && value.prices.length > 0 && value.prices.length <= 13);
	const eligible = catalog.posts.filter((post) => post.canSell && post.id !== sourcePostId &&
		(mode !== "group" || catalog.products.some((p) => p.postId === post.id && p.mode === "group")));
	const prices = value.prices.map((entry: unknown) => {
		const row = object(entry);
		exactKeys(row, ["postId", "salePrice", "profit"]);
		// 0 is the explicitly documented Smuggler quote, never a source post.
		const postId = integer(row.postId, 0, 1_000_000);
		requireCondition(eligible.some((post) => post.id === postId) || (postId === 0 && mode !== "group"), "invalid_destination");
		const salePrice = integer(row.salePrice, 0, 1_000_000_000);
		if (mode === "barter") requireCondition(row.profit === null, "barter_sale_only");
		const profit = mode === "barter" || (review && row.profit === null) ? null : integer(row.profit, -1_000_000_000, 1_000_000_000);
		if (sourcePrice !== null && profit !== null)
			requireCondition(salePrice - profit === observedSourcePrice, "price_cross_check_failed");
		return { postId, salePrice, profit };
	}).sort((a, b) => a.postId - b.postId);
	requireCondition(new Set(prices.map((p) => p.postId)).size === prices.length, "duplicate_destination");
	requireCondition(eligible.every((post) => prices.some((p) => p.postId === post.id)), "incomplete_prices");
	requireCondition(!review || review.manualPostIds.every((id) => prices.some((p) => p.postId === id)), "invalid_review");
	requireCondition(mode !== "barter" || !review?.sourceManual, "barter_sale_only");
	return { scanId, mode, productId, sourcePostId, sourcePrice, stock, prices,
		...(normalized ? { priceBasis: "normalized-v1" as const, observedSourcePrice, purchaseDiscountPercent } : {}),
		...(review ? { review } : {}) };
}

export function queryInteger(url: URL, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	const raw = url.searchParams.get(name);
	if (raw === null) return fallback;
	requireCondition(/^(0|[1-9]\d*)$/.test(raw), "invalid_query");
	return integer(Number(raw), min, max);
}

export function scanBatchInput(input: unknown): Scan[] {
	const value = object(input);
	exactKeys(value, ["scans"]);
	requireCondition(Array.isArray(value.scans) && value.scans.length > 0 &&
		value.scans.length <= MAX_BATCH_SCANS, "invalid_batch_size");
	const scans = value.scans.map(scanInput);
	requireCondition(scans.every((scan) => scan.mode === scans[0].mode &&
		scan.sourcePostId === scans[0].sourcePostId), "mixed_batch_outpost");
	requireCondition(new Set(scans.map((scan) => scan.scanId)).size === scans.length &&
		new Set(scans.map((scan) => scan.productId)).size === scans.length, "duplicate_batch_good");
	return scans;
}

export { catalog };
