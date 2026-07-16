import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
  actions: [{ label: 'Fix them', prompt: 'Please fix the failing tests' }],
}

function metaOffer(reg: SessionRegistry, sessionId: string) {
  return reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.offer
}

describe('agent action offer [spec:SP-c7f1]', () => {
  it('setOffer surfaces on session meta with a createdAt; a second offer replaces it', () => {
    const reg = new SessionRegistry()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })

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

  it('clearOffer removes it', () => {
    const reg = new SessionRegistry()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.modules.sessions.clearOffer(sessionId)
    expect(metaOffer(reg, sessionId)).toBeUndefined()
  })

  it('persists the offer across a restart (reload from the same store file)', () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = new SessionRegistry(new SessionStore(file))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.dispose()

    const reg2 = new SessionRegistry(new SessionStore(file))
    const surfaced = metaOffer(reg2, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    reg2.dispose()
  })

  it('clears the offer when a message is queued to the session (a user turn)', () => {
    const reg = new SessionRegistry()
    // A session with no live daemon parks the send into the durable queue, which
    // is the clear-on-turn path a button click also rides through.
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.modules.sessions.queueText({ sessionId, text: 'do the thing' })
    expect(metaOffer(reg, sessionId)).toBeUndefined()
  })
})
