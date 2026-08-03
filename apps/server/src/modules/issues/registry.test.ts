import { ISSUE_COMMAND_NAMES, ISSUE_CONTRACTS } from '@podium/commands'
import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'
import { guardIssueCommand, issueRegistry } from './registry'

/**
 * Registry completeness + explicit authz decisions (#248, #413). Action and
 * target metadata are pinned here so every policy change is deliberate.
 */

// Expected registry action for every non-read command. Unlisted commands are explicit reads.
const EXPECTED_PROC_ACTION: Record<string, 'read' | 'write' | 'manage'> = {
  promote: 'write',
  claim: 'write',
  setCoordinator: 'write',
  update: 'write',
  addComment: 'write',
  defer: 'write',
  undefer: 'write',
  setNeedsHuman: 'write',
  answerQuestion: 'write',
  clearNeedsHuman: 'write',
  close: 'write',
  start: 'write',
  addSession: 'write',
  addShell: 'write',
  action: 'write',
  cleanup: 'write',
  stop: 'write',
  integrate: 'write',
  applySuggestion: 'write',
  dismissSuggestion: 'write',
  refreshAssistant: 'write',
  depAdd: 'write',
  panelApply: 'write',
  setState: 'write',
  linearSearch: 'write',
  create: 'write',
  attachSession: 'write',
  mailSend: 'write',
  mailClaim: 'write',
  mailInbox: 'read',
  mailPending: 'read',
  subscriptionAdd: 'write',
  subscriptionRemove: 'write',
  subscriptionSetEnabled: 'write',
  subscriptionList: 'read',
  archive: 'write',
  delete: 'manage',
  restore: 'manage',
  setLabels: 'manage',
  share: 'write',
  unshare: 'write',
  depRemove: 'write',
  reparent: 'write',
  supersede: 'write',
  duplicate: 'write',
}

// SCOPED_TARGET as deleted: proc → the input field carrying the target issue id.
// 'none' = the extractor deliberately returned undefined (mailClaim).
const OLD_SCOPED_TARGET_FIELD: Record<string, 'id' | 'fromId' | 'oldId' | 'none'> = {
  promote: 'id',
  claim: 'id',
  setCoordinator: 'id',
  update: 'id',
  close: 'id',
  defer: 'id',
  undefer: 'id',
  setNeedsHuman: 'id',
  answerQuestion: 'id',
  clearNeedsHuman: 'id',
  addComment: 'id',
  panelApply: 'id',
  setState: 'id',
  action: 'id',
  cleanup: 'id',
  stop: 'id',
  integrate: 'id',
  applySuggestion: 'id',
  dismissSuggestion: 'id',
  refreshAssistant: 'id',
  start: 'id',
  addSession: 'id',
  addShell: 'id',
  depAdd: 'fromId',
  mailClaim: 'none',
  archive: 'id',
  delete: 'id',
  restore: 'id',
  setLabels: 'id',
  share: 'id',
  unshare: 'id',
  reparent: 'id',
  depRemove: 'fromId',
  supersede: 'oldId',
  duplicate: 'id',
}

const defs = issueRegistry.defs as Record<
  string,
  {
    action: string
    scope?: string
    target?: (i: Record<string, unknown>) => string | undefined
    kind: string
  }
>

