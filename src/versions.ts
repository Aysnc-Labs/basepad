/**
 * The tool versions basepad relies on, in one place. Kept free of imports and of syntax newer
 * than Node 18, since the launcher reads it before basepad has moved onto a Node 24.
 */

/** The oldest mise basepad runs with. Lower it only with a test on that version. */
export const MISE_MIN_VERSION = "2026.10.24";

/** The Node basepad runs on, from mise, whatever Node the project has. */
export const NODE_MAJOR = 24;

/** pitchfork is pinned: 2.34.0 fixes a port clash between apps started in parallel. */
export const PITCHFORK_VERSION = "2.34.0";
