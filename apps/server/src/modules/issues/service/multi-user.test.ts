/**
 * A SESSION STARTED FROM AN ISSUE BELONGS TO THE HUMAN WHO STARTED IT (POD-3902).
 *
 * WHAT FAILS HERE BEFORE THE FIX, stated plainly. `IssueWorkflow.start` and
 * `IssueWorkflow.addSession` both ended their spawn with
 *
 *     ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {})
 *
 * where `row` is the ISSUE. So `podium issue start` / `add-session` stamped the
 * TASK's owner onto the new session no matter who ran the command, and every
 * owner-keyed gate downstream then answered about the wrong person:
 * `session-control-policy`'s `mayWatch`/`mayDrive`, `memory/visibility` and
 * `sessions/queries` have no spawnedBy/parent arm at all, so for them the
 * durable row IS the answer. This is the same defect POD-3901 fixed on
 * `messages/handlers/spawn-agent.ts`; these were the two remaining producers,
 * left behind because neither method had a caller principal in scope.
 *
 * WHY THE TWO HUMANS ARE THE WHOLE TEST. A single-account fixture cannot see
 * this at all: the task's owner and the person running the command are the same
 * person, so the assertion passes whichever field the code reads (false-green
 * catalogue shape 14). Only Bob-starts-Alice's-task separates the two answers.
 *
 * WHY BOTH LAYERS ARE HERE. The defect is only half in `workflow.ts`. Fixing the
 * spawn to read an initiating human is inert unless the command layer actually
 * supplies one, and a test of either half alone passes while the other half is
 * still broken. So each `describe` below drives the SAME two spawns from a
 * different depth: the service arm proves the spawn honours the initiating
 * human over the row, and the command arm proves the registry derives that
 * human from the caller's principal rather than leaving it undefined.
 *
 * NOTHING HERE STUBS THE DECISION. `IssueCommandDispatcher` is the real
 * relay/MCP pipeline (guard → parse → handle), the guard is the real
 * `checkIssueAccess`, and the principal is resolved by the real
 * `resolvePrincipalAsync` from the capability. The fixture supplies a store, a
 * fake `repoOp` and a recording `spawnSession` port — rows and effects, never
 * verdicts.
 *
 * BOB IS NOT A DENIAL CASE, and that matters as much as here as it did on
 * POD-3901. His capability is exactly what `capabilityForSession` mints for an
 * agent working a task — `worker` / `subtree` rooted at it — which passes the
 * scope gate on Alice's issue. The operator arm is a plain human running the
 * CLI. Both are legitimate starts that must simply be stamped to the right
 * person.
 */

import { asIssueId, asSessionId, asUserId, type MutationId, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { Capability } from '../../../issue-authz'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueCommandDispatcher } from '../dispatcher'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

const ALICE = asUserId('u_alice')
const BOB = asUserId('u_bob')

/** Every argument object the workflow handed the spawn port, in order. */
type RecordedSpawn = Parameters<IssueDeps['spawnSession']>[0]

async function harness() {
  const store = await openTestStore(':memory:')
  const spawns: RecordedSpawn[] = []
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async (o: RecordedSpawn) => {
      spawns.push(o)
      return { sessionId: asSessionId(`s${spawns.length}`), machine: 'machine-under-test' }
    }),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now: () => '2026-09-13T00:00:00.000Z',
  }
  const svc = await IssueService.create(deps)
  const dispatcher = new IssueCommandDispatcher({
    issues: svc,
    shipping: {} as never,
    arbitration: { run: (_input, operation) => operation() },
    attachSession: () => {
      throw new Error('not used')
    },
    deleteIssue: () => undefined,
    restoreIssue: () => undefined,
    // Idempotency is not what this file measures; run the body once. The
    // signatures are spelled out rather than cast so a drift in
    // `MutationLedgerPort` still fails the compiler here.
    mutations: {
      apply: async <T>(
        _id: MutationId | undefined,
        _proc: string,
        body: () => T | Promise<T>,
      ): Promise<{ outcome: 'applied'; value: Awaited<T> }> => ({
        outcome: 'applied',
        value: await body(),
      }),
      once: async <T>(
        _id: MutationId | undefined,
        _proc: string,
        body: () => T | Promise<T>,
      ): Promise<Awaited<T>> => await body(),
    },
    sessionById: async () => undefined,
    listSessionsForIssue: async () => [],
    repoPaths: () => ['/r'],
    inferRepoFromPath: () => undefined,
  })

  /**
   * Alice's task. Non-vacuity: if the owner write were silently dropped the
   * issue would still belong to the ambient first admin and every assertion
   * below would pass for the wrong reason, so the owner is read back through
   * the SAME port the authorization path consults rather than trusted.
   */
  const alicesTask = async (title = 'Alice’s task') => {
    const issue = await svc.create({ repoPath: '/r', title, startNow: false })
    await svc.update(issue.id, { ownerUserId: ALICE })
    expect((await svc.ownedTarget(issue.id, 'read'))?.owner).toBe(ALICE)
    return issue
  }

  return { store, svc, dispatcher, spawns, alicesTask }
}

/** An agent session working a task: `worker` / `subtree` rooted at it. */
const agentOn = (human: UserId, issueId: string, sessionId: string): Capability => ({
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId(issueId) },
  actorSessionId: asSessionId(sessionId),
  onBehalfOf: human,
})

/** A person at the CLI: unconstrained scope, acting as themselves. */
const operator = (human: UserId): Capability => ({
  role: 'admin',
  scope: { kind: 'all' },
  actorUser: human,
  onBehalfOf: human,
})

