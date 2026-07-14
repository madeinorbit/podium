/**
 * Session birth naming (#474) — allocation happens at deliberate naming points
 * (spawn / first attach / boot backfill), never lazily during serialization, so
 * a broadcast can never brand a soon-to-be-attached session POD-DRAFT-n.
 */
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function harness() {
  const store = new SessionStore(':memory:')
  store.repos.addRepo('/r/podium') // prefix POD
  const reg = new SessionRegistry(store)
  const issue = reg.modules.issues.create({ repoPath: '/r/podium', title: 'T', startNow: false })
  const meta = (id: string) =>
    reg.modules.sessions.listSessions().find((s) => s.sessionId === id)
  return { store, reg, issue, meta }
}

describe('session birth naming (#474)', () => {
  it('spawn with a resolved issueId gets the issue letter immediately', () => {
    const { reg, issue, meta } = harness()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/podium',
      issueId: issue.id,
    })
    expect(meta(sessionId)?.displayRef).toBe(`${issue.displayRef}-A`)
  })

  it('issueless spawn gets a DRAFT ordinal, not an issue letter', () => {
    const { reg, meta } = harness()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r/podium' })
    expect(meta(sessionId)?.displayRef).toBe('POD-DRAFT-1')
  })

  it('a broadcast/listSessions read NEVER allocates: unnamed stays unnamed', () => {
    const { store, reg } = harness()
    // A session in an unregistered cwd has no prefix — no DRAFT allocation either.
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/elsewhere' })
    reg.modules.sessions.listSessions()
    reg.modules.sessions.listSessions()
    const row = store.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(row?.refIssueId).toBeNull()
    expect(row?.refDraft).toBeNull()
  })

  it('first attach names an unnamed session with the issue letter (no DRAFT brand)', () => {
    const { reg, issue, meta } = harness()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/elsewhere' })
    reg.modules.sessions.setSessionIssueId(sessionId, issue.id)
    expect(meta(sessionId)?.displayRef).toBe(`${issue.displayRef}-A`)
  })

  it('re-attach keeps the permanent birth name', () => {
    const { reg, issue, meta } = harness()
    const other = reg.modules.issues.create({ repoPath: '/r/podium', title: 'U', startNow: false })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/podium',
      issueId: issue.id,
    })
    reg.modules.sessions.setSessionIssueId(sessionId, other.id)
    expect(meta(sessionId)?.displayRef).toBe(`${issue.displayRef}-A`)
    expect(meta(sessionId)?.issueId).toBe(other.id)
  })

  it('boot backfill names historical unnamed sessions once, deterministically', () => {
    const store = new SessionStore(':memory:')
    store.repos.addRepo('/r/podium')
    const reg1 = new SessionRegistry(store)
    const a = reg1.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r/podium' }).sessionId
    // Simulate a pre-#474 row: rewrite it with its ref wiped (COALESCE in the
    // upsert keeps non-null refs, so write via a fresh row literal).
    const seeded = store.sessions.loadSessions().find((r) => r.id === a)!
    store.sessions.purgeSession(a)
    store.sessions.upsertSession({ ...seeded, refIssueId: null, refLetter: null, refDraft: null })
    const reg2 = new SessionRegistry(store)
    reg2.modules.sessions.loadFromStore()
    const row = store.sessions.loadSessions().find((r) => r.id === a)
    expect(row?.refDraft).not.toBeNull()
  })
})
