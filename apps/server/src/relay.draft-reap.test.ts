import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// issue-as-workspace: empty-draft auto-cleanup when its sessions die (kill /
// archive / exit) + the boot-time sweep for drafts leaked before the reaper
// existed. Hibernation is an intentional park and must NOT reap.

const G = { cols: 80, rows: 24 }
const bind = (sessionId: string) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

function regWithDaemon(store?: SessionStore) {
  const reg = new SessionRegistry(store)
  reg.attachDaemon('local', () => {})
  return reg
}

function draftWithSession(reg: SessionRegistry, repo = '/repo') {
  const draft = reg.issues.createDraftFor(repo)
  const { sessionId } = reg.createSession({
    agentKind: 'claude-code',
    cwd: repo,
    issueId: draft.id,
  })
  return { draft, sessionId }
}

describe('empty-draft reap on session death', () => {
  it('kill of the last attached session deletes the draft', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    expect(reg.issues.get(draft.id)).not.toBeNull()
    reg.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).toBeNull()
    expect(reg.listSessions()).toHaveLength(0)
  })

  it('archiving the last attached session deletes the draft and detaches the session', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.setArchived({ sessionId, archived: true })
    expect(reg.issues.get(draft.id)).toBeNull()
    // The surviving (archived) session must not dangle on a deleted issue.
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBeNull()
  })

  it('agent exit of the last attached session deletes the draft and detaches the dead session', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.onDaemonMessageFrom('local', bind(sessionId))
    reg.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(reg.issues.get(draft.id)).toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBeNull()
    // Exited row itself survives (resurrectable) — only the empty draft goes.
    expect(reg.listSessions().map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('hibernation does NOT delete the draft (intentional park)', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.onDaemonMessageFrom('local', bind(sessionId))
    reg.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude', value: 'conv-1' },
    })
    const r = reg.hibernateSession({ sessionId })
    expect(r.ok).toBe(true)
    // The hibernate kill produces an agentExit like any death — still no reap.
    reg.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(sessionId)).toBe(draft.id)
  })

  it('draft with a second live session is kept when one dies', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    const second = reg.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: draft.id,
    }).sessionId
    reg.onDaemonMessageFrom('local', bind(second))
    reg.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).not.toBeNull()
    expect(reg.modules.sessions.getSessionIssueId(second)).toBe(draft.id)
  })

  it('non-draft issue is never reaped', () => {
    const reg = regWithDaemon()
    const issue = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    const { sessionId } = reg.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: issue.id,
    })
    reg.killSession({ sessionId })
    expect(reg.issues.get(issue.id)).not.toBeNull()
  })

  it('draft with a worktree is kept', () => {
    const reg = regWithDaemon()
    const { draft, sessionId } = draftWithSession(reg)
    reg.issues.update(draft.id, { worktreePath: '/repo/.claude/worktrees/wt' })
    expect(reg.issues.get(draft.id)?.draft).toBe(true) // worktree does not clear draft
    reg.killSession({ sessionId })
    expect(reg.issues.get(draft.id)).not.toBeNull()
  })
})

describe('boot-time leaked-draft sweep', () => {
  const freshFile = () => join(mkdtempSync(join(tmpdir(), 'podium-reap-')), 'state.sqlite')

  it('reaps a draft whose attached session no longer exists', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file))
    reg1.attachDaemon('local', () => {})
    const { draft, sessionId } = draftWithSession(reg1)
    // Leak: the session row vanishes without the reaper seeing it (pre-reaper kills).
    new SessionStore(file).deleteSession(sessionId)
    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(reg2.issues.get(draft.id)).toBeNull()
  })

  it('reaps a draft whose only attached session is exited, detaching it', () => {
    const file = freshFile()
    const store = new SessionStore(file)
    const reg1 = new SessionRegistry(store)
    reg1.attachDaemon('local', () => {})
    const { draft, sessionId } = draftWithSession(reg1)
    // Force-persist the row as exited behind the reaper's back (leaked state).
    const row = store.loadSessions().find((r) => r.id === sessionId)
    if (!row) throw new Error('session row missing')
    store.upsertSession({ ...row, status: 'exited' })
    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(reg2.issues.get(draft.id)).toBeNull()
    expect(reg2.modules.sessions.getSessionIssueId(sessionId)).toBeNull()
  })

  it('keeps drafts with live (reconnecting) or hibernated sessions across boot', () => {
    const file = freshFile()
    const reg1 = new SessionRegistry(new SessionStore(file))
    reg1.attachDaemon('local', () => {})
    // Live session draft: comes back 'reconnecting' at boot — must survive.
    const live = draftWithSession(reg1, '/repo-a')
    reg1.onDaemonMessageFrom('local', bind(live.sessionId))
    // Hibernated session draft: parked on purpose — must survive.
    const hib = draftWithSession(reg1, '/repo-b')
    reg1.onDaemonMessageFrom('local', bind(hib.sessionId))
    reg1.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId: hib.sessionId,
      resume: { kind: 'claude', value: 'conv-h' },
    })
    expect(reg1.hibernateSession({ sessionId: hib.sessionId }).ok).toBe(true)
    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(reg2.issues.get(live.draft.id)).not.toBeNull()
    expect(reg2.issues.get(hib.draft.id)).not.toBeNull()
  })
})
