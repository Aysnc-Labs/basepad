import { execFile } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureLocalhostCertificate } from "../src/tls.ts";

const openssl = (...args: string[]) => promisify(execFile)("openssl", args);

let dir: string;
let paths: { ca: string; caKey: string; cert: string; key: string };

/** A CA in `dir` named `name`, as the proxy makes one. */
async function makeCa(name: string): Promise<{ ca: string; caKey: string }> {
	const caKey = join(dir, `${name}-key.pem`);
	const ca = join(dir, `${name}.pem`);
	await openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKey);
	await openssl(
		"req",
		"-x509",
		"-new",
		"-key",
		caKey,
		"-subj",
		`/CN=${name}`,
		"-days",
		"30",
		"-out",
		ca,
	);
	return { ca, caKey };
}

const certificate = async () => new X509Certificate(await readFile(paths.cert));
const signedBy = async (ca: string) =>
	(await certificate()).verify(new X509Certificate(await readFile(ca)).publicKey);

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bp-tls-"));
	paths = {
		...(await makeCa("ca")),
		cert: join(dir, "tls/localhost.pem"),
		key: join(dir, "tls/localhost-key.pem"),
	};
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("makes a certificate for localhost, signed by the CA, with its key readable by its owner only", async () => {
	await ensureLocalhostCertificate(paths);
	const cert = await certificate();
	expect(await signedBy(paths.ca)).toBe(true);
	expect(cert.checkHost("localhost")).toBe("localhost");
	expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
	expect(cert.checkIP("::1")).toBe("::1");
	expect(cert.checkPrivateKey(createPrivateKey(await readFile(paths.key)))).toBe(true);
	expect((await stat(paths.key)).mode & 0o777).toBe(0o600);
});

test("keeps a certificate the CA signed that has time left", async () => {
	await ensureLocalhostCertificate(paths);
	const first = await readFile(paths.cert, "utf8");
	await ensureLocalhostCertificate(paths);
	expect(await readFile(paths.cert, "utf8")).toBe(first);
});

test("makes it again once another CA signs certificates", async () => {
	await ensureLocalhostCertificate(paths);
	paths = { ...paths, ...(await makeCa("new-ca")) };
	await ensureLocalhostCertificate(paths);
	expect(await signedBy(paths.ca)).toBe(true);
	expect((await certificate()).checkPrivateKey(createPrivateKey(await readFile(paths.key)))).toBe(
		true,
	);
});

test("makes it again when it expires within 30 days", async () => {
	await ensureLocalhostCertificate(paths);
	const csr = join(dir, "short.csr");
	await openssl("req", "-new", "-key", paths.key, "-subj", "/CN=localhost", "-out", csr);
	await openssl(
		"x509",
		"-req",
		"-in",
		csr,
		"-CA",
		paths.ca,
		"-CAkey",
		paths.caKey,
		"-set_serial",
		"7",
		"-days",
		"10",
		"-out",
		paths.cert,
	);
	await ensureLocalhostCertificate(paths);
	const left = Date.parse((await certificate()).validTo) - Date.now();
	expect(left).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);
});

test("waits for a CA the proxy has yet to write", async () => {
	const later = { ...paths, ca: join(dir, "later.pem"), caKey: join(dir, "later-key.pem") };
	setTimeout(async () => {
		await writeFile(later.caKey, await readFile(paths.caKey));
		await writeFile(later.ca, await readFile(paths.ca));
	}, 300);
	await ensureLocalhostCertificate(later);
	expect(await signedBy(paths.ca)).toBe(true);
});

test("with no CA in time, says where it looked", async () => {
	const none = { ...paths, ca: join(dir, "none.pem") };
	await expect(ensureLocalhostCertificate(none, 200)).rejects.toThrow(`No CA at ${none.ca}`);
});
