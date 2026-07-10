import { ISSUE_COMMAND_NAMES } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { OPERATOR } from '../../issue-authz'
import { SessionRegistry } from '../../relay'
import { guardIssueCommand, issueRegistry } from './registry'

/**
 * Registry completeness + authz parity (#248 [spec:SP-3fe2]). The old
 * PROC_ACTION/SCOPED_TARGET string maps are hardcoded HERE as historical pins:
 * the registry definitions must classify every command exactly as the maps did
 * the day they were deleted. Changing a classification is a deliberate edit to
 * this file, never a silent side effect of a rename.
 */

// PROC_ACTION as deleted from packages/domain/src/issue-authz.ts. Unlisted ⇒ 'read'.
const OLD_PROC_ACTION: Record<string, 'read' | 'write' | 'manage'> = {
  claim: 'write',
  update: 'write',
  addComment: 'write',
  defer: 'write',
  undefer: 'write',
  setNeedsHuman: 'write',
  clearNeedsHuman: 'write',
  close: 'write',
  start: 'write',
  addSession: 'write',
  addShell: 'write',
  action: 'write',
  cleanup: 'write',
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
  archive: 'manage',
  delete: 'manage',
  setLabels: 'manage',
  depRemove: 'manage',
  reparent: 'manage',
  supersede: 'manage',
  duplicate: 'manage',
}

// SCOPED_TARGET as deleted: proc → the input field carrying the target issue id.
// 'none' = the extractor deliberately returned undefined (mailClaim).
const OLD_SCOPED_TARGET_FIELD: Record<string, 'id' | 'fromId' | 'oldId' | 'none'> = {
  claim: 'id',
  update: 'id',
  close: 'id',
  defer: 'id',
  undefer: 'id',
  setNeedsHuman: 'id',
  clearNeedsHuman: 'id',
  addComment: 'id',
  panelApply: 'id',
  setState: 'id',
  action: 'id',
  cleanup: 'id',
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

  it('every old PROC_ACTION key has a def with the SAME action', () => {
    for (const [proc, action] of Object.entries(OLD_PROC_ACTION)) {
      expect(defs[proc], `missing def for ${proc}`).toBeTruthy()
      expect(defs[proc]?.action, proc).toBe(action)
    }
  })

  it("every command the old map left unlisted is an explicit 'read' now", () => {
    for (const name of ISSUE_COMMAND_NAMES) {
      if (!Object.hasOwn(OLD_PROC_ACTION, name)) {
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

// Authz parity: the derived guard must admit/reject exactly as the old
// string-map path (router middleware over PROC_ACTION/SCOPED_TARGET) did.
describe('guardIssueCommand parity with the old string-map guard', () => {
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
