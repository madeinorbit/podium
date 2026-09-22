/**
 * THE COMPOSER SHARED VOCABULARY (POD-4477): the byte sequences and the
 * verify-normalization every per-harness composer rule set is written in.
 *
 * Pure data plus one pure function — no imports at all — so the browser entry
 * bundles it (the `manifest-browser-reach` closure refuses node-shaped code
 * there) and the daemon reads the same bytes through the manifest. One copy:
 * the claude and codex rule sets share it rather than restating it, the way
 * `adapters/shared/hook-fields.ts` shares the hook spelling-union readers.
 */

/** Ctrl-U (kill-line). Claude clears its composer with one per line. */
export const CTRL_U = '\x15'
/** Ctrl-C. Codex clears a NON-EMPTY composer with it (stashes to history); on an
 *  empty composer it arms quit — never send it blind. */
export const CTRL_C = '\x03'
/** Bracketed-paste start (ESC[200~) — makes the burst a single literal paste. */
export const PASTE_START = '\x1b[200~'
/** Bracketed-paste end (ESC[201~). */
export const PASTE_END = '\x1b[201~'

// Verify is a coarse "did the text land" check, not an exact-fidelity one. A line
// wider than the PTY wraps, so the scrape comes back with an extra newline where the
// injected text had none (or a space) — exact equality would false-mismatch, trigger
// a re-inject, and self-demote (reviewer blocker 3). Collapsing all whitespace makes
// verify wrap-insensitive (mid-word AND at-space wraps) while still catching a truly
// different composer.
export function normalizeForVerify(s: string): string {
  return s.replace(/\s+/g, '')
}
