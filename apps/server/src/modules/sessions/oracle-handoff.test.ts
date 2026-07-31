import { asSessionId, FIRST_ADMIN_USER_ID, type RepoId, type SessionId } from '@podium/model'
/**
 * ORACLE — session handoff across two machines (POD-379 for POD-642).
 *
 * Handoff is the one session write that moves a session between machines, and
 * the one whose failure modes are expensive: a half-transferred session is a
 * lost conversation. What is pinned here is the ORDER of the irreversible steps
 * (nothing is stopped until every pre-flight passed), the rollback contract on
 * a mid-transfer failure, the worktree-reuse guard, and the bundle-base refusal
 * that the d73e9121 bug class produced.
 *
 * TOPOLOGY NOTE. The issue brief asks for the POD-498 isolated harness
 * (tests/e2e/iso-handoff-host.ts + iso-handoff-daemon.ts). That harness needs a
 * SECOND REAL MACHINE reachable over the tailnet and is a hand-driven script,
 * not a lane — it cannot run in the hermetic unit lane and there is no human in
 * this run to drive it. These tests instead run two paired machines with
 * SCRIPTED daemons against the real SessionsService, which is where the
 * orchestration being characterized actually lives (the daemons only answer
 * export/import/repoOp RPCs). The real-hardware transfer path — bundle apply,
 * git worktree add, credential install — stays the iso harness's job.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, type MachineId } from '@podium/model'
import type { ControlMessage, UserId } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { userCommandPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { machineUseGateFor } from './handoff/access'
import { SessionStore } from '../../store'
import { MUST_NOT_CHANGE, messageOf, waitFor, willChange } from './oracle-support'

const TEST_CAPABILITY = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin').capability

const SHA = 'a'.repeat(40)

type FixtureMachine = 'm1' | 'm2' | 'm3'

interface TimelineEvent {
  machine: FixtureMachine
  type: ControlMessage['type']
  msg: ControlMessage
}

interface HandoffFixture {
  reg: SessionRegistry
  store: SessionStore
  source: ControlMessage[]
  target: ControlMessage[]
  /** ONE ordered stream across BOTH machines — cross-machine ordering claims
   *  (nothing is stopped before the target verified a base) are only assertable
   *  against a shared timeline, never against two per-machine arrays. */
  timeline: TimelineEvent[]
  /** Position of the first `machine:type` event, or -1. */
  at(machine: FixtureMachine, type: ControlMessage['type']): number
  /** How many `machine:type` events happened. */
  count(machine: FixtureMachine, type: ControlMessage['type']): number
  sessionId: SessionId
}

const built: SessionRegistry[] = []
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-oracle-handoff-'))
})

afterEach(() => {
  for (const reg of built.splice(0)) reg.dispose()
  if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = priorStateDir
})

/**
 * Two paired machines (m1 source, m2 target) with scripted daemons, and one
 * resumable claude-code session living in a worktree on m1.
 */
