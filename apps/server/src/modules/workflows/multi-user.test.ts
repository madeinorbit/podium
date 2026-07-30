/**
 * POD-731 — the workflow surface under MORE THAN ONE HUMAN.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CHARACTERIZATION SUITE. That suite runs
 * against the single-user present, where one human owns everything and the
 * ownership port honestly says so; every behaviour it pins therefore stays
 * green. It cannot show that the new decision DENIES anything, because in a
 * one-human world there is nobody to deny.
 *
 * So these tests wire a real multi-user ownership port and a real machine-grant
 * port — the shapes POD-1075 and POD-1079 will fill in — and assert the
 * refusals. Without this file the guards would be mechanism with no coverage:
 * present, plausible, and never once observed saying no.
 *
 * EVERY REFUSAL BELOW HAS A COUNTERFACTUAL. A test that only ever sees `denied`
 * cannot tell a working gate from a gate that refuses everything — including
 * one that refuses the owner too. Each case therefore asserts the SAME call
 * succeeding for the principal who should be allowed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowOwnershipPort, WorkflowUserRef } from '@podium/commands'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import type { WorkflowMachineAccess } from './handlers/context'
import { type WorkflowCaller, WorkflowService } from './service'

const NOW = '2026-07-30T00:00:00.000Z'
const ALICE = 'user:alice'
const BOB = 'user:bob'

const SESSIONS = new Map([
  // Alice's agent, on Alice's machine.
  [
    'a1',
    {
      sessionId: 'a1',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      agentKind: 'claude-code',
      machineId: 'm-alice',
    },
  ],
  // Bob's agent, on Bob's machine.
  [
    'b1',
    {
      sessionId: 'b1',
      cwd: '/repo-b/wt',
      issueId: 'issue-b',
      agentKind: 'claude-code',
      machineId: 'm-bob',
    },
  ],
  // Alice's second agent, parked on BOB's machine — the placement case.
  [
    'a2',
    {
      sessionId: 'a2',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      agentKind: 'codex',
      machineId: 'm-bob',
    },
  ],
  // A session on a machine that exists and is DOWN, so `unauthorized` and
  // `unreachable` have distinct subjects to be distinguished on.
  [
    'a3',
    {
      sessionId: 'a3',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      agentKind: 'codex',
      machineId: 'm-offline',
    },
  ],
])

/**
 * A real two-user ownership port: rows are owned by whoever the test records,
 * grants are an explicit edge set, and NOTHING is ambient.
 *
 * `revoked` is A1's revocation, modelled the way the pack requires it to work —
 * as a fact resolved at every apply, not as a flag copied into a capability
 * when the run started.
 */
function twoUserPolicy() {
  const owners = new Map<string, WorkflowUserRef>()
  const grants = new Set<string>()
  const revoked = new Set<WorkflowUserRef>()
  const machineUse = new Map<WorkflowUserRef, Set<string>>([
    [ALICE, new Set(['m-alice', 'm-offline'])],
    [BOB, new Set(['m-bob'])],
  ])
  const reachable = new Set(['m-alice', 'm-bob'])
  let acting: WorkflowUserRef = ALICE

  const ownership: WorkflowOwnershipPort = {
    ownerOf: (entity) => owners.get(entity.id) ?? null,
    hasGrant: (user, entity, verb) => grants.has(`${user}|${entity.id}|${verb}`),
  }
  const machines: WorkflowMachineAccess = {
    // Resolved against the CURRENT acting human every time (M6: agents inherit
    // machine grants through the A1/A2 intersection — one check, not a
    // separate fleet ACL).
    mayUse: (machineId) => machineUse.get(acting)?.has(machineId) === true,
    isReachable: (machineId) => reachable.has(machineId),
  }
  return {
    ownership,
    machines,
    own: (id: string, user: WorkflowUserRef) => owners.set(id, user),
    grant: (user: WorkflowUserRef, id: string, verb: 'read' | 'write') =>
      grants.add(`${user}|${id}|${verb}`),
    revoke: (user: WorkflowUserRef) => revoked.add(user),
    setActing: (user: WorkflowUserRef) => {
      acting = user
    },
    /**
     * A caller as the transport would build it. `onBehalfOf` resolves the
     * delegation LIVE — a revoked human yields `null`, which is what makes an
     * in-flight run stop advancing with no reaper anywhere.
     */
    caller: (
      sessionId: string | null,
      human: WorkflowUserRef,
      role: 'member' | 'admin' = 'member',
    ): WorkflowCaller => {
      acting = human
      return {
        actor: sessionId ? { kind: 'session', id: sessionId } : { kind: 'operator', id: null },
        ...(sessionId
          ? {
              capability: {
                role: 'worker' as const,
                scope: {
                  kind: 'subtree' as const,
                  rootId: SESSIONS.get(sessionId)?.issueId ?? 'x',
                },
                actorSessionId: sessionId,
              },
            }
          : {}),
        onBehalfOf: revoked.has(human) ? null : human,
        ...(role === 'admin' ? { protectedWrite: true } : {}),
      }
    },
  }
}

