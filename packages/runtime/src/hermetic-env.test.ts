import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertHermeticStateDir } from '../../../test-hermetic-state-guard'
import { hermeticChildEnv } from '../../../test-hermetic-env'
import { resolveAgentRelay } from './config'

/**
 * Proves the hermetic test harness (test-hermetic-env.ts, wired as vitest `setupFiles`)
 * actually ran for this file — i.e. a suite launched from inside a live agent session is
 * insulated from the live instance. [spec:SP-b85a] (POD-555)
 */
describe('hermetic test env', () => {
  it('scrubs the ambient Podium agent-session env', () => {
    expect(process.env.PODIUM_AGENT_RELAY).toBeUndefined()
    expect(process.env.PODIUM_ISSUE_RELAY).toBeUndefined()
    expect(process.env.PODIUM_SESSION_ID).toBeUndefined()
    expect(process.env.PODIUM_PORT).toBeUndefined()
  })

  it('forces operator mode — resolveAgentRelay() reads undefined from the live env', () => {
    expect(process.env.PODIUM_NO_RELAY).toBe('1')
    expect(resolveAgentRelay()).toBeUndefined()
  })

  it('points state at a throwaway dir, never the live ~/.podium', () => {
    expect(process.env.PODIUM_STATE_DIR).toBeTruthy()
    expect(process.env.PODIUM_STATE_DIR).not.toMatch(/\.podium(\/|$)/)
  })

  it('removes the live ~/.podium tree from command lookup', () => {
    const liveStateDir = resolve(join(homedir(), '.podium'))
    const pathEntries = (process.env.PATH ?? '').split(delimiter).map((entry) => resolve(entry))
    expect(
      pathEntries.some((entry) => entry === liveStateDir || entry.startsWith(`${liveStateDir}${sep}`)),
    ).toBe(false)
  })

  it('refuses an unset or live state root', () => {
    const liveStateDir = resolve(join(homedir(), '.podium'))
    expect(() => assertHermeticStateDir({}, liveStateDir)).toThrow(/PODIUM_STATE_DIR is required/)
    expect(() =>
      assertHermeticStateDir({ PODIUM_STATE_DIR: liveStateDir }, liveStateDir),
    ).toThrow(/must not use the live state tree/)
    expect(() =>
      assertHermeticStateDir({ PODIUM_STATE_DIR: join(liveStateDir, 'child') }, liveStateDir),
    ).toThrow(/must not use the live state tree/)
  })
})

describe('hermetic child env', () => {
  it('passes the scrubbed environment to a real child process', () => {
    const env = hermeticChildEnv({
      PODIUM_TEST_CHILD_ENV_SENTINEL: 'hermetic-child-env',
    })
    const probe = [
      'process.stdout.write(JSON.stringify({',
      '  agentRelay: process.env.PODIUM_AGENT_RELAY ?? null,',
      '  issueRelay: process.env.PODIUM_ISSUE_RELAY ?? null,',
      '  sessionId: process.env.PODIUM_SESSION_ID ?? null,',
      '  port: process.env.PODIUM_PORT ?? null,',
      '  noRelay: process.env.PODIUM_NO_RELAY ?? null,',
      '  stateDir: process.env.PODIUM_STATE_DIR ?? null,',
      '  tmpDir: process.env.TMPDIR ?? null,',
      '  path: process.env.PATH ?? null,',
      '  sentinel: process.env.PODIUM_TEST_CHILD_ENV_SENTINEL ?? null,',
      '}))',
    ].join('\n')
    const observed = JSON.parse(
      execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env }),
    ) as Record<string, string | null>

    expect(observed).toEqual({
      sentinel: 'hermetic-child-env',
      agentRelay: null,
      issueRelay: null,
      sessionId: null,
      port: null,
      noRelay: '1',
      stateDir: env.PODIUM_STATE_DIR,
      tmpDir: env.TMPDIR,
      path: env.PATH,
    })
  })
  it('writes file-backed evidence for new, overwritten, and deleted values', () => {
    const configuredOutput = process.env.PODIUM_HERMETIC_PROBE_OUTPUT
    const outputDir = configuredOutput ? undefined : mkdtempSync(join(tmpdir(), 'podium-env-probe-'))
    const outputFile = configuredOutput ?? join(outputDir!, 'child-env.json')
    const newKey = 'PODIUM_HERMETIC_NEW'
    const existingKey = 'PODIUM_HERMETIC_EXISTING'
    try {
      vi.stubEnv(newKey, 'from-parent')
      vi.stubEnv(existingKey, 'overwritten-parent')
      vi.stubEnv('LANG', undefined)
      const env = hermeticChildEnv()
      const parent = {
        newValue: env[newKey] ?? '',
        existingValue: env[existingKey] ?? '',
        deletedValue: env.LANG ?? '',
      }
      const probe = [
        "const { writeFileSync } = require('node:fs')",
        `writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({`,
        `  newValue: process.env.${newKey} ?? '',`,
        `  existingValue: process.env.${existingKey} ?? '',`,
        "  deletedValue: process.env.LANG ?? '',",
        '}))',
      ].join('\n')
      execFileSync(process.execPath, ['-e', probe], { stdio: 'ignore', env })
      const child = JSON.parse(readFileSync(outputFile, 'utf8')) as typeof parent
      const evidence = { parent, child }
      if (configuredOutput) writeFileSync(outputFile, JSON.stringify(evidence))
      expect(child).toEqual(parent)
      expect(child).toEqual({
        newValue: 'from-parent',
        existingValue: 'overwritten-parent',
        deletedValue: '',
      })
    } finally {
      vi.unstubAllEnvs()
      if (outputDir) rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
