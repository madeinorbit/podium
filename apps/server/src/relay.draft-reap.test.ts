import type { SessionId } from '@podium/model'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Draft cleanup is tied to an explicit rehome, never inferred from process or
// session liveness. Exited drafts remain the route to resume/remove in sidebar.

const G = { cols: 80, rows: 24 }
const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: '/',
    agentKind: 'codex',
    geometry: G,
  }) as const

function regWithDaemon(store?: SessionStore) {
  const reg = new SessionRegistry(store, undefined, { instanceId: 'default' })
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  return reg
}

function draftWithSession(reg: SessionRegistry, repo = '/repo') {
  const draft = reg.issues.createDraftFor(repo, 'codex')
  const { sessionId } = reg.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: repo,
    issueId: draft.id,
  })
  return { draft, sessionId }
}

describe('draft retention on session death', () => {
  it('kill of the last attached session keeps the draft', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    expect(reg.issues.get(draft.id)).not.toBeNull()
    reg.modules.sessions.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.listSessions()).toHaveLength(0)
    expect(reg.sessionStore.sessions.getSession(sessionId)?.issueId).toBe(draft.id)
  })

  it('archiving the last attached session keeps its draft attachment', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.modules.sessions.setArchived({ sessionId, archived: true })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
  })

  it('keeps a fresh Codex draft attached after an updater exit, including across boot', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-updater-exit-')), 'state.sqlite')
    const reg = regWithDaemon(new SessionStore(file))
    const { draft, sessionId } = draftWithSession(reg)
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))

    // Codex exits cleanly while replacing itself during an update. The daemon
    // has no distinct update-exit frame, so the server must retain recoverability.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })

    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
    expect(reg.modules.sessions.listSessions()).toContainEqual(
      expect.objectContaining({ sessionId, status: 'exited', issueId: draft.id }),
    )

    const restarted = new SessionRegistry(new SessionStore(file), undefined, {
      instanceId: 'default',
    })
    expect(restarted.issues.get(draft.id)).not.toBeNull()
    expect(restarted.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
    expect(restarted.modules.sessions.listSessions()).toContainEqual(
      expect.objectContaining({ sessionId, status: 'exited', issueId: draft.id }),
    )
  })

  it('hibernation does NOT delete the draft (intentional park)', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude', value: 'conv-1' },
    })
    const r = reg.modules.sessions.hibernateSession({ sessionId })
    expect(r.ok).toBe(true)
    // The hibernate kill produces an agentExit like any death — still no reap.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
  })

  it('draft with a second live session is kept when one dies', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    const second = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: draft.id,
    }).sessionId
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(second))
    reg.modules.sessions.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(second)).toBe(draft.id)
  })

  it('non-draft issue is never reaped', () => {
    const reg = regWithDaemon()
    const issue = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: issue.id,
    })
    reg.modules.sessions.killSession({ sessionId })
    expect(reg.issues.get(issue.id)).not.toBeNull()
  })

  it('draft with a worktree is kept', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.issues.update(draft.id, { worktreePath: '/repo/.claude/worktrees/wt' })
    expect(reg.issues.get(draft.id)?.draft).toBe(true) // worktree does not clear draft
    reg.modules.sessions.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).not.toBeNull()
  })
})

describe('explicit rehome draft cleanup', () => {
  it('purges a draft after its sole visible session is rehomed', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    const target = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })

    reg.issues.attachSession({ sessionId, targetId: target.id })

    expect(reg.issues.get(draft.id)).toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBe(target.id)
  })

  it('keeps the draft and exited sibling attached when its live session is rehomed', () => {
    const reg = regWithDaemon()
    const exited = draftWithSession(reg)
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(exited.sessionId))
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: exited.sessionId,
      code: 0,
    })
    const liveSessionId = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/repo',
      issueId: exited.draft.id,
    }).sessionId
    const target = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })

    reg.issues.attachSession({ sessionId: liveSessionId, targetId: target.id })

    expect(reg.issues.get(exited.draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(exited.sessionId)).toBe(exited.draft.id)
    expect(reg.modules.sessions.listSessions()).toContainEqual(
      expect.objectContaining({
        sessionId: exited.sessionId,
        status: 'exited',
        issueId: exited.draft.id,
      }),
    )
    expect(reg.modules.sessions.getSessionIssueId(liveSessionId)).toBe(target.id)
  })
})

describe('boot-time draft retention', () => {
  const freshFile = () => join(mkdtempSync(join(tmpdir(), 'podium-reap-')), 'state.sqlite')

  it('does not infer abandonment from a missing session', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg1.gateway.attachDaemon(reg1.sessionStore.hostMachineId, () => {})
    const { draft, sessionId } = draftWithSession(reg1)
    // Leak: the session row vanishes without the reaper seeing it (pre-reaper kills).
    new SessionStore(file).sessions.purgeSession(sessionId)
    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(reg2.issues.get(draft.id)).not.toBeNull()
  })

  it('keeps a draft whose only attached session is exited', () => {
    const file = freshFile()
    const store = new SessionStore(file)
    const reg1 = new SessionRegistry(store, undefined, { instanceId: 'default' })
    reg1.gateway.attachDaemon(reg1.sessionStore.hostMachineId, () => {})
    const { draft, sessionId } = draftWithSession(reg1)
    // Force-persist the row as exited behind the reaper's back (leaked state).
    const row = store.sessions.loadSessions().find((r) => r.id === sessionId)
    if (!row) throw new Error('session row missing')
    store.sessions.upsertSession({ ...row, status: 'exited' })
    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(reg2.issues.get(draft.id)).not.toBeNull()
    expect(reg2.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
  })

  it('keeps drafts with live (reconnecting) or hibernated sessions across boot', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg1.gateway.attachDaemon(reg1.sessionStore.hostMachineId, () => {})
    // Live session draft: comes back 'reconnecting' at boot — must survive.
    const live = draftWithSession(reg1, '/repo-a')
    reg1.gateway.routeDaemonFrame(reg1.sessionStore.hostMachineId, bind(live.sessionId))
    // Hibernated session draft: parked on purpose — must survive.
    const hib = draftWithSession(reg1, '/repo-b')
    reg1.gateway.routeDaemonFrame(reg1.sessionStore.hostMachineId, bind(hib.sessionId))
    reg1.gateway.routeDaemonFrame(reg1.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId: hib.sessionId,
      resume: { kind: 'claude', value: 'conv-h' },
    })
    expect(reg1.modules.sessions.hibernateSession({ sessionId: hib.sessionId }).ok).toBe(true)
    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(reg2.issues.get(live.draft.id)).not.toBeNull()
    expect(reg2.issues.get(hib.draft.id)).not.toBeNull()
  })
})

