/**
 * THE ISSUE STRUCTURE WRITES ON THE SYNC WRITE ENTRY POINT (POD-6413).
 *
 * Every listed issue command (`SYNCED_ISSUE_COMMANDS`) is registered, and every
 * transport reaches it through `submit`: `sync.submit` itself, the old tRPC
 * routes (thin adapters), an agent's relay (its own `sync.submit` adapter and
 * the dispatcher's), and the in-process MCP. The work outside the database stays
 * out of the write: a create's start runs after the commit, and the artifact
 * operations keep the family's own path.
 */

import {
  MAIL_ISSUE_COMMANDS,
  QUEUED_ISSUE_COMMANDS,
  SESSION_ISSUE_COMMANDS,
  STRUCTURE_ISSUE_COMMANDS,
  SYNCED_ISSUE_COMMANDS,
} from '@podium/commands'
import { asMachineId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { SyncSubmitInput } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { OPERATOR } from '../../test-support/capabilities'
import { confirmingRetirement } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { disposeOracles, makeOracle as makeBareOracle } from '../sessions/oracle-support'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'
import { startAfterCreate } from './sync-write'

afterEach(() => disposeOracles())

/** The oracle, with the repo the issues below are filed in reported by its machine. */
async function makeOracle() {
  const o = await makeBareOracle()
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  return o
}

const newIssue = (title: string, extra: Record<string, unknown> = {}) => ({
  repoPath: '/r',
  title,
  startNow: false,
  ...extra,
})

describe('the listed issue commands on the entry point', () => {
  it('the list is the queued and the structure commands, and every one is registered', async () => {
    expect(SYNCED_ISSUE_COMMANDS).toEqual([
      ...QUEUED_ISSUE_COMMANDS,
      ...STRUCTURE_ISSUE_COMMANDS,
      ...SESSION_ISSUE_COMMANDS,
      ...MAIL_ISSUE_COMMANDS,
    ])
    const o = await makeOracle()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const proc of SYNCED_ISSUE_COMMANDS) expect(names, proc).toContain(`issues.${proc}`)
  })

  it('a create applies once with its rows carrying the mutationId; the replay answers it', async () => {
    const o = await makeOracle()
    const { result, rows } = await expectAppliedOnPath(
      o,
      envelope('issues.create', newIssue('filed on the path'), 'mut_create_1'),
      { writes: true },
    )
    expect(result).toMatchObject({ title: 'filed on the path' })
    // The issue's own row is among them, under its id.
    expect(rows.some((row) => row.entityId === (result as { id: string }).id)).toBe(true)
  })

  it('structure writes apply through sync.submit with provenance', async () => {
    const o = await makeOracle()
    const a = appliedReply(await submit(o, envelope('issues.create', newIssue('a'), 'mut_a')))
      .result as { id: string }
    const b = appliedReply(await submit(o, envelope('issues.create', newIssue('b'), 'mut_b')))
      .result as { id: string }

    for (const [command, input] of [
      ['issues.depAdd', { fromId: a.id, toId: b.id, type: 'blocked-by' }],
      ['issues.addComment', { id: a.id, body: 'on the path' }],
      ['issues.setState', { id: a.id, text: 'where things stand' }],
      ['issues.setNeedsHuman', { id: a.id, question: 'which one?' }],
      ['issues.clearNeedsHuman', { id: a.id }],
      ['issues.panelApply', { id: a.id, op: 'todo-add', text: 'one more thing' }],
      ['issues.reparent', { id: b.id, parentId: a.id }],
    ] as const) {
      await expectAppliedOnPath(o, envelope(command, input, `mut_${command}`), { writes: true })
    }
  })

  it('sync.submit refuses a create that starts its task: that is an issue.start effect', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope('issues.create', newIssue('started', { startNow: true }), 'mut_start'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: {
        kind: 'invalid',
        message: 'Start a new task with its agent through an issue.start effect record.',
      },
    })
    expect(await rowsOf(o, 'mut_start')).toEqual([])
  })

  it('sync.submit refuses the artifact operations; the other panel operations apply', async () => {
    const o = await makeOracle()
    const a = appliedReply(await submit(o, envelope('issues.create', newIssue('a'), 'mut_pa')))
      .result as { id: string }
    for (const op of ['artifact-add', 'artifact-remove', 'artifact-upload']) {
      const reply = await submit(
        o,
        envelope('issues.panelApply', { id: a.id, op, path: 'x.md', index: 0 }, `mut_${op}`),
      )
      expect(reply.outcome, op).toBe('rejected')
      if (reply.outcome === 'rejected') expect(reply.refusal.kind).toBe('invalid')
    }
  })

  it('the old route of a listed write is a thin adapter onto the entry point', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const created = await o.call.issues.create(newIssue('through the route'))
    await o.call.issues.addComment({ id: created.id, body: 'hi' })

    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['issues.create', 'trpc'],
      ['issues.addComment', 'trpc'],
    ])
  })

  it("a refused handler's route answer is the family's own error, as before", async () => {
    const o = await makeOracle()
    await expect(
      o.call.issues.create(newIssue('orphan', { parentId: 'iss_nope' })),
    ).rejects.toThrow('unknown parent issue iss_nope — nothing was created')
  })

  it("over sync.submit that refusal carries the handler's message", async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope('issues.create', newIssue('orphan', { parentId: 'iss_nope' }), 'mut_orphan'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', message: 'unknown parent issue iss_nope — nothing was created' },
    })
  })

  it("a shipping write the handler refuses carries the handler's message (POD-6414)", async () => {
    const o = await makeOracle()
    for (const [command, input] of [
      ['issues.cancelShip', { orderId: 'ord_nope' }],
      ['issues.resolveShipHold', { orderId: 'ord_nope', action: 'retry', expectedGeneration: 1 }],
    ] as const) {
      const reply = await submit(o, envelope(command, input, `mut_${command}`))
      expect(reply.outcome, command).toBe('rejected')
      if (reply.outcome === 'rejected') {
        expect(reply.refusal.kind, command).toBe('target-not-found')
        expect(reply.refusal.message, command).toBeTruthy()
      }
    }
  })

  it('the in-process MCP surface writes through the entry point as MCP', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const mcp = o.reg.issueCommands.asIssueTrpc(OPERATOR)

    const created = (await mcp.issues.create.mutate(newIssue('from mcp'))) as { id: string }
    expect(created.id).toMatch(/^iss_/)
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['issues.create', 'mcp'],
    ])
  })
})

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe("an agent's relay through the entry point", () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  let registry: SessionRegistry
  let store: SessionStore
  let root: { id: string }
  let outside: { id: string }
  let agent: SessionId
  let replies: RelayResult[]

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    await store.machines.upsertMachine({
      id: machineId,
      name: 'ludovico',
      hostname: 'ludovico.local',
      tokenHash: 'hash-1',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: false, agentExecution: true },
    })
    await store.repos.addRepo('/r', asMachineId(machineId))
    registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    replies = []
    await registry.gateway.attachDaemon(
      machineId,
      confirmingRetirement(registry, machineId, (msg) => {
        if (msg.type === 'agentRelayResult') replies.push(msg)
      }),
    )
    root = await registry.issues.crud.create({ repoPath: '/r', title: 'root', startNow: false })
    await registry.issues.crud.update(root.id, { worktreePath: '/r/.worktrees/issue-1-root' })
    outside = await registry.issues.crud.create({ repoPath: '/r', title: 'other', startNow: false })
    agent = asSessionId(
      (
        await registry.modules.sessions.createSession({
          cwd: '/r/.worktrees/issue-1-root',
          agentKind: 'shell',
        })
      ).sessionId,
    )
  })

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  async function relay(
    requestId: string,
    router: string,
    proc: string,
    input: unknown,
    outsideScope = false,
  ): Promise<RelayResult> {
    await registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId,
      sessionId: agent,
      router,
      proc,
      input,
      ...(outsideScope ? { outsideScope: true } : {}),
    })
    await vi.waitFor(() => expect(replies.some((r) => r.requestId === requestId)).toBe(true))
    return replies.find((r) => r.requestId === requestId) as RelayResult
  }

  const submitEnvelope = (command: string, input: unknown, mutationId: string): SyncSubmitInput =>
    ({ mutationId, command, version: 1, input }) as SyncSubmitInput

  it("the dispatcher's relay path writes through the entry point as the relay", async () => {
    const entry = vi.spyOn(registry.modules.syncWrite, 'submitDetailed')
    const r = await relay('r-state', 'issues', 'setState', { id: root.id, text: 'mine' })
    expect(r.ok).toBe(true)
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['issues.setState', 'relay'],
    ])
  })

  it('the relay serves sync.submit: a write in scope applies with a receipt', async () => {
    const r = await relay(
      'r-submit',
      'sync',
      'submit',
      submitEnvelope('issues.setState', { id: root.id, text: 'via submit' }, 'mut_relay_state'),
    )
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ outcome: 'applied', replayed: false })
  })

  it('outside the subtree it needs the confirmation; --outside-scope is that confirmation', async () => {
    const env = submitEnvelope('issues.setState', { id: outside.id, text: 'x' }, 'mut_outside')
    const refused = await relay('r-out', 'sync', 'submit', env)
    expect(refused.result).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'confirmation-required' },
    })
    const confirmed = await relay('r-out-ok', 'sync', 'submit', env, true)
    expect(confirmed.result).toMatchObject({ outcome: 'applied' })
  })

  it('attachSession through sync.submit acts on the calling session, whatever session it names (POD-6414)', async () => {
    const r = await relay(
      'r-attach',
      'sync',
      'submit',
      submitEnvelope(
        'issues.attachSession',
        { sessionId: 'sess_someone_else', targetId: outside.id, confirmRehome: true },
        'mut_attach',
      ),
    )
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ outcome: 'applied' })
    expect((await registry.modules.sessions.sessionById(agent))?.issueId).toBe(outside.id)
  })

  it('sync.submit adds no reach: a command the relay does not allow is refused at the gate', async () => {
    const r = await relay(
      'r-effect',
      'sync',
      'submit',
      submitEnvelope(
        'effects.create',
        { id: 'eff_x', kind: 'issue.merge', target: { kind: 'issue', id: root.id }, input: {} },
        'mut_eff',
      ),
    )
    expect(r).toMatchObject({ ok: false, error: 'effects.create is not permitted via relay' })
  })
})

