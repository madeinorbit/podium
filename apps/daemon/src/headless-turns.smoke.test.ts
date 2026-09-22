import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '@podium/harness'
import {
  type HeadlessEmit,
  type HeadlessTurnSpec,
  runHostedHeadlessTurn,
} from '@podium/harness/driver/host'
import type { ResolvedHarnessInventory } from '@podium/harness'
import { asAccountId, asSessionId, type HarnessAgent } from '@podium/model'
import { createDurableProcess } from '@podium/process/durable'
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
import { headlessTurnEnv } from './control/session-env.js'
import { createSessionEngineScope } from './session/engines.js'
import { testHarnessSnapshot } from './test-support/harness-snapshot.js'

/**
 * REAL-BINARY smoke (repo rule from the #84 post-mortem): every constructed
 * agent-CLI invocation gets one run against the actual binary, skipped cleanly
 * when it isn't installed. Here the invariant under test is the Phase-A core:
 * a turn returns the harness session id, and a SECOND turn resumed with that id
 * retains the first turn's context — the harness owns the conversation.
 */
/**
 * One turn the way production runs it (POD-4614): under a REAL podium-host,
 * through the session layer's engine hold, with the daemon's env composition.
 * Each turn gets a fresh session label; a resumed turn is a new session turn
 * on the same harness conversation, exactly as the server sends it.
 */
const engines = createSessionEngineScope(createDurableProcess('host', { host: true, abduco: false }))
let smokeTurns = 0
function runHeadlessTurn(
  spec: Omit<HeadlessTurnSpec, 'durableLabel'>,
  emit: HeadlessEmit,
  harnessSnapshot: ResolvedHarnessInventory,
) {
  const sessionId = asSessionId(randomUUID())
  smokeTurns += 1
  return runHostedHeadlessTurn(
    {
      owner: engines,
      childEnv: (invocation) =>
        headlessTurnEnv({
          agent: spec.agent,
          ...(spec.env ? { specEnv: spec.env } : {}),
          ...invocation,
          commandEnv: harnessSnapshot.commandEnvironment.env,
        }),
    },
    {
      spec: { ...spec, durableLabel: `podium-smoke-${sessionId.slice(0, 8)}` },
      identity: {
        sessionId,
        turnId: `smoke-${smokeTurns}`,
        requestDigest: spec.requestDigest,
        accountId: spec.accountId,
      },
      snapshot: harnessSnapshot,
      emit,
    },
  )
}

const hasBin = (bin: string): boolean => {
  try {
    execFileSync(bin, ['--version'], {
      timeout: AGENT_VERSION_PROBE_TIMEOUT_MS,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

const snapshot = testHarnessSnapshot({
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  opencode: resolveOpencodeBin(),
  cursor: resolveCursorBin(),
  pi: 'pi',
})
const identity = (agent: HarnessAgent) => ({
  accountId: asAccountId(`native:${agent}:smoke`),
  requestDigest: 'a'.repeat(64),
})
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
          ...identity('claude-code'),
          cwd,
          prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
          permissionMode: 'bypassPermissions',
          sessionUuid,
          timeoutMs: 240_000,
        },
        (e) => events.push(e),
        snapshot,
      )
      const r1 = await turn1.done
      expect(r1.harnessSessionId).toBe(sessionUuid)
      expect(r1.output.length).toBeGreaterThan(0)
      // includePartialMessages must produce at least one cumulative partial.
      expect(events.some((e) => e.kind === 'partial-text' && e.text.length > 0)).toBe(true)

      const turn2 = runHeadlessTurn(
        {
          agent: 'claude-code',
          ...identity('claude-code'),
          cwd,
          prompt: 'What was the token I asked you to remember? Reply with just the token.',
          permissionMode: 'bypassPermissions',
          resumeValue: r1.harnessSessionId,
          timeoutMs: 240_000,
        },
        () => {},
        snapshot,
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
          ...identity('codex'),
          cwd,
          prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
          timeoutMs: 240_000,
        },
        (e) => events.push(e),
        snapshot,
      )
      const r1 = await turn1.done
      expect(r1.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(r1.output.length).toBeGreaterThan(0)
      expect(events.some((e) => e.kind === 'partial-text')).toBe(true)

      const turn2 = runHeadlessTurn(
        {
          agent: 'codex',
          ...identity('codex'),
          cwd,
          prompt: 'What was the token I asked you to remember? Reply with just the token.',
          resumeValue: r1.harnessSessionId,
          timeoutMs: 240_000,
        },
        () => {},
        snapshot,
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
  {
    agent: 'pi' as const,
    label: 'pi',
    // `pi` is a tiny name; the help banner proves this is the coding agent.
    available: hasBin('pi') && piHelpIsCodingAgent(),
    tokenPrefix: 'ORYX',
  },
]

function piHelpIsCodingAgent(): boolean {
  try {
    return /\bpi - AI coding assistant\b/.test(
      execFileSync('pi', ['--help'], { timeout: 15_000, stdio: 'pipe' }).toString(),
    )
  } catch {
    return false
  }
}

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
            ...identity(smoke.agent),
            cwd,
            prompt: `Remember this token: ${token}. Reply with just the word "stored".`,
            timeoutMs: 240_000,
          },
          () => {},
          snapshot,
        )
        const r1 = await first.done
        expect(r1.harnessSessionId.length).toBeGreaterThan(0)
        expect(r1.output.length).toBeGreaterThan(0)

        const resumed = runHeadlessTurn(
          {
            agent: smoke.agent,
            ...identity(smoke.agent),
            cwd,
            prompt: 'What was the token I asked you to remember? Reply with just the token.',
            resumeValue: r1.harnessSessionId,
            timeoutMs: 240_000,
          },
          () => {},
          snapshot,
        )
        const r2 = await resumed.done
        expect(r2.harnessSessionId).toBe(r1.harnessSessionId)
        expect(r2.output).toContain(token)
      }, 500_000)
    },
  )
}