async function handoffFixture(
  opts: {
    failExport?: boolean
    targetHasBase?: boolean
    /** Fires when the SOURCE receives the export request — i.e. after the kill and
     *  before the import leg. The window a mid-transfer revocation lands in. */
    onExport?: () => void
    /** Fires when the TARGET is asked to prove a bundle base — i.e. after the
     *  dispatch-time checks passed and BEFORE anything irreversible. A hook rather
     *  than a re-attached daemon on purpose: a hand-written stand-in that answers
     *  only the probe leaves the later legs unanswered, so a mutant that removes
     *  the pre-kill re-check HANGS to a test timeout instead of failing on its
     *  assertion — the POD-379 round-4 failure mode, in a file that has to stay
     *  sharp because two of its tests exist to catch exactly that mutant. */
    onTargetProbe?: () => void
  } = {},
): Promise<HandoffFixture> {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({
    id: 'm1',
    name: 'source',
    hostname: 'source',
    tokenHash: 'x',
    ownerUserId: 'user:sole',
  })
  store.machines.upsertMachine({
    id: 'm2',
    name: 'target',
    hostname: 'target',
    tokenHash: 'y',
    ownerUserId: 'user:sole',
  })
  const inventory = JSON.stringify({
    os: 'linux',
    arch: 'x64',
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
    tools: [],
  })
  store.machines.setMachineInventory('m1', inventory)
  store.machines.setMachineInventory('m2', inventory)
  store.repos.addRepo('/source/repo', 'm1', 'git@github.com:example/repo.git')
  store.repos.addRepo('/target/repo', 'm2', 'git@github.com:example/repo.git')
  const reg = new SessionRegistry(store)
  built.push(reg)

  const source: ControlMessage[] = []
  const target: ControlMessage[] = []
  const timeline: TimelineEvent[] = []
  reg.gateway.attachDaemon('m1', (msg) => {
    source.push(msg)
    timeline.push({ machine: 'm1', type: msg.type, msg })
    if (msg.type === 'repoOpRequest') {
      const ok = msg.args?.ref === 'main'
      reg.gateway.routeDaemonFrame('m1', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok,
        output: ok ? SHA : 'missing',
      })
    }
    if (msg.type === 'handoffExportRequest') {
      opts.onExport?.()
      reg.gateway.routeDaemonFrame(
        'm1',
        opts.failExport
          ? {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: false,
              error: 'source exploded mid-export',
            }
          : {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: true,
              stagePath: '/source/.podium/handoff/package.tgz',
              sizeBytes: 3,
              manifest: {
                format: 1,
                sessionId: msg.sessionId,
                agentKind: 'claude-code',
                resume: { kind: 'claude-session', value: 'native-id' },
                transcriptFilename: 'native-id.jsonl',
                repoId: store.repos.listRepos('m1')[0]?.repoId as RepoId,
                branch: 'x',
                headSha: SHA,
                snapshotSha: null,
                snapshotFlattened: true,
                worktreeName: 'x',
                worktreeRelativePath: '.worktrees/x',
                bundleBase: [SHA],
                sourceMachineId: 'm1',
                exportedAt: new Date().toISOString(),
              },
            },
      )
    }
    if (msg.type === 'handoffChunkReadRequest')
      reg.gateway.routeDaemonFrame('m1', {
        type: 'handoffChunkReadResult',
        requestId: msg.requestId,
        ok: true,
        data: Buffer.from('pkg').toString('base64'),
        sizeBytes: 3,
        eof: true,
      })
  })
  reg.gateway.attachDaemon('m2', (msg) => {
    target.push(msg)
    timeline.push({ machine: 'm2', type: msg.type, msg })
    if (msg.type === 'repoOpRequest') {
      // The bundle-base handshake: the target proves which of the source's SHAs
      // it already has. `targetHasBase: false` is the d73e9121 shape — a target
      // that shares no verified commit with the source.
      opts.onTargetProbe?.()
      const ok = opts.targetHasBase === false ? false : msg.args?.ref === SHA
      reg.gateway.routeDaemonFrame('m2', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok,
        output: ok ? SHA : 'missing',
      })
    }
    if (msg.type === 'handoffImportChunk')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'handoffImportChunkResult',
        requestId: msg.requestId,
        ok: true,
        sizeBytes: msg.offset + Buffer.from(msg.data, 'base64').length,
      })
    if (msg.type === 'handoffImportRequest')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'handoffImportResult',
        requestId: msg.requestId,
        ok: true,
        newCwd: '/target/repo/.worktrees/x',
        worktreeRoot: '/target/repo/.worktrees/x',
      })
  })

  const { sessionId } = await reg.modules.sessions.resumeSession({
    agentKind: 'claude-code',
    cwd: '/source/repo/.worktrees/x',
    resume: { kind: 'claude-session', value: 'native-id' },
    conversationId: 'native-id',
    machineId: 'm1',
  })
  timeline.length = 0
  source.length = 0
  target.length = 0
  return {
    reg,
    store,
    source,
    target,
    timeline,
    at: (machine, type) => timeline.findIndex((e) => e.machine === machine && e.type === type),
    count: (machine, type) =>
      timeline.filter((e) => e.machine === machine && e.type === type).length,
    sessionId,
  }
}

const meta = (f: HandoffFixture) =>
  f.reg.modules.sessions.listSessions().find((s) => s.sessionId === f.sessionId)

/**
 * An ownership index that answers for a two-person fleet — POD-381's
 * `MachineOwnershipIndex`, hand-built rather than derived from the machines table,
 * because today's table resolves EVERY row to the one instance account and a
 * second human is therefore not expressible through it yet. This is the only way
 * to test the scoping rather than merely ship it; POD-1079 replaces the source of
 * these rows, not the rules that read them.
 */
