import { ISSUE_COMMAND_NAMES } from '@podium/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../issue-authz'
import { SessionRegistry } from '../../relay'
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

  it("scope: 'issue' is declared exactly on the targeted (SCOPED_TARGET) commands", () => {
    for (const name of ISSUE_COMMAND_NAMES) {
      const d = defs[name]
      if (Object.hasOwn(OLD_SCOPED_TARGET_FIELD, name)) expect(d?.scope, name).toBe('issue')
      else expect(d?.scope, name).toBeUndefined()
    }
  })
})

// Authz matrix: historical classifications plus deliberate lifecycle posture changes.
describe('guardIssueCommand authorization matrix', () => {
  const registries: SessionRegistry[] = []
  const fresh = () => {
    const r = new SessionRegistry()
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
      expect(definition.scope, name).toBe('issue')
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

describe('issue spawn provenance', () => {
  it('passes the exact initiating session through start and add-session commands', async () => {
    const registry = new SessionRegistry()
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
          actorSessionId: 'parent-session',
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
    const registry = new SessionRegistry()
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
          actorSessionId: 'sess_agent_creator',
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
            scope: { kind: 'subtree', rootId: created.id },
            actorSessionId: 'sess_coord',
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
        { id: created.id, sessionId: 'sess_handoff' },
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
})
