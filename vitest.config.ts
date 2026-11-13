import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/build.ts"],
		testTimeout: 60_000,
		// A sandbox that ran `up` stops its supervisor and apps on dispose, which can take seconds.
		hookTimeout: 60_000,
	},
});