const twoPersonFleet = (m2Grants: { subject: string; verb: 'see' | 'use' | 'manage' }[]) => ({
  rowFor: (machineId: string) =>
    machineId === 'm1'
      ? { machine: 'm1' as MachineId, owner: 'alice' as UserId, grants: [], name: 'source' }
      : machineId === 'm2'
        ? {
            machine: 'm2' as MachineId,
            owner: 'bob' as UserId,
            grants: m2Grants.map((grant) => ({
              subject: grant.subject as UserId,
              verb: grant.verb,
            })),
            name: 'target',
          }
        : undefined,
})

/**
 * The same fleet, but with m2's grants read LIVE from a mutable holder — so a test
 * can revoke a grant part-way through a transfer. This is the honest shape of a
 * revocation: the ROW changes, and `checkMachineUse` is consulted again. Flipping
 * a capability's role instead (which an earlier draft of these tests did) does not
 * model anything real — a role floor is a different gate, and POD-381's resolver
 * correctly ignores it when deciding machine `use`.
 */
const revocableFleet = (state: { m2: ('see' | 'use' | 'manage')[] }) => ({
  rowFor: (machineId: string) =>
    machineId === 'm1'
      ? { machine: 'm1' as MachineId, owner: 'alice' as UserId, grants: [], name: 'source' }
      : machineId === 'm2'
        ? {
            machine: 'm2' as MachineId,
            owner: 'bob' as UserId,
            grants: state.m2.map((verb) => ({ subject: 'alice' as UserId, verb })),
            name: 'target',
          }
        : undefined,
})

const gateForPrincipal = (user: string, ownership: ReturnType<typeof revocableFleet>) =>
  machineUseGateFor({
    principal: { kind: 'user', user: user as UserId, capability: TEST_CAPABILITY },
    ownership,
  })

/** The gate a real transport would build, for a principal that is `alice`. */
const aliceGate = (m2Grants: { subject: string; verb: 'see' | 'use' | 'manage' }[]) =>
  machineUseGateFor({
    principal: { kind: 'user', user: 'alice' as UserId, capability: TEST_CAPABILITY },
    ownership: twoPersonFleet(m2Grants),
  })

/** The PERSISTED row, as the store holds it — the widest view of "what moved". */
const rowOf = (f: HandoffFixture): Record<string, unknown> => {
  const row = f.store.sessions.loadSessions().find((r) => r.id === f.sessionId)
  if (!row) throw new Error('session row vanished')
  return row as unknown as Record<string, unknown>
}

/** Every durable handoff record, projected to the attribution pair + the move. */
const handoffRecords = (f: HandoffFixture): unknown[] =>
  f.store.events
    .listEventsSince(0, { kinds: ['session.handoff'] })
    .map((event) => event.payload as Record<string, unknown>)
    .map(({ actor, actorKind, onBehalfOf, fromMachineId, toMachineId }) => ({
      actor,
      actorKind,
      onBehalfOf,
      fromMachineId,
      toMachineId,
    }))