type Policy = ReturnType<typeof twoUserPolicy>

function makeHarness(policy: Policy) {
  const store = new SessionStore(':memory:')
  const service = new WorkflowService(
    {
      store: store.workflows,
      now: () => NOW,
      session: (id) => SESSIONS.get(id),
      issue: () => undefined,
      repoIdForPath: (path) =>
        path.startsWith('/repo-a') ? 'repo-a' : path.startsWith('/repo-b') ? 'repo-b' : null,
    },
    { ownership: policy.ownership, machines: policy.machines },
  )
  return { store, service }
}

const thrown = (fn: () => unknown): string => {
  try {
    fn()
    return 'NO THROW'
  } catch (error) {
    return (error as Error).message
  }
}

describe('workflows under two humans', () => {
  let policy: Policy
  let h: ReturnType<typeof makeHarness>

  beforeEach(() => {
    policy = twoUserPolicy()
    h = makeHarness(policy)
  })

  /** Alice's task workflow, owned by Alice. */
  const alicesWorkflow = () => {
    const created = h.service.create(
      {
        name: 'Alice work',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: 'hers',
        steps: [],
      },
      policy.caller('a1', ALICE),
    )
    policy.own(created.workflow.id, ALICE)
    return created
  }

  /**
   * BOB ACTS AS A HUMAN HERE, NOT THROUGH `b1`, AND THAT IS THE POINT.
   *
   * The first version of this test used Bob's AGENT, and a mutation test caught
   * it: with the ownership denial mutated to `allowed` the test still passed,
   * because `b1` was spawned for issue-b and the SCOPE arm refused it. The name
   * claimed ownership; the assertion measured scope. Two guards in series, and
   * the test could not tell which one had fired.
   *
   * A human principal has no agent scope to be held inside (§3.1.3 A2), so the
   * only thing that can refuse Bob below is the ownership decision — which is
   * what the name says. The scope arm keeps its own coverage in the
   * characterization suite.
   */
  it('refuses one member WRITING another member’s workflow, and lets the owner through', () => {
    const created = alicesWorkflow()
    expect(
      thrown(() =>
        h.service.revise(
          { workflowId: created.workflow.id, instructions: 'bob was here', steps: [] },
          policy.caller(null, BOB),
        ),
      ),
      // The message is the unknown-id string, so Bob cannot even confirm the
      // workflow exists (D20.2).
    ).toBe(`unknown workflow: ${created.workflow.id}`)
    // THE COUNTERFACTUAL: Alice writes it as a human, through the same
    // no-agent-scope path, so the refusal above is ownership deciding and not
    // the human path being closed to everyone.
    expect(
      h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2', steps: [] },
        policy.caller(null, ALICE),
      ).version,
    ).toBe(2)
    // …and Alice's own AGENT writes it too, which is the arm the scope check
    // also has to pass.
    expect(
      h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v3', steps: [] },
        policy.caller('a1', ALICE),
      ).version,
    ).toBe(3)
  })

  it('refuses one member READING another member’s workflow, and honours an explicit grant', () => {
    const created = alicesWorkflow()
    expect(thrown(() => h.service.get({ id: created.workflow.id }, policy.caller('b1', BOB)))).toBe(
      `unknown workflow: ${created.workflow.id}`,
    )
    expect(h.service.list({}, policy.caller('b1', BOB))).toEqual([])
    // ADR 9 D2: sharing is EXPLICIT and it is an edge. A read grant opens the
    // read and nothing else — the write stays refused, which is what makes this
    // a grant rather than a transfer.
    policy.grant(BOB, created.workflow.id, 'read')
    // Granted to BOB THE HUMAN, so it is Bob who can read it — not, on its own,
    // Bob's AGENT. §3.1.3 A2: an agent's reach is its own scope INTERSECTED
    // with its human's rights, and `b1` was spawned for issue-b. Sharing a
    // workflow with a colleague does not silently widen every agent they have
    // running, which is the whole point of the intersection being an
    // intersection. That is asserted rather than assumed:
    expect(h.service.get({ id: created.workflow.id }, policy.caller(null, BOB)).workflow.id).toBe(
      created.workflow.id,
    )
    expect(thrown(() => h.service.get({ id: created.workflow.id }, policy.caller('b1', BOB)))).toBe(
      `unknown workflow: ${created.workflow.id}`,
    )
    // …and the read grant does not open the WRITE path for Bob either.
    expect(
      thrown(() =>
        h.service.revise(
          { workflowId: created.workflow.id, instructions: 'x', steps: [] },
          policy.caller(null, BOB),
        ),
      ),
    ).toBe(`unknown workflow: ${created.workflow.id}`)
  })

  it('does not list another member’s RUNS, BINDINGS or PROFILES', () => {
    // The three READ-shaped branches POD-730 pinned. Each one returned the
    // whole instance for an operator, which is a cross-user read the moment
    // there is a second human — so each is asserted separately here rather than
    // trusted to share a code path.
    const created = alicesWorkflow()
    policy.grant(ALICE, created.workflow.id, 'read')
    const admin = policy.caller(null, ALICE, 'admin')
    const published = h.service.publish({ revisionId: created.revision.id }, admin)
    const binding = h.service.assign(
      { targetKind: 'issue', targetId: 'issue-a', revisionId: published.id },
      admin,
    )
    policy.own(`${binding.targetKind}:${binding.targetId}`, ALICE)
    const profile = h.service.profileSave(
      {
        name: 'Alice profile',
        accountId: 'acct-alice',
        harness: 'codex',
        model: 'auto',
        effort: 'auto',
      },
      policy.caller(null, ALICE, 'admin'),
    )
    policy.own(profile.id, ALICE)
    const run = h.service.startRun({
      sessionId: 'a1',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      revisionId: published.id,
    })
    policy.own(run.id, ALICE)

    const bob = () => policy.caller('b1', BOB)
    expect(h.service.runs({}, bob())).toEqual([])
    expect(h.service.bindings({}, bob())).toEqual([])
    expect(h.service.profiles({}, bob())).toEqual([])
    // …and a named run id tells Bob nothing either.
    expect(thrown(() => h.service.status({ runId: run.id }, bob()))).toBe(
      'no active workflow run for this session',
    )

    // THE COUNTERFACTUAL for all four: Alice sees her own. Without this the
    // assertions above would pass against a surface that lists nothing at all.
    expect(h.service.runs({}, policy.caller('a1', ALICE)).map((r) => r.id)).toEqual([run.id])
    expect(h.service.bindings({}, policy.caller('a1', ALICE))).toHaveLength(1)
    expect(h.service.profiles({}, policy.caller(null, ALICE, 'admin'))).toHaveLength(1)
    expect(h.service.status({ runId: run.id }, policy.caller('a1', ALICE)).id).toBe(run.id)
  })

  it('closes the ambient global-scope write path, for a member of either account', () => {
    const global = {
      name: 'Shared library entry',
      description: '',
      scope: 'global' as const,
      instructions: '',
      steps: [],
    }
    expect(thrown(() => h.service.create(global, policy.caller('a1', ALICE)))).toBe(
      'approval required to create a global workflow',
    )
    expect(thrown(() => h.service.create(global, policy.caller('b1', BOB)))).toBe(
      'approval required to create a global workflow',
    )
    // An ADMIN may. The library is admin-grade to WRITE, not unwritable.
    const created = h.service.create(global, policy.caller(null, ALICE, 'admin'))
    expect(created.workflow.scope).toBe('global')
    // …and a member still cannot revise what the admin created, which is the
    // half the shipped `assertWorkflowWrite` left wide open.
    expect(
      thrown(() =>
        h.service.revise(
          { workflowId: created.workflow.id, instructions: 'member edit', steps: [] },
          policy.caller('b1', BOB),
        ),
      ),
    ).toBe('approval required to change a global workflow')
  })

  /**
   * ADR 9 D5 A1, and the case the rule exists for: workflow runs are long-lived
   * and UNATTENDED, so revoking a person must stop their in-flight runs with no
   * reaper to write and none to forget.
   */
  it('stops an IN-FLIGHT run advancing once its delegating human is revoked', () => {
    const created = h.service.create(
      {
        name: 'Long run',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: '',
        steps: [
          { id: 'one', title: 'One', instructions: '', completionGuidance: '' },
          { id: 'two', title: 'Two', instructions: '', completionGuidance: '' },
        ],
      },
      policy.caller('a1', ALICE),
    )
    policy.own(created.workflow.id, ALICE)
    const run = h.service.startRun({
      sessionId: 'a1',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      revisionId: created.revision.id,
    })
    policy.own(run.id, ALICE)
    // The run is live and advancing normally.
    expect(
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'one',
          status: 'complete',
          summary: '',
          evidence: { summary: '', tests: [], artifacts: [] },
        },
        policy.caller('a1', ALICE),
      ).message,
    ).toBe('Step complete. Next: Two')

    // Alice is revoked. NOTHING is done to the run — no reaper runs, no flag is
    // set on it, and the agent's capability is untouched. The next apply simply
    // fails to resolve a delegation.
    policy.revoke(ALICE)

    expect(
      thrown(() =>
        h.service.checkpoint(
          {
            runId: run.id,
            stepId: 'two',
            status: 'complete',
            summary: '',
            evidence: { summary: '', tests: [], artifacts: [] },
          },
          policy.caller('a1', ALICE),
        ),
      ),
    ).toBe('no active workflow run for this session')
    // The step really did not move — the refusal is not cosmetic.
    expect(h.store.workflows.getRunSteps(run.id)[1]?.status).toBe('pending')

    // THE ASSERTION THAT ACTUALLY ISOLATES REVOCATION, and it is here because a
    // mutation test proved the one above does not.
    //
    // Deleting the `onBehalfOf === null` arm entirely left every assertion
    // above still passing: with no human resolved, `ownerOf(run) === null` is
    // false for a run Alice owns, so the MEMBER path denies anyway — for "not
    // the owner", not for "revoked". Two rules in series again, and the first
    // one was doing no observable work.
    //
    // A revoked ADMIN is the case that separates them: without the arm, the
    // admin fallback allows, and the mutant lives. With it, revocation wins
    // over the grade — which is the rule ADR 9 D5 A1 actually states, since a
    // revoked person's rights are gone regardless of what they used to be.
    expect(
      thrown(() =>
        h.service.checkpoint(
          {
            runId: run.id,
            stepId: 'two',
            status: 'complete',
            summary: '',
            evidence: { summary: '', tests: [], artifacts: [] },
          },
          policy.caller(null, ALICE, 'admin'),
        ),
      ),
    ).toBe('no active workflow run for this session')
    // The counterfactual: a NON-revoked admin reaches the same run, so the
    // refusal above is revocation and not admins being locked out of runs.
    expect(
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'two',
          status: 'complete',
          summary: '',
          evidence: { summary: '', tests: [], artifacts: [] },
        },
        policy.caller(null, BOB, 'admin'),
      ).message,
    ).toBe('Workflow complete.')
    // …and the refusal is the same string an unknown run gives, so a revoked
    // principal cannot use its own revocation as an existence oracle.
    expect(thrown(() => h.service.status({ runId: 'wrun_nope' }, policy.caller('a1', ALICE)))).toBe(
      'no active workflow run for this session',
    )
  })

  /**
   * Readiness §3.1.4 M2/M5. `use` is a CODE-EXECUTION boundary — arbitrary
   * execution on someone's hardware with their SSH keys, git identity, dotfiles
   * and checked-out private repos — so this is the ONE decision on the surface
   * where refusing must stay distinguishable from the machine being down.
   */
  it('DENIES assigning a step onto a machine the principal may not use, distinguishably from offline', () => {
    const created = h.service.create(
      {
        name: 'Placement',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: '',
        steps: [{ id: 'one', title: 'One', instructions: '', completionGuidance: '' }],
      },
      policy.caller('a1', ALICE),
    )
    policy.own(created.workflow.id, ALICE)
    const run = h.service.startRun({
      sessionId: 'a1',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      revisionId: created.revision.id,
    })
    policy.own(run.id, ALICE)

    // a2 sits on m-bob, which Alice holds no `use` on.
    expect(
      thrown(() =>
        h.service.assignStep(
          { runId: run.id, stepId: 'one', sessionId: 'a2' },
          policy.caller('a1', ALICE),
        ),
      ),
    ).toBe('not authorized to run work on machine m-bob')
    // a3 sits on m-offline, which Alice DOES hold `use` on and which is down.
    // The two answers differ — M5's requirement — so an operator can tell a
    // permissions problem from a dead machine.
    expect(
      thrown(() =>
        h.service.assignStep(
          { runId: run.id, stepId: 'one', sessionId: 'a3' },
          policy.caller('a1', ALICE),
        ),
      ),
    ).toBe('machine m-offline is unreachable')
    // Neither was silently retargeted: the step is still unassigned.
    expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe(null)
    // THE COUNTERFACTUAL: her own reachable machine works.
    expect(
      h.service.assignStep(
        { runId: run.id, stepId: 'one', sessionId: 'a1' },
        policy.caller('a1', ALICE),
      ).message,
    ).toBe('Step assigned to a1.')
  })

  it('DENIES priming a run onto a machine the principal may not use, at APPLY time', () => {
    const admin = policy.caller(null, ALICE, 'admin')
    const profile = h.service.profileSave(
      {
        name: 'Bob box',
        accountId: 'acct',
        machineId: 'm-alice',
        harness: 'codex',
        model: 'auto',
        effort: 'auto',
      },
      admin,
    )
    policy.own(profile.id, ALICE)
    // Alice may launch it today.
    policy.setActing(ALICE)
    expect(h.service.executionProfileForLaunch({ profileId: profile.id }).machineId).toBe('m-alice')
    // BOB may not — the same pinned profile, a different effective principal.
    // This is the apply-time half: the profile's machine was authorized when it
    // was saved, and authorization is re-taken every time work is placed rather
    // than inherited from the snapshot (ADR 9 D5 A1 / POD-730 §4's warning that
    // a reproducibility snapshot must not become an authorization model).
    policy.setActing(BOB)
    expect(thrown(() => h.service.executionProfileForLaunch({ profileId: profile.id }))).toBe(
      'not authorized to run work on machine m-alice',
    )
  })

  it('refuses a member saving an execution profile, and an admin editing another admin’s', () => {
    const admin = policy.caller(null, ALICE, 'admin')
    const profile = h.service.profileSave(
      {
        name: 'Alice profile',
        accountId: 'acct-alice',
        harness: 'codex',
        model: 'auto',
        effort: 'auto',
      },
      admin,
    )
    policy.own(profile.id, ALICE)
    // A member may not create one at all — ADR 1 D6, managed credentials are
    // admin-grade to manage.
    expect(
      thrown(() =>
        h.service.profileSave(
          {
            name: 'Bob profile',
            accountId: 'acct-bob',
            harness: 'codex',
            model: 'auto',
            effort: 'auto',
          },
          policy.caller('b1', BOB),
        ),
      ),
    ).toBe('only an administrator may change execution profiles')
    // AND A SECOND ADMIN *CAN* EDIT ALICE'S PROFILE. That is what `admin` means
    // in `workflowDecision` — owner-or-admin, with admin last as the fallback —
    // and it is recorded here rather than left to be discovered, because it is
    // the one place on this surface where a grade genuinely overrides an owner.
    //
    // It is defensible for THIS class specifically: an execution profile binds
    // managed credentials to owned compute (ADR 1 D6), and credential
    // administration that the credential's binder could lock an admin out of is
    // not administration. If the pack later wants owner-only profiles, the
    // change is one line in `workflowDecision`, and this assertion is what will
    // fail to announce it.
    expect(
      h.service.profileSave(
        {
          id: profile.id,
          name: 'admin edit',
          accountId: 'acct-bob',
          harness: 'codex',
          model: 'auto',
          effort: 'auto',
        },
        policy.caller(null, BOB, 'admin'),
      ).name,
    ).toBe('admin edit')
    // THE COUNTERFACTUAL: Alice edits her own.
    expect(
      h.service.profileSave(
        {
          id: profile.id,
          name: 'renamed',
          accountId: 'acct-alice',
          harness: 'codex',
          model: 'auto',
          effort: 'auto',
        },
        policy.caller(null, ALICE, 'admin'),
      ).name,
    ).toBe('renamed')
  })
})