describe('a create that asked to start, after its commit', () => {
  const created = { id: 'iss_1', coordinator: 'you coordinate #1' }
  const issues = (opts: { proposedParent?: boolean; worktreePath?: string | null } = {}) => {
    const start = vi.fn(async (id: string) => ({ id, started: true }))
    return {
      start,
      issues: {
        gitWorkflow: {
          start,
          projectionNow: vi.fn(async (id: string) => ({ id, started: 'before' })),
        },
        hierarchy: { inProposedSubtree: vi.fn(async () => opts.proposedParent === true) },
        reports: {
          getMeta: vi.fn(async (id: string) =>
            id === 'iss_1' ? { id, worktreePath: opts.worktreePath ?? null } : { id },
          ),
        },
      } as never,
    }
  }
  const operator = { capability: { role: 'admin', scope: { kind: 'all' } } } as never
  const agent = {
    capability: {
      role: 'worker',
      scope: { kind: 'subtree', rootId: 'iss_root' },
      actorSessionId: 'sess_a',
    },
  } as never

  it("an operator's start runs, and the create's notes ride along", async () => {
    const { issues: deps, start } = issues()
    const answer = await startAfterCreate(deps, operator, { startNow: true }, created)
    expect(start).toHaveBeenCalledWith('iss_1', undefined, { spawnedBy: 'user' })
    expect(answer).toEqual({ id: 'iss_1', started: true, coordinator: 'you coordinate #1' })
  })

  it("an agent's top-level task is a proposal and does not start", async () => {
    const { issues: deps, start } = issues()
    expect(await startAfterCreate(deps, agent, { startNow: true }, created)).toBe(created)
    expect(start).not.toHaveBeenCalled()
  })

  it("an agent's task under a proposal is inert", async () => {
    const { issues: deps, start } = issues({ proposedParent: true })
    expect(
      await startAfterCreate(deps, agent, { startNow: true, parentId: 'iss_p' }, created),
    ).toBe(created)
    expect(start).not.toHaveBeenCalled()
  })

  it("an agent's sub-task starts, spawned by the agent's session", async () => {
    const { issues: deps, start } = issues()
    await startAfterCreate(
      deps,
      agent,
      { startNow: true, parentId: 'iss_p', startSessionId: 'sess_new' },
      created,
    )
    expect(start).toHaveBeenCalledWith('iss_1', undefined, {
      spawnedBy: 'session:sess_a',
      sessionId: 'sess_new',
    })
  })

  it('a replayed create whose task already started is not started twice', async () => {
    const { issues: deps, start } = issues({ worktreePath: '/r/.worktrees/issue-1' })
    expect(await startAfterCreate(deps, operator, { startNow: true }, created)).toEqual({
      id: 'iss_1',
      started: 'before',
      coordinator: 'you coordinate #1',
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('a create that did not ask to start answers as it is', async () => {
    const { issues: deps, start } = issues()
    expect(await startAfterCreate(deps, operator, { startNow: false }, created)).toBe(created)
    expect(start).not.toHaveBeenCalled()
  })
})