describe('oracle: handoff success across two machines', () => {
  it(`${MUST_NOT_CHANGE}: the row is re-homed onto the target and resumed there, and the source is told to kill`, async () => {
    const f = await handoffFixture()

    const result = await f.reg.modules.sessions.handoffSession(
      {
        sessionId: f.sessionId,
        machineId: 'm2',
      },
      { capability: TEST_CAPABILITY },
    )

    expect(result).toEqual({ ok: true, newCwd: '/target/repo/.worktrees/x' })
    expect(meta(f)).toMatchObject({
      machineId: 'm2',
      cwd: '/target/repo/.worktrees/x',
      status: 'starting',
    })
    expect(f.source).toContainEqual(
      expect.objectContaining({ type: 'kill', sessionId: f.sessionId }),
    )
    expect(f.target).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId: f.sessionId,
        cwd: '/target/repo/.worktrees/x',
      }),
    )
    // The overlay every client renders the move with is cleared on arrival.
    expect(meta(f)?.handoffTarget).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: the whole two-machine step sequence, in order — nothing irreversible happens before the TARGET verified a common base`, async () => {
    const f = await handoffFixture()

    await f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )

    // ONE stream across both machines. Exact equality, so a reordering, an extra
    // round-trip or a dropped step all fail — including the one this test exists
    // for: killing the source before the target has proven it shares a base.
    expect(f.timeline.map((e) => `${e.machine}:${e.type}`)).toEqual([
      // source rev-parses the candidate refs (parentBranch/main/origin-main/branch)
      'm1:repoOpRequest',
      'm1:repoOpRequest',
      'm1:repoOpRequest',
      // target proves which of them it already has — the bundle-base handshake
      'm2:repoOpRequest',
      // ONLY NOW is the live process stopped
      'm1:kill',
      'm1:handoffExportRequest',
      'm1:handoffChunkReadRequest',
      'm2:handoffImportChunk',
      'm2:handoffImportRequest',
      'm2:spawn',
    ])
    // Stated as the cross-machine inequality too, so the intent survives a
    // legitimate future change to the number of rev-parse probes.
    expect(f.at('m2', 'repoOpRequest')).toBeGreaterThanOrEqual(0)
    expect(f.at('m2', 'repoOpRequest')).toBeLessThan(f.at('m1', 'kill'))
    expect(f.at('m1', 'kill')).toBeLessThan(f.at('m1', 'handoffExportRequest'))
    expect(f.at('m1', 'handoffExportRequest')).toBeLessThan(f.at('m2', 'handoffImportRequest'))
    expect(f.at('m2', 'handoffImportRequest')).toBeLessThan(f.at('m2', 'spawn'))
  })

  it(`${willChange('POD-1079', 'machine rows gain real owners and grants; today every row resolves to the one instance account')}: with the DEFAULT fleet any authenticated caller may hand off, because there is only one account to own anything`, async () => {
    const f = await handoffFixture()

    // The check point is in the path (the next three tests refuse through it).
    // What POD-1079 replaces is where its ROWS come from: `ownershipFromMachines`
    // resolves every machine to the instance owner with no grants, so a
    // constrained capability is indistinguishable from the operator here — machine
    // `use` is not gated on the issue-tracker role, and POD-381's resolver is right
    // to ignore it. Two callers, one answer, and that is the behaviour-preserving
    // default rather than an absence of enforcement.
    await expect(
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: { ...TEST_CAPABILITY, role: 'worker' } },
      ),
    ).resolves.toMatchObject({ ok: true })
  })

  it(`${MUST_NOT_CHANGE}: a caller that may use the SOURCE but not the TARGET is denied, and the session is not retargeted anywhere`, async () => {
    const f = await handoffFixture()
    // The case today's machines table cannot express: alice OWNS m1 and merely
    // SEES m2. Driven through POD-381's real resolver over a hand-built ownership
    // index — the rules are theirs, only the rows are the fixture's.
    f.reg.modules.sessions.machineUseGate = () => aliceGate([{ subject: 'alice', verb: 'see' }])

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
      // DENIED, and distinguishable from unreachable: alice can SEE m2, so she is
      // told she may not run agents there rather than that it does not exist.
    ).toBe("you do not have access to run agents on machine 'target'")
    // NEVER SILENTLY RETARGETED (§3.1.4 M5): the session stayed where it was, and
    // m1 — the one machine alice may use — was not handed its own session back as
    // a consolation move.
    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    expect(f.source.some((m) => m.type === 'handoffImportRequest')).toBe(false)
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
  })

  it(`${MUST_NOT_CHANGE}: a machineId that does not exist is refused with the SAME message as one the caller may not SEE`, async () => {
    const f = await handoffFixture()
    // alice owns the source and can see NEITHER m2 (bob's, no grant) nor an id
    // that names nothing at all.
    f.reg.modules.sessions.machineUseGate = () => aliceGate([])

    const invisible = await messageOf(() =>
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: TEST_CAPABILITY },
      ),
    )
    const nonexistent = await messageOf(() =>
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'no-such-machine' },
        { capability: TEST_CAPABILITY },
      ),
    )

    // The consistent-error rule (§3.1.5) is an EQUALITY between the two paths, not
    // two string checks that could drift apart while both stayed green. Only the
    // machine id differs — an id is what the caller already supplied.
    expect(invisible).toBe("unknown machine 'm2'")
    expect(nonexistent).toBe("unknown machine 'no-such-machine'")
    expect(invisible.replace("'m2'", "'X'")).toBe(nonexistent.replace("'no-such-machine'", "'X'"))
  })

  it(`${MUST_NOT_CHANGE}: a machine the caller may use but that is OFFLINE says so — denied and unreachable are different answers`, async () => {
    const f = await handoffFixture()
    // Same operator, same eligible-in-every-other-way target: only reachability
    // differs from the passing case, so the different message is attributable to
    // reachability alone (§3.1.4 M5's visible-machine distinction).
    f.reg.gateway.detachDaemon('m2')

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('target machine is offline')
  })
})

describe('oracle: handoff refusals that must not move anything', () => {
  it(`${MUST_NOT_CHANGE}: no verified common bundle base ⇒ refuse, with the session untouched on the source (the d73e9121 class)`, async () => {
    const f = await handoffFixture({ targetHasBase: false })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('target repository has no verified common bundle base')

    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    // Nothing irreversible ran: no kill, no export, no import.
    expect(f.source.some((m) => m.type === 'kill')).toBe(false)
    expect(f.source.some((m) => m.type === 'handoffExportRequest')).toBe(false)
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
    // And the handover overlay was cleared rather than left painted.
    expect(meta(f)?.handoffTarget).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: handing a session to the machine it is already on is refused`, async () => {
    const f = await handoffFixture()

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm1' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('session is already on that machine')
  })

  it(`${MUST_NOT_CHANGE}: a session with no resume ref cannot be handed off — the conversation would not survive`, async () => {
    const f = await handoffFixture()
    const shell = f.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/source/repo/.worktrees/x',
      machineId: 'm1',
    })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: shell.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('session harness does not support handoff')
  })
})

