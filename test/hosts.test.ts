import { expect, test } from "vitest";
import { withHosts } from "../src/hosts.ts";

const HOSTS = "127.0.0.1 localhost\n::1 localhost\n";

test("a project's domains are added as a marked block, every other line kept", () => {
	expect(withHosts(HOSTS, "shop", ["web.shop.localhost", "cms.shop.localhost"])).toBe(
		`${HOSTS}# >>> basepad shop\n127.0.0.1 web.shop.localhost\n127.0.0.1 cms.shop.localhost\n# <<< basepad shop\n`,
	);
});

test("the block is replaced in place, other projects' blocks untouched, and a rerun changes nothing", () => {
	const two = withHosts(withHosts(HOSTS, "shop", ["web.shop.localhost"]), "blog", [
		"web.blog.localhost",
	]);
	const changed = withHosts(two, "shop", ["api.shop.localhost"]);
	expect(changed).toBe(
		`${HOSTS}# >>> basepad shop\n127.0.0.1 api.shop.localhost\n# <<< basepad shop\n# >>> basepad blog\n127.0.0.1 web.blog.localhost\n# <<< basepad blog\n`,
	);
	expect(withHosts(changed, "shop", ["api.shop.localhost"])).toBe(changed);
});

test("a file without a final newline gets one before the block", () => {
	expect(withHosts("127.0.0.1 localhost", "shop", ["web.shop.localhost"])).toBe(
		"127.0.0.1 localhost\n# >>> basepad shop\n127.0.0.1 web.shop.localhost\n# <<< basepad shop\n",
	);
});
