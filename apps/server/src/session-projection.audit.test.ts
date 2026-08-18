import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname)

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })

const FORBIDDEN = [
  /listSessions\(\)\s*\.\s*find\(/,
  /listSessions\(\)\s*\.\s*some\(/,
  /sessionsForIssue\([^)]*listSessions\(\)/,
]

/** Intentional full-world consumers and correct-but-slow fixture fallbacks. */
const FALLBACK_ALLOWLIST: Record<string, string> = {
  'steward.ts': 'supervisory batch cadence intentionally scans the live fleet',
  'modules/issues/registry.ts': 'issue read returns its complete session membership by contract',
  'modules/issues/service/core.ts': 'fallback behind the production listSessionsForIssue port',
  'modules/sessions/session-by-id.ts': 'the shared fallback helper itself',
}

function offenders(source = SRC): string[] {
  const found: string[] = []
  for (const file of walk(source)) {
    const relative = file.slice(source.length + 1)
    if (relative in FALLBACK_ALLOWLIST) continue
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    if (FORBIDDEN.some((pattern) => pattern.test(text))) found.push(relative)
  }
  return found
}

describe('session projection source audit [POD-2322]', () => {
  it('the scanner detects a planted full-list point lookup', () => {
    expect(FORBIDDEN.some((pattern) => pattern.test('x.listSessions().find((s) => s)'))).toBe(true)
  })

  it('production has no unapproved full-list point lookup', () => {
    expect(offenders()).toEqual([])
  })

  it('fallback allowlist entries remain narrow-port fallbacks', () => {
    for (const [relative, reason] of Object.entries(FALLBACK_ALLOWLIST)) {
      const text = readFileSync(join(SRC, relative), 'utf8')
      if (reason.includes('fallback')) {
        expect(text, relative).toMatch(/sessionById|listSessionsForIssue/)
      }
      expect(
        FORBIDDEN.some((pattern) => pattern.test(text)),
        relative,
      ).toBe(true)
    }
  })
})