describe('oracle: mid-transfer crash', () => {
  it(`${MUST_NOT_CHANGE}: an export failure rolls the session back onto the SOURCE and re-resurrects it there`, async () => {
    const f = await handoffFixture({ failExport: true })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('source exploded mid-export')

    // Home, cwd and overlay all restored; the recovery spawn goes back to m1.
    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    expect(meta(f)?.handoffTarget).toBeUndefined()
    await waitFor(
      () => f.source.some((m) => m.type === 'spawn' && m.sessionId === f.sessionId),
      'the rollback resurrect to spawn back on the source',
    )
    // The target never imported anything.
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
  })

  it(`${MUST_NOT_CHANGE}: a grant REVOKED MID-TRANSFER refuses the import at APPLY time and rolls back to the source`, async () => {
    // ADR 3 D8/D16: rights are re-resolved live at every apply, never carried as
    // the snapshot taken when the command was dispatched. The revocation lands
    // after the source has already been killed and the package exported — which is
    // precisely the window a dispatch-time-only check cannot see. alice starts with
    // see+use on bob's machine and loses `use` mid-transfer.
    const fleet = { m2: ['see', 'use'] as ('see' | 'use' | 'manage')[] }
    const f = await handoffFixture({
      onExport: () => {
        fleet.m2 = ['see']
      },
    })
    f.reg.modules.sessions.machineUseGate = () => gateForPrincipal('alice', revocableFleet(fleet))

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
      // Refused as UNAUTHORIZED, not as absent: alice kept `see`, so she is told she
      // may not run agents there rather than that the machine vanished (M5).
    ).toBe("you do not have access to run agents on machine 'target'")

    // NOT COMPLETED AND NOT LOST: no import ran on the target, and the session is
    // back on the source with a recovery spawn — the same rollback contract as a
    // daemon-side failure, because a refusal at apply IS a mid-transfer failure.
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    expect(meta(f)?.handoffTarget).toBeUndefined()
    await waitFor(
      () => f.source.some((m) => m.type === 'spawn' && m.sessionId === f.sessionId),
      'the rollback resurrect to spawn back on the source',
    )
  })

  it(`${MUST_NOT_CHANGE}: a revocation landing DURING the base handshake refuses before the kill, with the live process untouched`, async () => {
    // The earlier apply-time checkpoint. `ensureTargetRepo` may clone a repository
    // and the base handshake is a network round trip per ref, so the window between
    // dispatch and the first irreversible act is minutes wide; the revocation lands
    // inside it, and nothing may be stopped. A dispatch-time-only check cannot
    // refuse here: at dispatch alice still held `use`.
    const fleet = { m2: ['see', 'use'] as ('see' | 'use' | 'manage')[] }
    let seenTargetProbe = 0
    const f = await handoffFixture({
      onTargetProbe: () => {
        seenTargetProbe += 1
        fleet.m2 = ['see']
      },
    })
    f.reg.modules.sessions.machineUseGate = () => gateForPrincipal('alice', revocableFleet(fleet))

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe("you do not have access to run agents on machine 'target'")

    // The revocation really did land after dispatch: the target was probed, which
    // only happens once the dispatch-time checks have already passed.
    expect(seenTargetProbe).toBeGreaterThan(0)
    expect(f.source.some((m) => m.type === 'kill')).toBe(false)
    expect(f.source.some((m) => m.type === 'handoffExportRequest')).toBe(false)
    expect(meta(f)).toMatchObject({ machineId: 'm1', status: 'starting' })
    expect(meta(f)?.handoffTarget).toBeUndefined()
  })
})

