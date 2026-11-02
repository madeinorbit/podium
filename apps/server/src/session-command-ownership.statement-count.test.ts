/**
 * A SESSION COMMAND READS THE OWNERSHIP OF THE MACHINES IT ACTS ON, NOT THE
 * FLEET [POD-6252, server-data rule 8].
 *
 * Every session command used to build its context with the whole fleet's
 * ownership: every machine row, and every grant on every machine. Two
 * statements whatever the fleet's size, so a statement pin alone cannot see it;
 * what grows is the ROWS those two statements hand back. These pins count both,
 * at 5 and at 200 other machines (each with its custody grants):
 *
 *  - `sessions.rename` (the server-data bench's session write) consults no
 *    machine and reads none;
 *  - `sessions.answerAskUserQuestion` on a running session gates `use` on the
 *    session's own machine: a point read of that row and its grants.
 *
 * The legacy arm puts the old eager fleet read back inside the counted window,
 * and each pin must fail on it. This file uses no API the parent commit lacks,
 * so it also runs unchanged on the parent, where it fails the same way.
 */
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { ownershipSnapshotFromMachines } from './machine-access'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import type { SessionStore } from './store'
import { probeStatements, type StatementProbeHolder } from './store/executor/statement-probe'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { quietShipping } from './test-support/statement-count'

/**
 * The pinned counts. Rename: the session row, its write, its change-log entry
 * and the visibility reads behind them; no machine, no grant. Answer: the
 * session's machine row and its grants (one point read each), the
 * open-question lookup and its event. (9 before POD-6150 cached the earliest
 * admin, whose `users` read this command paid.)
 */
const RENAME_STATEMENTS = 10
const ANSWER_STATEMENTS = 8

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  sessionId: string
  superagent: SuperagentService
  call: ReturnType<typeof appRouter.createCaller>
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** One running session on the host, and `size` other machines with an owner. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const owner = firstAdminMemberId()
  for (let i = 0; i < size; i++) {
    await store.machines.upsertMachine({
      id: asMachineId(`mach_other_${i}`),
      name: `Other ${i}`,
      hostname: `other-${i}`,
      tokenHash: `token-${i}`,
      ownerUserId: owner,
      assignment: { server: false, agentExecution: true },
    })
  }
  const cwd = '/repo/w0'
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd })
  await reg.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd,
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  } as never)
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(owner, 'admin'),
  })
  await settle(reg)
  return { store, reg, sessionId, superagent, call }
}

/** Statements and the rows they handed back, per query, for one operation. */
interface Tally {
  statements: number
  rows: number
  byQuery: Map<string, { statements: number; rows: number }>
}

async function tally(store: SessionStore, fn: () => Promise<unknown>): Promise<Tally> {
  const out: Tally = { statements: 0, rows: 0, byQuery: new Map() }
  const detach = probeStatements(store as unknown as StatementProbeHolder, (seen) => {
    out.statements += 1
    out.rows += seen.rows
    const entry = out.byQuery.get(seen.key) ?? { statements: 0, rows: 0 }
    entry.statements += 1
    entry.rows += seen.rows
    out.byQuery.set(seen.key, entry)
  })
  try {
    await fn()
  } finally {
    detach()
  }
  return out
}

function describeTallies(small: Tally, large: Tally): string {
  const keys = new Set([...small.byQuery.keys(), ...large.byQuery.keys()])
  return [...keys]
    .map((key) => {
      const a = small.byQuery.get(key) ?? { statements: 0, rows: 0 }
      const b = large.byQuery.get(key) ?? { statements: 0, rows: 0 }
      const same = a.statements === b.statements && a.rows === b.rows
      return `${same ? ' ' : '!'} ${a.statements}/${a.rows} -> ${b.statements}/${b.rows}  ${key}`
    })
    .sort()
    .join('\n')
}

type Operation = (f: Fixture) => Promise<unknown>

/** The parent's context build: the whole fleet's ownership, read eagerly. */
const legacyFleetRead =
  (operation: Operation): Operation =>
  async (f) => {
    await ownershipSnapshotFromMachines(f.reg.modules.machines)
    return await operation(f)
  }

async function measure(operation: Operation, size: number): Promise<Tally> {
  const f = await fixture(size)
  try {
    return await tally(f.store, async () => {
      await operation(f)
      await settle(f.reg)
    })
  } finally {
    f.superagent.dispose()
    await f.reg.dispose()
    await f.store.close()
  }
}

/** Same statements AND same rows at 5 and 200 other machines, and the pinned count. */
async function expectFleetIndependent(
  name: string,
  operation: Operation,
  statements: number,
): Promise<void> {
  const small = await measure(operation, 5)
  const large = await measure(operation, 200)
  const detail = `${name}: statements/rows at 5 -> 200 machines\n${describeTallies(small, large)}`
  expect(large.rows, detail).toBe(small.rows)
  expect(large.statements, detail).toBe(small.statements)
  expect(small.statements, detail).toBe(statements)
}

const rename: Operation = async (f) =>
  await f.call.sessions.rename({ sessionId: f.sessionId as never, name: 'Renamed' })

const answer: Operation = async (f) =>
  await f.call.sessions.answerAskUserQuestion({
    sessionId: f.sessionId as never,
    choices: [{ optionIndices: [1] }],
  })

describe('session commands read the ownership of their own machine only (POD-6252)', () => {
  it('sessions.rename reads no machine and no grant', async () => {
    await expectFleetIndependent('sessions.rename', rename, RENAME_STATEMENTS)
  })

  it('sessions.rename pin fails on the legacy fleet read', async () => {
    await expect(
      expectFleetIndependent(
        'sessions.rename (legacy fleet read)',
        legacyFleetRead(rename),
        RENAME_STATEMENTS + 2,
      ),
    ).rejects.toThrow(/statements\/rows at 5 -> 200 machines/)
  })

  it("a targeted command reads its session's machine by a point read", async () => {
    await expectFleetIndependent('sessions.answerAskUserQuestion', answer, ANSWER_STATEMENTS)
  })

  it('the targeted pin fails on the legacy fleet read', async () => {
    await expect(
      expectFleetIndependent(
        'sessions.answerAskUserQuestion (legacy fleet read)',
        legacyFleetRead(answer),
        ANSWER_STATEMENTS + 2,
      ),
    ).rejects.toThrow(/statements\/rows at 5 -> 200 machines/)
  })
})