describe('the issue workflow stamps the initiating human, not the task owner', () => {
  it('start: BOB starting ALICE’s task spawns a session owned by BOB', async () => {
    const { svc, spawns, alicesTask } = await harness()
    const issue = await alicesTask()

    await svc.start(issue.id, undefined, { spawnedBy: 'user', ownerUserId: BOB })

    expect(spawns).toHaveLength(1)
    // THE DEFECT: this read ALICE, because the spawn resolved the owner off the
    // issue row. A session is not the work — it is someone's private run.
    expect(spawns[0]?.ownerUserId).toBe(BOB)
  })

  it('addSession: BOB adding to ALICE’s started task spawns a session owned by BOB', async () => {
    const { svc, spawns, alicesTask } = await harness()
    const issue = await alicesTask()
    await svc.start(issue.id, undefined, { spawnedBy: 'user', ownerUserId: ALICE })

    await svc.addSession(issue.id, undefined, { spawnedBy: 'user', ownerUserId: BOB })

    expect(spawns).toHaveLength(2)
    expect(spawns[1]?.ownerUserId).toBe(BOB)
  })

  it('addShell: the shell path carries the initiating human too', async () => {
    const { svc, spawns, alicesTask } = await harness()
    const issue = await alicesTask()
    await svc.start(issue.id, undefined, { spawnedBy: 'user', ownerUserId: ALICE })

    await svc.addShell(issue.id, { spawnedBy: 'user', ownerUserId: BOB })

    expect(spawns).toHaveLength(2)
    expect(spawns[1]?.ownerUserId).toBe(BOB)
  })

  it('still stamps ALICE when ALICE starts her own task — the instrument can say either name', async () => {
    const { svc, spawns, alicesTask } = await harness()
    const issue = await alicesTask()

    await svc.start(issue.id, undefined, { spawnedBy: 'user', ownerUserId: ALICE })

    // The counterfactual that keeps the assertions above from being "always
    // BOB": the stamp follows the initiating human, and here that human happens
    // to own the task, so the two answers coincide and the field reads ALICE.
    expect(spawns[0]?.ownerUserId).toBe(ALICE)
  })

  it('leaves the owner UNSET when no human initiated the spawn, rather than inventing the task’s', async () => {
    const { svc, spawns, alicesTask } = await harness()
    const issue = await alicesTask()

    // The system/fixture path: nobody delegated this. ADR 3 Amendment 1
    // D17.5/D21.2 — "representable none, never defaulted to an operator or to a
    // row's owner". Falling back to `row.ownerUserId` here is exactly the defect
    // in its quietest form, so the absence is asserted rather than left untested.
    await svc.start(issue.id)

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.ownerUserId).toBeUndefined()
  })
})

describe('the issue command layer supplies the caller’s human to the spawn', () => {
  it('issues.start: BOB at the CLI on ALICE’s task', async () => {
    const { dispatcher, spawns, alicesTask } = await harness()
    const issue = await alicesTask()

    await dispatcher.dispatch({ capability: operator(BOB) }, 'issues', 'start', { id: issue.id })

    expect(spawns).toHaveLength(1)
    // Before the fix the registry passed no owner at all and the workflow filled
    // the gap from the row, so this read ALICE.
    expect(spawns[0]?.ownerUserId).toBe(BOB)
  })

  it('issues.start: BOB’s AGENT on ALICE’s task — the delegating human, not the actor', async () => {
    const { dispatcher, spawns, alicesTask } = await harness()
    const issue = await alicesTask()

    await dispatcher.dispatch({ capability: agentOn(BOB, issue.id, 's_bob') }, 'issues', 'start', {
      id: issue.id,
    })

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.ownerUserId).toBe(BOB)
  })

  it('issues.addSession and issues.addShell carry the caller’s human as well', async () => {
    const { dispatcher, spawns, alicesTask } = await harness()
    const issue = await alicesTask()
    await dispatcher.dispatch({ capability: operator(ALICE) }, 'issues', 'start', { id: issue.id })
    expect(spawns[0]?.ownerUserId).toBe(ALICE)

    await dispatcher.dispatch({ capability: operator(BOB) }, 'issues', 'addSession', {
      id: issue.id,
    })
    await dispatcher.dispatch({ capability: operator(BOB) }, 'issues', 'addShell', { id: issue.id })

    expect(spawns).toHaveLength(3)
    expect(spawns[1]?.ownerUserId).toBe(BOB)
    expect(spawns[2]?.ownerUserId).toBe(BOB)
  })

  /**
   * GREEN BEFORE THE FIX TOO, AND SAID SO RATHER THAN LEFT TO LOOK LIKE A RED
   * ARM. `issues.create` stamps the creator as the new issue's owner, so on this
   * path the task's owner and the initiating human are the same person by
   * construction and the old row lookup happened to reach the right answer
   * (false-green catalogue shape 14, from the other side). It is here as a
   * REGRESSION guard: `createAndMaybeStart` forwards its opts into `start`, and
   * now that `start` no longer consults the row, dropping the owner from that
   * forward would leave `--start` spawning unowned sessions — which nothing else
   * in this file would catch.
   */
  it('issues.create --start: the session belongs to the creator, who is also the new task’s owner', async () => {
    const { dispatcher, spawns } = await harness()

    await dispatcher.dispatch({ capability: operator(BOB) }, 'issues', 'create', {
      repoPath: '/r',
      title: 'Bob’s own task',
      startNow: true,
    })

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.ownerUserId).toBe(BOB)
  })
})
