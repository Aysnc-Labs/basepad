export const MISE_MIN_VERSION = "2026.10.24";

export const NODE_MAJOR = 24;

/** pitchfork is pinned: 2.34.0 fixes a port clash between apps started in parallel: https://github.com/jdx/pitchfork/pull/1114 */
export const PITCHFORK_VERSION = "2.34.0";

/** mise's conda backend takes a version's newest build, built for Postgres 18 since 0.8.1; 0.8.0 is the newest whose builds are all for 17: https://anaconda.org/conda-forge/pgvector/files */
export const PGVECTOR_VERSIONS = { 17: "0.8.0", 18: "0.8.6" } as const;

export const MAILPIT_VERSION = "1";

export const REDIS_VERSION = "8";

export const NEON_PROXY_VERSION = "neon-proxy-8853";
