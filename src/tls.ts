import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BasepadError, must } from "./internal/exec.ts";

/**
 * The certificate for `localhost` that an app with no domain serves HTTPS with, signed by the CA
 * the proxy signs with, so a browser that trusts the proxy trusts it too. Safari keeps a page's
 * requests to `localhost` on the machine, where iCloud Private Relay sends those to another
 * `*.localhost` domain away from it.
 */

/** Days a new certificate lasts: under the 398 browsers accept. */
const DAYS = 365;
/** A certificate with less left than this is made again. */
const RENEW_MS = 30 * 24 * 60 * 60 * 1000;

export interface CertificatePaths {
	/** The CA and its key. */
	ca: string;
	caKey: string;
	/** Where the certificate and its key are written. */
	cert: string;
	key: string;
}

/** Makes the certificate unless one signed by the CA, with time left, is already there. */
export async function ensureLocalhostCertificate(paths: CertificatePaths): Promise<void> {
	const ca = await readFile(paths.ca, "utf8").catch(() => undefined);
	if (ca === undefined) {
		throw new BasepadError(`No CA at ${paths.ca} to sign the certificate for localhost with.`);
	}
	if (await current(paths.cert, ca)) return;
	await mkdir(dirname(paths.cert), { recursive: true });
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	await writeFile(paths.key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	const scratch = await mkdtemp(join(tmpdir(), "basepad-tls-"));
	const csr = join(scratch, "localhost.csr");
	const extensions = join(scratch, "localhost.ext");
	await writeFile(
		extensions,
		[
			"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
			"extendedKeyUsage=serverAuth",
			"keyUsage=digitalSignature",
			"basicConstraints=CA:FALSE",
		].join("\n"),
	);
	try {
		await must("openssl", [
			"req",
			"-new",
			"-key",
			paths.key,
			"-subj",
			"/CN=localhost",
			"-out",
			csr,
		]);
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
			paths.cert,
		]);
	} finally {
		await rm(scratch, { recursive: true, force: true });
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
