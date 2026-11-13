import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/build.ts"],
		testTimeout: 60_000,
	},
});
