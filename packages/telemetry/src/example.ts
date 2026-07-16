/**
 * The example usage report [spec:SP-f933] — the most-read artifact in this
 * package.
 *
 * Every new user sees it (the setup prompt shows it BY DEFAULT rather than
 * behind a "learn more"), and `podium telemetry show` falls back to it before
 * anything real exists. Almost nobody reads docs/TELEMETRY.md. So this string,
 * not the doc, is what most people will ever know about what Podium sends —
 * which makes silent drift from {@link UsageReport} a trust bug, not a typo.
 *
 * It lives HERE, beside the schema, rather than in apps/cli, for exactly one
 * reason: `packages/*` may not import `apps/*` (scripts/check-boundaries.ts), so
 * an example defined in the CLI could never be drift-tested against the schema
 * it claims to illustrate. Guarding it requires it to live next to what it
 * mirrors.
 *
 * Two guards, deliberately overlapping:
 *   1. {@link EXAMPLE_USAGE_REPORT} is typed as `UsageReport` and parsed in
 *      `example.test.ts` — the schema is `.strict()`, so a missing or extra
 *      field fails to compile or fails the test.
 *   2. `example.test.ts` asserts every field name appears in the rendered
 *      display string, so adding a schema field forces the display to change.
 */
import type { UsageReport } from './schema'

/**
 * A real, schema-valid report. Illustrative VALUES (a plausible install), but
 * exactly the schema's FIELDS — that is what guard 1 pins.
 */
export const EXAMPLE_USAGE_REPORT: UsageReport = {
  schema: 1,
  installId: '3f9c1a2e-7b4d-4c8f-9e21-5a6b7c8d9e0f',
  version: '1.4.2',
  os: 'linux',
  arch: 'x64',
  installAge: '1-7d',
  machines: '2-5',
  sessions: { 'claude-code': 14, codex: 2 },
  features: { issues: true },
}

/**
 * The hand-formatted rendering shown to humans. Hand-formatted on purpose:
 * aligned keys and the inline `//` note read better than anything
 * `JSON.stringify` produces, and this text is doing persuasion work, not
 * serialization work. Guard 2 keeps the hand-formatting honest.
 *
 * Unindented: the CLI prompt indents it for terminal layout, the web renders it
 * in a <pre>. Callers own their own leading whitespace — see {@link indentExample}.
 *
 * This module has NO runtime imports (the `UsageReport` import above is
 * type-only, erased at compile), which is what lets `apps/web` reach it via the
 * `@podium/telemetry/example` subpath without dragging node:fs into the browser
 * bundle. Note this INVERTS the @podium/runtime convention where the bare
 * specifier is the browser-safe one: here the bare specifier pulls the emitter,
 * the queue and consent, and only this subpath is pure. Keep it that way — the
 * alternative is what we had, three hand-maintained copies of the example that
 * had already drifted apart.
 */
export const EXAMPLE_USAGE_REPORT_DISPLAY = [
  '{',
  '  "schema":    1,',
  // Gutter kept tight on purpose: this line is the longest, and the web renders
  // the same string in a narrow <pre> where a wide gutter pushed the comment
  // off the edge mid-word ("…reset-id to chang"). A trust artifact that appears
  // truncated undercuts the exact thing it is there to do.
  '  "installId": "3f9c1a2e-…",  // random · reset-id to change',
  '  "version":   "1.4.2",',
  '  "os": "linux", "arch": "x64",',
  '  "installAge": "1-7d",',
  '  "machines":   "2-5",',
  '  "sessions":   { "claude-code": 14, "codex": 2 },',
  '  "features":   { "issues": true }',
  '}',
].join('\n')

/** Indent every line — the CLI prompt sits inside an indented block. */
export function indentExample(by = '    '): string {
  return EXAMPLE_USAGE_REPORT_DISPLAY.split('\n')
    .map((l) => by + l)
    .join('\n')
}