describe('issue command registry completeness', () => {
  it('def keys are exactly the protocol name list (both directions)', () => {
    expect(Object.keys(issueRegistry.defs).sort()).toEqual([...ISSUE_COMMAND_NAMES].sort())
    expect(issueRegistry.namespace).toBe('issues')
  })

  it('every command has its explicit expected action', () => {
    for (const [proc, action] of Object.entries(EXPECTED_PROC_ACTION)) {
      expect(defs[proc], `missing def for ${proc}`).toBeTruthy()
      expect(defs[proc]?.action, proc).toBe(action)
    }
  })

  it("every command the expected-action map leaves unlisted is an explicit 'read' now", () => {
    for (const name of ISSUE_COMMAND_NAMES) {
      if (!Object.hasOwn(EXPECTED_PROC_ACTION, name)) {
        expect(defs[name]?.action, name).toBe('read')
      }
    }
  })

  it('target extractors match the old SCOPED_TARGET set exactly', () => {
    const withTarget = Object.keys(defs)
      .filter((n) => defs[n]?.target !== undefined)
      .sort()
    expect(withTarget).toEqual(Object.keys(OLD_SCOPED_TARGET_FIELD).sort())
    // And each extractor reads the SAME input field the old map read.
    const probe = { id: 'ID', fromId: 'FROM', oldId: 'OLD' }
    for (const [proc, field] of Object.entries(OLD_SCOPED_TARGET_FIELD)) {
      const got = defs[proc]?.target?.(probe)
      expect(got, proc).toBe(
        field === 'none' ? undefined : { id: 'ID', fromId: 'FROM', oldId: 'OLD' }[field],
      )
    }
  })

  /**
   * THE SEAM BICONDITIONAL (POD-311). The old `scope: 'issue'` field lived on the
   * handler beside the extractor, so the two could not disagree. They now live on
   * opposite sides of the L1/L3 split — `policy.resource` on the contract, `target`
   * on the handler — and nothing structural stops one changing without the other.
   * So it is asserted, in BOTH directions, over the whole table.
   *
   * Written over the PRESENCE of the extractor and never over the value it returns:
   * `mailClaim` has an extractor that deliberately returns `undefined`, because its
   * target is only discoverable by loading the message, and its handler runs the
   * same `checkIssueAccess` once it can. A check phrased over the returned value
   * would call that a missing extractor and be wrong.
   */
  it("policy.resource 'issue' holds exactly where a target extractor exists (both directions)", () => {
    for (const name of ISSUE_COMMAND_NAMES) {
      const hasExtractor = defs[name]?.target !== undefined
      const scoped = ISSUE_CONTRACTS[name].policy.resource === 'issue'
      expect(scoped, `${name}: contract says resource 'issue'`).toBe(hasExtractor)
      // And the partition still matches the old SCOPED_TARGET set exactly, so the
      // biconditional cannot be satisfied by both sides drifting together.
      expect(hasExtractor, name).toBe(Object.hasOwn(OLD_SCOPED_TARGET_FIELD, name))
    }
  })

  /**
   * NON-VACUITY for the check above. A biconditional over a table is satisfied by a
   * table with nothing in it, and "every command agrees" reads identically whether
   * the agreement is 68 real matches or zero iterations. Prove both arms are
   * populated and that a planted disagreement would FAIL.
   */
  it('the biconditional has both arms populated, and a mismatch would fail it', () => {
    const scoped = ISSUE_COMMAND_NAMES.filter((n) => ISSUE_CONTRACTS[n].policy.resource === 'issue')
    const unscoped = ISSUE_COMMAND_NAMES.filter(
      (n) => ISSUE_CONTRACTS[n].policy.resource !== 'issue',
    )
    expect(scoped.length).toBe(35)
    expect(unscoped.length).toBe(35)
    // The predicate the assertion above applies, run on PLANTED pairs so it is
    // observed saying NO before its silence is read as agreement.
    const agrees = (hasExtractor: boolean, resource: string) =>
      (resource === 'issue') === hasExtractor
    expect(agrees(true, 'issue')).toBe(true)
    expect(agrees(false, 'none')).toBe(true)
    expect(agrees(false, 'issue')).toBe(false)
    expect(agrees(true, 'none')).toBe(false)
  })
})

/**
 * THE SEAM'S SCHEMA IDENTITY (POD-311).
 *
 * The contracts moved to `@podium/commands` and the handlers stayed here. The claim
 * is that the schema MOVED — one instance, imported back — and not that it was
 * re-declared on both sides.
 *
 * `toBe` and never `toEqual`, for the reason the ledger states plainly: a restatement
 * of the same field list parses identically, encodes identically, and passes every
 * golden wire fixture, because branding is compile-time. Object identity is the only
 * instrument that sees the fork.
 */
