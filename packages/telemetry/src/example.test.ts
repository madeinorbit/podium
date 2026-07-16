/**
 * Guards for the example report [spec:SP-f933].
 *
 * Why this file exists: the first version of the example (defined in apps/cli,
 * where nothing could test it) advertised `"sessions": { "claude": 14 }`. There
 * is no `claude` AgentKind — the wire says `claude-code`. Every new user read
 * that prompt, and it misdescribed the payload it claimed to be showing.
 *
 * The example is a promise about the wire. These tests make it a checked one.
 */
import { describe, expect, it } from 'vitest'
import { EXAMPLE_USAGE_REPORT, EXAMPLE_USAGE_REPORT_DISPLAY } from './example'
import { UsageReport } from './schema'

describe('the example usage report', () => {
  it('is a report the schema actually accepts', () => {
    // `.strict()` — a stale field the schema dropped fails here too.
    expect(() => UsageReport.parse(EXAMPLE_USAGE_REPORT)).not.toThrow()
  })

  it('uses real AgentKind session keys, not friendly names', () => {
    // The original bug, pinned: 'claude' is not an AgentKind.
    const parsed = UsageReport.parse(EXAMPLE_USAGE_REPORT)
    expect(Object.keys(parsed.sessions).length).toBeGreaterThan(0)
    expect(Object.keys(parsed.sessions)).not.toContain('claude')
  })

  it('shows every field the schema can send', () => {
    // Adding a field to UsageReport must force the display to change: a user who
    // reads the prompt should not later find a field they were never shown.
    for (const field of Object.keys(UsageReport.shape)) {
      expect(
        EXAMPLE_USAGE_REPORT_DISPLAY,
        `the example display omits the schema field "${field}"`,
      ).toContain(`"${field}"`)
    }
  })

  it('shows no field the schema cannot send', () => {
    // The reverse drift: an example that promises a field we removed.
    const shown = [...EXAMPLE_USAGE_REPORT_DISPLAY.matchAll(/"([A-Za-z][\w-]*)":/g)].map(
      (m) => m[1],
    )
    const allowed = new Set<string>([
      ...Object.keys(UsageReport.shape),
      ...Object.keys(EXAMPLE_USAGE_REPORT.sessions),
      ...Object.keys(EXAMPLE_USAGE_REPORT.features),
    ])
    for (const key of shown) {
      expect(allowed.has(key), `the example display invents the field "${key}"`).toBe(true)
    }
  })

  it('displays the same values it claims to parse', () => {
    // Cheap coherence check between the typed object and the hand-formatted text
    // (the two can drift independently — that is the cost of hand-formatting).
    expect(EXAMPLE_USAGE_REPORT_DISPLAY).toContain(`"${EXAMPLE_USAGE_REPORT.version}"`)
    expect(EXAMPLE_USAGE_REPORT_DISPLAY).toContain(`"${EXAMPLE_USAGE_REPORT.installAge}"`)
    expect(EXAMPLE_USAGE_REPORT_DISPLAY).toContain(`"${EXAMPLE_USAGE_REPORT.machines}"`)
    for (const kind of Object.keys(EXAMPLE_USAGE_REPORT.sessions)) {
      expect(EXAMPLE_USAGE_REPORT_DISPLAY).toContain(`"${kind}"`)
    }
  })
})