describe('run history records the attribution PAIR', () => {
  /**
   * ADR 9 D5 A3 with two real humans, which is the only setting where the pair
   * says anything: under one human both halves are the same value, and a test
   * that asserted them there could not tell a recorded human from a hard-coded
   * one. Here Alice's agent and Bob's agent write to the same history and the
   * rows have to disagree.
   */
  it('names WHICH agent acted and WHICH human it acted for, and they differ per row', () => {
    const policy = twoUserPolicy()
    const h = makeHarness(policy)
    const created = h.service.create(
      {
        name: 'Shared history',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: '',
        steps: [{ id: 'one', title: 'One', instructions: '', completionGuidance: '' }],
      },
      policy.caller('a1', ALICE),
    )
    policy.own(created.workflow.id, ALICE)
    const run = h.service.startRun({
      sessionId: 'a1',
      cwd: '/repo-a/wt',
      issueId: 'issue-a',
      revisionId: created.revision.id,
    })
    policy.own(run.id, ALICE)
    // Bob, an admin, skips a step on Alice's run. ONE row must carry BOTH: the
    // session that acted (a1's coordinator seat is Alice's, but the actor here
    // is the operator channel Bob came in on) and the human accountable for it.
    h.service.skip(
      { runId: run.id, stepId: 'one', reason: 'bob intervened' },
      policy.caller(null, BOB, 'admin'),
    )

    // `workflow_events` has no reader on the repository (POD-730 §9: the table
    // is write-only and reachable only by raw SQL), so the history is read the
    // same way the characterization suite reads it.
    const rows = (h.store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
      .prepare('SELECT kind, actor_kind, actor_id, on_behalf_of FROM workflow_events ORDER BY id')
      .all() as {
      kind: string
      actor_kind: string
      actor_id: string | null
      on_behalf_of: string | null
    }[]
    const created_ = rows.find((r) => r.kind === 'workflow.created')
    const skipped = rows.find((r) => r.kind === 'workflow.step_skipped')
    expect([created_?.actor_id, created_?.on_behalf_of]).toEqual(['a1', ALICE])
    expect([skipped?.actor_kind, skipped?.on_behalf_of]).toEqual(['operator', BOB])
    // THE ASSERTION THAT MATTERS: the two rows name DIFFERENT humans. A hard-
    // coded or actor-derived value could not produce that, and neither could a
    // single collapsed identity — which is exactly what A3 forbids.
    expect(created_?.on_behalf_of).not.toBe(skipped?.on_behalf_of)
  })
})

describe('the ownership port is consulted, not assumed', () => {
  /**
   * THE INSTRUMENT PROBE for this whole file.
   *
   * Every test above asserts a DENIAL. A port that was never wired — because
   * the service quietly fell back to its single-user default — would produce
   * allows, so the reds would be obvious. The reverse mistake is the dangerous
   * one and is not obvious at all: a port wired to a policy that denies
   * everything makes every assertion above pass while proving nothing.
   *
   * So this shows the SAME service, with the SAME port, saying yes.
   */
  it('says YES for an owner before any of its NOs are believed', () => {
    const policy = twoUserPolicy()
    const h = makeHarness(policy)
    const created = h.service.create(
      {
        name: 'Probe',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: '',
        steps: [],
      },
      policy.caller('a1', ALICE),
    )
    policy.own(created.workflow.id, ALICE)
    expect(
      h.service.get({ id: created.workflow.id }, policy.caller('a1', ALICE)).workflow.name,
    ).toBe('Probe')
    expect(h.service.list({}, policy.caller('a1', ALICE))).toHaveLength(1)
  })

  /**
   * …and the other half: an UNOWNED row (every workflow written before
   * ownership columns exist) fails closed rather than reading as everyone's.
   * This is the migration hazard, asserted rather than assumed.
   */
  it('fails closed on a row nobody owns, for a member — and an admin can still reach it', () => {
    const policy = twoUserPolicy()
    const h = makeHarness(policy)
    const created = h.service.create(
      {
        name: 'Legacy',
        description: '',
        scope: 'task',
        scopeRef: 'issue-a',
        instructions: '',
        steps: [],
      },
      policy.caller(null, ALICE, 'admin'),
    )
    // Deliberately NOT recorded as owned — the pre-migration row.
    expect(
      thrown(() => h.service.get({ id: created.workflow.id }, policy.caller('a1', ALICE))),
    ).toBe(`unknown workflow: ${created.workflow.id}`)
    expect(
      h.service.get({ id: created.workflow.id }, policy.caller(null, ALICE, 'admin')).workflow.id,
    ).toBe(created.workflow.id)
  })
})

// The store is in-memory per test; this keeps a stray temp dir from leaking if
// a future case needs a file-backed store.
let tmp: string | undefined
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-multi-user-'))
})
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})