describe('handler↔contract schema identity', () => {
  it('every joined def parses with its contract’s own schema INSTANCE', () => {
    let checked = 0
    for (const name of ISSUE_COMMAND_NAMES) {
      const def = (issueRegistry.defs as Record<string, { input: unknown }>)[name]
      expect(def?.input, name).toBe(ISSUE_CONTRACTS[name].input)
      checked += 1
    }
    expect(checked).toBe(70)
  })

  it('`toBe` here is load-bearing: an equal-but-separate schema would pass toEqual', () => {
    // The non-vacuity probe. `close`'s schema cloned field-for-field is a DIFFERENT
    // object that validates the same values — which is exactly the fork this
    // assertion exists to catch, and exactly what a value comparison would miss.
    const original = ISSUE_CONTRACTS.close.input
    const clone = z.object({
      id: z.string(),
      reason: z.string().optional(),
      mutationId: z.string().max(128).optional(),
    })
    const sample = { id: 'i1', reason: 'done' }
    expect(clone.parse(sample)).toEqual(original.parse(sample))
    expect(clone).not.toBe(original)
  })
})

// Authz matrix: historical classifications plus deliberate lifecycle posture changes.
describe('guardIssueCommand authorization matrix', () => {
  const registries: SessionRegistry[] = []
  const fresh = () => {
    const r = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(r)
    return r
  }
  afterAll(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('reads pass for any role; writes are role-gated (viewer FORBIDDEN)', () => {
    const reg = fresh()
    const viewer = { capability: { role: 'viewer', scope: { kind: 'all' } } } as const
    expect(() =>
      guardIssueCommand(viewer, reg.issues, 'list', issueRegistry.defs.list, {}),
    ).not.toThrow()
    expect(() =>
      guardIssueCommand(viewer, reg.issues, 'create', issueRegistry.defs.create, {
        repoPath: '/r',
        title: 'x',
        startNow: false,
      }),
    ).toThrow(/not allowed/)
  })

  it('a subtree worker writing an outside target gets PRECONDITION unless overridden', () => {
    const reg = fresh()
    const a = reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = reg.issues.create({ repoPath: '/r', title: 'B', startNow: false })
    const scoped = {
      capability: { role: 'worker' as const, scope: { kind: 'subtree' as const, rootId: a.id } },
    }
    expect(() =>
      guardIssueCommand(scoped, reg.issues, 'update', issueRegistry.defs.update, {
        id: a.id,
        patch: {},
      }),
    ).not.toThrow()
    expect(() =>
      guardIssueCommand(scoped, reg.issues, 'update', issueRegistry.defs.update, {
        id: b.id,
        patch: {},
      }),
    ).toThrow(/outside your subtree/)
    expect(() =>
      guardIssueCommand(
        { ...scoped, overrideScope: true },
        reg.issues,
        'update',
        issueRegistry.defs.update,
        { id: b.id, patch: {} },
      ),
    ).not.toThrow()
  })

  it('the guard resolves display refs (#seq) before the subtree check (#140)', () => {
    const reg = fresh()
    const a = reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const scoped = {
      capability: { role: 'worker' as const, scope: { kind: 'subtree' as const, rootId: a.id } },
    }
    // The agent's own issue addressed by bare display seq must NOT trip the gate.
    expect(() =>
      guardIssueCommand(scoped, reg.issues, 'update', issueRegistry.defs.update, {
        id: String(a.seq),
        patch: {},
      }),
    ).not.toThrow()
  })

  it('the five lifecycle repairs are worker-write in subtree, confirm outside, and viewer-denied', () => {
    const reg = fresh()
    const epic = reg.issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const child = reg.issues.create({
      repoPath: '/r',
      title: 'Child',
      parentId: epic.id,
      startNow: false,
    })
    const outside = reg.issues.create({ repoPath: '/r', title: 'Outside', startNow: false })
    const scoped = {
      capability: { role: 'worker' as const, scope: { kind: 'subtree' as const, rootId: epic.id } },
    }
    const viewer = {
      capability: { role: 'viewer' as const, scope: { kind: 'all' as const } },
    }
    const cases = [
      ['archive', { id: child.id }, { id: outside.id }],
      ['depRemove', { fromId: child.id, toId: epic.id }, { fromId: outside.id, toId: epic.id }],
      ['reparent', { id: child.id, parentId: epic.id }, { id: outside.id, parentId: epic.id }],
      ['supersede', { oldId: child.id, newId: epic.id }, { oldId: outside.id, newId: epic.id }],
      [
        'duplicate',
        { id: child.id, canonicalId: epic.id },
        { id: outside.id, canonicalId: epic.id },
      ],
    ] as const

    for (const [name, insideInput, outsideInput] of cases) {
      const definition = issueRegistry.defs[name]
      expect(definition.action, name).toBe('write')
      // `scope: 'issue'` moved to the L1 contract as `policy.resource` (POD-311).
      // Read through the contract so this asserts the fact the guard actually
      // consults, rather than a copy of it left on the handler.
      expect(ISSUE_CONTRACTS[name].policy.resource, name).toBe('issue')
      expect(() =>
        guardIssueCommand(scoped, reg.issues, name, definition, insideInput),
      ).not.toThrow()
      expect(() => guardIssueCommand(scoped, reg.issues, name, definition, outsideInput)).toThrow(
        /outside your subtree/,
      )
      expect(() =>
        guardIssueCommand(
          { ...scoped, overrideScope: true },
          reg.issues,
          name,
          definition,
          outsideInput,
        ),
      ).not.toThrow()
      expect(() => guardIssueCommand(viewer, reg.issues, name, definition, insideInput)).toThrow(
        /not allowed/,
      )
    }
  })

  it('additive writes (create/mailSend) and manage-tier are gated by role only', () => {
    const reg = fresh()
    const a = reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = reg.issues.create({ repoPath: '/r', title: 'B', startNow: false })
    const scoped = {
      capability: { role: 'worker' as const, scope: { kind: 'subtree' as const, rootId: a.id } },
    }
    // mailSend addressed OUTSIDE the subtree passes (no target extractor).
    expect(() =>
      guardIssueCommand(scoped, reg.issues, 'mailSend', issueRegistry.defs.mailSend, {
        id: b.id,
        body: 'hi',
      }),
    ).not.toThrow()
    // manage from a worker is a hard role denial regardless of target.
    expect(() =>
      guardIssueCommand(scoped, reg.issues, 'delete', issueRegistry.defs.delete, { id: a.id }),
    ).toThrow(/not allowed/)
    // the operator is unconstrained.
    expect(() =>
      guardIssueCommand({ capability: OPERATOR }, reg.issues, 'delete', issueRegistry.defs.delete, {
        id: b.id,
      }),
    ).not.toThrow()
  })
})

describe('issues.get session membership', () => {
  it('returns every attached agent and excludes shell sessions', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = registry.issues.create({ repoPath: '/r', title: 'A', startNow: false })
      registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
      const first = registry.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: '/r',
        issueId: issue.id,
        model: 'gpt-5.7',
      })
      const second = registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/r',
        issueId: issue.id,
      })
      registry.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/r',
        issueId: issue.id,
      })
      const shown = (await registry.issueCommands.dispatch(
        { capability: OPERATOR },
        'issues',
        'get',
        { id: issue.id },
      )) as { sessions: { sessionId: string; agentKind: string }[] }
      expect(shown.sessions.map((session) => session.sessionId).sort()).toEqual(
        [first.sessionId, second.sessionId].sort(),
      )
      expect(shown.sessions.map((session) => session.agentKind)).not.toContain('shell')
    } finally {
      registry.dispose()
    }
  })
})

