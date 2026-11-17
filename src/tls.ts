import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { must } from "./internal/exec.ts";
import { waitFor } from "./internal/ports.ts";

const DAYS = 365;
const RENEW_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 30_000;

export interface CertificatePaths {
	ca: string;
	caKey: string;
	cert: string;
	key: string;
}

export async function ensureLocalhostCertificate(
	paths: CertificatePaths,
	waitMs = 10_000,
): Promise<void> {
	const ca = await waitFor(
		() => readFile(paths.ca, "utf8"),
		`No CA at ${paths.ca} to sign the certificate for localhost with.`,
		waitMs,
	);
	if (await current(paths.cert, ca)) return;
	const dir = dirname(paths.cert);
	await mkdir(dir, { recursive: true });
	const lock = `${paths.cert}.lock`;
	await waitFor(() => takeLock(lock), `${lock} is held by another basepad.`, STALE_LOCK_MS * 2);
	const scratch = await mkdtemp(join(dir, ".new-"));
	try {
		if (await current(paths.cert, ca)) return;
		const key = join(scratch, "key.pem");
		const cert = join(scratch, "cert.pem");
		const csr = join(scratch, "localhost.csr");
		const extensions = join(scratch, "localhost.ext");
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		await writeFile(key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		await writeFile(
			extensions,
			[
				"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
				"extendedKeyUsage=serverAuth",
				"keyUsage=digitalSignature",
				"basicConstraints=CA:FALSE",
			].join("\n"),
		);
		await must("openssl", ["req", "-new", "-key", key, "-subj", "/CN=localhost", "-out", csr]);
		await must("openssl", [
			"x509",
			"-req",
			"-in",
			csr,
			"-CA",
			paths.ca,
			"-CAkey",
			paths.caKey,
			"-set_serial",
			`0x${randomBytes(8).toString("hex")}`,
			"-days",
			String(DAYS),
			"-sha256",
			"-extfile",
			extensions,
			"-out",
			cert,
		]);
		await rename(key, paths.key);
		await rename(cert, paths.cert);
	} finally {
		await rm(scratch, { recursive: true, force: true });
		await rm(lock, { recursive: true, force: true });
	}
}

async function takeLock(lock: string): Promise<void> {
	try {
		await mkdir(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const age = Date.now() - (await stat(lock)).mtimeMs;
		if (age < STALE_LOCK_MS) throw new Error("another basepad is making it");
		await rm(lock, { recursive: true, force: true });
		await mkdir(lock);
	}
}

async function current(cert: string, ca: string): Promise<boolean> {
	const pem = await readFile(cert, "utf8").catch(() => undefined);
	if (pem === undefined) return false;
	try {
		const certificate = new X509Certificate(pem);
		const signed = certificate.verify(new X509Certificate(ca).publicKey);
		return signed && Date.parse(certificate.validTo) - Date.now() > RENEW_MS;
	} catch {
		return false;
	}
}
