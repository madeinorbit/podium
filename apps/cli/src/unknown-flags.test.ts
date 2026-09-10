import { describe, expect, it, vi } from 'vitest'
import { runAgentCli } from './agent-cli'
import { authCliMain } from './auth-cli'
import { resolvePlan, unknownLaunchToken } from './cli'
import { parseExportCrashArgs, parseLogsArgs } from './cli-lifecycle'
import { parseInstallFinishArgs } from './install-finish'
import { instanceCliMain } from './instance-cli'
import { runInteractionsCommand } from './interactions-cli'
import { runIssueCli } from './issue-cli'
import { runLockCli } from './lock-cli'
import { parseLogsDaemonArgs } from './logs-daemon-cli'
import { parseLogsLevelArgs } from './logs-level-cli'
import { runMachineCli } from './machine-cli'
import { runMailCli } from './mail-cli'
import { runOfferCli } from './offer-cli'
import { runPerfCli } from './perf-cli'
import { runQuotaCli } from './quota-cli'
import { runSessionCli } from './session-cli'
import { runSpecCli } from './spec-cli'
import { telemetryCliMain } from './telemetry-cli'
import { updateKeyCliMain } from './update-key-cli'
import { runWorkflowCli } from './workflow-cli'
import { runWorkspaceCli } from './workspace-cli'
import { runWorktreeCli } from './worktree-cli'

/**
 * THE ROSTER TRIPWIRE (POD-3836).
 *
 * One case per `podium` subcommand: hand it a flag that exists nowhere and
 * require the failure to NAME it. That is the whole issue in one assertion —
 * before this, most of these accepted the flag, dropped it, and did the default
 * thing, so a caller could not tell a no-op from a success (POD-339).
 *
 * It is a ROSTER rather than a set of scattered cases because the defect was
 * uniform: fourteen hand-rolled argv loops, each of which had to remember to
 * refuse. A new subcommand that forgets is not caught by any of its own tests —
 * a test nobody wrote cannot fail — so the guard has to live where the absence
 * is visible. `EVERY_SUBCOMMAND` below is checked against the dispatcher's own
 * list at the bottom of this file, which is what makes "every" true rather than
 * "every one we remembered".
 *
 * Each entry returns the message the CLI produced, however that CLI reports
 * failure (throw, exit code + io, or a returned plan) — the roster is about
 * WHETHER the flag was refused, not about how each surface spells refusal.
 */

const BOGUS = '--zzznotaflag'

const noopClient = new Proxy(
  {},
  {
    get: () => new Proxy({}, { get: () => vi.fn(async () => ({}) as unknown) }),
  },
) as never

