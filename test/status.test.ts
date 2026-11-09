import { afterAll, beforeAll, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

/** The rows of `basepad status`, keyed by service, as a developer reads them. */
function rows(table: string): Record<string, { state: string; port: string; url: string }> {
	const [header, ...lines] = table.trim().split("\n");
	expect(header?.split(/\s+/)).toEqual(["SERVICE", "STATE", "PORT", "URL", "NAME"]);
	return Object.fromEntries(
		lines.map((line) => {
			const [service, state, port, url] = line.split(/\s+/);
			return [service, { state, port, url }];
		}),
	);
}

test("basepad status lists basepad's services and the project's own daemons", async () => {
	const shop = await box.project("shop", {
		"mise.toml": [
			"[settings]",
			"experimental = true",
			"",
			"[daemons.worker]",
			'run = "exec sleep 600"',
			"port = 47811",
			"proxy = false",
			"",
		].join("\n"),
	});
	expect((await box.basepad(shop, "add", "postgres")).code).toBe(0);

	const before = await box.basepad(shop, "status");
	expect(before.code).toBe(0);
	const listed = rows(before.stdout);
	expect(listed.postgres?.state).toBe("running");
	expect(listed.postgres?.url).toMatch(/^postgres:\/\/postgres:\*+@localhost:\d+\/shop$/);
	expect(listed.postgres?.port).toBe(listed.postgres?.url.match(/:(\d+)\//)?.[1]);
	expect(listed.worker).toEqual({ state: "available", port: "47811", url: "-" });

	expect((await box.mise(shop, "daemons", "start", "worker")).code).toBe(0);
	expect(rows((await box.basepad(shop, "status")).stdout).worker?.state).toBe("running");
});