/**
 * POD-1926 — THE PURGE MUST NOT LEAVE A SESSION POINTING AT THE ROW IT DELETED.
 *
 * `purgeEmptyDraft` really does `DELETE FROM issues`, and `sessions.issue_id`
 * declares no foreign key (only `parent_id`, `superseded_by` and `duplicate_of`
 * have `ON DELETE SET NULL`), so nothing at the SQL layer catches a stale
 * pointer. Explicit rehome cleanup detaches what it can SEE — and it looks through
 * `loadSessions()`, which is `deleted_at IS NULL`, so a TOMBSTONED session is
 * invisible to it in both directions, so the SQL purge must detach it too.
 *
 * The live row that produced this issue: spawned 16:19:20, soft-deleted 16:19:29
 * with `status` still `live`, still naming a draft that no longer exists.
 */
describe('purge of an empty draft detaches tombstoned sessions (POD-1926)', () => {
  const freshFile = () => join(mkdtempSync(join(tmpdir(), 'podium-dangle-')), 'state.sqlite')

  it('a session tombstoned before explicit rehome does not outlive its draft pointer', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg1.gateway.attachDaemon(reg1.sessionStore.hostMachineId, () => {})
    const { draft, sessionId } = draftWithSession(reg1)
    const activeSessionId = reg1.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/repo',
      issueId: draft.id,
    }).sessionId

    // Tombstone it the way a standalone delete does. The row keeps a RUNNABLE
    // status. Explicit rehome cleanup cannot see this row because
    // `loadSessions()` is `deleted_at IS NULL`.
    const store = new SessionStore(file)
    store.sessions.softDeleteSessions([sessionId], new Date().toISOString(), 'standalone')
    const tombstone = store.sessions.getSession(sessionId)
    expect(tombstone?.archived).toBe(false)
    expect(tombstone?.status).not.toBe('exited')
    expect(store.sessions.loadSessions().map((r) => r.id)).not.toContain(sessionId)

    // Rehoming the remaining live session is the explicit cleanup point.
    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    const target = reg2.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    reg2.issues.attachSession({ sessionId: activeSessionId, targetId: target.id })
    expect(reg2.issues.get(draft.id)).toBeNull()

    const after = new SessionStore(file).sessions.getSession(sessionId)
    expect(after).toBeDefined()
    expect(after?.deletedAt).not.toBeNull() // still a tombstone, not resurrected
    expect(after?.issueId).toBeNull()
    expect(after?.refIssueId).toBeNull()
    expect(after?.refLetter).toBeNull()
  })

  it('boot heals references a purge before this fix already left behind', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg1.gateway.attachDaemon(reg1.sessionStore.hostMachineId, () => {})
    const { draft, sessionId } = draftWithSession(reg1)

    // The PRE-FIX state, reconstructed: the issue row is deleted straight from
    // the table (what `purgeEmptyDraft` used to amount to) while the session row
    // keeps naming it. `deleteIssue` deliberately does not touch sessions — only
    // the purge path does — so this leaves the exact damage found in the field.
    const store = new SessionStore(file)
    store.sessions.softDeleteSessions([sessionId], new Date().toISOString(), 'standalone')
    store.issues.deleteIssue(draft.id)
    expect(store.sessions.getSession(sessionId)?.issueId).toBe(draft.id)

    // Reopening the store runs the boot heal ahead of every reader.
    const healed = new SessionStore(file)
    expect(healed.sessions.getSession(sessionId)?.issueId).toBeNull()
    expect(healed.sessions.getSession(sessionId)?.refIssueId).toBeNull()

    // Idempotent: a clean database heals nothing.
    expect(healed.sessions.detachDanglingIssueReferences()).toBe(0)
    expect(healed.issues.pruneOrphanRefLetters()).toBe(0)
  })

  it('a LIVE session keeps its pointers — explicit rehome owns those, not the SQL scrub', () => {
    const file = freshFile()
    const reg = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const { draft, sessionId } = draftWithSession(reg)

    // Scrubbing a live row behind the in-memory `Session` map's back would
    // desync it, so `detachTombstonesFromIssue` must leave it strictly alone.
    new SessionStore(file).sessions.detachTombstonesFromIssue(draft.id)
    expect(new SessionStore(file).sessions.getSession(sessionId)?.issueId).toBe(draft.id)
  })

  it('the deleted issue takes its ref-letter counter with it', () => {
    const file = freshFile()
    const reg = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const { draft } = draftWithSession(reg)

    const store = new SessionStore(file)
    store.issues.allocateSessionLetter(draft.id)
    store.issues.deleteIssue(draft.id)
    // Nothing left to prune: the delete already took the counter.
    expect(store.issues.pruneOrphanRefLetters()).toBe(0)
  })
})