describe('oracle: what the transfer is and is not allowed to change', () => {
  it(`${MUST_NOT_CHANGE}: the moved row changes ONLY its placement — no owner, provenance or identity field moves with it`, async () => {
    const f = await handoffFixture()
    const before = rowOf(f)

    await f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )

    const after = rowOf(f)
    const changed = Object.keys({ ...before, ...after })
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .sort()
    // ASSERTED BY ABSENCE, deliberately. A session's owner is its on-behalf-of
    // human (ADR 9 D5 A4) and a machine change is not an ownership change; the
    // agent principal's lifecycle is its SessionBinding (POD-323/POD-644), so
    // delegation survives the move by NOT being re-minted. There is no owner
    // column to assert on yet (POD-1075), and a test that only checked today's
    // columns would go quiet the moment one arrived. This one gets LOUDER: any new
    // field the transfer starts writing has to be justified in this list.
    // `cwd` + `machineId` are the placement; `activityCount` + `lastResumedAt`
    // are the resume on the target, which is the last leg of the move. Nothing
    // else — no owner, no provenance, no identity, no capability.
    expect(changed).toEqual(['activityCount', 'cwd', 'lastResumedAt', 'machineId'])
  })

  it(`${MUST_NOT_CHANGE}: the durable record names the ACTOR and the ON-BEHALF-OF human, and an agent-initiated move is distinguishable from a human one`, async () => {
    const human = await handoffFixture()
    await human.reg.modules.sessions.handoffSession(
      { sessionId: human.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )

    const agent = await handoffFixture()
    await agent.reg.modules.sessions.handoffSession(
      { sessionId: agent.sessionId, machineId: 'm2' },
      {
        capability: {
          role: 'admin',
          scope: { kind: 'all' },
          actorSessionId: asSessionId('sess-agent-7'),
          onBehalfOf: FIRST_ADMIN_USER_ID,
        },
      },
    )

    // The counterfactual the pair exists for: both moves were made FOR alice, so
    // an on-behalf-of alone cannot tell them apart. Only the actor half can.
    expect(handoffRecords(human)).toEqual([
      {
        actor: FIRST_ADMIN_USER_ID,
        actorKind: 'user',
        onBehalfOf: FIRST_ADMIN_USER_ID,
        fromMachineId: 'm1',
        toMachineId: 'm2',
      },
    ])
    expect(handoffRecords(agent)).toEqual([
      {
        actor: 'sess-agent-7',
        actorKind: 'agent',
        onBehalfOf: FIRST_ADMIN_USER_ID,
        fromMachineId: 'm1',
        toMachineId: 'm2',
      },
    ])
  })

  it(`${MUST_NOT_CHANGE}: identity fields smuggled into the command INPUT are inert — the record still comes from the transport`, async () => {
    const f = await handoffFixture()

    await f.reg.modules.sessions.handoffSession(
      {
        sessionId: f.sessionId,
        machineId: 'm2',
        // ADR 3 D7 rule 1: payload identity is informational at best and must not
        // reach an authorization or attribution decision. Cast because the command
        // input has no such fields — which is the first half of the defence.
        ...({ actor: 'mallory', onBehalfOf: 'mallory', capability: { role: 'admin' } } as object),
      },
      { capability: TEST_CAPABILITY },
    )

    expect(handoffRecords(f)).toEqual([
      {
        actor: FIRST_ADMIN_USER_ID,
        actorKind: 'user',
        onBehalfOf: FIRST_ADMIN_USER_ID,
        fromMachineId: 'm1',
        toMachineId: 'm2',
      },
    ])
  })
})