/** Run `fn`, returning whatever message it failed with (or '' if it did not). */
async function failureOf(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    const out = await fn()
    return typeof out === 'string' ? out : JSON.stringify(out ?? '')
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Collect what a CLI that reports through an io object printed. */
function ioRecorder(): {
  io: { print(s: string): void; printErr(s: string): void; error(s: string): void }
  text(): string
} {
  const lines: string[] = []
  const push = (s: string): void => {
    lines.push(s)
  }
  return {
    io: { print: push, printErr: push, error: push },
    text: () => lines.join('\n'),
  }
}

const plan = (argv: string[]): unknown => resolvePlan({}, argv, {}, false)

/**
 * Every `podium` subcommand, and how to hand it an undeclared flag.
 *
 * The argv in each case is otherwise WELL FORMED — a valid command with its
 * required arguments — so the only thing left to object to is the bogus flag.
 * A case that failed for a missing argument instead would pass this suite while
 * proving nothing.
 */
const EVERY_SUBCOMMAND: ReadonlyArray<readonly [string, () => Promise<string>]> = [
  ['issue', () => failureOf(() => runIssueCli(['show', '--id', '5', BOGUS], noopClient))],
  ['spec', () => failureOf(() => runSpecCli(['show', 'SP-1', BOGUS], noopClient))],
  ['lock', () => failureOf(() => runLockCli(['status', '--repoPath', '/r', BOGUS], noopClient))],
  [
    'merge-lock',
    () =>
      failureOf(() =>
        runLockCli(['status', '--repoPath', '/r', BOGUS], noopClient, { group: 'merge-lock' }),
      ),
  ],
  ['mail', () => failureOf(() => runMailCli(['inbox', BOGUS], noopClient))],
  [
    'agent',
    () =>
      failureOf(() => runAgentCli(['spawn', '--issue', '#1', '--prompt', 'go', BOGUS], noopClient)),
  ],
  ['offer', () => failureOf(() => runOfferCli(['--message', 'hi', BOGUS], noopClient))],
  ['session', () => failureOf(() => runSessionCli(['status', 's1', BOGUS], noopClient))],
  [
    'workflow',
    () => failureOf(() => runWorkflowCli(['status', BOGUS], { client: noopClient, cwd: '/r' })),
  ],
  [
    'worktree',
    () => failureOf(() => runWorktreeCli([BOGUS], { relayEndpoint: 'http://x/1', cwd: '/r' })),
  ],
  [
    'workspace',
    () => failureOf(() => runWorkspaceCli(['clean', BOGUS], { relayEndpoint: 'http://x/1' })),
  ],
  ['perf', () => failureOf(() => runPerfCli(['level', BOGUS]))],
  ['interactions', () => failureOf(() => runInteractionsCommand(['list', BOGUS], noopClient))],
  ['auth', () => failureOf(() => authCliMain(['sessions', BOGUS], ioRecorder().io))],
  ['machine', () => failureOf(() => runMachineCli(['list', BOGUS], noopClient))],
  ['quota', () => failureOf(() => runQuotaCli([BOGUS], noopClient))],
  [
    'telemetry',
    async () => {
      const rec = ioRecorder()
      telemetryCliMain(['show', BOGUS], rec.io)
      return rec.text()
    },
  ],
  [
    'instance',
    async () => {
      const rec = ioRecorder()
      instanceCliMain(['rekey', BOGUS], rec.io)
      return rec.text()
    },
  ],
  ['logs', () => failureOf(() => parseLogsArgs([BOGUS]))],
  ['logs export-crash', () => failureOf(() => parseExportCrashArgs([BOGUS]))],
  ['logs level', () => failureOf(() => parseLogsLevelArgs(['level', 'debug', BOGUS]))],
  [
    'logs daemon-level',
    () => failureOf(() => parseLogsDaemonArgs(['daemon-level', 'debug', BOGUS])),
  ],
  ['update', async () => JSON.stringify(plan(['update', BOGUS]))],
  ['channel', async () => JSON.stringify(plan(['channel', 'edge', BOGUS]))],
  ['status', async () => JSON.stringify(plan(['status', BOGUS]))],
  ['stop', async () => JSON.stringify(plan(['stop', BOGUS]))],
  ['set-server', async () => JSON.stringify(plan(['set-server', 'wss://h', BOGUS]))],
  ['join-config', async () => JSON.stringify(plan(['join-config', 'TOKEN', BOGUS]))],
  [
    'server-transfer-promote',
    async () => JSON.stringify(plan(['server-transfer-promote', 't1', BOGUS])),
  ],
  [
    'server-transfer-retire-daemon',
    async () => JSON.stringify(plan(['server-transfer-retire-daemon', BOGUS])),
  ],
  ['janitor', async () => JSON.stringify(plan(['janitor', BOGUS]))],
  // The launch path: mode subcommands and a bare `podium` are guarded by
  // `unknownLaunchToken`, not by a per-command table.
  ['launch path', async () => unknownLaunchToken(['server', BOGUS]) ?? ''],
  [
    'approval',
    async () =>
      JSON.stringify(
        resolvePlan(
          {},
          ['approval', 'status', 'a1', BOGUS],
          {
            PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
          },
          false,
        ),
      ),
  ],
  [
    'automation',
    async () =>
      JSON.stringify(
        resolvePlan(
          {},
          ['automation', 'schedule', '--at', '2026-01-01T00:00:00Z', '--message', 'x', BOGUS],
          {
            PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
          },
          false,
        ),
      ),
  ],
  [
    'install-finish',
    async () => {
      const out = parseInstallFinishArgs(['--dest', '/d', '--bin', '/b', BOGUS], {})
      return 'error' in out ? out.error : ''
    },
  ],
  [
    'update-key',
    async () => {
      const errs: string[] = []
      const original = console.error
      console.error = (s: unknown) => errs.push(String(s))
      try {
        // Exit 2 with the usage text: `update-key` matches its forms exactly, so
        // a bogus flag falls through to the usage rather than being ignored.
        return updateKeyCliMain(['rotate', BOGUS]) === 0 ? '' : errs.join('\n') || 'usage'
      } finally {
        console.error = original
      }
    },
  ],
]

describe('every podium subcommand refuses an undeclared flag', () => {
  it.each(EVERY_SUBCOMMAND)('%s', async (_name, refuse) => {
    const message = await refuse()
    expect(message).not.toBe('')
    expect(message).toContain(BOGUS)
  })
})

describe('the roster covers the dispatcher', () => {
  /**
   * The launch path (mode subcommands and a bare `podium`) is guarded by
   * `unknownLaunchToken` rather than by a per-command table, and has its own
   * case in the roster. Listed here so the exclusion is a decision on the page
   * rather than a gap.
   */
  const LAUNCH_PATH = new Set([
    'all',
    'all-in-one',
    'daemon',
    'client',
    'server',
    'supervisor',
    'setup',
    'parent',
  ])
  /** Not commands: the informational tokens `resolveStateFreeInformationalPlan` answers. */
  const INFORMATIONAL = new Set(['help', 'version', '--version', '-v'])

  it('names every subcommand the dispatcher branches on', async () => {
    // Derived from cli.ts's own source, so a subcommand added tomorrow shows up
    // here as a missing roster entry rather than as silence. A roster that
    // listed only what someone remembered would be the same defect this issue
    // is about, one level up.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
    const dispatched = new Set(
      [...source.matchAll(/argv\[0\] === '([a-z][a-z-]*)'/g)].map((m) => m[1] as string),
    )
    const covered = new Set(EVERY_SUBCOMMAND.map(([name]) => name.split(' ')[0] as string))
    const uncovered = [...dispatched]
      .filter((name) => !LAUNCH_PATH.has(name) && !INFORMATIONAL.has(name))
      .filter((name) => !covered.has(name))
      .sort()
    expect(uncovered).toEqual([])
  })

  it('is derived from a source read that actually found the dispatcher', async () => {
    // The instrument, verified: a regex that matched nothing would make the
    // check above pass for every possible roster.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
    const dispatched = [...source.matchAll(/argv\[0\] === '([a-z][a-z-]*)'/g)]
    expect(dispatched.length).toBeGreaterThan(20)
  })
})
