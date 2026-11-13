import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { must } from "./internal/exec.ts";
import { waitFor } from "./internal/ports.ts";

/** Days a new certificate lasts: under the 398 browsers accept. */
const DAYS = 365;
/** A certificate with less left than this is made again. */
const RENEW_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a lock another basepad holds is waited on before it is taken as abandoned. */
const STALE_LOCK_MS = 30_000;

export interface CertificatePaths {
	/** The CA and its key. */
	ca: string;
	caKey: string;
	/** Where the certificate and its key are written. */
	cert: string;
	key: string;
}

/**
 * Makes the certificate for `localhost` that apps with no domain serve HTTPS with, signed by the
 * proxy's CA, unless one it signed, with time left, is already there. Waits up to `waitMs` for the
 * CA, which the proxy writes as it starts. Two basepads at once take turns, and each file is
 * replaced whole, so an app never reads a key and a certificate that do not match.
 */
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
		// Another basepad may have made it while this one waited.
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

/** Takes the lock, a folder only one process can make; throws while another holds it. */
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

/** Whether the certificate is there, signed by this CA, and not about to expire. */
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
