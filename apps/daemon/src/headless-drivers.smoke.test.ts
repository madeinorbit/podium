import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import {
  isCursorCliAvailable,
  resolveCursorBin,
  validateCursorCliHelp,
} from '../../../packages/harness/src/cursor/cli.js'
import {
  isOpencodeCliAvailable,
  resolveOpencodeBin,
} from '../../../packages/harness/src/opencode/cli.js'
import type { HarnessBins } from './harness-exec.js'
import { runHeadlessTurn } from './headless-drivers.js'

/**
 * REAL-BINARY smoke (repo rule from the #84 post-mortem): every constructed
 * agent-CLI invocation gets one run against the actual binary, skipped cleanly
 * when it isn't installed. Here the invariant under test is the Phase-A core:
 * a turn returns the harness session id, and a SECOND turn resumed with that id
 * retains the first turn's context — the harness owns the conversation.
 */
const hasBin = (bin: string): boolean => {
  try {
    execFileSync(bin, ['--version'], { timeout: 15_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const bins: HarnessBins = { opencode: resolveOpencodeBin, cursor: resolveCursorBin }
const dirs: string[] = []
const tempCwd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-headless-smoke-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBin('claude'))(
  '[real-agent:claude] ClaudeSdkDriver real-binary smoke',
  () => {
    it('runs two turns; turn 2 resumes and recalls a turn-1 token; partials stream', async () => {
      const cwd = tempCwd()
      const sessionUuid = randomUUID()
      const token = `ZEBRA-${Math.floor(Math.random() * 100000)}`
      const events: HeadlessTurnEvent[] = []
      const turn1 = runHeadlessTurn(
        {
          agent: 'claude-code',
          cwd,
          prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
          permissionMode: 'bypassPermissions',
          sessionUuid,
          timeoutMs: 240_000,
        },
        (e) => events.push(e),
        bins,
      )
      const r1 = await turn1.done
      expect(r1.harnessSessionId).toBe(sessionUuid)
      expect(r1.output.length).toBeGreaterThan(0)
      // includePartialMessages must produce at least one cumulative partial.
      expect(events.some((e) => e.kind === 'partial-text' && e.text.length > 0)).toBe(true)

      const turn2 = runHeadlessTurn(
        {
          agent: 'claude-code',
          cwd,
          prompt: 'What was the token I asked you to remember? Reply with just the token.',
          permissionMode: 'bypassPermissions',
          resumeValue: r1.harnessSessionId,
          timeoutMs: 240_000,
        },
        () => {},
        bins,
      )
      const r2 = await turn2.done
      expect(r2.harnessSessionId).toBe(sessionUuid)
      expect(r2.output).toContain(token)
    }, 500_000)
  },
)

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBin('codex'))(
  '[real-agent:codex] CodexExecDriver real-binary smoke',
  () => {
    it('runs two turns; captures the thread id; `exec resume` retains context', async () => {
      const cwd = tempCwd()
      const token = `YAK-${Math.floor(Math.random() * 100000)}`
      const events: HeadlessTurnEvent[] = []
      const turn1 = runHeadlessTurn(
        {
          agent: 'codex',
          cwd,
          prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
          timeoutMs: 240_000,
        },
        (e) => events.push(e),
        bins,
      )
      const r1 = await turn1.done
      expect(r1.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(r1.output.length).toBeGreaterThan(0)
      expect(events.some((e) => e.kind === 'partial-text')).toBe(true)

      const turn2 = runHeadlessTurn(
        {
          agent: 'codex',
          cwd,
          prompt: 'What was the token I asked you to remember? Reply with just the token.',
          resumeValue: r1.harnessSessionId,
          timeoutMs: 240_000,
        },
        () => {},
        bins,
      )
      const r2 = await turn2.done
      expect(r2.harnessSessionId).toBe(r1.harnessSessionId)
      expect(r2.output).toContain(token)
    }, 500_000)
  },
)

const resumeExecCases = [
  {
    agent: 'opencode' as const,
    label: 'opencode',
    available: isOpencodeCliAvailable(),
    tokenPrefix: 'IBIS',
  },
  {
    agent: 'cursor' as const,
    label: 'cursor',
    // `agent` is a generic executable name also used by Grok. The help marker
    // proves this is Cursor before the smoke spends a real turn on it.
    available: isCursorCliAvailable() && validateCursorCliHelp(),
    tokenPrefix: 'LYNX',
  },
  {
    agent: 'grok' as const,
    label: 'grok',
    available: hasBin('grok'),
    tokenPrefix: 'NEWT',
  },
]

for (const smoke of resumeExecCases) {
  describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !smoke.available)(
    `[real-agent:${smoke.label}] ${smoke.label} resume-exec real-binary smoke`,
    () => {
      // Cursor preserves its workspace-trust boundary in headless mode; use the
      // runner checkout that the operator chose to trust, not a fresh temp directory.
      it('runs a turn and resumes the same session with its context intact', async () => {
        const cwd = smoke.agent === 'cursor' ? process.cwd() : tempCwd()
        const token = `${smoke.tokenPrefix}-${Math.floor(Math.random() * 100000)}`
        const first = runHeadlessTurn(
          {
            agent: smoke.agent,
            cwd,
            prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
            timeoutMs: 240_000,
          },
          () => {},
          bins,
        )
        const r1 = await first.done
        expect(r1.harnessSessionId.length).toBeGreaterThan(0)
        expect(r1.output.length).toBeGreaterThan(0)

        const resumed = runHeadlessTurn(
          {
            agent: smoke.agent,
            cwd,
            prompt: 'What was the token I asked you to remember? Reply with just the token.',
            resumeValue: r1.harnessSessionId,
            timeoutMs: 240_000,
          },
          () => {},
          bins,
        )
        const r2 = await resumed.done
        expect(r2.harnessSessionId).toBe(r1.harnessSessionId)
        expect(r2.output).toContain(token)
      }, 500_000)
    },
  )
}
