import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Community backend foundation", () => {
	it("reports service health without exposing client information", async () => {
		const response = await SELF.fetch("http://localhost/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "mabicommerce-community",
			status: "ok",
			apiVersion: 1,
		});
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("does not accept writes at the health endpoint", async () => {
		const response = await SELF.fetch("http://localhost/health", { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
		expect(await response.json()).toEqual({ error: "method_not_allowed" });
	});

	it("does not pretend unimplemented endpoints exist", async () => {
		const response = await SELF.fetch("http://localhost/v1/not-implemented", { method: "POST" });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});
});
