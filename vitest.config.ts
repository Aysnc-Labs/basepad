import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/build.ts"],
		// Each test drives real services through mise; files share nothing, but run one at a time
		// so their supervisors and Postgres servers never compete for ports while starting.
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 180_000,
	},
});
