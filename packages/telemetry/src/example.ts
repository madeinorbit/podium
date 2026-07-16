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
  features: { issues: true, spec: true, handoff: false },
}

/**
 * The hand-formatted rendering shown to humans. Hand-formatted on purpose:
 * aligned keys and the inline `//` note read better than anything
 * `JSON.stringify` produces, and this text is doing persuasion work, not
 * serialization work. Guard 2 keeps the hand-formatting honest.
 */
export const EXAMPLE_USAGE_REPORT_DISPLAY = [
  '    {',
  '      "schema":    1,',
  '      "installId": "3f9c1a2e-…",        // random · reset-id to change',
  '      "version":   "1.4.2",',
  '      "os": "linux", "arch": "x64",',
  '      "installAge": "1-7d",',
  '      "machines":   "2-5",',
  '      "sessions":   { "claude-code": 14, "codex": 2 },',
  '      "features":   { "issues": true, "spec": true, "handoff": false }',
  '    }',
].join('\n')
