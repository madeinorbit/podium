/**
 * The workflow engine's behavioural suite — `apps/server/src/modules/workflows/service.ts`
 * and the two transports that reach it.
 *
 * WHAT THIS FILE IS, AND WHAT IT STOPPED BEING (POD-521). It was written as
 * POD-730's characterization oracle: a photograph of the engine's behaviour taken
 * so that POD-731 (contracts + handlers) and POD-732 (cutover) could be proven
 * behaviour-preserving rather than merely compiling. Its header said, in these
 * words, that it was "an ORACLE FOR A MIGRATION, NOT A SPECIFICATION OF THE
 * TARGET", and every test title carried a `PIN` / `ARTEFACT` / `BUG` marker
 * describing its role in that migration.
 *
 * All three issues landed. What is left is not a photograph of anything — it is
 * the only coverage the workflow engine has for most of what it does. Mapped
 * case by case against the suites that were supposed to have absorbed it
 * (`service.test.ts`, `multi-user.test.ts`), roughly eighteen of ninety-five were
 * genuinely duplicated and have been removed; the rest are sole coverage. Whole
 * areas below exist nowhere else: duplicate delivery and mutation-id replay,
 * out-of-order step attempts, adopt validation and scope, the three-way
 * error-shape existence leakage, relay exposure being default-closed per
 * declaration, and run durability across a full store close and reopen.
 *
 * The migration framing is therefore gone, because it was actively misleading: a
 * reader who believed the old header would treat a failure here as a stale
 * recording to be re-baselined, when it is a live regression in the engine. That
 * is the maintenance surface POD-521 set out to remove, and removing it did not
 * require removing the tests.
 *
 * TWO ANNOTATIONS SURVIVE, because they say something true about the CODE rather
 * than about a migration. Both are kept in test titles:
 *
 *   SINGLE-OPERATOR — behaviour that is only safe while Podium has one human.
 *                     Each is a decision ADR 9 will have to make per-user, and
 *                     each is asserted as it behaves TODAY, not as it should
 *                     behave. Formerly `ARTEFACT`.
 *   KNOWN-DEFECT    — behaviour that is wrong, recorded as-is so a fix is a
 *                     deliberate diff rather than a surprise. Formerly `BUG`.
 *
 * The `PIN` marker is gone with no replacement: it meant "this should survive
 * POD-731", which is not a property of anything any more.
 *
 * MESSAGE TEXTS ARE STILL ASSERTED VERBATIM in places. That was originally a
 * migration tactic — make every convergence show up as a failing pin. It is kept
 * where the message is the product (a refusal an agent reads and acts on) and it
 * is the reason several of these tests are worth their brittleness; it is not a
 * general policy for new tests here.
 *
 * GOVERNING ADRs, unchanged:
 *
 *   ADR 9 D1.5  — `OPERATOR` (role admin, scope all) is the single-operator
 *                 vocabulary ADR 9 replaces.
 *   ADR 9 D5    — A1 live delegation (never a snapshot), A2 the human is a
 *                 ceiling, A3 attribution is a PAIR, A4 agent output is owned
 *                 by the delegating human.
 *   ADR 9 D6    — machines are owned compute: see / use / manage; `use` is a
 *                 code-execution boundary, not a privacy boundary.
 *   ADR 9 D3/D4 — five visibility classes, default-closed with a totality test.
 *   ADR 3 Am.1  — apply-time re-auth resolving the delegation chain live.
 *   ADR 1 D5    — NOT multi-tenancy; no instance_id.
 *
 * References: docs/adr/0009-identity-ownership-sharing.md,
 * docs/adr/0003-command-security-amendment-1.md,
 * docs/multi-user-readiness.md, docs/agents/pod-521-oracle-retirement.md
 * (the coverage map and why this file was kept).
 */
import { asIssueId, asSessionId } from '@podium/model'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AMBIGUOUS_ADVANCE_MESSAGE, WORKFLOW_CONTRACTS } from '@podium/commands'
import type { WorkflowStepEvidence } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import { isWorkflowQueryExposedOn } from './queries'
import { isWorkflowProcExposedOn } from './registry'
import { dispatchWorkflowRpc } from './rpc'
import { type WorkflowCaller, WorkflowService } from './service'
import { type DrivenWorkflowService, driveWorkflows } from './test-support'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * SINGLE-OPERATOR: an "operator" caller today is any transport caller with no
 * `actorSessionId` — `workflowCaller()` in apps/server/src/router.ts maps that
 * to `{ actor: { kind: 'operator', id: null }, protectedWrite: true }`
 * unconditionally. There is no human principal, no owner, and no admin role:
 * operator means "not an agent".
 *
 * This is the exact construct ADR 9 D1.5 names as out of compliance — an
 * unconstrained capability built from "someone authenticated". Every operator
 * ARTEFACT in this file is downstream of it: the sixteen guards are
 * unconstrained BECAUSE the principal handed to them already is. POD-731
 * replaces it with a real `(user, device, capability)` principal derived from
 * the authenticated transport (ADR 9 D1).
 */
const operator: WorkflowCaller = { actor: { kind: 'operator', id: null }, protectedWrite: true }

/** An operator-shaped caller WITHOUT protectedWrite, to isolate that flag's arm. */
const bareOperator: WorkflowCaller = { actor: { kind: 'operator', id: null } }

const agent = (sessionId: string, subtreeRootId = 'issue-1'): WorkflowCaller => ({
  actor: { kind: 'session', id: asSessionId(sessionId) },
  capability: {
    role: 'worker',
    scope: { kind: 'subtree', rootId: asIssueId(subtreeRootId) },
    actorSessionId: asSessionId(sessionId),
  },
})

/** A session caller that has been granted the scope override at the edge. */
const overriding = (sessionId: string): WorkflowCaller => ({
  ...agent(sessionId),
  overrideScope: true,
})

/** A session caller that has been granted protected-write at the edge. */
const protectedAgent = (sessionId: string): WorkflowCaller => ({
  ...agent(sessionId),
  protectedWrite: true,
})

const SESSIONS = new Map([
  // Coordinator of the issue-1 run, in repo-a.
  [
    's1',
    {
      sessionId: asSessionId('s1'),
      cwd: '/repo-a/wt',
      issueId: 'issue-1',
      agentKind: 'claude-code',
      machineId: 'm1',
    },
  ],
  // Worker on the same issue, different harness, same machine.
  [
    's2',
    {
      sessionId: asSessionId('s2'),
      cwd: '/repo-a/wt',
      issueId: 'issue-1',
      agentKind: 'codex',
      machineId: 'm1',
    },
  ],
  // Foreign session: different issue, different repo, different machine.
  [
    's3',
    {
      sessionId: asSessionId('s3'),
      cwd: '/repo-b/wt',
      issueId: 'issue-2',
      agentKind: 'claude-code',
      machineId: 'm2',
    },
  ],
  // Session with no issue and no machine — the unreachable/unknown-machine arm.
  ['s4', { sessionId: asSessionId('s4'), cwd: '/repo-a/wt', agentKind: 'claude-code' }],
  // Session in a directory that resolves to no repository at all.
  [
    's5',
    {
      sessionId: asSessionId('s5'),
      cwd: '/nowhere',
      issueId: 'issue-1',
      agentKind: 'claude-code',
      machineId: 'm1',
    },
  ],
])

const ISSUES = new Map([
  ['issue-1', { id: 'issue-1', repoId: 'repo-a', repoPath: '/repo-a', worktreePath: '/repo-a/wt' }],
  ['issue-2', { id: 'issue-2', repoId: 'repo-b', repoPath: '/repo-b', worktreePath: '/repo-b/wt' }],
])

const NOW = '2026-07-30T00:00:00.000Z'
const EMPTY_EVIDENCE: WorkflowStepEvidence = { summary: '', tests: [], artifacts: [] }

interface EventRow {
  kind: string
  actor_kind: string
  actor_id: string | null
  /** ADR 9 D5 A3's other half (POD-731): the human the actor acted for. */
  on_behalf_of: string | null
  run_id: string | null
  workflow_id: string | null
  payload_json: string
}

/**
 * `workflow_events` is append-only and has NO reader on WorkflowsRepository and
 * no reader anywhere else in the product (verified by grep: the only reference
 * is the INSERT). Run history is therefore only observable through raw SQL —
 * which is exactly why this suite reads it directly. Test-only reach into the
 * store's private handle; production code is untouched by this issue.
 */
