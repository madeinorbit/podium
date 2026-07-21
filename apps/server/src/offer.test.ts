import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Agent action offer [spec:SP-c7f1] — service-level set/replace/clear, meta
// surfacing, persistence across a restart, and clear-on-turn (queue path).

const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const OFFER = {
  message: 'Tests are red on main',
  actions: [
    { label: 'Fix them', prompt: 'Please fix the failing tests' },
    // Feedback-collecting action — `input` must survive set + persistence.
    { label: 'Send back', prompt: 'Revise per this feedback:', input: true },
  ],
}

function metaOffer(reg: SessionRegistry, sessionId: string) {
  return reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.offer
}

describe('agent action offer [spec:SP-c7f1]', () => {
  it('setOffer surfaces on session meta with a createdAt; a second offer replaces it', () => {
    const reg = new SessionRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })

    expect(metaOffer(reg, sessionId)).toBeUndefined()

    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    const surfaced = metaOffer(reg, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    expect(typeof surfaced?.createdAt).toBe('string')

    reg.modules.sessions.setOffer({ sessionId, message: 'Ready to land', actions: [] })
    expect(metaOffer(reg, sessionId)?.message).toBe('Ready to land')
    expect(metaOffer(reg, sessionId)?.actions).toEqual([])
  })

  it('carries artifact references [POD-120] on meta and across a restart', () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = new SessionRegistry(new SessionStore(file))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    const artifacts = ['e2e/header-after.png', 'docs/proposal.md']
    reg.modules.sessions.setOffer({ sessionId, ...OFFER, artifacts })
    expect(metaOffer(reg, sessionId)?.artifacts).toEqual(artifacts)
    reg.dispose()

    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(metaOffer(reg2, sessionId)?.artifacts).toEqual(artifacts)

    // A replacing offer WITHOUT artifacts drops them (no sticky column).
    reg2.modules.sessions.setOffer({ sessionId, ...OFFER })
    expect(metaOffer(reg2, sessionId)?.artifacts).toBeUndefined()
    reg2.dispose()

    const reg3 = new SessionRegistry(new SessionStore(file))
    expect(metaOffer(reg3, sessionId)?.artifacts).toBeUndefined()
    reg3.dispose()
  })

  it('clearOffer removes it', () => {
    const reg = new SessionRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.modules.sessions.clearOffer(sessionId)
    expect(metaOffer(reg, sessionId)).toBeUndefined()
  })

  it('persists the offer across a restart (reload from the same store file)', () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = new SessionRegistry(new SessionStore(file))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.dispose()

    const reg2 = new SessionRegistry(new SessionStore(file))
    const surfaced = metaOffer(reg2, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    reg2.dispose()
  })

  it('boot reconciliation: user input after the offer drops it on reload', () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = new SessionRegistry(new SessionStore(file))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    const createdAt = metaOffer(reg, sessionId)?.createdAt as string
    reg.dispose()

    // The user typed into the session after the offer was posted (e.g. via the
    // raw PTY while the server was down / before the stale-clear shipped).
    const db = openDatabase(file)
    db.prepare('UPDATE sessions SET last_input_at = ? WHERE id = ?').run(
      new Date(Date.parse(createdAt) + 60_000).toISOString(),
      sessionId,
    )
    db.close()

    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(metaOffer(reg2, sessionId)).toBeUndefined()
    reg2.dispose()

    // ...and the offers table row is gone too, not just the in-memory overlay.
    const check = openDatabase(file)
    expect(check.prepare('SELECT COUNT(*) n FROM offers').get()).toEqual({ n: 0 })
    check.close()
  })

  it('clears the offer when a message is queued to the session (a user turn)', () => {
    const reg = new SessionRegistry()
    // A session with no live daemon parks the send into the durable queue, which
    // is the clear-on-turn path a button click also rides through.
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.modules.sessions.queueText({ sessionId, text: 'do the thing' })
    expect(metaOffer(reg, sessionId)).toBeUndefined()
  })

  // The USER moving the conversation past the offer makes it stale — a NEW
  // turn (entry into 'working' after the offer's createdAt) that follows raw
  // controller keystrokes clears it, catching the path sendText never sees.
  // A turn WITHOUT user input (stop-hook continuation, mail/cron wake) must
  // preserve the standing offer the human never saw [POD-118].
  describe('staleness: a user-driven new turn after the offer clears it', () => {
    const working = (since: string) => ({
      phase: 'working' as const,
      since,
      nativeSubagentCount: 0,
    })
    const idle = (since: string) => ({
      phase: 'idle' as const,
      since,
      nativeSubagentCount: 0,
    })

    function seed() {
      const reg = new SessionRegistry()
      reg.modules.sessions.attachDaemon('local', () => {})
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      const createdAt = metaOffer(reg, sessionId)?.createdAt as string
      return { reg, sessionId, createdAt }
    }
    // Raw PTY keystrokes from the controlling client — bumps lastInputAtMs.
    // Pinned a minute after the offer: same-ms input would not count as "after"
    // (strictly-greater, matching the boot reconcile).
    function typeIntoPty(reg: SessionRegistry, sessionId: string, afterIso: string) {
      const clientId = reg.modules.sessions.attachClient(() => {})
      reg.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(afterIso) + 60_000)
      try {
        reg.modules.sessions.onClientMessage(clientId, {
          type: 'input',
          sessionId,
          data: Buffer.from('fix it\r').toString('base64'),
        })
      } finally {
        nowSpy.mockRestore()
      }
    }
    const plusMinute = (iso: string) => new Date(Date.parse(iso) + 60_000).toISOString()
    const minusMinute = (iso: string) => new Date(Date.parse(iso) - 60_000).toISOString()

    it('entering working after the user typed into the PTY consumes it', () => {
      const { reg, sessionId, createdAt } = seed()
      typeIntoPty(reg, sessionId, createdAt)
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a forced turn with NO user input (stop-hook/mail wake) preserves it [POD-118]', () => {
      const { reg, sessionId, createdAt } = seed()
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    it('a boot replay of the turn that produced the offer (older event-time) leaves it', () => {
      const { reg, sessionId, createdAt } = seed()
      typeIntoPty(reg, sessionId, createdAt)
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: working(minusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    it('non-working phases and continued working do not clear', () => {
      const { reg, sessionId, createdAt } = seed()
      typeIntoPty(reg, sessionId, createdAt)
      // Turn end after the offer — the offer is exactly for this moment.
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: idle(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
      // working → working (hook updates mid-turn) never re-triggers: only the
      // ENTRY into working counts, so an offer set mid-turn survives its turn.
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      typeIntoPty(reg, sessionId, createdAt)
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(plusMinute(createdAt))),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })
  })
})