describe('oracle: duplicate dispatch', () => {
  it(`${MUST_NOT_CHANGE}: a SECOND handoff after the first completed is refused as already-there, not run twice`, async () => {
    const f = await handoffFixture()
    await f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )
    const importsAfterFirst = f.target.filter((m) => m.type === 'handoffImportRequest').length

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession(
          { sessionId: f.sessionId, machineId: 'm2' },
          { capability: TEST_CAPABILITY },
        ),
      ),
    ).toBe('session is already on that machine')
    expect(f.target.filter((m) => m.type === 'handoffImportRequest')).toHaveLength(
      importsAfterFirst,
    )
  })

  it(`${MUST_NOT_CHANGE}: CONCURRENT duplicate dispatch to the same target is SINGLE-FLIGHTED — one export, one import, one spawn`, async () => {
    const f = await handoffFixture()

    const settled = await Promise.allSettled([
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: TEST_CAPABILITY },
      ),
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: TEST_CAPABILITY },
      ),
    ])

    // REWRITTEN BY POD-642, WHICH IS WHAT THE will-change TAG WAS FOR. Before the
    // command contract this ran TWO complete orchestrations: exported twice,
    // imported twice, and SPAWNED TWICE on the target — two live owners of one
    // conversation. Both callers still get the same successful answer, because the
    // second one JOINS the transfer already in flight rather than being refused;
    // what must never come back is the second set of daemon legs.
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(
      settled.map((s) => (s.status === 'fulfilled' ? s.value : (s.reason as Error).message)),
    ).toEqual([
      { ok: true, newCwd: '/target/repo/.worktrees/x' },
      { ok: true, newCwd: '/target/repo/.worktrees/x' },
    ])
    expect(f.count('m1', 'handoffExportRequest')).toBe(1)
    expect(f.count('m2', 'handoffImportRequest')).toBe(1)
    expect(f.count('m2', 'spawn')).toBe(1)
    expect(f.count('m1', 'kill')).toBe(1)
    // One row, on the target — which was ALSO true of the forked run, and is
    // exactly why the row count alone was never evidence: the fork was visible
    // only in the daemon legs above.
    expect(
      f.reg.modules.sessions
        .listSessions()
        .map((s) => ({ machineId: s.machineId, cwd: s.cwd, status: s.status })),
    ).toEqual([{ machineId: 'm2', cwd: '/target/repo/.worktrees/x', status: 'starting' }])
  })

  it(`${MUST_NOT_CHANGE}: a concurrent dispatch to a DIFFERENT target is refused rather than racing two targets for one session`, async () => {
    const f = await handoffFixture()
    // The counterfactual this name needs: m3 is a fully eligible target — paired,
    // online, with the same logged-in harness and the same repo — so the refusal
    // below is about the transfer already in flight and not about m3.
    f.store.machines.upsertMachine({
      id: 'm3',
      name: 'third',
      hostname: 'third',
      tokenHash: 'z',
      ownerUserId: 'user:sole',
    })
    f.store.machines.setMachineInventory(
      'm3',
      JSON.stringify({
        os: 'linux',
        arch: 'x64',
        agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
        tools: [],
      }),
    )
    f.store.repos.addRepo('/third/repo', 'm3', 'git@github.com:example/repo.git')
    f.reg.gateway.attachDaemon('m3', () => {})

    const first = f.reg.modules.sessions.handoffSession(
      {
        sessionId: f.sessionId,
        machineId: 'm2',
      },
      { capability: TEST_CAPABILITY },
    )
    const second = f.reg.modules.sessions.handoffSession(
      {
        sessionId: f.sessionId,
        machineId: 'm3',
      },
      { capability: TEST_CAPABILITY },
    )

    await expect(second).rejects.toThrow('session handoff already in progress')
    await expect(first).resolves.toEqual({ ok: true, newCwd: '/target/repo/.worktrees/x' })
    // m3 was never asked for anything: not a rev-parse, not an import.
    expect(f.count('m3', 'repoOpRequest')).toBe(0)
    expect(f.count('m3', 'handoffImportRequest')).toBe(0)
    expect(meta(f)).toMatchObject({ machineId: 'm2' })
  })

  it(`${MUST_NOT_CHANGE}: a caller JOINING an in-flight transfer is authorized with its OWN rights, not the initiator's`, async () => {
    const f = await handoffFixture()

    // The operator starts the move; a constrained caller asks for the same move
    // while it is in flight. Coalescing is a latency optimisation and must not
    // become an authorization one: the joiner is refused on its own rights and
    // never learns the transfer succeeded.
    // Two principals, distinguished by the actor half of their capability: the
    // operator (default fleet — may use everything) and carol, who owns nothing.
    f.reg.modules.sessions.machineUseGate = (caller) =>
      caller.capability.actorUser === 'carol'
        ? gateForPrincipal('carol', revocableFleet({ m2: [] }))
        : machineUseGateFor({
            principal: { kind: 'user', user: 'alice' as UserId, capability: TEST_CAPABILITY },
            ownership: revocableFleet({ m2: ['see', 'use'] }),
          })

    const initiator = f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )
    const joiner = f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: { role: 'admin', scope: { kind: 'all' }, actorUser: 'carol' } },
    )

    await expect(joiner).rejects.toThrow("unknown machine 'm1'")
    // And the initiator's transfer is unharmed — the refusal touched only the
    // caller that was refused, which is the other half of the claim.
    await expect(initiator).resolves.toEqual({ ok: true, newCwd: '/target/repo/.worktrees/x' })
    expect(f.count('m2', 'handoffImportRequest')).toBe(1)
  })

  it(`${MUST_NOT_CHANGE}: a FAILED transfer releases the single-flight slot, so the move can be retried instead of being wedged`, async () => {
    const f = await handoffFixture({ failExport: true })

    const first = await messageOf(() =>
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: TEST_CAPABILITY },
      ),
    )
    // The retry must reach the daemon legs again and fail on the SAME cause. A
    // slot released only on the success path would answer 'session handoff already
    // in progress' here — permanently, for the life of the process — and every
    // other test in this file would still pass.
    const second = await messageOf(() =>
      f.reg.modules.sessions.handoffSession(
        { sessionId: f.sessionId, machineId: 'm2' },
        { capability: TEST_CAPABILITY },
      ),
    )

    expect([first, second]).toEqual(['source exploded mid-export', 'source exploded mid-export'])
    expect(f.count('m1', 'handoffExportRequest')).toBe(2)
  })
})