describe('issue spawn provenance', () => {
  it('stamps agent comment actor and human owner from the transport principal', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = registry.issues.create({ repoPath: '/r', title: 'A', startNow: false })
      await registry.issueCommands.dispatch(
        {
          capability: {
            role: 'worker',
            scope: { kind: 'subtree', rootId: issue.id },
            actorSessionId: asSessionId('comment-agent'),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
        },
        'issues',
        'addComment',
        { id: issue.id, author: 'agent', body: 'transport attributed' },
      )

      const internal = registry as unknown as {
        store: {
          issues: {
            listIssueComments(
              id: string,
            ): Array<{ actor?: string | null; onBehalfOf?: string | null }>
          }
        }
      }
      expect(internal.store.issues.listIssueComments(issue.id)).toMatchObject([
        { actor: 'session:comment-agent', onBehalfOf: FIRST_ADMIN_USER_ID },
      ])
    } finally {
      registry.dispose()
    }
  })

  it('passes the exact initiating session through start and add-session commands', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = registry.issues.create({ repoPath: '/r', title: 'A', startNow: false })
      registry.issues.update(issue.id, {
        worktreePath: '/r/.worktrees/issue-1-a',
        stage: 'in_progress',
      })
      const caller = {
        capability: {
          role: 'worker',
          scope: { kind: 'subtree', rootId: issue.id },
          actorSessionId: asSessionId('parent-session'),
          onBehalfOf: FIRST_ADMIN_USER_ID,
        },
      } as const
      const start = vi.spyOn(registry.issues, 'start').mockResolvedValue(issue)
      await registry.issueCommands.dispatch(caller, 'issues', 'start', { id: issue.id })
      expect(start).toHaveBeenCalledWith(issue.id, undefined, {
        spawnedBy: 'session:parent-session',
      })
      const add = vi.spyOn(registry.issues, 'addSession').mockReturnValue(issue)
      await registry.issueCommands.dispatch(caller, 'issues', 'addSession', { id: issue.id })
      expect(add).toHaveBeenCalledWith(issue.id, undefined, { spawnedBy: 'session:parent-session' })
      const shell = vi.spyOn(registry.issues, 'addShell').mockReturnValue(issue)
      await registry.issueCommands.dispatch({ capability: OPERATOR }, 'issues', 'addShell', {
        id: issue.id,
      })
      expect(shell).toHaveBeenCalledWith(issue.id, { spawnedBy: 'user' })
    } finally {
      registry.dispose()
    }
  })

  it('agent create stamps startedBySession; setCoordinator claim/set/clear round-trips', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      // Operator create → no startedBySession.
      const op = (await registry.issueCommands.dispatch(
        { capability: OPERATOR },
        'issues',
        'create',
        { repoPath: '/r', title: 'Op create', startNow: false },
      )) as { id: string; startedBySession?: string }
      expect(op.startedBySession).toBeUndefined()

      // Agent create → bare actor session id.
      const agentCaller = {
        capability: {
          role: 'worker' as const,
          scope: { kind: 'none' as const },
          actorSessionId: asSessionId('sess_agent_creator'),
          onBehalfOf: FIRST_ADMIN_USER_ID,
        },
      }
      const created = (await registry.issueCommands.dispatch(agentCaller, 'issues', 'create', {
        repoPath: '/r',
        title: 'Agent create',
        startNow: false,
        // parentId would keep audience agent; top-level agent creates force needsHuman
        parentId: op.id,
      })) as { id: string; startedBySession?: string }
      expect(created.startedBySession).toBe('sess_agent_creator')

      // setCoordinator --claim uses actorSessionId.
      const claimed = (await registry.issueCommands.dispatch(
        {
          capability: {
            role: 'worker',
            scope: { kind: 'subtree', rootId: asIssueId(created.id) },
            actorSessionId: asSessionId('sess_coord'),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
        },
        'issues',
        'setCoordinator',
        { id: created.id, claim: true },
      )) as { coordinatorSessionId?: string }
      expect(claimed.coordinatorSessionId).toBe('sess_coord')

      const set = (await registry.issueCommands.dispatch(
        { capability: OPERATOR },
        'issues',
        'setCoordinator',
        { id: created.id, sessionId: asSessionId('sess_handoff') },
      )) as { coordinatorSessionId?: string }
      expect(set.coordinatorSessionId).toBe('sess_handoff')

      const cleared = (await registry.issueCommands.dispatch(
        { capability: OPERATOR },
        'issues',
        'setCoordinator',
        { id: created.id, sessionId: null },
      )) as { coordinatorSessionId?: string }
      expect(cleared.coordinatorSessionId).toBeUndefined()
    } finally {
      registry.dispose()
    }
  })

  // [POD-1365] The command RESPONSE carrying coordinatorSessionId (above) is not
  // the thing mail routing reads. attemptDelivery calls issues().get(id) and looks
  // at `issue.coordinatorSessionId` on that projection, so the field has to survive
  // toWire() — which spreads it conditionally. A routing test that builds its own
  // issue object cannot see this seam: it would stay green while the live server
  // routed every message by recency, which is exactly the failure mode this pair of
  // tests exists to separate (the defect is SILENT — mail reaches someone, nothing
  // errors, no lane goes red).
  it('exposes coordinatorSessionId on issues.get(), the projection mail routing reads', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = registry.issues.create({
        repoPath: '/r',
        title: 'Routing reads the projection',
        startNow: false,
      })

      // Unset must be ABSENT, not null/'' — routing tests `typeof === 'string'`.
      expect(registry.issues.get(issue.id)?.coordinatorSessionId).toBeUndefined()

      await registry.issueCommands.dispatch({ capability: OPERATOR }, 'issues', 'setCoordinator', {
        id: issue.id,
        sessionId: 'sess_coord_wire',
      })
      expect(registry.issues.get(issue.id)?.coordinatorSessionId).toBe('sess_coord_wire')

      // And it must go back to absent, or a stale coordinator keeps winning.
      await registry.issueCommands.dispatch({ capability: OPERATOR }, 'issues', 'setCoordinator', {
        id: issue.id,
        sessionId: null,
      })
      expect(registry.issues.get(issue.id)?.coordinatorSessionId).toBeUndefined()
    } finally {
      registry.dispose()
    }
  })
})

