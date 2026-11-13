import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, readEnv, type Sandbox, sandbox, sendMail } from "./sandbox.ts";

/** Each test file's project has its own name, so its derived ports differ. */
const config = configFile(`{
	name: "mp-shop",
	services: { mail: mailpit() },
	env: ({ mail }) => ({
		".env.local": { SMTP_URL: mail.url, SMTP_HOST: mail.host, SMTP_PORT: mail.port, INBOX: mail.inbox },
	}),
}`);

interface Messages {
	messages: { Subject: string; Tags: string[] }[];
}

const git = (cwd: string, ...args: string[]) =>
	promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});

let box: Sandbox;
let shop: string;
let firstUp: Result;

beforeAll(async () => {
	box = await sandbox();
	shop = await box.project("shop", {
		"basepad.config.ts": config,
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(shop, "init", "--quiet", "--initial-branch=main");
	await git(shop, "add", ".");
	await git(shop, "commit", "--quiet", "-m", "init");
	firstUp = await box.basepad(shop, "up");
}, 300_000);
afterAll(() => box?.dispose());

/** The subjects in the inbox at `inbox`, each with its tags. */
async function inbox(url: string): Promise<Record<string, string[]>> {
	const { messages } = await box.get<Messages>(`${url}/api/v1/messages`);
	return Object.fromEntries(messages.map((m) => [m.Subject, m.Tags]));
}

test("up runs the project's Mailpit; mail sent to the written SMTP URL lands in the inbox at the service's domain, marked main", async () => {
	expect(firstUp.stderr).toBe("");
	expect(firstUp.code).toBe(0);
	const env = await readEnv(shop, ".env.local");
	expect(env.SMTP_URL).toMatch(/^smtp:\/\/main:[^@]+@127\.0\.0\.1:\d+$/);
	expect(env.SMTP_HOST).toBe("127.0.0.1");
	expect(env.SMTP_URL).toContain(`:${env.SMTP_PORT}`);
	expect(env.INBOX).toBe(`https://mail.mp-shop.localhost:${box.proxyPort}`);
	await sendMail(env.SMTP_URL as string, { from: "a@shop.test", to: "b@x.test", subject: "hi" });
	expect(await inbox(env.INBOX as string)).toEqual({ hi: ["main"] });
});

test("a worktree shares main's inbox, and its mail is marked with the worktree", async () => {
	const add = await box.basepad(shop, "worktree", "add");
	expect(add.stderr).toBe("");
	expect(add.code).toBe(0);
	const main = await readEnv(shop, ".env.local");
	const tree = await readEnv(join(box.root, "mp-shop.worktrees/worktree-1"), ".env.local");
	expect(tree.SMTP_URL).toBe((main.SMTP_URL as string).replace("//main:", "//worktree-1:"));
	expect(tree.INBOX).toBe(main.INBOX);
	await sendMail(tree.SMTP_URL as string, { from: "a@shop.test", to: "b@x.test", subject: "wt" });
	expect(await inbox(main.INBOX as string)).toEqual({ hi: ["main"], wt: ["worktree-1"] });
});

test("another project has a Mailpit of its own, and never sees this one's mail", async () => {
	const cafe = await box.project("cafe", {
		"basepad.config.ts": config.replace('"mp-shop"', '"mp-cafe"'),
	});
	const up = await box.basepad(cafe, "up", "-d");
	expect(up.stderr).toBe("");
	const theirs = await readEnv(cafe, ".env.local");
	const ours = await readEnv(shop, ".env.local");
	expect(theirs.INBOX).toBe(`https://mail.mp-cafe.localhost:${box.proxyPort}`);
	expect(theirs.SMTP_PORT).not.toBe(ours.SMTP_PORT);
	await sendMail(theirs.SMTP_URL as string, { from: "a@cafe.test", to: "b@x.test", subject: "c" });
	expect(await inbox(theirs.INBOX as string)).toEqual({ c: ["main"] });
	expect(Object.keys(await inbox(ours.INBOX as string))).not.toContain("c");
});

test("status lists the inbox; down stops Mailpit, and up brings it back with its mail", async () => {
	const env = await readEnv(shop, ".env.local");
	const status = await box.basepad(shop, "status");
	expect(status.stdout).toMatch(
		new RegExp(`^mail +https://mail\\.mp-shop\\.localhost:${box.proxyPort} +running$`, "m"),
	);
	expect((await box.basepad(shop, "down")).code).toBe(0);
	expect((await box.basepad(shop, "status")).stdout).toMatch(/^mail +\S+ +stopped$/m);
	await expect(
		sendMail(env.SMTP_URL as string, { from: "a@shop.test", to: "b@x.test", subject: "lost" }),
	).rejects.toThrow();
	const up = await box.basepad(shop, "up", "-d");
	expect(up.stderr).toBe("");
	expect((await readEnv(shop, ".env.local")).SMTP_URL).toBe(env.SMTP_URL);
	expect(Object.keys(await inbox(env.INBOX as string))).toEqual(expect.arrayContaining(["hi"]));
});