describe('oracle: worktree reuse on the target', () => {
  it(`${MUST_NOT_CHANGE}: the import is told which target worktrees are OCCUPIED so it never resets a live peer's workspace`, async () => {
    const f = await handoffFixture()
    await f.reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/target/repo/.worktrees/shared',
      resume: { kind: 'claude-session', value: 'other-native-id' },
      conversationId: 'other-native-id',
      machineId: 'm2',
    })

    await f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )

    expect(f.target).toContainEqual(
      expect.objectContaining({
        type: 'handoffImportRequest',
        occupiedWorktreePaths: ['/target/repo/.worktrees/shared'],
      }),
    )
  })

  it(`${MUST_NOT_CHANGE}: an EXITED peer's worktree is not treated as occupied — a dead session must not hold a checkout hostage`, async () => {
    const f = await handoffFixture()
    const peer = await f.reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/target/repo/.worktrees/shared',
      resume: { kind: 'claude-session', value: 'other-native-id' },
      conversationId: 'other-native-id',
      machineId: 'm2',
    })
    f.reg.gateway.routeDaemonFrame('m2', {
      type: 'agentExit',
      sessionId: peer.sessionId,
      code: 0,
    })

    await f.reg.modules.sessions.handoffSession(
      { sessionId: f.sessionId, machineId: 'm2' },
      { capability: TEST_CAPABILITY },
    )

    const importRequest = f.target.find((m) => m.type === 'handoffImportRequest')
    // An empty guard list is OMITTED from the wire rather than sent as [].
    expect(importRequest && 'occupiedWorktreePaths' in importRequest).toBe(false)
  })
})