/**
 * The mailbox is per ISSUE, the read state is per READING SESSION [POD-1379].
 * Dispatched through the real registry so the wire path is under test too: the
 * reader is server-stamped from the caller's capability (actorSessionId), never
 * passed by the client.
 */
describe('issue mail read state is per reading session [POD-1379]', () => {
  it('a peer read leaves the other agent on the issue still pending, and no self-nag', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = registry.issues.create({ repoPath: '/r', title: 'Shared', startNow: false })
      // REAL SESSIONS, not the bare ids main used. `authorizeAtApply` re-resolves
      // the SENDER's principal on every delivery (POD-728/POD-1193), so a send
      // from a session id that names no session is dead-lettered — "sender
      // authorization is no longer valid" — and never reaches a peer's mailbox.
      // The ids are the sessions' own; the arrangement (two agents, one issue,
      // one shared mailbox) is unchanged.
      const sA = registry.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: '/r',
        issueId: issue.id,
      }).sessionId
      const sB = registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/r',
        issueId: issue.id,
      }).sessionId
      const agent = (sessionId: string) =>
        ({
          capability: {
            role: 'worker' as const,
            scope: { kind: 'subtree' as const, rootId: issue.id },
            actorSessionId: asSessionId(sessionId),
            // An agent capability must name the human it acts for: `resolvePrincipal`
            // refuses one with no delegation owner (POD-1075 attribution).
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
        }) as const
      const pending = async (sessionId: string) =>
        (await registry.issueCommands.dispatch(agent(sessionId), 'issues', 'mailPending', {})) as {
          unread: number
        }

      // Session A mails ITS OWN issue, meaning it for session B (the POD-1342 move).
      await registry.issueCommands.dispatch(agent(sA), 'issues', 'mailSend', {
        id: issue.id,
        body: 'handing this to you',
      })
      expect((await pending(sA)).unread).toBe(0)
      expect((await pending(sB)).unread).toBe(1)

      // A opens the shared mailbox anyway — B's handoff must survive it.
      await registry.issueCommands.dispatch(agent(sA), 'issues', 'mailInbox', { id: issue.id })
      expect((await pending(sB)).unread).toBe(1)

      const inboxB = (await registry.issueCommands.dispatch(agent(sB), 'issues', 'mailInbox', {
        id: issue.id,
      })) as Array<{ body: string; wasUnread: boolean }>
      expect(inboxB).toMatchObject([{ body: 'handing this to you', wasUnread: true }])
      expect((await pending(sB)).unread).toBe(0)
    } finally {
      registry.dispose()
    }
  })
})