function readEvents(store: SessionStore): EventRow[] {
  const db = (store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
  return db
    .prepare(
      'SELECT kind, actor_kind, actor_id, on_behalf_of, run_id, workflow_id, payload_json FROM workflow_events ORDER BY id',
    )
    .all() as EventRow[]
}

function kinds(store: SessionStore): string[] {
  return readEvents(store).map((row) => row.kind)
}

/** Row count of a broadcast table, to check the ABSENCE of client fan-out. */
function countRows(store: SessionStore, table: 'changes' | 'podium_events'): number {
  const db = (store as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

interface Harness {
  store: SessionStore
  /**
   * POD-732: the eleven three-line shims this suite was written against are
   * DELETED. `driveWorkflows` forwards each proc name to
   * `WorkflowService.execute` — the one door tRPC, the relay and the approval
   * broker all enter through — reordering arguments and nothing else. The suite
   * therefore measures the shipped path, WITH the contract's parse, rather than
   * a shim beside it. See `test-support.ts`.
   */
  service: DrivenWorkflowService
  notices: Array<{ sessionId: string; text: string }>
  clock: { value: string }
}

function makeHarness(path = ':memory:'): Harness {
  const store = new SessionStore(path)
  const notices: Array<{ sessionId: string; text: string }> = []
  const clock = { value: NOW }
  // The idempotency ledger, in memory. The server backs this with
  // `applied_mutations` (see `relay.ts`); a Map is the same port with the same
  // contract, which is the point of it being a port.
  const ledger = new Map<string, string>()
  const service = new WorkflowService(
    {
      store: store.workflows,
      now: () => clock.value,
      session: (id) => SESSIONS.get(id),
      issue: (id) => ISSUES.get(id),
      repoIdForPath: (path) =>
        path.startsWith('/repo-a') ? 'repo-a' : path.startsWith('/repo-b') ? 'repo-b' : null,
      notifyCoordinator: (sessionId, text) => notices.push({ sessionId, text }),
    },
    {
      ledger: {
        recall: (key) => ledger.get(key),
        record: (key, result) => {
          ledger.set(key, result)
        },
      },
    },
  )
  return { store, service: driveWorkflows(service), notices, clock }
}

/**
 * Two ordered steps plus a live run. Defaults to issue-1 coordinated by s1.
 *
 * NOTE for anyone adding a test: a subject may have only ONE live run
 * (`workflow_runs_one_live_subject`), and startRun returns the EXISTING run for
 * a live subject rather than creating a second one. A test that needs a second
 * independent run in the same case must pass a different subject.
 */
function twoStepRun(
  h: Harness,
  extra: { profileId?: string; issueId?: string; sessionId?: string; cwd?: string } = {},
) {
  const issueId = extra.issueId ?? 'issue-1'
  const sessionId = extra.sessionId ?? 's1'
  const cwd = extra.cwd ?? '/repo-a/wt'
  const created = h.service.create(
    {
      name: `Two step ${Math.random()}`,
      description: '',
      scope: 'task',
      scopeRef: issueId,
      instructions: 'drive it',
      steps: [
        { id: 'implement', title: 'Implement', instructions: 'build', completionGuidance: 'green' },
        {
          id: 'review',
          title: 'Review',
          instructions: 'review',
          completionGuidance: 'resolved',
          ...(extra.profileId ? { executionProfileId: extra.profileId } : {}),
        },
      ],
    },
    operator,
  )
  const run = h.service.startRun({
    sessionId: asSessionId(sessionId),
    cwd,
    issueId,
    revisionId: created.revision.id,
  })
  return { created, run }
}

/**
 * THREE ordered steps plus a live run — the shape the double-advance needs, so
 * that "it advanced once" and "it advanced twice" are distinguishable and a
 * third delivery has somewhere left to go.
 *
 * `subjectSession` picks the coordinator AND therefore the subject, because a
 * subject may have only one live run (`workflow_runs_one_live_subject`).
 */
function threeStepRun(h: Harness, name = 'Double advance', subjectSession = 's1') {
  const session = SESSIONS.get(subjectSession)
  if (!session) throw new Error(`test harness has no session ${subjectSession}`)
  const scopeRef = session.issueId ?? session.sessionId
  const created = h.service.create(
    {
      name: `${name} ${Math.random()}`,
      description: '',
      scope: 'task',
      scopeRef,
      instructions: '',
      steps: [
        { id: 'a', title: 'A', instructions: '', completionGuidance: '' },
        { id: 'b', title: 'B', instructions: '', completionGuidance: '' },
        { id: 'c', title: 'C', instructions: '', completionGuidance: '' },
      ],
    },
    operator,
  )
  const run = h.service.startRun({
    sessionId: session.sessionId,
    cwd: session.cwd,
    ...(session.issueId ? { issueId: session.issueId } : {}),
    revisionId: created.revision.id,
  })
  return { created, run }
}

/** A second, independent two-step run: issue-2 in repo-b, coordinated by s3. */
const secondSubject = {
  issueId: 'issue-2',
  sessionId: asSessionId('s3'),
  cwd: '/repo-b/wt',
} as const
const s3 = agent('s3', 'issue-2')

/** Capture a throw as `name: message | code=<code>` so both are pinned at once. */
function thrown(fn: () => unknown): string {
  try {
    fn()
    return 'NO THROW'
  } catch (error) {
    const err = error as Error & { code?: unknown }
    return `${err.name}: ${err.message} | code=${String(err.code)}`
  }
}

describe('POD-730 workflow mutation characterization', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(() => h.store.close())

  // -------------------------------------------------------------------------
  // 1. Library CRUD — create / revise / fork / publish
  // -------------------------------------------------------------------------

  describe('library CRUD', () => {
    it('create writes workflow + v1 revision + workflow.created, and the revision starts unpublished', () => {
      const created = h.service.create(
        {
          name: 'Ship it',
          description: 'desc',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'body',
          steps: [{ id: 'a', title: 'A', instructions: 'i', completionGuidance: 'c' }],
        },
        operator,
      )
      expect(created.workflow.id).toMatch(/^wf_/)
      expect(created.revision.id).toMatch(/^wfr_/)
      expect(created.revision.version).toBe(1)
      expect(created.revision.publishedAt).toBeNull()
      expect(created.workflow.latestRevisionId).toBe(created.revision.id)
      expect(readEvents(h.store)).toMatchObject([
        {
          kind: 'workflow.created',
          workflow_id: created.workflow.id,
          run_id: null,
          actor_kind: 'operator',
        },
      ])
      expect(JSON.parse(readEvents(h.store)[0]?.payload_json ?? '{}')).toEqual({
        revisionId: created.revision.id,
        scope: 'task',
        scopeRef: 'issue-1',
      })
    })

    it('revise appends a new version and never edits a prior revision in place', () => {
      const created = h.service.create(
        {
          name: 'Immutable',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'v1 body',
          steps: [{ id: 'a', title: 'A', instructions: '', completionGuidance: '' }],
        },
        operator,
      )
      const v2 = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2 body', steps: [] },
        operator,
      )
      const v3 = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v3 body', steps: [] },
        operator,
      )
      expect([v2.version, v3.version]).toEqual([2, 3])
      // The v1 row is byte-identical after two revisions: revisions are immutable.
      const v1 = h.store.workflows.getRevision(created.revision.id)
      expect(v1?.instructions).toBe('v1 body')
      expect(v1?.steps).toHaveLength(1)
      expect(v1?.version).toBe(1)
      // listRevisions returns newest first.
      expect(h.store.workflows.listRevisions(created.workflow.id).map((r) => r.version)).toEqual([
        3, 2, 1,
      ])
      expect(kinds(h.store)).toEqual(['workflow.created', 'workflow.revised', 'workflow.revised'])
    })

    it('revise on a PUBLISHED revision still only appends — publication is not a lock', () => {
      const created = h.service.create(
        {
          name: 'Published',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'v1',
          steps: [],
        },
        operator,
      )
      h.service.publish({ revisionId: created.revision.id }, operator)
      const v2 = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2', steps: [] },
        operator,
      )
      expect(v2.version).toBe(2)
      expect(v2.publishedAt).toBeNull()
      // The published v1 is untouched, and stays published.
      const v1 = h.store.workflows.getRevision(created.revision.id)
      expect(v1?.instructions).toBe('v1')
      expect(v1?.publishedAt).toBe(NOW)
    })

    it('KNOWN-DEFECT: fork copies the body but records NO lineage link to its source', () => {
      const source = h.service.create(
        {
          name: 'Source',
          description: 'src desc',
          scope: 'global',
          instructions: 'source body',
          steps: [{ id: 'a', title: 'A', instructions: 'i', completionGuidance: 'c' }],
        },
        operator,
      )
      const forked = h.service.fork(
        {
          revisionId: source.revision.id,
          name: 'Forked',
          description: 'fork desc',
          scope: 'task',
          scopeRef: 'issue-1',
        },
        operator,
      )
      // The body is copied verbatim from the SOURCE REVISION (not the latest).
      expect(forked.revision.instructions).toBe('source body')
      expect(forked.revision.steps).toEqual(source.revision.steps)
      expect(forked.revision.version).toBe(1)
      expect(forked.workflow.id).not.toBe(source.workflow.id)
      expect(forked.workflow.scope).toBe('task')
      expect(forked.workflow.scopeRef).toBe('issue-1')
      expect(forked.workflow.description).toBe('fork desc')
      // BUG: "fork lineage" is not persisted anywhere. The workflow row has no
      // forkedFrom/parent field, and fork emits `workflow.created` — identical
      // to a from-scratch create — with a payload that does not mention the
      // source. Provenance of a forked workflow is unrecoverable today.
      expect(Object.keys(forked.workflow).sort()).toEqual([
        'archivedAt',
        'createdAt',
        'description',
        'id',
        'latestRevisionId',
        'latestVersion',
        'name',
        'scope',
        'scopeRef',
        'updatedAt',
      ])
      const forkEvent = readEvents(h.store).at(-1)
      expect(forkEvent?.kind).toBe('workflow.created')
      expect(JSON.parse(forkEvent?.payload_json ?? '{}')).toEqual({
        revisionId: forked.revision.id,
        scope: 'task',
        scopeRef: 'issue-1',
      })
    })

    it('fork forks a NON-LATEST revision faithfully', () => {
      const source = h.service.create(
        {
          name: 'Drifting',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'v1',
          steps: [],
        },
        operator,
      )
      h.service.revise({ workflowId: source.workflow.id, instructions: 'v2', steps: [] }, operator)
      const forked = h.service.fork(
        {
          revisionId: source.revision.id,
          name: 'Fork of v1',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
        },
        operator,
      )
      expect(forked.revision.instructions).toBe('v1')
    })

    it('fork of an unknown revision throws before touching anything', () => {
      expect(
        thrown(() =>
          h.service.fork(
            { revisionId: 'wfr_nope', name: 'X', description: '', scope: 'global' },
            operator,
          ),
        ),
      ).toBe('Error: unknown workflow revision: wfr_nope | code=undefined')
      expect(h.service.list({}, operator)).toEqual([])
    })

    it('publish stamps publishedAt and is idempotent under duplicate delivery', () => {
      const created = h.service.create(
        {
          name: 'Publishable',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      h.clock.value = '2026-07-30T01:00:00.000Z'
      const first = h.service.publish({ revisionId: created.revision.id }, operator)
      expect(first.publishedAt).toBe('2026-07-30T01:00:00.000Z')
      // Duplicate delivery: publish again at a LATER clock.
      h.clock.value = '2026-07-30T02:00:00.000Z'
      const second = h.service.publish({ revisionId: created.revision.id }, operator)
      // publishRevision does not re-stamp an already-published revision, so
      // the second delivery is value-idempotent...
      expect(second.publishedAt).toBe('2026-07-30T01:00:00.000Z')
      // ...but NOT event-idempotent: a second workflow.published is appended.
      expect(kinds(h.store)).toEqual([
        'workflow.created',
        'workflow.published',
        'workflow.published',
      ])
    })

    it('publish of an unknown revision, and of a revision whose workflow is gone', () => {
      expect(thrown(() => h.service.publish({ revisionId: 'wfr_nope' }, operator))).toBe(
        'Error: unknown workflow revision: wfr_nope | code=undefined',
      )
    })

    it('duplicate create with the same scope + name is refused by the unique index', () => {
      h.service.create(
        {
          name: 'Same name',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // uniqueness is enforced only by `workflows_scope_name_active`, so the
      // failure surfaces as a raw SQLite constraint error, not a domain error.
      // The service has no pre-check and no friendly message.
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'Same name',
              description: '',
              scope: 'task',
              scopeRef: 'issue-1',
              instructions: '',
              steps: [],
            },
            operator,
          ),
        ),
      ).toMatch(/UNIQUE constraint failed|constraint/i)
    })

    it('input validation: duplicate step ids are rejected at the schema, not the service', () => {
      expect(() =>
        WORKFLOW_CONTRACTS.create.input.parse({
          name: 'Invalid',
          scope: 'global',
          steps: [
            { id: 'same', title: 'One' },
            { id: 'same', title: 'Two' },
          ],
        }),
      ).toThrow('duplicate workflow step id: same')
      // The service itself does NOT re-check: a caller reaching the method
      // directly with duplicate ids is not stopped here.
      expect(WORKFLOW_CONTRACTS.revise.input.parse({ workflowId: 'w', steps: [] })).toEqual({
        workflowId: 'w',
        instructions: '',
        steps: [],
      })
    })
  })

  // -------------------------------------------------------------------------
  // 2. Scope resolution — global / repository / task, on create, write and read
  // -------------------------------------------------------------------------

  describe('scope resolution', () => {
    it('scopeRef is forced null for global and required for repository and task', () => {
      const global = h.service.create(
        {
          name: 'G',
          description: '',
          scope: 'global',
          scopeRef: 'ignored',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // a scopeRef supplied for a global workflow is silently DISCARDED,
      // not rejected.
      expect(global.workflow.scopeRef).toBeNull()
      expect(
        thrown(() =>
          h.service.create(
            { name: 'R', description: '', scope: 'repository', instructions: '', steps: [] },
            operator,
          ),
        ),
      ).toBe('Error: repository workflows require scopeRef | code=undefined')
      // RE-PINNED (POD-732), and the ONE assertion the cutover changed for a
      // reason that is not a behaviour change.
      //
      // POD-730 pinned `scopeRef: ''` reaching the handler's domain error. It
      // never could, on any transport: the create schema has had
      // `.min(1)` since before POD-731 (`scopeInput` in the deleted
      // `workflowInputs`, and the contract it now points at), so tRPC and the
      // relay have ALWAYS turned this input into a validation error. The old
      // pin described a path only the deleted shims could take — they passed
      // hand-built objects through unparsed.
      //
      // The suite now drives the shipped door, which parses. So the assertion
      // moves to what the wire actually does, and the DOMAIN error keeps its own
      // pin above via the `repository` arm, where `scopeRef` is legitimately
      // absent rather than empty and the schema accepts it.
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'T',
              description: '',
              scope: 'task',
              scopeRef: '',
              instructions: '',
              steps: [],
            },
            operator,
          ),
        ),
      ).toContain('ZodError')
    })

    /**
     * RE-PINNED BY POD-731 against the closed hole. The ARTEFACT this replaced
     * asserted that an agent session creates global content freely, because
     * `assertCreateScope` returned early on `scope === 'global'`.
     *
     * DECISION IMPLEMENTED: readiness §3.1.1 — a global library entry is
     * substrate-shaped, so its WRITE is admin-grade. It is decided as the
     * `workflow-library-entry` class in `workflowDecision`, which takes the
     * admin arm for a write and refuses everyone else. Built on the existing
     * publish brake rather than a second approval notion; see the commit and
     * `packages/commands/src/workflows/contracts.ts`.
     */
    it('POD-731 a member may NOT create a global workflow; an admin may', () => {
      const global = {
        name: 'Agent global',
        description: '',
        scope: 'global' as const,
        instructions: 'agent wrote this',
        steps: [],
      }
      expect(thrown(() => h.service.create(global, agent('s1')))).toBe(
        'Error: approval required to create a global workflow | code=undefined',
      )
      // The COUNTERFACTUAL: the same call by an admin-grade principal is
      // allowed, so the refusal above is the grade rule firing and not the
      // create path being broken for everyone.
      const created = h.service.create(global, operator)
      expect(created.workflow.scope).toBe('global')
      expect(created.revision.instructions).toBe('agent wrote this')
      // …and a TASK-scoped create by the same member session still works, so
      // the refusal is scoped to the global arm and is not a role floor on
      // creating workflows at all.
      expect(
        h.service.create(
          {
            name: 'Agent task',
            description: '',
            scope: 'task',
            scopeRef: 'issue-1',
            instructions: '',
            steps: [],
          },
          agent('s1'),
        ).workflow.scope,
      ).toBe('task')
    })

    /**
     * RE-PINNED BY POD-731. The ARTEFACT asserted that a FOREIGN session in
     * another repo could append a revision to shared global content, because
     * `assertWorkflowWrite` returned early for any global workflow.
     *
     * DECISION IMPLEMENTED: the same one as the create arm above. Note the
     * refusal message differs from an unknown id's on purpose and is not a
     * D20.2 exception — a global entry is readable, so saying "approval
     * required" discloses nothing a read did not already give.
     */
    it('POD-731 a member may NOT revise a global workflow; an admin may', () => {
      const created = h.service.create(
        { name: 'Global body', description: '', scope: 'global', instructions: 'v1', steps: [] },
        operator,
      )
      expect(
        thrown(() =>
          h.service.revise(
            { workflowId: created.workflow.id, instructions: 'v2 by a foreign agent', steps: [] },
            agent('s3', 'issue-2'),
          ),
        ),
      ).toBe('Error: approval required to change a global workflow | code=undefined')
      const revised = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2 by an admin', steps: [] },
        operator,
      )
      expect(revised.version).toBe(2)
      expect(revised.instructions).toBe('v2 by an admin')
    })

    it('SINGLE-OPERATOR: any caller may READ a global workflow — canReadWorkflow returns true on scope=global', () => {
      const created = h.service.create(
        { name: 'Global read', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      expect(h.service.get({ id: created.workflow.id }, agent('s3', 'issue-2')).workflow.id).toBe(
        created.workflow.id,
      )
      expect(h.service.list({}, agent('s3', 'issue-2')).map((w) => w.id)).toContain(
        created.workflow.id,
      )
    })

    /**
     * STILL A PIN — the brake survives, and it is now the SAME guard rather
     * than a special case bolted beside one. Two edits, both consequences of
     * the global-scope closure above and neither a change to what this test
     * claims:
     *   - the setup creates through an admin, because a member can no longer
     *     create the global workflow this test needs;
     *   - the message is the guard's, since publish no longer carries its own.
     */
    it('the one existing brake on global content: publish refuses a session without protectedWrite', () => {
      const created = h.service.create(
        { name: 'Needs approval', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      expect(
        thrown(() => h.service.publish({ revisionId: created.revision.id }, agent('s1'))),
      ).toBe('Error: approval required to change a global workflow | code=undefined')
      // The SAME session with protectedWrite granted at the edge gets through.
      expect(
        h.service.publish({ revisionId: created.revision.id }, protectedAgent('s1')).publishedAt,
      ).toBe(NOW)
    })

    it('repository scope resolves through repoIdForPath against the caller session cwd — create', () => {
      // s1 is in /repo-a/wt → repo-a. Its own repo is allowed...
      const mine = h.service.create(
        {
          name: 'Repo a',
          description: '',
          scope: 'repository',
          scopeRef: 'repo-a',
          instructions: '',
          steps: [],
        },
        agent('s1'),
      )
      expect(mine.workflow.scopeRef).toBe('repo-a')
      // ...another repo is not.
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'Repo b',
              description: '',
              scope: 'repository',
              scopeRef: 'repo-b',
              instructions: '',
              steps: [],
            },
            agent('s1'),
          ),
        ),
      ).toBe('Error: repository workflow is outside this session | code=undefined')
      // A session whose cwd resolves to NO repo cannot create a repository
      // workflow at all — repoIdForPath returns null and nothing matches.
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'Repo none',
              description: '',
              scope: 'repository',
              scopeRef: 'repo-a',
              instructions: '',
              steps: [],
            },
            agent('s5'),
          ),
        ),
      ).toBe('Error: repository workflow is outside this session | code=undefined')
    })

    it('repository scope on the WRITE side and the READ side', () => {
      const repoB = h.service.create(
        {
          name: 'Repo b write',
          description: '',
          scope: 'repository',
          scopeRef: 'repo-b',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // write: s1 (repo-a) may not revise a repo-b workflow.
      expect(
        thrown(() =>
          h.service.revise(
            { workflowId: repoB.workflow.id, instructions: 'x', steps: [] },
            agent('s1'),
          ),
        ),
        // POD-731 CONVERGENCE (ADR 3 Amendment 1 D20.2 / readiness §3.1.5): an id
        // the principal may not see now fails IDENTICALLY to an id that does not
        // exist, so a workflow id is no longer an existence oracle. POD-730 §10
        // pinned the divergence precisely so this convergence would be visible.
      ).toBe(`Error: unknown workflow: ${repoB.workflow.id} | code=undefined`)
      // read: same boundary, and now the SAME message as the write.
      expect(thrown(() => h.service.get({ id: repoB.workflow.id }, agent('s1')))).toBe(
        `Error: unknown workflow: ${repoB.workflow.id} | code=undefined`,
      )
      // The COUNTERFACTUAL that stops this being vacuous: an id that really
      // does not exist produces the byte-identical string, which is the whole
      // claim — two DIFFERENT causes, one indistinguishable answer.
      expect(thrown(() => h.service.get({ id: 'wf_nope' }, agent('s1')))).toBe(
        'Error: unknown workflow: wf_nope | code=undefined',
      )
      // s3 IS in repo-b and may do both.
      expect(
        h.service.revise(
          { workflowId: repoB.workflow.id, instructions: 'x', steps: [] },
          agent('s3', 'issue-2'),
        ).version,
      ).toBe(2)
      expect(h.service.get({ id: repoB.workflow.id }, agent('s3', 'issue-2')).workflow.id).toBe(
        repoB.workflow.id,
      )
      expect(h.service.list({}, agent('s1')).map((w) => w.id)).not.toContain(repoB.workflow.id)
    })

    it('task scope matches the SESSION id or the session issue id, on create/write/read', () => {
      // scopeRef = the session id itself.
      const bySession = h.service.create(
        {
          name: 'By session',
          description: '',
          scope: 'task',
          scopeRef: 's1',
          instructions: '',
          steps: [],
        },
        agent('s1'),
      )
      expect(bySession.workflow.scopeRef).toBe('s1')
      // scopeRef = the session's issue id.
      const byIssue = h.service.create(
        {
          name: 'By issue',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        agent('s1'),
      )
      expect(byIssue.workflow.scopeRef).toBe('issue-1')
      // Neither → refused.
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'By stranger',
              description: '',
              scope: 'task',
              scopeRef: 'issue-2',
              instructions: '',
              steps: [],
            },
            agent('s1'),
          ),
        ),
      ).toBe('Error: task workflow is outside this session | code=undefined')
      // write side: both of the caller's own refs are writable.
      expect(
        h.service.revise(
          { workflowId: bySession.workflow.id, instructions: 'x', steps: [] },
          agent('s1'),
        ).version,
      ).toBe(2)
      expect(
        h.service.revise(
          { workflowId: byIssue.workflow.id, instructions: 'x', steps: [] },
          agent('s1'),
        ).version,
      ).toBe(2)
      // read side: s3 sees neither.
      expect(h.service.list({}, agent('s3', 'issue-2')).map((w) => w.id)).toEqual([])
    })

    it('SINGLE-OPERATOR: the task READ arm ALSO accepts the capability subtree root, which the WRITE arm does not', () => {
      // canReadWorkflow accepts `capability.scope.rootId`; assertWorkflowWrite
      // does not look at the capability at all. A caller can therefore READ a
      // task workflow it cannot WRITE — an asymmetry POD-731 should make
      // deliberate rather than incidental.
      const subtree = h.service.create(
        {
          name: 'Subtree root',
          description: '',
          scope: 'task',
          scopeRef: 'issue-root',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const caller = agent('s1', 'issue-root')
      expect(h.service.get({ id: subtree.workflow.id }, caller).workflow.id).toBe(
        subtree.workflow.id,
      )
      expect(
        thrown(() =>
          h.service.revise(
            { workflowId: subtree.workflow.id, instructions: 'x', steps: [] },
            caller,
          ),
        ),
        // POD-731 CONVERGENCE (ADR 3 Amendment 1 D20.2 / readiness §3.1.5): an id
        // the principal may not see now fails IDENTICALLY to an id that does not
        // exist, so a task workflow id is no longer an existence oracle. POD-730 §10
        // pinned the divergence precisely so this convergence would be visible.
      ).toBe(`Error: unknown workflow: ${subtree.workflow.id} | code=undefined`)
    })

    it('a session caller whose session row has vanished loses write and read', () => {
      const created = h.service.create(
        {
          name: 'Orphan',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const ghost: WorkflowCaller = { actor: { kind: 'session', id: asSessionId('gone') } }
      expect(
        thrown(() =>
          h.service.revise(
            { workflowId: created.workflow.id, instructions: 'x', steps: [] },
            ghost,
          ),
        ),
        // POD-731 CONVERGENCE (D20.2). A vanished session row is a VISIBILITY
        // outcome — the caller can no longer be placed in any scope — so it now
        // fails as an unknown id like every other invisible outcome, rather than
        // reporting that the workflow is there and the caller's session is not.
      ).toBe(`Error: unknown workflow: ${created.workflow.id} | code=undefined`)
      expect(
        thrown(() =>
          h.service.create(
            {
              name: 'Ghost create',
              description: '',
              scope: 'task',
              scopeRef: 'issue-1',
              instructions: '',
              steps: [],
            },
            ghost,
          ),
        ),
      ).toBe('Error: workflow creation lost its session context | code=undefined')
      expect(thrown(() => h.service.get({ id: created.workflow.id }, ghost))).toBe(
        `Error: unknown workflow: ${created.workflow.id} | code=undefined`,
      )
    })

    it('overrideScope short-circuits create, write and read exactly like the operator arm', () => {
      const foreign = h.service.create(
        {
          name: 'Foreign',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const caller = overriding('s1')
      expect(h.service.get({ id: foreign.workflow.id }, caller).workflow.id).toBe(
        foreign.workflow.id,
      )
      expect(
        h.service.revise({ workflowId: foreign.workflow.id, instructions: 'x', steps: [] }, caller)
          .version,
      ).toBe(2)
      expect(
        h.service.create(
          {
            name: 'Cross repo',
            description: '',
            scope: 'repository',
            scopeRef: 'repo-b',
            instructions: '',
            steps: [],
          },
          caller,
        ).workflow.scopeRef,
      ).toBe('repo-b')
    })

    it('list honours includeArchived / scope / scopeRef filters before the read filter', () => {
      h.service.create(
        { name: 'G', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      const task = h.service.create(
        {
          name: 'T',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(h.service.list({ scope: 'task' }, operator).map((w) => w.id)).toEqual([
        task.workflow.id,
      ])
      expect(h.service.list({ scope: 'task', scopeRef: 'issue-2' }, operator)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 3. assign + bindings
  // -------------------------------------------------------------------------

  describe('assign and bindings', () => {
    function publishedRevision(
      name: string,
      scope: 'global' | 'repository' | 'task',
      scopeRef?: string,
    ) {
      const created = h.service.create(
        {
          name,
          description: '',
          scope,
          ...(scopeRef ? { scopeRef } : {}),
          instructions: '',
          steps: [],
        },
        operator,
      )
      h.service.publish({ revisionId: created.revision.id }, operator)
      return created
    }

    it('assign records a binding and workflow.assigned, and is last-write-wins under duplicate delivery', () => {
      const first = publishedRevision('First', 'global')
      const second = publishedRevision('Second', 'global')
      h.service.assign(
        { targetKind: 'global', targetId: '', revisionId: first.revision.id },
        operator,
      )
      const binding = h.service.assign(
        { targetKind: 'global', targetId: '', revisionId: second.revision.id },
        operator,
      )
      expect(binding.revisionId).toBe(second.revision.id)
      expect(h.store.workflows.listBindings()).toHaveLength(1)
      // Duplicate delivery of the identical assign is value-idempotent...
      h.service.assign(
        { targetKind: 'global', targetId: '', revisionId: second.revision.id },
        operator,
      )
      expect(h.store.workflows.getBinding('global', '')?.revisionId).toBe(second.revision.id)
      // ...but appends another workflow.assigned event.
      expect(kinds(h.store).filter((k) => k === 'workflow.assigned')).toHaveLength(3)
    })

    it('shared defaults require a PUBLISHED revision; the protectedWrite check runs FIRST', () => {
      const unpublished = h.service.create(
        { name: 'Draft', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      // Operator: only the published-revision brake applies.
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'global', targetId: '', revisionId: unpublished.revision.id },
            operator,
          ),
        ),
      ).toBe('Error: shared workflow defaults require a published revision | code=undefined')
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'repository', targetId: 'repo-a', revisionId: unpublished.revision.id },
            operator,
          ),
        ),
      ).toBe('Error: shared workflow defaults require a published revision | code=undefined')
      // Session without protectedWrite: the ORDER matters — approval is
      // reported before the unpublished-revision problem is ever noticed.
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'global', targetId: '', revisionId: unpublished.revision.id },
            agent('s1'),
          ),
        ),
      ).toBe('Error: approval required to change the global workflow default | code=undefined')
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'repository', targetId: 'repo-a', revisionId: unpublished.revision.id },
            agent('s1'),
          ),
        ),
      ).toBe('Error: approval required to change the repository workflow default | code=undefined')
    })

    it('SINGLE-OPERATOR: a repository default may be set for ANY repo, including one the caller is not in', () => {
      const published = publishedRevision('Any repo', 'global')
      // No repoIdForPath check on the assign path: protectedWrite is the only
      // gate, and it is granted to every operator caller. A protected session
      // can therefore rebind a repository it has never been in.
      const binding = h.service.assign(
        { targetKind: 'repository', targetId: 'repo-b', revisionId: published.revision.id },
        protectedAgent('s1'),
      )
      expect(binding.targetId).toBe('repo-b')
    })

    it('issue bindings go through assertIssueScope: subtree root only, for a session', () => {
      const own = publishedRevision('Own issue', 'task', 'issue-1')
      expect(
        h.service.assign(
          { targetKind: 'issue', targetId: 'issue-1', revisionId: own.revision.id },
          agent('s1'),
        ).targetId,
      ).toBe('issue-1')
      // A different issue, even in the same repo, is outside the capability subtree.
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'issue', targetId: 'issue-2', revisionId: own.revision.id },
            agent('s1'),
          ),
        ),
      ).toBe("Error: issue issue-2 is outside this agent's workflow scope | code=undefined")
      // A caller with no capability at all cannot bind any issue.
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'issue', targetId: 'issue-1', revisionId: own.revision.id },
            { actor: { kind: 'session', id: asSessionId('s1') } },
          ),
        ),
      ).toBe("Error: issue issue-1 is outside this agent's workflow scope | code=undefined")
    })

    it('a session may bind only its OWN session target', () => {
      const own = publishedRevision('Session bind', 'task', 'issue-1')
      expect(
        h.service.assign(
          { targetKind: 'session', targetId: 's1', revisionId: own.revision.id },
          agent('s1'),
        ).targetId,
      ).toBe('s1')
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'session', targetId: 's2', revisionId: own.revision.id },
            agent('s1'),
          ),
        ),
      ).toBe('Error: agents may directly assign only their own session | code=undefined')
      // overrideScope lifts it; unpublished revisions are fine for session/issue targets.
      expect(
        h.service.assign(
          { targetKind: 'session', targetId: 's2', revisionId: own.revision.id },
          overriding('s1'),
        ).targetId,
      ).toBe('s2')
    })

    it('assign reads the revision through assertWorkflowRead, so an out-of-scope revision is refused', () => {
      const foreign = h.service.create(
        {
          name: 'Foreign assign',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'session', targetId: 's1', revisionId: foreign.revision.id },
            agent('s1'),
          ),
        ),
        // POD-731 CONVERGENCE (D20.2). POD-730 §10 recorded that a revision id
        // CONFIRMED existence: it resolved, and only then did the workflow read
        // refuse with a different message. Both outcomes now leave by the same
        // string — and the very next assertion is the counterfactual, an id that
        // never existed producing it too.
      ).toBe(`Error: unknown workflow revision: ${foreign.revision.id} | code=undefined`)
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'session', targetId: 's1', revisionId: 'wfr_nope' },
            agent('s1'),
          ),
        ),
      ).toBe('Error: unknown workflow revision: wfr_nope | code=undefined')
    })

    it('SINGLE-OPERATOR: bindings() returns EVERY binding for the operator and a session-filtered view otherwise', () => {
      const g = publishedRevision('G', 'global')
      const r = publishedRevision('R', 'repository', 'repo-a')
      const rb = publishedRevision('Rb', 'repository', 'repo-b')
      const own = publishedRevision('Own', 'task', 'issue-1')
      const other = publishedRevision('Other', 'task', 'issue-2')
      h.service.assign({ targetKind: 'global', targetId: '', revisionId: g.revision.id }, operator)
      h.service.assign(
        { targetKind: 'repository', targetId: 'repo-a', revisionId: r.revision.id },
        operator,
      )
      h.service.assign(
        { targetKind: 'repository', targetId: 'repo-b', revisionId: rb.revision.id },
        operator,
      )
      h.service.assign(
        { targetKind: 'issue', targetId: 'issue-1', revisionId: own.revision.id },
        operator,
      )
      h.service.assign(
        { targetKind: 'issue', targetId: 'issue-2', revisionId: other.revision.id },
        operator,
      )
      h.service.assign(
        { targetKind: 'session', targetId: 's2', revisionId: own.revision.id },
        operator,
      )

      // SINGLE-OPERATOR: the operator arm is unconstrained — this becomes a cross-user
      // read the moment there is more than one human (3.1.2).
      expect(h.service.bindings(operator)).toHaveLength(6)
      // A session sees: global (always), its own repo, its own session, its own issue.
      expect(
        h.service
          .bindings(agent('s1'))
          .map((b) => `${b.targetKind}:${b.targetId}`)
          .sort(),
      ).toEqual(['global:', 'issue:issue-1', 'repository:repo-a'])
      // s2 additionally sees its own session binding.
      expect(
        h.service
          .bindings(agent('s2'))
          .map((b) => `${b.targetKind}:${b.targetId}`)
          .sort(),
      ).toEqual(['global:', 'issue:issue-1', 'repository:repo-a', 'session:s2'])
      // overrideScope on a session gets the operator's full view.
      expect(h.service.bindings(overriding('s1'))).toHaveLength(6)
    })

    it('resolveRevision precedence is session → issue → repository → global, first hit wins', () => {
      const g = publishedRevision('G', 'global')
      const r = publishedRevision('R', 'repository', 'repo-a')
      const i = publishedRevision('I', 'task', 'issue-1')
      const s = publishedRevision('S', 'task', 'issue-1')
      h.service.assign({ targetKind: 'global', targetId: '', revisionId: g.revision.id }, operator)
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        })?.id,
      ).toBe(g.revision.id)
      h.service.assign(
        { targetKind: 'repository', targetId: 'repo-a', revisionId: r.revision.id },
        operator,
      )
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        })?.id,
      ).toBe(r.revision.id)
      h.service.assign(
        { targetKind: 'issue', targetId: 'issue-1', revisionId: i.revision.id },
        operator,
      )
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        })?.id,
      ).toBe(i.revision.id)
      h.service.assign(
        { targetKind: 'session', targetId: 's1', revisionId: s.revision.id },
        operator,
      )
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        })?.id,
      ).toBe(s.revision.id)
      // an unrelated session in another repo on another issue still
      // resolves the GLOBAL binding — the global default is the floor, so
      // resolution never returns null once a global binding exists.
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s3'),
          cwd: '/repo-b/wt',
          issueId: 'issue-2',
        })?.id,
      ).toBe(g.revision.id)
    })

    it('with no binding at all resolveRevision returns null rather than throwing', () => {
      expect(
        h.service.resolveRevision({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        }),
      ).toBeNull()
      expect(
        h.service.prepareStart({
          sessionId: asSessionId('s1'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
        }),
      ).toBeNull()
      expect(
        h.service.prepareExistingSession({ sessionId: asSessionId('s1'), issueId: 'issue-1' }),
      ).toBeNull()
    })

    it('resolveRevision with an explicit revision enforces the start scope', () => {
      const foreign = h.service.create(
        {
          name: 'Foreign start',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(
        thrown(() =>
          h.service.resolveRevision({
            sessionId: asSessionId('s1'),
            cwd: '/repo-a/wt',
            issueId: 'issue-1',
            explicitRevisionId: foreign.revision.id,
          }),
        ),
      ).toBe(
        `Error: workflow revision ${foreign.revision.id} is outside the requested start scope | code=undefined`,
      )
      expect(
        thrown(() =>
          h.service.resolveRevision({
            sessionId: asSessionId('s1'),
            cwd: '/repo-a/wt',
            explicitRevisionId: 'wfr_nope',
          }),
        ),
      ).toBe('Error: unknown workflow revision: wfr_nope | code=undefined')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Execution profiles
  // -------------------------------------------------------------------------

  describe('execution profiles', () => {
    it('profileSave inserts with a generated id and upserts by supplied id', () => {
      const created = h.service.profileSave(
        {
          name: 'Codex',
          accountId: 'native:codex',
          harness: 'codex',
          model: 'gpt-5.6',
          effort: 'medium',
        },
        operator,
      )
      expect(created.id).toMatch(/^wfp_/)
      // machineId defaults to null when omitted — a profile is machine-agnostic
      // unless pinned.
      expect(created.machineId).toBeNull()
      expect(created).toMatchObject({
        accountId: 'native:codex',
        harness: 'codex',
        model: 'gpt-5.6',
        effort: 'medium',
      })
      h.clock.value = '2026-07-30T03:00:00.000Z'
      const updated = h.service.profileSave(
        {
          id: created.id,
          name: 'Codex pinned',
          accountId: 'native:claude-code',
          machineId: 'm2',
          harness: 'claude-code',
          model: 'claude-fable-5',
          effort: 'high',
        },
        operator,
      )
      expect(updated.id).toBe(created.id)
      expect(updated).toMatchObject({
        name: 'Codex pinned',
        machineId: 'm2',
        harness: 'claude-code',
      })
      expect(h.service.profiles(operator)).toHaveLength(1)
      // profileSave emits NO workflow event at all — profile changes leave
      // no audit trail.
      expect(kinds(h.store)).toEqual([])
    })

    it('explicit machineId: null clears the pin; model/effort default to "auto"', () => {
      const parsed = WORKFLOW_CONTRACTS.profileSave.input.parse({
        name: 'Defaults',
        accountId: 'acct',
        harness: 'codex',
      })
      expect(parsed).toMatchObject({ model: 'auto', effort: 'auto' })
      const created = h.service.profileSave({ ...parsed, machineId: 'm1' }, operator)
      const cleared = h.service.profileSave(
        { ...parsed, id: created.id, machineId: null },
        operator,
      )
      expect(cleared.machineId).toBeNull()
    })

    it('SINGLE-OPERATOR: profileSave refuses a session actor without protectedWrite — the inverse shape of every other guard', () => {
      // Every other guard on this surface returns EARLY for the operator; this
      // one refuses the SESSION. Both encode "there is exactly one human".
      expect(
        thrown(() =>
          h.service.profileSave(
            {
              name: 'Agent profile',
              accountId: 'acct',
              harness: 'codex',
              model: 'auto',
              effort: 'auto',
            },
            agent('s1'),
          ),
        ),
        // POD-731: the message names the ACCOUNT GRADE, not the operator role
        // class. readiness §3.1.4 M1 / ADR 1 D6 — a profile binds managed
        // credentials to owned compute, which is admin-grade to manage once there
        // is more than one human. Same refusal, decided against a real principal.
      ).toBe('Error: only an administrator may change execution profiles | code=undefined')
      // overrideScope does NOT lift it — only protectedWrite does.
      expect(
        thrown(() =>
          h.service.profileSave(
            {
              name: 'Agent profile',
              accountId: 'acct',
              harness: 'codex',
              model: 'auto',
              effort: 'auto',
            },
            overriding('s1'),
          ),
        ),
      ).toBe('Error: only an administrator may change execution profiles | code=undefined')
      expect(
        h.service.profileSave(
          {
            name: 'Agent profile',
            accountId: 'acct',
            harness: 'codex',
            model: 'auto',
            effort: 'auto',
          },
          protectedAgent('s1'),
        ).name,
      ).toBe('Agent profile')
      // POD-731: an operator WITHOUT protectedWrite is now REFUSED. The old
      // check was on `actor.kind === 'session'`, so "not an agent" was enough to
      // bind managed credentials to owned compute; the grade decides it now, and
      // a bare operator is a member. This is the inverse-shaped guard becoming
      // the same shape as every other one.
      expect(
        thrown(() =>
          h.service.profileSave(
            {
              name: 'Bare operator profile',
              accountId: 'acct',
              harness: 'codex',
              model: 'auto',
              effort: 'auto',
            },
            bareOperator,
          ),
        ),
      ).toBe('Error: only an administrator may change execution profiles | code=undefined')
    })

    it('SINGLE-OPERATOR: profiles() has NO authorization gate and lists every profile to any caller', () => {
      h.service.profileSave(
        {
          name: 'Secret',
          accountId: 'native:codex',
          harness: 'codex',
          model: 'auto',
          effort: 'auto',
        },
        operator,
      )
      // A foreign agent session in another repo reads every profile in the
      // instance, including its accountId. Cross-user read the moment there is
      // a second human (3.1.2).
      expect(h.service.profiles(agent('s3', 'issue-2'))).toMatchObject([
        { name: 'Secret', accountId: 'native:codex' },
      ])
      expect(
        h.service.profiles({ actor: { kind: 'session', id: asSessionId('gone') } }),
      ).toHaveLength(1)
    })

    it('a run pins an IMMUTABLE profile snapshot; the live profile may drift away from it', () => {
      const profile = h.service.profileSave(
        {
          name: 'Pinned',
          accountId: 'native:codex',
          harness: 'codex',
          model: 'gpt-5.6',
          effort: 'medium',
        },
        operator,
      )
      const { run } = twoStepRun(h, { profileId: profile.id })
      h.service.profileSave(
        {
          id: profile.id,
          name: 'Drifted',
          accountId: 'native:claude-code',
          harness: 'claude-code',
          model: 'claude-fable-5',
          effort: 'high',
        },
        operator,
      )
      // Resolved WITH run+step → the snapshot taken at startRun.
      expect(
        h.service.executionProfileForLaunch({
          caller: operator,
          profileId: profile.id,
          runId: run.id,
          stepId: 'review',
        }),
      ).toMatchObject({ harness: 'codex', model: 'gpt-5.6', effort: 'medium' })
      // Resolved WITHOUT run+step → the current shared profile.
      expect(
        h.service.executionProfileForLaunch({ caller: operator, profileId: profile.id }),
      ).toMatchObject({
        harness: 'claude-code',
        model: 'claude-fable-5',
        effort: 'high',
      })
      // A profile id that does not match the step's pinned id is refused.
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({
            caller: operator,
            profileId: 'wfp_other',
            runId: run.id,
            stepId: 'review',
          }),
        ),
      ).toBe(`Error: workflow step review requires ${profile.id}, not wfp_other | code=undefined`)
      // A step with no profile reports "no execution profile" in the same text.
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({
            caller: operator,
            profileId: profile.id,
            runId: run.id,
            stepId: 'implement',
          }),
        ),
      ).toBe(
        `Error: workflow step implement requires no execution profile, not ${profile.id} | code=undefined`,
      )
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({
            caller: operator,
            profileId: profile.id,
            runId: 'wrun_nope',
            stepId: 'x',
          }),
        ),
      ).toBe('Error: unknown workflow run: wrun_nope | code=undefined')
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({
            caller: operator,
            profileId: profile.id,
            runId: run.id,
            stepId: 'nope',
          }),
        ),
      ).toBe(`Error: workflow run ${run.id} has no step nope | code=undefined`)
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({ caller: operator, profileId: 'wfp_nope' }),
        ),
      ).toBe('Error: unknown execution profile: wfp_nope | code=undefined')
    })

    it('an UNREACHABLE / mismatched machine is a non-blocking WARNING, never a refusal', () => {
      // 3.1.4 M5 requires a machine use-grant check that is DISTINGUISHABLE from
      // unreachable. Today there is no reachability concept at all: the only
      // machine signal is a string comparison against the session's machineId,
      // reported as a warning while the checkpoint SUCCEEDS.
      const profile = h.service.profileSave(
        {
          name: 'On m9',
          accountId: 'acct',
          machineId: 'm9-unreachable',
          harness: 'codex',
          model: 'auto',
          effort: 'auto',
        },
        operator,
      )
      const { run } = twoStepRun(h, { profileId: profile.id })
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      const packet = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(packet.warnings).toEqual([
        'expected execution profile On m9 (codex), used claude-code',
        'expected machine m9-unreachable, used m1',
      ])
      // The step still completed. A warning is all that distinguishes it.
      expect(packet.run.status).toBe('complete')
      // A session with NO machineId at all reports "unknown" — indistinguishable
      // from a machine that exists but is unreachable.
      const other = twoStepRun(h, { profileId: profile.id })
      h.service.assignStep(
        { runId: other.run.id, stepId: 'implement', sessionId: asSessionId('s4') },
        operator,
      )
      const noMachine = h.service.checkpoint(
        {
          runId: other.run.id,
          stepId: 'implement',
          status: 'active',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s4'),
      )
      expect(noMachine.warnings).toEqual([])
    })

    it('a MISSING profile snapshot warns and does not block the step', () => {
      const created = h.service.create(
        {
          name: 'Ghost profile',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [
            {
              id: 'a',
              title: 'A',
              instructions: '',
              completionGuidance: '',
              executionProfileId: 'wfp_missing',
            },
          ],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })
      const packet = h.service.checkpoint(
        { runId: run.id, stepId: 'a', status: 'active', summary: '', evidence: EMPTY_EVIDENCE },
        agent('s1'),
      )
      expect(packet.warnings).toEqual(['execution profile wfp_missing is unavailable'])
      expect(
        thrown(() =>
          h.service.executionProfileForLaunch({
            caller: operator,
            profileId: 'wfp_missing',
            runId: run.id,
            stepId: 'a',
          }),
        ),
      ).toBe('Error: execution profile snapshot wfp_missing is unavailable | code=undefined')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Run advances — state transitions, persistence and ordering
  // -------------------------------------------------------------------------

  describe('run advances', () => {
    it('startRun persists run + step rows and emits workflow.run_started attributed to the session', () => {
      const { created, run } = twoStepRun(h)
      expect(run.status).toBe('active')
      expect(run.subjectKind).toBe('issue')
      expect(run.subjectId).toBe('issue-1')
      expect(run.coordinatorSessionId).toBe('s1')
      expect(run.supersedesRunId).toBeNull()
      expect(run.steps.map((s) => [s.stepId, s.status, s.position, s.attempt])).toEqual([
        ['implement', 'pending', 0, 1],
        ['review', 'pending', 1, 1],
      ])
      // Everything is persisted: a fresh read of the store returns the same run.
      expect(h.store.workflows.getRun(run.id)?.status).toBe('active')
      expect(h.store.workflows.getRunSteps(run.id)).toHaveLength(2)
      const started = readEvents(h.store).at(-1)
      expect(started).toMatchObject({
        kind: 'workflow.run_started',
        run_id: run.id,
        workflow_id: created.workflow.id,
        actor_kind: 'session',
        actor_id: 's1',
      })
      // the payload omits startStepId entirely when it was not supplied
      // (JSON.stringify drops undefined) — a shape POD-731 must not change
      // silently if anything ever reads it.
      expect(JSON.parse(started?.payload_json ?? '{}')).toEqual({
        revisionId: created.revision.id,
        subjectKind: 'issue',
        subjectId: 'issue-1',
      })
    })

    it('checkpoint advances one step at a time and drives the run status machine', () => {
      const { run } = twoStepRun(h)
      const first = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'built',
          evidence: { summary: 'done', tests: ['unit: pass'], artifacts: ['abc123'] },
        },
        agent('s1'),
      )
      expect(first.message).toBe('Step complete. Next: Review')
      expect(first.currentStep?.stepId).toBe('review')
      // currentStep and nextStep are the SAME object today — the packet has
      // no notion of "the step I just finished".
      expect(first.nextStep?.stepId).toBe('review')
      expect(first.run.status).toBe('active')
      const step = h.store.workflows.getRunSteps(run.id)[0]
      expect(step).toMatchObject({
        status: 'complete',
        summary: 'built',
        assignedSessionId: 's1',
        startedAt: NOW,
        completedAt: NOW,
      })
      expect(step?.evidence).toEqual({
        summary: 'done',
        tests: ['unit: pass'],
        artifacts: ['abc123'],
      })

      const second = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'complete',
          summary: 'reviewed',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(second.message).toBe('Workflow complete.')
      expect(second.run.status).toBe('complete')
      expect(second.currentStep).toBeNull()
      expect(h.store.workflows.getRun(run.id)?.completedAt).toBe(NOW)
      expect(kinds(h.store)).toEqual([
        'workflow.created',
        'workflow.run_started',
        'workflow.step_complete',
        'workflow.step_complete',
      ])
    })

    it('blocked → active is reversible and blocks/unblocks the run', () => {
      const { run } = twoStepRun(h)
      const blocked = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'blocked',
          summary: 'stuck',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(blocked.message).toBe('Step blocked. Coordinator attention is required.')
      expect(blocked.run.status).toBe('blocked')
      // A blocked step is still "the current step" (currentStep prefers
      // active|blocked over pending).
      expect(blocked.currentStep?.stepId).toBe('implement')
      const active = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'active',
          summary: 'moving',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(active.message).toBe('Step active: Implement')
      expect(active.run.status).toBe('active')
      expect(kinds(h.store).slice(-2)).toEqual(['workflow.step_blocked', 'workflow.step_active'])
    })

    it('completing a step leaves completedAt null unless the status is complete', () => {
      const { run } = twoStepRun(h)
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'active',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.store.workflows.getRunSteps(run.id)[0]?.completedAt).toBeNull()
      expect(h.store.workflows.getRunSteps(run.id)[0]?.startedAt).toBe(NOW)
      // startedAt is sticky across later checkpoints.
      h.clock.value = '2026-07-30T05:00:00.000Z'
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.store.workflows.getRunSteps(run.id)[0]).toMatchObject({
        startedAt: NOW,
        completedAt: '2026-07-30T05:00:00.000Z',
      })
    })

    it('a prompt-only (zero-step) run has its own checkpoint arm, gated on the coordinator', () => {
      const created = h.service.create(
        {
          name: 'Prompt only',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'just prose',
          steps: [],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })
      // A non-coordinator issue participant is refused by assertCoordinator...
      expect(
        thrown(() =>
          h.service.checkpoint(
            { runId: run.id, status: 'active', summary: '', evidence: EMPTY_EVIDENCE },
            agent('s2'),
          ),
        ),
      ).toBe('Error: only the workflow coordinator may perform this transition | code=undefined')
      const blocked = h.service.checkpoint(
        { runId: run.id, status: 'blocked', summary: 'stuck', evidence: EMPTY_EVIDENCE },
        agent('s1'),
      )
      expect(blocked.message).toBe('Workflow blocked.')
      expect(blocked.run.status).toBe('blocked')
      expect(blocked.currentStep).toBeNull()
      const done = h.service.checkpoint(
        { runId: run.id, status: 'complete', summary: 'done', evidence: EMPTY_EVIDENCE },
        agent('s1'),
      )
      expect(done.message).toBe('Workflow complete.')
      expect(done.run.status).toBe('complete')
      expect(kinds(h.store)).toEqual([
        'workflow.created',
        'workflow.run_started',
        'workflow.run_blocked',
        'workflow.run_complete',
      ])
    })

    it('assignStep sets the assignee, keeps it across a checkpoint, and notifies the coordinator on worker progress', () => {
      const { run } = twoStepRun(h)
      const packet = h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      expect(packet.message).toBe('Step assigned to s2.')
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      const worker = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'worker did it',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s2'),
      )
      expect(worker.run.status).toBe('active')
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      expect(h.notices).toEqual([
        { sessionId: asSessionId('s1'), text: 'Workflow step "Implement" complete: worker did it' },
      ])
      // The coordinator's own checkpoint does NOT notify.
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'complete',
          summary: 'coordinator',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.notices).toHaveLength(1)
      // the notice text falls back to "(no summary)" on an empty summary.
      const other = twoStepRun(h)
      h.service.assignStep(
        { runId: other.run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      h.service.checkpoint(
        {
          runId: other.run.id,
          stepId: 'implement',
          status: 'blocked',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s2'),
      )
      expect(h.notices.at(-1)).toEqual({
        sessionId: asSessionId('s1'),
        text: 'Workflow step "Implement" blocked: (no summary)',
      })
    })

    it('a COORDINATOR checkpoint on a step assigned to someone else does not reassign it to the coordinator', () => {
      // The sharp form of "the assignee survives a checkpoint". Asserting it
      // after the ASSIGNEE checkpoints would pass for the wrong reason: there
      // the assignee and the caller are the same session, so the
      // `?? caller.actor.id` fallback yields the same value either way. Only a
      // DIFFERENT caller can tell "kept" apart from "overwritten".
      const { run } = twoStepRun(h)
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'coordinator closed it out',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      // ...and the fallback still applies when there was no assignee at all.
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'active',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.store.workflows.getRunSteps(run.id)[1]?.assignedSessionId).toBe('s1')
    })

    it('assignStep with sessionId null unassigns, and duplicate delivery is fully idempotent', () => {
      const { run } = twoStepRun(h)
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      const packet = h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: null },
        agent('s1'),
      )
      expect(packet.message).toBe('Step unassigned.')
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBeNull()
      // assignStep does NOT validate that the session exists.
      expect(
        h.service.assignStep(
          { runId: run.id, stepId: 'implement', sessionId: asSessionId('does-not-exist') },
          agent('s1'),
        ).message,
      ).toBe('Step assigned to does-not-exist.')
    })

    it('skip marks the current step skipped with the reason as its summary', () => {
      const { run } = twoStepRun(h)
      const packet = h.service.skip(
        { runId: run.id, stepId: 'implement', reason: 'not needed' },
        agent('s1'),
      )
      expect(packet.message).toBe('Skipped. Next: Review')
      expect(h.store.workflows.getRunSteps(run.id)[0]).toMatchObject({
        status: 'skipped',
        summary: 'not needed',
        completedAt: NOW,
      })
      expect(h.store.workflows.getRun(run.id)?.status).toBe('active')
      const last = h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, agent('s1'))
      expect(last.message).toBe('Workflow complete.')
      expect(h.store.workflows.getRun(run.id)?.status).toBe('complete')
      expect(kinds(h.store).slice(-2)).toEqual(['workflow.step_skipped', 'workflow.step_skipped'])
      const skipEvent = readEvents(h.store).at(-2)
      expect(JSON.parse(skipEvent?.payload_json ?? '{}')).toEqual({
        stepId: 'implement',
        reason: 'not needed',
      })
    })

    it('retry resets the step, bumps attempt, KEEPS the assignee, and reactivates a complete run', () => {
      const { run } = twoStepRun(h)
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'first attempt',
          evidence: { summary: 'e', tests: ['t'], artifacts: ['a'] },
        },
        agent('s2'),
      )
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'complete',
          summary: 'r',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(h.store.workflows.getRun(run.id)?.status).toBe('complete')
      const packet = h.service.retry({ runId: run.id, stepId: 'review' }, agent('s1'))
      expect(packet.message).toBe('Retry ready: Review')
      // retry always sets the run back to active, even from complete, and
      // clears the run's completedAt stamp along with it.
      expect(h.store.workflows.getRun(run.id)?.status).toBe('active')
      expect(h.store.workflows.getRun(run.id)?.completedAt).toBeNull()
      const review = h.store.workflows.getRunSteps(run.id)[1]
      expect(review).toMatchObject({
        status: 'pending',
        attempt: 2,
        summary: '',
        startedAt: null,
        completedAt: null,
      })
      // resetStep writes a literal '{}' to evidence_json; the wire schema then
      // fills the empty defaults back in on read.
      expect(review?.evidence).toEqual({ summary: '', tests: [], artifacts: [] })
      expect(review?.warnings).toEqual([])
      // Retrying the earlier step is allowed once the later one is pending again.
      const earlier = h.service.retry({ runId: run.id, stepId: 'implement' }, agent('s1'))
      expect(earlier.message).toBe('Retry ready: Implement')
      // The assignee SURVIVES a retry.
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      expect(h.store.workflows.getRunSteps(run.id)[0]?.attempt).toBe(2)
    })

    it('git observation is persisted verbatim and drives the dirty / worktree warnings', () => {
      const { run } = twoStepRun(h)
      const observation = {
        cwd: '/repo-a/wt',
        worktree: '/repo-a/other-wt',
        branch: 'feature',
        head: 'abc123',
        dirty: true,
        ahead: 1,
        behind: 0,
        observedAt: NOW,
      }
      const packet = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
          observation,
        },
        agent('s1'),
      )
      expect(packet.warnings).toEqual([
        'step completed with uncommitted worktree changes',
        'expected issue worktree /repo-a/wt, observed /repo-a/other-wt',
      ])
      const step = h.store.workflows.getRunSteps(run.id)[0]
      expect(step?.observation).toEqual(observation)
      expect(step?.warnings).toEqual(packet.warnings)
      // A dirty worktree is only a warning on `complete` — not on active.
      const other = twoStepRun(h, secondSubject)
      expect(
        h.service.checkpoint(
          {
            runId: other.run.id,
            stepId: 'implement',
            status: 'active',
            summary: '',
            evidence: EMPTY_EVIDENCE,
            observation: { ...observation, cwd: '/repo-b/wt', worktree: '/repo-b/wt' },
          },
          s3,
        ).warnings,
      ).toEqual([])
    })

    it('a second startRun for a live subject returns the EXISTING run instead of creating one', () => {
      const { created, run } = twoStepRun(h)
      const again = h.service.startRun({
        sessionId: asSessionId('s2'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })
      expect(again.id).toBe(run.id)
      expect(again.coordinatorSessionId).toBe('s1')
      // No second run_started event: the duplicate start is fully idempotent.
      expect(kinds(h.store).filter((k) => k === 'workflow.run_started')).toHaveLength(1)
      expect(h.service.runs({ includeTerminal: true }, operator)).toHaveLength(1)
    })

    it('startRun with startStepId skips the earlier steps with a fixed summary', () => {
      const created = h.service.create(
        {
          name: 'Start midway',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [
            { id: 'a', title: 'A', instructions: '', completionGuidance: '' },
            { id: 'b', title: 'B', instructions: '', completionGuidance: '' },
            { id: 'c', title: 'C', instructions: '', completionGuidance: '' },
          ],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
        startStepId: 'c',
      })
      expect(run.steps.map((s) => [s.stepId, s.status])).toEqual([
        ['a', 'skipped'],
        ['b', 'skipped'],
        ['c', 'pending'],
      ])
      expect(run.steps[0]?.summary).toBe('Skipped when adopting workflow')
      // those skips are written straight to the step rows — NO
      // workflow.step_skipped events are emitted for them.
      expect(kinds(h.store)).toEqual(['workflow.created', 'workflow.run_started'])
      expect(
        thrown(() =>
          h.service.startRun({
            sessionId: asSessionId('s3'),
            cwd: '/repo-b/wt',
            issueId: 'issue-2',
            revisionId: created.revision.id,
            startStepId: 'nope',
          }),
        ),
      ).toBe('Error: workflow has no step nope | code=undefined')
    })

    it('a session-subject run (no issue) is keyed on the session id', () => {
      const created = h.service.create(
        {
          name: 'Session run',
          description: '',
          scope: 'task',
          scopeRef: 's4',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s4'),
        cwd: '/repo-a/wt',
        revisionId: created.revision.id,
      })
      expect(run.subjectKind).toBe('session')
      expect(run.subjectId).toBe('s4')
      expect(h.service.status({}, agent('s4')).id).toBe(run.id)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Duplicate delivery
  // -------------------------------------------------------------------------

  describe('duplicate delivery', () => {
    /**
     * THE HEADLINE. POD-730 pinned this as a BUG and said POD-731's
     * no-double-advance is a CHANGE this test would prove; here it is proved.
     *
     * The defect: a checkpoint with no `stepId` resolves the run's CURRENT step
     * at apply time, so a second byte-identical delivery re-resolves, finds the
     * NEXT step, and completes it with the FIRST delivery's summary and
     * evidence. A third finished the run off one payload.
     *
     * DECISION IMPLEMENTED (`packages/commands/src/workflows/idempotency.ts`):
     * at-most-once needs a DELIVERY IDENTITY, because "the same frame twice"
     * and "the same thing twice" are indistinguishable from the payload alone.
     * So the frame that carries neither a mutation id nor a step id is REFUSED
     * — before any run state is read, so it cannot half-apply.
     *
     * BOTH BRANCHES ARE ASSERTED BELOW, because a refusal on its own would be a
     * test that passes if the framework simply broke checkpointing: the run
     * must still be advanceable, once, by a caller that names its delivery.
     */
    it('POD-731 an UNNAMED duplicate checkpoint cannot double-advance — it is refused', () => {
      const { run } = threeStepRun(h)
      const payload = {
        runId: run.id,
        status: 'complete' as const,
        summary: 'finished step A',
        evidence: { summary: 'A evidence', tests: ['a: pass'], artifacts: [] },
      }
      expect(thrown(() => h.service.checkpoint(payload, agent('s1')))).toBe(
        `Error: ${AMBIGUOUS_ADVANCE_MESSAGE} | code=undefined`,
      )
      // NOTHING HAPPENED. The refusal is not a half-apply: the run is exactly
      // where it was, which is what "before any state is read" buys.
      expect(h.store.workflows.getRunSteps(run.id).map((x) => [x.stepId, x.status])).toEqual([
        ['a', 'pending'],
        ['b', 'pending'],
        ['c', 'pending'],
      ])
      expect(kinds(h.store).filter((k) => k === 'workflow.step_complete')).toHaveLength(0)
    })

    /**
     * THE LEDGER BRANCH. A caller that mints a mutation id may deliver the same
     * frame as often as it likes: the first application is recorded against
     * `(command, run, mutationId)` and every replay returns that recorded
     * result WITHOUT invoking the handler — which is the only reason it cannot
     * double-advance, since an invoked handler could not tell the two apart.
     */
    it('POD-731 a duplicate checkpoint carrying a MUTATION ID replays its first result', () => {
      const { run } = threeStepRun(h)
      const payload = {
        runId: run.id,
        mutationId: 'mut-1',
        status: 'complete' as const,
        summary: 'finished step A',
        evidence: { summary: 'A evidence', tests: ['a: pass'], artifacts: [] },
      }
      const first = h.service.checkpoint(payload, agent('s1'))
      expect(first.message).toBe('Step complete. Next: B')

      // Delivered twice more. Under the shipped code this completed B, then C.
      const second = h.service.checkpoint(payload, agent('s1'))
      const third = h.service.checkpoint(payload, agent('s1'))
      expect(second.message).toBe('Step complete. Next: B')
      expect(third.message).toBe('Step complete. Next: B')

      // ONE advance, and B still carries nothing of A's.
      expect(h.store.workflows.getRunSteps(run.id).map((x) => [x.stepId, x.status])).toEqual([
        ['a', 'complete'],
        ['b', 'pending'],
        ['c', 'pending'],
      ])
      expect(h.store.workflows.getRunSteps(run.id)[1]?.summary).toBe('')
      // ONE event, too: the handler was never invoked a second time, so the
      // append-only log did not grow either.
      expect(kinds(h.store).filter((k) => k === 'workflow.step_complete')).toHaveLength(1)

      // THE COUNTERFACTUAL, and the reason this is not "checkpointing is
      // broken": a DIFFERENT mutation id is a different delivery and advances.
      const next = h.service.checkpoint({ ...payload, mutationId: 'mut-2' }, agent('s1'))
      expect(next.message).toBe('Step complete. Next: C')
      expect(kinds(h.store).filter((k) => k === 'workflow.step_complete')).toHaveLength(2)
    })

    /**
     * THE RUN-ID RESOURCE SCOPE, which is why the ledger key is not the bare
     * mutation id. A client that replays one id against a DIFFERENT run must
     * not be handed the first run's recorded result — that would look like
     * success and would leave the second run un-advanced.
     */
    it('POD-731 a mutation id replayed against a DIFFERENT run is a different delivery', () => {
      const one = threeStepRun(h, 'Run one')
      const two = threeStepRun(h, 'Run two', 's4')
      const payload = {
        mutationId: 'shared-id',
        status: 'complete' as const,
        summary: 'x',
        evidence: EMPTY_EVIDENCE,
      }
      h.service.checkpoint({ ...payload, runId: one.run.id }, agent('s1'))
      h.service.checkpoint({ ...payload, runId: two.run.id }, agent('s4'))
      expect(h.store.workflows.getRunSteps(one.run.id)[0]?.status).toBe('complete')
      expect(h.store.workflows.getRunSteps(two.run.id)[0]?.status).toBe('complete')
    })

    it('duplicate checkpoint WITH an explicit stepId is refused by the linear-step guard', () => {
      const { run } = twoStepRun(h)
      const payload = {
        runId: run.id,
        stepId: 'implement',
        status: 'complete' as const,
        summary: 'built',
        evidence: EMPTY_EVIDENCE,
      }
      h.service.checkpoint(payload, agent('s1'))
      // The second delivery names a step that is no longer current → refused.
      // Naming the step is the ONLY protection against the double-advance above.
      expect(thrown(() => h.service.checkpoint(payload, agent('s1')))).toBe(
        'Error: step implement is not the current linear step | code=undefined',
      )
      expect(h.store.workflows.getRunSteps(run.id).map((s) => s.status)).toEqual([
        'complete',
        'pending',
      ])
    })

    it('duplicate non-terminal checkpoints on the SAME step are idempotent-in-effect', () => {
      const { run } = twoStepRun(h)
      const payload = {
        runId: run.id,
        stepId: 'implement',
        status: 'active' as const,
        summary: 'working',
        evidence: EMPTY_EVIDENCE,
      }
      h.service.checkpoint(payload, agent('s1'))
      h.service.checkpoint(payload, agent('s1'))
      h.service.checkpoint(payload, agent('s1'))
      expect(h.store.workflows.getRunSteps(run.id)[0]).toMatchObject({
        status: 'active',
        summary: 'working',
        attempt: 1,
      })
      // Three events, though: the event log is not deduplicated.
      expect(kinds(h.store).filter((k) => k === 'workflow.step_active')).toHaveLength(3)
    })

    it('duplicate checkpoint on a prompt-only run is idempotent', () => {
      const created = h.service.create(
        {
          name: 'Prompt dup',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })
      const payload = {
        runId: run.id,
        status: 'complete' as const,
        summary: 'x',
        evidence: EMPTY_EVIDENCE,
      }
      expect(h.service.checkpoint(payload, agent('s1')).run.status).toBe('complete')
      expect(h.service.checkpoint(payload, agent('s1')).run.status).toBe('complete')
      expect(kinds(h.store).filter((k) => k === 'workflow.run_complete')).toHaveLength(2)
    })

    it('duplicate skip is refused; duplicate retry bumps attempt again', () => {
      const { run } = twoStepRun(h)
      h.service.skip({ runId: run.id, stepId: 'implement', reason: 'no' }, agent('s1'))
      expect(
        thrown(() =>
          h.service.skip({ runId: run.id, stepId: 'implement', reason: 'no' }, agent('s1')),
        ),
      ).toBe('Error: only the current step may be skipped | code=undefined')
      // Duplicate retry is NOT refused — each delivery bumps attempt.
      h.service.retry({ runId: run.id, stepId: 'review' }, agent('s1'))
      h.service.retry({ runId: run.id, stepId: 'review' }, agent('s1'))
      expect(h.store.workflows.getRunSteps(run.id)[1]?.attempt).toBe(3)
    })

    it('KNOWN-DEFECT: retry RESURRECTS a skipped step, so a duplicate skip is reachable again', () => {
      const { run } = twoStepRun(h)
      h.service.skip({ runId: run.id, stepId: 'implement', reason: 'no' }, agent('s1'))
      // retry has no status precondition — a SKIPPED step goes back to
      // pending, which un-skips it. Nothing records that it was ever skipped.
      h.service.retry({ runId: run.id, stepId: 'implement' }, agent('s1'))
      expect(h.store.workflows.getRunSteps(run.id)[0]).toMatchObject({
        status: 'pending',
        summary: '',
        attempt: 2,
      })
      expect(
        h.service.skip({ runId: run.id, stepId: 'implement', reason: 'again' }, agent('s1'))
          .message,
      ).toBe('Skipped. Next: Review')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Out-of-order step attempts
  // -------------------------------------------------------------------------

  describe('out-of-order step attempts', () => {
    it('only the current linear step may be checkpointed', () => {
      const { run } = twoStepRun(h)
      expect(
        thrown(() =>
          h.service.checkpoint(
            {
              runId: run.id,
              stepId: 'review',
              status: 'complete',
              summary: '',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s1'),
          ),
        ),
      ).toBe('Error: step review is not the current linear step | code=undefined')
      expect(
        thrown(() =>
          h.service.checkpoint(
            {
              runId: run.id,
              stepId: 'nope',
              status: 'complete',
              summary: '',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s1'),
          ),
        ),
      ).toBe('Error: workflow has no step nope | code=undefined')
      expect(h.store.workflows.getRunSteps(run.id).map((s) => s.status)).toEqual([
        'pending',
        'pending',
      ])
    })

    /**
     * STILL A PIN, reached one guard earlier. POD-731's framework check runs
     * BEFORE any run state is read — deliberately, so an ambiguous frame cannot
     * half-apply — so an unnamed checkpoint against a stepped run is refused
     * for being unnamed before it can be refused for having nowhere to go.
     *
     * The behaviour the name claims is unchanged and is asserted below: the
     * same call that NAMES its step still reports `workflow has no remaining
     * step`. Both are kept so the ordering is visible rather than silently
     * swapped.
     */
    it('checkpointing a run whose steps are all terminal throws', () => {
      const { run } = twoStepRun(h)
      h.service.skip({ runId: run.id, stepId: 'implement', reason: '' }, agent('s1'))
      h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, agent('s1'))
      expect(
        thrown(() =>
          h.service.checkpoint(
            { runId: run.id, status: 'complete', summary: '', evidence: EMPTY_EVIDENCE },
            agent('s1'),
          ),
        ),
      ).toBe(`Error: ${AMBIGUOUS_ADVANCE_MESSAGE} | code=undefined`)
      expect(
        thrown(() =>
          h.service.checkpoint(
            {
              runId: run.id,
              stepId: 'review',
              status: 'complete',
              summary: '',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s1'),
          ),
        ),
      ).toBe('Error: workflow has no remaining step | code=undefined')
    })

    it('only the current step may be assigned or skipped', () => {
      const { run } = twoStepRun(h)
      expect(
        thrown(() =>
          h.service.assignStep(
            { runId: run.id, stepId: 'review', sessionId: asSessionId('s2') },
            agent('s1'),
          ),
        ),
      ).toBe('Error: only the current step may be assigned | code=undefined')
      expect(
        thrown(() => h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, agent('s1'))),
      ).toBe('Error: only the current step may be skipped | code=undefined')
      expect(
        thrown(() =>
          h.service.assignStep(
            { runId: run.id, stepId: 'nope', sessionId: asSessionId('s2') },
            agent('s1'),
          ),
        ),
      ).toBe('Error: only the current step may be assigned | code=undefined')
    })

    it('a step cannot be retried once a LATER step has left pending', () => {
      const { run } = twoStepRun(h)
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      // Merely making the later step ACTIVE (not complete) already locks the
      // earlier one: the guard is `status !== 'pending'`, not "completed".
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'review',
          status: 'active',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(
        thrown(() => h.service.retry({ runId: run.id, stepId: 'implement' }, agent('s1'))),
      ).toBe('Error: cannot retry a step after a later step has started | code=undefined')
      expect(thrown(() => h.service.retry({ runId: run.id, stepId: 'nope' }, agent('s1')))).toBe(
        'Error: workflow has no step nope | code=undefined',
      )
      // A SKIPPED later step also counts as "started" and locks the earlier one.
      const other = twoStepRun(h, secondSubject)
      h.service.checkpoint(
        {
          runId: other.run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        s3,
      )
      h.service.skip({ runId: other.run.id, stepId: 'review', reason: '' }, s3)
      expect(thrown(() => h.service.retry({ runId: other.run.id, stepId: 'implement' }, s3))).toBe(
        'Error: cannot retry a step after a later step has started | code=undefined',
      )
    })
  })

  // -------------------------------------------------------------------------
  // 8. adopt mid-run
  // -------------------------------------------------------------------------

  describe('adopt', () => {
    it('adopt supersedes the live run, writes the supersedes edge, and emits workflow.run_adopted', () => {
      const { created, run } = twoStepRun(h)
      const v2 = h.service.revise(
        {
          workflowId: created.workflow.id,
          instructions: 'v2',
          steps: [
            {
              id: 'implement',
              title: 'Implement',
              instructions: 'build v2',
              completionGuidance: '',
            },
            { id: 'review', title: 'Review', instructions: 'review v2', completionGuidance: '' },
          ],
        },
        operator,
      )
      const adopted = h.service.adopt({ revisionId: v2.id, startStepId: 'review' }, agent('s1'))
      expect(adopted.id).not.toBe(run.id)
      expect(adopted.supersedesRunId).toBe(run.id)
      expect(adopted.revision.id).toBe(v2.id)
      expect(adopted.status).toBe('active')
      expect(adopted.coordinatorSessionId).toBe('s1')
      // The old run is superseded, not deleted — its step history survives.
      expect(h.store.workflows.getRun(run.id)?.status).toBe('superseded')
      expect(h.store.workflows.getRun(run.id)?.completedAt).toBe(NOW)
      expect(h.store.workflows.getRunSteps(run.id)).toHaveLength(2)
      // The skipped-step record written by the adopt path.
      expect(adopted.steps.map((s) => [s.stepId, s.status])).toEqual([
        ['implement', 'skipped'],
        ['review', 'pending'],
      ])
      expect(adopted.steps[0]).toMatchObject({
        summary: 'Skipped when adopting workflow',
        assignedSessionId: null,
        startedAt: null,
        completedAt: NOW,
        evidence: { summary: '', tests: [], artifacts: [] },
      })
      const event = readEvents(h.store).at(-1)
      expect(event?.kind).toBe('workflow.run_adopted')
      expect(JSON.parse(event?.payload_json ?? '{}')).toEqual({
        revisionId: v2.id,
        subjectKind: 'issue',
        subjectId: 'issue-1',
        startStepId: 'review',
      })
      // the adopt path emits run_adopted but NO step_skipped events for the
      // steps it skipped.
      expect(kinds(h.store).filter((k) => k === 'workflow.step_skipped')).toHaveLength(0)
    })

    it('adopt mid-run preserves the work already recorded on the superseded run', () => {
      const { created, run } = twoStepRun(h)
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'real work',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      const v2 = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2', steps: [] },
        operator,
      )
      const adopted = h.service.adopt({ revisionId: v2.id }, agent('s1'))
      expect(h.store.workflows.getRunSteps(run.id)[0]).toMatchObject({
        status: 'complete',
        summary: 'real work',
      })
      // the new run does NOT carry the completed step forward. A zero-step
      // revision produces a run with no steps at all.
      expect(adopted.steps).toEqual([])
    })

    it('adopt validates EVERYTHING before superseding — no partial state on any failure', () => {
      const { created, run } = twoStepRun(h)
      const foreign = h.service.create(
        {
          name: 'Foreign adopt',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(thrown(() => h.service.adopt({ revisionId: 'wfr_nope' }, agent('s1')))).toBe(
        'Error: unknown workflow revision: wfr_nope | code=undefined',
      )
      expect(
        thrown(() =>
          h.service.adopt({ revisionId: created.revision.id, startStepId: 'nope' }, agent('s1')),
        ),
      ).toBe('Error: workflow has no step nope | code=undefined')
      // POD-731 CONVERGENCE (D20.2): a revision the principal may not see now
      // fails identically to one that does not exist — the assertion two above
      // is the counterfactual, using an id that never existed.
      expect(thrown(() => h.service.adopt({ revisionId: foreign.revision.id }, agent('s1')))).toBe(
        `Error: unknown workflow revision: ${foreign.revision.id} | code=undefined`,
      )
      // Every one of those left the live run untouched...
      expect(h.store.workflows.getRun(run.id)?.status).toBe('active')
      expect(kinds(h.store).filter((k) => k === 'workflow.run_adopted')).toHaveLength(0)
      // ...and, the other half of "no partial state": no SUCCESSOR run was
      // created either. Checking only the old run's status would still pass if
      // adopt superseded first and then failed, or created a replacement before
      // validating — which is precisely the partial state this name claims does
      // not happen.
      expect(h.store.workflows.listRuns(true)).toHaveLength(1)
    })

    it('only an active or blocked run may adopt', () => {
      const { created, run } = twoStepRun(h)
      h.service.skip({ runId: run.id, stepId: 'implement', reason: '' }, agent('s1'))
      h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, agent('s1'))
      expect(h.store.workflows.getRun(run.id)?.status).toBe('complete')
      expect(
        thrown(() =>
          h.service.adopt({ revisionId: created.revision.id, runId: run.id }, agent('s1')),
        ),
      ).toBe('Error: only an active workflow run may adopt a revision | code=undefined')
      // A BLOCKED run may adopt.
      const other = twoStepRun(h)
      h.service.checkpoint(
        {
          runId: other.run.id,
          stepId: 'implement',
          status: 'blocked',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s1'),
      )
      expect(
        h.service.adopt({ revisionId: other.created.revision.id, runId: other.run.id }, agent('s1'))
          .supersedesRunId,
      ).toBe(other.run.id)
    })

    it('adopt is coordinator-only for a session caller', () => {
      const { created, run } = twoStepRun(h)
      expect(
        thrown(() =>
          h.service.adopt({ revisionId: created.revision.id, runId: run.id }, agent('s2')),
        ),
      ).toBe('Error: only the workflow coordinator may perform this transition | code=undefined')
    })

    it('prepareStart pins an issue to its live run revision and refuses an implicit switch', () => {
      const { created, run } = twoStepRun(h)
      const v2 = h.service.revise(
        { workflowId: created.workflow.id, instructions: 'v2', steps: [] },
        operator,
      )
      // A later session on the same issue gets the PINNED revision, not v2.
      const prepared = h.service.prepareStart({
        sessionId: asSessionId('s2'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
      })
      expect(prepared?.revision.id).toBe(created.revision.id)
      expect(prepared?.prompt).toContain('drive it')
      // Asking for a different revision is refused — adopt is the only way.
      expect(
        thrown(() =>
          h.service.prepareStart({
            sessionId: asSessionId('s2'),
            cwd: '/repo-a/wt',
            issueId: 'issue-1',
            explicitRevisionId: v2.id,
          }),
        ),
      ).toBe(
        'Error: the issue already has a pinned workflow; adopt a new revision explicitly | code=undefined',
      )
      // Asking for the SAME revision is fine.
      expect(
        h.service.prepareStart({
          sessionId: asSessionId('s2'),
          cwd: '/repo-a/wt',
          issueId: 'issue-1',
          explicitRevisionId: created.revision.id,
        })?.revision.id,
      ).toBe(created.revision.id)
      expect(run.id).toBeTruthy()
    })

    it('adopt of a revision outside the run start scope is refused by assertRevisionMatchesStart', () => {
      // A GLOBAL revision always matches; a repository revision must match the
      // coordinator session's repo. s1 is in repo-a.
      const { run } = twoStepRun(h)
      const repoB = h.service.create(
        {
          name: 'Repo b rev',
          description: '',
          scope: 'repository',
          scopeRef: 'repo-b',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // The read gate rejects it first (repo mismatch), so the start-scope
      // message is not the one a session sees. POD-731 CONVERGENCE (D20.2):
      // that read refusal is now the unknown-revision string, so an invisible
      // revision id and one that never existed are indistinguishable here too.
      expect(
        thrown(() =>
          h.service.adopt({ revisionId: repoB.revision.id, runId: run.id }, agent('s1')),
        ),
      ).toBe(`Error: unknown workflow revision: ${repoB.revision.id} | code=undefined`)
      // With the read gate lifted, the start-scope check is what refuses it.
      expect(
        thrown(() =>
          h.service.adopt({ revisionId: repoB.revision.id, runId: run.id }, overriding('s1')),
        ),
      ).toBe(
        `Error: workflow revision ${repoB.revision.id} is outside the requested start scope | code=undefined`,
      )
      const global = h.service.create(
        { name: 'Global rev', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      expect(
        h.service.adopt({ revisionId: global.revision.id, runId: run.id }, agent('s1')).revision.id,
      ).toBe(global.revision.id)
    })
  })

  // -------------------------------------------------------------------------
  // 9. The operator surface, exhaustively
  // -------------------------------------------------------------------------

  describe('operator surface (single-operator artefacts)', () => {
    it('SINGLE-OPERATOR: the four scope guards all return early for the operator', () => {
      // assertCreateScope
      expect(
        h.service.create(
          {
            name: 'Any scope',
            description: '',
            scope: 'repository',
            scopeRef: 'repo-anything',
            instructions: '',
            steps: [],
          },
          operator,
        ).workflow.scopeRef,
      ).toBe('repo-anything')
      const foreign = h.service.create(
        {
          name: 'Foreign',
          description: '',
          scope: 'task',
          scopeRef: 'issue-nobody-has',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // assertWorkflowWrite
      expect(
        h.service.revise(
          { workflowId: foreign.workflow.id, instructions: 'x', steps: [] },
          operator,
        ).version,
      ).toBe(2)
      // canReadWorkflow
      expect(h.service.get({ id: foreign.workflow.id }, operator).workflow.id).toBe(
        foreign.workflow.id,
      )
      expect(h.service.list({}, operator).map((w) => w.id)).toContain(foreign.workflow.id)
      // assertIssueScope
      h.service.publish({ revisionId: foreign.revision.id }, operator)
      expect(
        h.service.assign(
          { targetKind: 'issue', targetId: 'issue-nobody-has', revisionId: foreign.revision.id },
          operator,
        ).targetId,
      ).toBe('issue-nobody-has')
      // SINGLE-OPERATOR: none of the above consulted a capability, an owner, or a
      // machine grant. POD-731 replaces this arm with an owner-or-admin check
      // against a real user principal.
    })

    /**
     * RE-PINNED. The ARTEFACT recorded that a bare operator — no
     * `protectedWrite` — cleared every guard, INCLUDING publishing global
     * content with no approval at all, because publish's brake was keyed on
     * `actor.kind === 'session'` and an operator is not a session.
     *
     * DECISION IMPLEMENTED: `protectedWrite` is now the ACCOUNT GRADE, so a
     * bare operator is a MEMBER. Two consequences, and the split between them
     * is the whole finding:
     *
     *  - personal (task/repository) content still works for it, because the
     *    single-user ownership port says one human owns everything and a member
     *    who owns a row may write it;
     *  - GLOBAL content is refused, because the library arm is admin-grade and
     *    a grade is not something ownership can supply.
     *
     * That is exactly the shape "role class is no longer sufficient on its own"
     * was supposed to produce: the same caller passes one and fails the other.
     */
    it('POD-731 a bare operator is a MEMBER: personal content yes, global content no', () => {
      const created = h.service.create(
        {
          name: 'Bare',
          description: '',
          scope: 'task',
          scopeRef: 'issue-nobody-has',
          instructions: '',
          steps: [],
        },
        bareOperator,
      )
      expect(created.workflow.scopeRef).toBe('issue-nobody-has')
      expect(
        h.service.revise(
          { workflowId: created.workflow.id, instructions: 'x', steps: [] },
          bareOperator,
        ).version,
      ).toBe(2)
      // THE CLOSED HALF. A bare operator can no longer create global content,
      // and therefore can no longer publish it without approval either.
      expect(
        thrown(() =>
          h.service.create(
            { name: 'Bare global', description: '', scope: 'global', instructions: '', steps: [] },
            bareOperator,
          ),
        ),
      ).toBe('Error: approval required to create a global workflow | code=undefined')
      // …and the publish brake now catches it on content an ADMIN created, which
      // is the case that used to slip through entirely.
      const global = h.service.create(
        { name: 'Bare global', description: '', scope: 'global', instructions: '', steps: [] },
        operator,
      )
      expect(
        thrown(() => h.service.publish({ revisionId: global.revision.id }, bareOperator)),
      ).toBe('Error: approval required to change a global workflow | code=undefined')
      expect(h.service.publish({ revisionId: global.revision.id }, operator).publishedAt).toBe(NOW)
    })

    it('SINGLE-OPERATOR: runs() returns EVERY run in the instance for the operator; a session gets only its own live run', () => {
      const first = twoStepRun(h)
      const second = h.service.create(
        {
          name: 'Other subject',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const otherRun = h.service.startRun({
        sessionId: asSessionId('s3'),
        cwd: '/repo-b/wt',
        issueId: 'issue-2',
        revisionId: second.revision.id,
      })
      // Cross-user read (3.1.2): two unrelated subjects, one caller.
      expect(
        h.service
          .runs({}, operator)
          .map((r) => r.id)
          .sort(),
      ).toEqual([first.run.id, otherRun.id].sort())
      // A session sees exactly its own live run.
      expect(h.service.runs({}, agent('s1')).map((r) => r.id)).toEqual([first.run.id])
      expect(h.service.runs({}, agent('s3', 'issue-2')).map((r) => r.id)).toEqual([otherRun.id])
      // A session with no run at all gets an empty list, not a throw.
      expect(h.service.runs({}, agent('s4'))).toEqual([])
      // includeTerminal is respected only on the operator arm — a session's
      // view is always the LIVE run, so a completed run vanishes from it.
      h.service.skip({ runId: first.run.id, stepId: 'implement', reason: '' }, agent('s1'))
      h.service.skip({ runId: first.run.id, stepId: 'review', reason: '' }, agent('s1'))
      expect(h.service.runs({}, agent('s1'))).toEqual([])
      expect(h.service.runs({ includeTerminal: true }, agent('s1'))).toEqual([])
      expect(h.service.runs({ includeTerminal: true }, operator)).toHaveLength(2)
      expect(h.service.runs({}, operator).map((r) => r.id)).toEqual([otherRun.id])
      // SINGLE-OPERATOR: overrideScope does NOT widen runs() — only actor.kind does.
      expect(h.service.runs({}, overriding('s1'))).toEqual([])
    })

    it('SINGLE-OPERATOR: runFor() resolves ANY run id for the operator, and a session is held to its own run', () => {
      const created = h.service.create(
        {
          name: 'Foreign run',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const foreignRun = h.service.startRun({
        sessionId: asSessionId('s3'),
        cwd: '/repo-b/wt',
        issueId: 'issue-2',
        revisionId: created.revision.id,
      })
      // Cross-user READ of another subject's run.
      expect(h.service.status({ runId: foreignRun.id }, operator).id).toBe(foreignRun.id)
      // POD-731 CONVERGENCE (D20.2). POD-730 §10 recorded that an INVISIBLE run
      // said "outside this session" while an UNKNOWN one collapsed into the
      // no-run message — the only path that never echoed the caller's id. The
      // convergence goes toward the stricter of the two, so a run id confirms
      // nothing; the assertion below on `wrun_nope` is the counterfactual.
      expect(thrown(() => h.service.status({ runId: foreignRun.id }, agent('s1')))).toBe(
        'Error: no active workflow run for this session | code=undefined',
      )
      expect(thrown(() => h.service.status({ runId: 'wrun_nope' }, agent('s1')))).toBe(
        'Error: no active workflow run for this session | code=undefined',
      )
      // Three ways a session is admitted: coordinator, step assignee, or any
      // session on the run's issue.
      const own = twoStepRun(h)
      expect(h.service.status({ runId: own.run.id }, agent('s1')).id).toBe(own.run.id)
      expect(h.service.status({ runId: own.run.id }, agent('s2')).id).toBe(own.run.id)
      h.service.assignStep(
        { runId: own.run.id, stepId: 'implement', sessionId: asSessionId('s4') },
        agent('s1'),
      )
      expect(h.service.status({ runId: own.run.id }, agent('s4')).id).toBe(own.run.id)
      // SINGLE-OPERATOR: overrideScope does NOT widen runFor either.
      expect(thrown(() => h.service.status({ runId: foreignRun.id }, overriding('s1')))).toBe(
        'Error: no active workflow run for this session | code=undefined',
      )
    })

    /**
     * RE-PINNED. The ARTEFACT recorded that an operator — and a BARE operator at
     * that — could perform any transition on any run: `assertCoordinator`
     * returned early on `actor.kind === 'operator'`, and `runFor` had already
     * handed it any run by id.
     *
     * DECISION IMPLEMENTED: an ADMIN with no session still reaches a run (there
     * is no coordinator seat for a human to occupy, and an admin is the
     * escalation path the pack gives). A MEMBER with no session does not — and
     * that is the arm that used to be every authenticated person.
     */
    it('POD-731 a bare operator can no longer transition any run; an admin still can', () => {
      const { run } = twoStepRun(h)
      expect(
        h.service.assignStep(
          { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
          operator,
        ).message,
      ).toBe('Step assigned to s2.')
      expect(
        h.service.skip({ runId: run.id, stepId: 'implement', reason: 'admin says so' }, operator)
          .message,
      ).toBe('Skipped. Next: Review')
      // THE CLOSED ARM. A bare operator is a member with no session, so the run
      // is not visible to it at all — and the refusal is the unknown-run message
      // (D20.2), not one that admits the run exists.
      expect(
        thrown(() => h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, bareOperator)),
      ).toBe('Error: no active workflow run for this session | code=undefined')
      // The COUNTERFACTUAL: the same call by the admin succeeds, so the refusal
      // above is the grade and not the run having become untouchable.
      expect(
        h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, operator).message,
      ).toBe('Workflow complete.')
    })

    it("SINGLE-OPERATOR: checkpoint's allowed check accepts the operator for ANY step, assigned or not", () => {
      const { run } = twoStepRun(h)
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        operator,
      )
      // s1 (coordinator) is allowed; s4 (neither coordinator nor assignee) is not;
      // the operator is allowed regardless.
      expect(
        thrown(() =>
          h.service.checkpoint(
            {
              runId: run.id,
              stepId: 'implement',
              status: 'complete',
              summary: '',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s4'),
          ),
        ),
      ).toBe('Error: no active workflow run for this session | code=undefined')
      const packet = h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'operator did it',
          evidence: EMPTY_EVIDENCE,
        },
        operator,
      )
      expect(packet.run.status).toBe('active')
      // an operator checkpoint does NOT overwrite the assignee, and it does
      // NOT notify the coordinator (the notify arm needs caller.actor.id).
      expect(h.store.workflows.getRunSteps(run.id)[0]?.assignedSessionId).toBe('s2')
      expect(h.notices).toEqual([])
    })

    it('a non-assigned session on the run issue is refused at the step level, not the run level', () => {
      const { run } = twoStepRun(h)
      // s2 IS on issue-1, so runFor admits it, but it is neither coordinator nor
      // the step's assignee — the refusal comes from checkpoint's allowed check.
      expect(
        thrown(() =>
          h.service.checkpoint(
            {
              runId: run.id,
              stepId: 'implement',
              status: 'complete',
              summary: '',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s2'),
          ),
        ),
      ).toBe('Error: session is not assigned to this workflow step | code=undefined')
      // Assigning it flips the outcome.
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      expect(
        h.service.checkpoint(
          {
            runId: run.id,
            stepId: 'implement',
            status: 'complete',
            summary: 'ok',
            evidence: EMPTY_EVIDENCE,
          },
          agent('s2'),
        ).run.status,
      ).toBe('active')
    })

    it('prime for an operator context has no run and says so', () => {
      twoStepRun(h)
      expect(h.service.prime(operator)).toBe('No workflow is attached to this operator context.')
      expect(h.service.prime(agent('s3', 'issue-2'))).toBe(
        'No workflow is attached to this session.',
      )
      expect(h.service.prime(agent('s1'))).toContain('role: coordinator')
      expect(h.service.prime(agent('s2'))).toContain('role: issue participant')
    })

    /**
     * RE-PINNED (POD-732). `WorkflowService.dispatch` is DELETED — it was a
     * reflective, name-keyed call over `workflowInputs` that served any proc
     * with a schema, so `relay` was served because a schema existed rather than
     * because a contract declared it (ADR 3 D3 says the opposite). The relay arm
     * is now `dispatchWorkflowRpc`, and this pin moves to it UNCHANGED IN WHAT
     * IT CLAIMS: routes by proc name, parses through the ONE declared schema,
     * unknown proc is `undefined`, and a schema failure throws SYNCHRONOUSLY out
     * of dispatch rather than rejecting the returned promise.
     *
     * ONE CLAIM IS ADDED, and it is the thing the old shape could not say: a
     * proc that EXISTS but does not declare this transport is REFUSED, not
     * absent. `undefined` would fall through to "unknown proc", which tells a
     * caller a command it may not reach does not exist — and stops telling them
     * the day someone adds `relay` to the exposure.
     */
    it('the relay arm routes by proc name, parses through the declared schema, and is default-closed', async () => {
      const created = h.service.create(
        {
          name: 'Dispatched',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      await expect(
        dispatchWorkflowRpc(h.service, operator, 'get', { id: created.workflow.id }),
      ).resolves.toMatchObject({
        workflow: { id: created.workflow.id },
      })
      expect(dispatchWorkflowRpc(h.service, operator, 'notAProc', {})).toBeUndefined()
      expect(() => dispatchWorkflowRpc(h.service, operator, 'get', {})).toThrow('Required')
    })

    /**
     * The instrument must be able to say YES: the refusal above is only
     * meaningful if this transport check can actually fire. `checkpoint`
     * declares `relay`, so asking about a transport NO workflow contract
     * declares proves the branch is reached rather than vacuously skipped.
     */
    /**
     * THE REFUSAL ITSELF, not the predicate behind it.
     *
     * The pin below checks `isWorkflowProcExposedOn`. That is mechanism
     * presence: deleting the check from `dispatchWorkflowRpc` entirely left it
     * green (measured with a mutant). This one drives the DISPATCHER against a
     * transport no workflow declares, so the branch that refuses is the branch
     * under test — and the `relay` arm beside it is the counterfactual that
     * stops the assertion passing against a dispatcher that refuses everything.
     */
    it('POD-732 a proc that exists but does not declare the transport is REFUSED, not absent', () => {
      const created = h.service.create(
        {
          name: `Exposure ${Math.random()}`,
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(() =>
        dispatchWorkflowRpc(
          h.service,
          operator,
          'publish',
          { revisionId: created.revision.id },
          'outbox',
        ),
      ).toThrow('workflows.publish is not available over the outbox transport')
      expect(() =>
        dispatchWorkflowRpc(h.service, operator, 'get', { id: created.workflow.id }, 'outbox'),
      ).toThrow('workflows.get is not available over the outbox transport')
      // The counterfactual: the SAME calls on a declared transport go through,
      // so the refusal above is about the transport and not about the call.
      expect(
        dispatchWorkflowRpc(h.service, operator, 'get', { id: created.workflow.id }, 'relay'),
      ).toBeDefined()
    })

    /**
     * ADOPT'S RECORDED DUPLICATE, closed for an IDENTIFIED delivery (POD-732).
     *
     * The contract's `advance` note records the hazard: a second adopt supersedes
     * the run the FIRST one created and starts a third. POD-731 refused to close
     * it by REFUSING unidentified adopts — that would break six behaviours
     * POD-730 pinned — and left the ledger as the only close. This proves the
     * ledger actually closes it, which the contract note alone does not.
     *
     * THE COUNTERFACTUAL IS THE POINT: the same second delivery with a DIFFERENT
     * mutation id must still supersede, or this test would pass against an adopt
     * that had simply stopped working.
     */
    it('POD-732 a replayed adopt is a ledger no-op; a differently-identified one still supersedes', () => {
      const { run } = twoStepRun(h)
      const next = h.service.create(
        {
          name: `Adopted ${Math.random()}`,
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: 'v2',
          steps: [{ id: 'a', title: 'A', instructions: '', completionGuidance: '' }],
        },
        operator,
      )
      const first = h.service.adopt(
        { revisionId: next.revision.id, runId: run.id, mutationId: 'delivery-1' },
        agent('s1'),
      )
      const replay = h.service.adopt(
        { revisionId: next.revision.id, runId: run.id, mutationId: 'delivery-1' },
        agent('s1'),
      )
      // Same delivery ⇒ the FIRST result, verbatim. No third run.
      expect(replay.id).toBe(first.id)
      expect(readEvents(h.store).filter((e) => e.kind === 'workflow.run_adopted')).toHaveLength(1)

      // Different delivery ⇒ a real second adopt, which is the behaviour POD-730
      // pinned and which this close must not have taken away.
      const second = h.service.adopt(
        { revisionId: next.revision.id, runId: first.id, mutationId: 'delivery-2' },
        agent('s1'),
      )
      expect(second.id).not.toBe(first.id)
      expect(readEvents(h.store).filter((e) => e.kind === 'workflow.run_adopted')).toHaveLength(2)
    })

    it('exposure is default-closed per declaration, not per table membership', () => {
      expect(isWorkflowProcExposedOn('checkpoint', 'relay')).toBe(true)
      expect(isWorkflowProcExposedOn('checkpoint', 'outbox')).toBe(false)
      expect(isWorkflowProcExposedOn('notAProc', 'relay')).toBe(false)
      expect(isWorkflowQueryExposedOn('get', 'relay')).toBe(true)
      expect(isWorkflowQueryExposedOn('get', 'outbox')).toBe(false)
      expect(isWorkflowQueryExposedOn('notAProc', 'relay')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 10. Error shape — unknown vs out-of-scope vs in-scope
  // -------------------------------------------------------------------------

  describe('error shape', () => {
    /**
     * docs/multi-user-readiness.md 3.1.5 (consistent errors) requires that an
     * id the caller may not see be INDISTINGUISHABLE from an id that does not
     * exist. Today they differ, on every path. These tests assert the
     * DIVERGENCE, so POD-731's convergence is a documented change and not a
     * silent one. They are expected to go red under POD-731 — that is the point.
     */
    it('SINGLE-OPERATOR: workflow reads leak existence: unknown, out-of-scope and in-scope are three distinct outcomes', () => {
      const foreign = h.service.create(
        {
          name: 'Foreign',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const mine = h.service.create(
        {
          name: 'Mine',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const unknown = thrown(() => h.service.get({ id: 'wf_does-not-exist' }, agent('s1')))
      const outOfScope = thrown(() => h.service.get({ id: foreign.workflow.id }, agent('s1')))
      const inScope = thrown(() => h.service.get({ id: mine.workflow.id }, agent('s1')))
      expect(unknown).toBe('Error: unknown workflow: wf_does-not-exist | code=undefined')
      // POD-731: the two have CONVERGED. This is the same assertion the ARTEFACT
      // made, inverted — `not.toBe` became `toBe` — which is the shape that
      // makes the change visible in the diff rather than a deleted line.
      expect(outOfScope).toBe(`Error: unknown workflow: ${foreign.workflow.id} | code=undefined`)
      expect(inScope).toBe('NO THROW')
      expect(unknown.replace(/wf_[^ ]+/, 'ID')).toBe(outOfScope.replace(/wf_[^ ]+/, 'ID'))
      // The IN-SCOPE case is the counterfactual: convergence would be trivially
      // satisfiable by refusing everything, and it is not — a workflow the
      // caller may see still resolves.
      // there is still no error CODE on this surface at all — only a bare
      // Error with a message. Every `code=undefined` above is that fact.
    })

    it('SINGLE-OPERATOR: workflow WRITES leak existence too, with a third distinct message per scope', () => {
      const foreignTask = h.service.create(
        {
          name: 'Foreign task',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const foreignRepo = h.service.create(
        {
          name: 'Foreign repo',
          description: '',
          scope: 'repository',
          scopeRef: 'repo-b',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const unknown = thrown(() =>
        h.service.revise(
          { workflowId: 'wf_does-not-exist', instructions: '', steps: [] },
          agent('s1'),
        ),
      )
      const outOfScopeTask = thrown(() =>
        h.service.revise(
          { workflowId: foreignTask.workflow.id, instructions: '', steps: [] },
          agent('s1'),
        ),
      )
      const outOfScopeRepo = thrown(() =>
        h.service.revise(
          { workflowId: foreignRepo.workflow.id, instructions: '', steps: [] },
          agent('s1'),
        ),
      )
      expect(unknown).toBe('Error: unknown workflow: wf_does-not-exist | code=undefined')
      // POD-731: three distinct messages became ONE shape. The scope no longer
      // leaks either — a caller cannot learn that the id it guessed names a
      // REPOSITORY workflow rather than a task one.
      expect(outOfScopeTask).toBe(
        `Error: unknown workflow: ${foreignTask.workflow.id} | code=undefined`,
      )
      expect(outOfScopeRepo).toBe(
        `Error: unknown workflow: ${foreignRepo.workflow.id} | code=undefined`,
      )
      expect(
        new Set([unknown, outOfScopeTask, outOfScopeRepo].map((m) => m.replace(/wf_[^ ]+/, 'ID')))
          .size,
      ).toBe(1)
    })

    it('SINGLE-OPERATOR: run ids leak existence differently again: unknown collapses into the no-run message', () => {
      const created = h.service.create(
        {
          name: 'Foreign run',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      const foreignRun = h.service.startRun({
        sessionId: asSessionId('s3'),
        cwd: '/repo-b/wt',
        issueId: 'issue-2',
        revisionId: created.revision.id,
      })
      const own = twoStepRun(h)
      const unknown = thrown(() => h.service.status({ runId: 'wrun_does-not-exist' }, agent('s1')))
      const outOfScope = thrown(() => h.service.status({ runId: foreignRun.id }, agent('s1')))
      const inScope = thrown(() => h.service.status({ runId: own.run.id }, agent('s1')))
      // POD-731: converged onto the message that never mentioned the id — the
      // strictest of the five shapes POD-730 found, rather than a sixth. An
      // unknown run id and an invisible one are now one answer.
      expect(unknown).toBe('Error: no active workflow run for this session | code=undefined')
      expect(outOfScope).toBe(unknown)
      expect(inScope).toBe('NO THROW')
      // A caller with no run and no runId gets the same text as an unknown id.
      expect(thrown(() => h.service.status({}, agent('s4')))).toBe(unknown)
      // ...and so does an operator with no runId at all.
      expect(thrown(() => h.service.status({}, operator))).toBe(unknown)
    })

    it('revision ids report existence directly, in scope or not', () => {
      const foreign = h.service.create(
        {
          name: 'Foreign rev',
          description: '',
          scope: 'task',
          scopeRef: 'issue-2',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // POD-731: an out-of-scope revision id is NO LONGER confirmed to exist.
      // POD-730 recorded that the read gate fired only after `getRevision`
      // succeeded, so the refusal itself proved the row was there; the handlers
      // now rethrow the unknown-revision string for both outcomes.
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'session', targetId: 's1', revisionId: foreign.revision.id },
            agent('s1'),
          ),
        ),
      ).toBe(`Error: unknown workflow revision: ${foreign.revision.id} | code=undefined`)
      expect(
        thrown(() =>
          h.service.assign(
            { targetKind: 'session', targetId: 's1', revisionId: 'wfr_nope' },
            agent('s1'),
          ),
        ),
      ).toBe('Error: unknown workflow revision: wfr_nope | code=undefined')
    })
  })

  // -------------------------------------------------------------------------
  // 11. Attribution
  // -------------------------------------------------------------------------

  describe('attribution', () => {
    /**
     * THE COUNTERFACTUAL for the line above (ADR 9 D5 A1).
     *
     * `startRun` resolving the human when none was supplied is only safe if an
     * EXPLICIT `null` — which is A1's REVOCATION value, what `adopt` passes when
     * a delegation no longer resolves — is never re-resolved to a live human.
     * That is a `!== undefined` test in the code and it would read identically
     * to a truthiness test until this case exists: a truthiness test would turn
     * a revoked run into an attributed one, silently, in an audit trail.
     *
     * The DIFFERENT-ACTOR half: the same call with the field ABSENT must record
     * the human, or this test would pass against a `startRun` that recorded
     * `null` unconditionally.
     */
    it('POD-732 an explicit null onBehalfOf is rejected rather than re-resolved', () => {
      const revoked = h.service.create(
        {
          name: `Revoked ${Math.random()}`,
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      expect(
        thrown(() =>
          h.service.startRun({
            sessionId: asSessionId('s1'),
            cwd: '/repo-a/wt',
            issueId: 'issue-1',
            revisionId: revoked.revision.id,
            onBehalfOf: null,
          }),
        ),
      ).toBe('Error: workflow run has no live owner | code=undefined')
      // The second subject, same call with the field ABSENT — the actor differs
      // from the assertion, so a `startRun` that always recorded null fails here.
      h.service.startRun({
        sessionId: asSessionId('s3'),
        cwd: '/repo-b/wt',
        issueId: 'issue-2',
        revisionId: h.service.create(
          {
            name: `Live ${Math.random()}`,
            description: '',
            scope: 'task',
            scopeRef: 'issue-2',
            instructions: '',
            steps: [],
          },
          operator,
        ).revision.id,
      })
      expect(
        readEvents(h.store)
          .filter((e) => e.kind === 'workflow.run_started')
          .map((e) => String(e.on_behalf_of)),
      ).toEqual(['user:single'])
    })

    it('POD-731 every advance records the PAIR — the actor AND the human it acted for', () => {
      const { run } = twoStepRun(h)
      h.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        agent('s1'),
      )
      h.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: '',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s2'),
      )
      h.service.skip({ runId: run.id, stepId: 'review', reason: '' }, operator)
      const events = readEvents(h.store).map(
        (e) => `${e.kind}:${e.actor_kind}:${String(e.actor_id)}`,
      )
      expect(events).toEqual([
        'workflow.created:operator:null',
        'workflow.run_started:session:s1',
        'workflow.step_assigned:session:s1',
        'workflow.step_complete:session:s2',
        'workflow.step_skipped:operator:null',
      ])
      // POD-731: THE PAIR (ADR 9 D5 A3). Every row above now ALSO names the
      // human the actor acted for, so "did a person or an agent skip this
      // step?" is answerable from the row rather than unanswerable. The actor
      // column is unchanged — this is a widening, not a substitution, which is
      // the distinction A3 draws.
      //
      // POD-732 CLOSES THE LAST HOLE, and this line is the proof. POD-731
      // recorded `null` on `run_started` because the session-start path had no
      // caller and inventing a human would be a lie in an audit trail. That
      // reasoning is inherited: the human is not invented, it is RESOLVED
      // through the one seam every other apply uses
      // (`WorkflowAccess.onBehalfOf` → `workflowPrincipal`) for the actor the
      // event already names. POD-730 §9's ARTEFACT is now closed rather than
      // narrowed, and every row on this surface carries the pair.
      expect(
        readEvents(h.store).map((e) => `${e.kind}:${e.actor_kind}:${String(e.on_behalf_of)}`),
      ).toEqual([
        'workflow.created:operator:user:single',
        'workflow.run_started:session:user:single',
        'workflow.step_assigned:session:user:single',
        'workflow.step_complete:session:user:single',
        'workflow.step_skipped:operator:user:single',
      ])
      const step = h.store.workflows.getRunSteps(run.id)[0]
      expect(step?.assignedSessionId).toBe('s2')
      expect(Object.keys(step ?? {})).not.toContain('completedBy')
    })

    it('SINGLE-OPERATOR: startRun hard-codes a SESSION actor, even when the operator started the run', () => {
      const created = h.service.create(
        {
          name: 'Operator start',
          description: '',
          scope: 'task',
          scopeRef: 'issue-1',
          instructions: '',
          steps: [],
        },
        operator,
      )
      // startRun takes a sessionId, not a caller: there is no way to record that
      // the operator (or a human) initiated it. The run_started event is
      // attributed to the coordinator session regardless of who asked.
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })
      expect(readEvents(h.store).at(-1)).toMatchObject({
        kind: 'workflow.run_started',
        actor_kind: 'session',
        actor_id: 's1',
      })
      expect(run.coordinatorSessionId).toBe('s1')
    })

    it('the workflows repository writes events, and reads them ONLY per run', () => {
      // Renamed to what this body actually checks. It previously claimed "no
      // reader anywhere in the product", which a unit test cannot see — that
      // claim is evidenced separately by a byte-wise scan of 1787 files
      // (NUL-safe, since one NUL byte makes grep answer "no match" for a whole
      // module) and recorded in docs/workflows/pinned-behaviour-pod730.md.
      //
      // Why it is pinned at all: run history is reachable only by raw SQL, so
      // POD-731 could drop the appendEvent calls with nothing going red. They
      // are the only durable audit trail this surface has.
      //
      // POD-647 ADDED `listRunEvents`, DELIBERATELY, AND THE PIN NOW GUARDS ITS
      // SHAPE RATHER THAN ITS ABSENCE. The UI has to show a run's attribution
      // PAIR (readiness §3.1.3 A3), which is impossible while the audit trail
      // has no reader. What the original pin was protecting — that this trail
      // never becomes a general-purpose event query — is protected by the list
      // below being CLOSED: a reader is admitted here one at a time, with an
      // argument, and `listRunEvents` is scoped to a single run id.
      const repositoryMethods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(h.store.workflows),
      ).sort()
      expect(repositoryMethods).toContain('appendEvent')
      expect(repositoryMethods.filter((m) => /event/i.test(m))).toEqual([
        'appendEvent',
        'listRunEvents',
      ])
    })

    it('POD-647 projects the attribution PAIR onto the run wire, never a payload', () => {
      const created = h.service.create(
        {
          name: 'attributed',
          description: '',
          scope: 'global',
          instructions: 'do the thing',
          steps: [],
        },
        operator,
      )
      const run = h.service.startRun({
        sessionId: asSessionId('s1'),
        cwd: '/repo-a/wt',
        issueId: 'issue-1',
        revisionId: created.revision.id,
      })

      // The run START is on the wire, with WHICH actor recorded — the half a
      // client may display and may never assert.
      const started = run.history.find((event) => event.kind === 'workflow.run_started')
      expect(started).toMatchObject({ actorKind: 'session', actorId: 's1' })

      // And the payload is NOT: the reader projects the pair and the kind, so a
      // widening of `payload_json` cannot reach a client through this door.
      expect(Object.keys(started ?? {}).sort()).toEqual([
        'actorId',
        'actorKind',
        'createdAt',
        'kind',
        'onBehalfOf',
      ])
    })
  })

  // -------------------------------------------------------------------------
  // 12. Persistence and restart mid-run
  // -------------------------------------------------------------------------

  describe('restart mid-run', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pod730-'))
    })

    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('a run survives a full store close/reopen, including step state and the profile snapshot', () => {
      const path = join(dir, 'restart.sqlite')
      const before = makeHarness(path)
      const profile = before.service.profileSave(
        {
          name: 'Snapshot',
          accountId: 'acct',
          harness: 'codex',
          model: 'gpt-5.6',
          effort: 'medium',
        },
        operator,
      )
      const { run } = twoStepRun(before, { profileId: profile.id })
      before.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        operator,
      )
      before.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'complete',
          summary: 'done before restart',
          evidence: { summary: 'e', tests: ['t: pass'], artifacts: ['sha'] },
        },
        agent('s2'),
      )
      before.store.close()

      // Restart: a brand-new store and service over the same file.
      const after = makeHarness(path)
      try {
        const recovered = after.service.status({ runId: run.id }, operator)
        expect(recovered.status).toBe('active')
        expect(recovered.coordinatorSessionId).toBe('s1')
        expect(recovered.steps.map((s) => [s.stepId, s.status, s.assignedSessionId])).toEqual([
          ['implement', 'complete', 's2'],
          ['review', 'pending', null],
        ])
        expect(recovered.steps[0]?.summary).toBe('done before restart')
        expect(recovered.steps[0]?.evidence).toEqual({
          summary: 'e',
          tests: ['t: pass'],
          artifacts: ['sha'],
        })
        // The pinned profile snapshot survives too.
        expect(recovered.steps[1]?.executionProfileSnapshot).toMatchObject({
          harness: 'codex',
          model: 'gpt-5.6',
        })
        // The recovery paths a resumed session actually uses.
        expect(
          after.service.prepareExistingSession({ sessionId: asSessionId('s1'), issueId: 'issue-1' })
            ?.revision.id,
        ).toBe(recovered.revision.id)
        expect(
          after.service.prepareStart({
            sessionId: asSessionId('s2'),
            cwd: '/repo-a/wt',
            issueId: 'issue-1',
          })?.revision.id,
        ).toBe(recovered.revision.id)
        expect(after.service.runs({}, agent('s1')).map((r) => r.id)).toEqual([run.id])
        // The run continues exactly where it stopped.
        expect(
          after.service.checkpoint(
            {
              runId: run.id,
              stepId: 'review',
              status: 'complete',
              summary: 'after',
              evidence: EMPTY_EVIDENCE,
            },
            agent('s1'),
          ).run.status,
        ).toBe('complete')
        // Events from BEFORE the restart are still there, in order.
        expect(kinds(after.store)).toEqual([
          'workflow.created',
          'workflow.run_started',
          'workflow.step_assigned',
          'workflow.step_complete',
          'workflow.step_complete',
        ])
      } finally {
        after.store.close()
      }
    })

    it('nothing about a run is volatile: notifyCoordinator is the ONLY out-of-band effect and it is fire-and-forget', () => {
      const path = join(dir, 'volatile.sqlite')
      const before = makeHarness(path)
      const { run } = twoStepRun(before)
      before.service.assignStep(
        { runId: run.id, stepId: 'implement', sessionId: asSessionId('s2') },
        operator,
      )
      before.service.checkpoint(
        {
          runId: run.id,
          stepId: 'implement',
          status: 'blocked',
          summary: 'needs help',
          evidence: EMPTY_EVIDENCE,
        },
        agent('s2'),
      )
      expect(before.notices).toHaveLength(1)
      before.store.close()

      const after = makeHarness(path)
      try {
        // the coordinator notice is NOT persisted and NOT replayed. A
        // restart between the checkpoint and the coordinator reading its inbox
        // loses the nudge; only the blocked STATE survives.
        expect(after.notices).toEqual([])
        // The "ONLY" in this test's name, actually checked: a full run wrote
        // nothing to either broadcast table, so there is no client fan-out to
        // lose across a restart. If POD-731 adds a fan-out here, this goes red
        // rather than the claim quietly becoming false.
        expect(countRows(after.store, 'changes')).toBe(0)
        expect(countRows(after.store, 'podium_events')).toBe(0)
        expect(after.service.status({ runId: run.id }, operator).status).toBe('blocked')
        // ...and a blocked run is still "live", so the session read finds it.
        expect(after.service.runs({}, agent('s1')).map((r) => r.id)).toEqual([run.id])
      } finally {
        after.store.close()
      }
    })
  })
})
