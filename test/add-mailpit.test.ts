import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox, sendMail } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

interface Message {
	Subject: string;
	Tags: string[];
}

test("basepad add mailpit gives each project an SMTP URL whose mail lands in one inbox, tagged with the project", async () => {
	const shop = await box.project("shop");
	const cafe = await box.project("Cafe Bar!");
	for (const dir of [shop, cafe]) {
		const add = await box.basepad(dir, "add", "mailpit");
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);
	}

	const urls = await Promise.all(
		[shop, cafe].map(
			async (dir) => blockOf(await readFile(join(dir, ".env.local"), "utf8")).SMTP_URL as string,
		),
	);
	expect(urls[0]).toMatch(/^smtp:\/\/shop:[^@]+@127\.0\.0\.1:\d+$/);
	expect(urls[1]).toMatch(/^smtp:\/\/Cafe-Bar:[^@]+@127\.0\.0\.1:\d+$/);
	expect(new URL(urls[0] as string).port).toBe(new URL(urls[1] as string).port);

	await sendMail(urls[0] as string, {
		from: "app@shop.test",
		to: "a@x.test",
		subject: "from shop",
	});
	await sendMail(urls[1] as string, {
		from: "app@cafe.test",
		to: "b@x.test",
		subject: "from cafe",
	});

	const status = await box.basepad(shop, "status");
	expect(status.code).toBe(0);
	expect(status.stdout).toMatch(/^mailpit +running +\d+ +smtp:\/\/shop:\*+@127\.0\.0\.1:\d+$/m);
	const inbox = status.stdout.match(/^mailpit\/inbox +running +\d+ +(http:\S+)$/m)?.[1];
	expect(inbox).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

	const res = await fetch(`${inbox}/api/v1/messages`);
	const { messages } = (await res.json()) as { messages: Message[] };
	const tags = Object.fromEntries(messages.map((m) => [m.Subject, m.Tags]));
	expect(tags).toEqual({ "from shop": ["shop"], "from cafe": ["Cafe-Bar"] });
});
