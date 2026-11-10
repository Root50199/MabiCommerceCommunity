import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					ADMIN_TOKEN: "a".repeat(64),
				},
			},
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});
