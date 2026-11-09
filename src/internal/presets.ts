/** A preset picks the framework's env file and its variable names. */
export const PRESETS = ["next", "laravel"] as const;
export type Preset = (typeof PRESETS)[number];

export const ENV_FILES: Record<Preset, string> = { next: ".env.local", laravel: ".env" };

/**
 * The variables a preset writes, from basepad's own (`DATABASE_URL`, `SMTP_URL`, `REDIS_URL`,
 * `<NAME>_URL` and so on), plus the app's URL when the preset has one.
 */
export function presetVars(
	preset: Preset,
	vars: Record<string, string>,
	appPort: number | undefined,
): Record<string, string> {
	if (preset === "next") return vars;

	// Laravel reads `.env` itself, not the shell, under the names its config uses.
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(vars)) {
		if (key === "DATABASE_URL") {
			out.DB_CONNECTION = "pgsql";
			out.DB_URL = value;
		} else if (key === "SMTP_URL") {
			const url = new URL(value);
			out.MAIL_MAILER = "smtp";
			out.MAIL_HOST = url.hostname;
			out.MAIL_PORT = url.port;
			out.MAIL_USERNAME = decodeURIComponent(url.username);
			out.MAIL_PASSWORD = decodeURIComponent(url.password);
		} else {
			out[key] = value;
		}
	}
	if (appPort !== undefined) {
		out.APP_URL = `http://localhost:${appPort}`;
		// `php artisan serve` reads it, so the app is served where APP_URL points.
		out.SERVER_PORT = String(appPort);
	}
	return out;
}

/** Where Neon's driver finds the proxy (`neonConfig.wsProxy`). One per machine, so it's unprefixed. */
export const NEON_WS_PROXY_VAR = "NEON_WS_PROXY";

/** Whether a preset writes the app's URL, so the project needs an app port. */
export function needsAppPort(preset: Preset): boolean {
	return preset === "laravel";
}
