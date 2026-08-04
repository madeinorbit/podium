import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'

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
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
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
    const reg = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    const artifacts = ['e2e/header-after.png', 'docs/proposal.md']
    reg.modules.sessions.setOffer({ sessionId, ...OFFER, artifacts })
    expect(metaOffer(reg, sessionId)?.artifacts).toEqual(artifacts)
    reg.dispose()

    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(metaOffer(reg2, sessionId)?.artifacts).toEqual(artifacts)

    // A replacing offer WITHOUT artifacts drops them (no sticky column).
    reg2.modules.sessions.setOffer({ sessionId, ...OFFER })
    expect(metaOffer(reg2, sessionId)?.artifacts).toBeUndefined()
    reg2.dispose()

    const reg3 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(metaOffer(reg3, sessionId)?.artifacts).toBeUndefined()
    reg3.dispose()
  })

  it('clearOffer removes it', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
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
    const reg = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.dispose()

    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    const surfaced = metaOffer(reg2, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    reg2.dispose()
  })

  it('boot reconciliation: user input after the offer drops it on reload', () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
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

    const reg2 = new SessionRegistry(new SessionStore(file), undefined, { instanceId: 'default' })
    expect(metaOffer(reg2, sessionId)).toBeUndefined()
    reg2.dispose()

    // ...and the offers table row is gone too, not just the in-memory overlay.
    const check = openDatabase(file)
    expect(check.prepare('SELECT COUNT(*) n FROM offers').get()).toEqual({ n: 0 })
    check.close()
  })

  it('clears the offer when a message is queued to the session (a user turn)', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
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
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
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
      const clientId = attachTestClient(reg.clientGateway, () => {})
      reg.clientGateway.routeClientFrame(clientId, {
        type: 'attach',
        sessionId: asSessionId(sessionId),
      })
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(afterIso) + 60_000)
      try {
        reg.clientGateway.routeClientFrame(clientId, {
          type: 'input',
          sessionId: asSessionId(sessionId),
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
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a forced turn with NO user input (stop-hook/mail wake) preserves it [POD-118]', () => {
      const { reg, sessionId, createdAt } = seed()
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    it('a boot replay of the turn that produced the offer (older event-time) leaves it', () => {
      const { reg, sessionId, createdAt } = seed()
      typeIntoPty(reg, sessionId, createdAt)
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: idle(plusMinute(createdAt)),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
      // working → working (hook updates mid-turn) never re-triggers: only the
      // ENTRY into working counts, so an offer set mid-turn survives its turn.
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      typeIntoPty(reg, sessionId, createdAt)
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(plusMinute(createdAt))),
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })
  })

  // Every causally-observed harness (claude-code, codex, grok) reports phase
  // through 'agentObservation', and the legacy branch above REFUSES those
  // sessions once a checkpoint exists — so the staleness rule has to live on
  // this path too, or a typed continuation never retires the card (POD-378).
  describe('staleness on the causal observation path [POD-378]', () => {
    const shift = (iso: string, seconds: number) =>
      new Date(Date.parse(iso) + seconds * 1000).toISOString()

    function seed(agentKind: 'claude-code' | 'codex') {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
      const { sessionId } = reg.modules.sessions.createSession({ agentKind, cwd: '/p' })
      reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      const createdAt = metaOffer(reg, sessionId)?.createdAt as string
      const provider = agentKind === 'claude-code' ? ('claude-code' as const) : ('codex' as const)
      const observe = (observation: AgentObservation) =>
        reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
          type: 'agentObservation',
          observation,
        })
      const state = (phase: 'idle' | 'working', since: string) => ({
        phase,
        since,
        workingMsTotal: 0,
        nativeSubagentCount: 0,
      })
      // The bootstrap snapshot the observer opens with: it establishes the
      // checkpoint (which is what makes the legacy branch bail) and predates
      // the offer, so it can never be mistaken for the continuation.
      const bootstrap: AgentObservation = {
        podiumSessionId: asSessionId(sessionId),
        provider,
        providerSessionId: null,
        bindingVersion: 1,
        providerTurnId: null,
        providerPromptId: null,
        observerGeneration: 1,
        providerCursor: { segmentId: 'seg-1', components: { file: 10 } },
        providerAt: shift(createdAt, -120),
        receivedAt: shift(createdAt, -120),
        sourceEventKind: 'bootstrap',
        transitionKind: 'snapshot',
        provenance: 'bootstrap',
        inputOrigin: 'provider',
        turnEpoch: 0,
        priorPhase: 'unknown',
        nextPhase: 'idle',
        transitionId: 'snapshot-1',
        state: state('idle', shift(createdAt, -120)),
      }
      observe(bootstrap)
      /** The next turn opening, a minute after the offer was posted. */
      const turnOpened = (inputOrigin: AgentObservation['inputOrigin']): AgentObservation => ({
        ...bootstrap,
        providerCursor: { segmentId: 'seg-1', components: { file: 20 } },
        providerAt: shift(createdAt, 60),
        receivedAt: shift(createdAt, 60),
        sourceEventKind: 'UserPromptSubmit',
        transitionKind: 'turn_opened',
        provenance: 'live',
        inputOrigin,
        turnEpoch: 1,
        priorPhase: 'idle',
        nextPhase: 'working',
        transitionId: 'turn-1-open',
        state: state('working', shift(createdAt, 60)),
      })
      return { reg, sessionId, createdAt, observe, turnOpened, shift }
    }

    // Raw PTY keystrokes from the controlling client — the continuation the
    // chat composer never sees, and the one that left cards standing.
    function typeIntoPty(reg: SessionRegistry, sessionId: string, atIso: string) {
      const clientId = attachTestClient(reg.clientGateway, () => {})
      reg.clientGateway.routeClientFrame(clientId, {
        type: 'attach',
        sessionId: asSessionId(sessionId),
      })
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(atIso))
      try {
        reg.clientGateway.routeClientFrame(clientId, {
          type: 'input',
          sessionId: asSessionId(sessionId),
          data: Buffer.from('fix it\r').toString('base64'),
        })
      } finally {
        nowSpy.mockRestore()
      }
    }

    it("a human-origin turn_opened consumes it (the harness's own answer)", () => {
      const { reg, sessionId, observe, turnOpened } = seed('claude-code')
      observe(turnOpened('human'))
      expect(metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a controller-origin turn_opened (chat/button) consumes it', () => {
      const { reg, sessionId, observe, turnOpened } = seed('claude-code')
      observe(turnOpened('controller'))
      expect(metaOffer(reg, sessionId)).toBeUndefined()
    })

    it.each([
      'mail',
      'auto_continue',
      'steward',
      'system',
    ] as const)('a %s-origin turn preserves it — nobody saw the offer yet [POD-118]', (origin) => {
      const { reg, sessionId, observe, turnOpened } = seed('claude-code')
      observe(turnOpened(origin))
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    // Codex and grok observers stamp every transition 'provider' — they track
    // no origin — so those harnesses fall back to input evidence.
    it('a provider-origin turn consumes it only after the user typed', () => {
      const withoutTyping = seed('codex')
      withoutTyping.observe(withoutTyping.turnOpened('provider'))
      expect(metaOffer(withoutTyping.reg, withoutTyping.sessionId)?.message).toBe(OFFER.message)

      const withTyping = seed('codex')
      typeIntoPty(withTyping.reg, withTyping.sessionId, shift(withTyping.createdAt, 30))
      withTyping.observe(withTyping.turnOpened('provider'))
      expect(metaOffer(withTyping.reg, withTyping.sessionId)).toBeUndefined()
    })

    // A mail wake types into the PTY too, so "any input since the offer" is not
    // evidence of a person — only user-origin input counts. The delivery must
    // not consume the offer on its own way in either [POD-118].
    it('a mail delivery neither clears the offer nor counts as input evidence', () => {
      const { reg, sessionId, observe, turnOpened } = seed('codex')
      reg.modules.sessions.sendText({
        sessionId: asSessionId(sessionId),
        text: 'a message from another agent',
        inputOrigin: 'mail',
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
      observe(turnOpened('provider'))
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    it('a chat send still clears it on the way in', () => {
      const { reg, sessionId } = seed('codex')
      reg.modules.sessions.sendText({
        sessionId: asSessionId(sessionId),
        text: 'carry on',
      })
      expect(metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a turn that opened BEFORE the offer cannot consume it', () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = seed('claude-code')
      const early = turnOpened('human')
      observe({ ...early, receivedAt: shift(createdAt, -30), providerAt: shift(createdAt, -30) })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    it('mid-turn activity and the turn end that posts the offer leave it', () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = seed('claude-code')
      const open = turnOpened('human')
      observe({
        ...open,
        transitionKind: 'activity',
        sourceEventKind: 'PostToolUse',
        transitionId: 'turn-1-activity',
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
      observe({
        ...open,
        providerCursor: { segmentId: 'seg-1', components: { file: 30 } },
        transitionKind: 'turn_terminal',
        sourceEventKind: 'Stop',
        priorPhase: 'working',
        nextPhase: 'idle',
        transitionId: 'turn-1-done',
        state: {
          phase: 'idle' as const,
          since: shift(createdAt, 90),
          workingMsTotal: 0,
          nativeSubagentCount: 0,
        },
      })
      expect(metaOffer(reg, sessionId)?.message).toBe(OFFER.message)
    })

    // The same branch divergence dropped the POD-98 git refresh (POD-381).
    it('a turn ending on this path fires the issue git-state refresh [POD-381]', () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = seed('claude-code')
      const derived: string[] = []
      reg.bus.on('issue.sessionDerived', (event) => {
        if ('sessionId' in event && event.sessionId === sessionId) derived.push(event.kind)
      })
      const open = turnOpened('human')
      observe(open)
      expect(derived).not.toContain('turnEnd')
      observe({
        ...open,
        providerCursor: { segmentId: 'seg-1', components: { file: 30 } },
        providerAt: shift(createdAt, 90),
        receivedAt: shift(createdAt, 90),
        transitionKind: 'turn_terminal',
        sourceEventKind: 'Stop',
        priorPhase: 'working',
        nextPhase: 'idle',
        transitionId: 'turn-1-done',
        state: {
          phase: 'idle' as const,
          since: shift(createdAt, 90),
          workingMsTotal: 0,
          nativeSubagentCount: 0,
        },
      })
      expect(derived).toContain('turnEnd')
    })
  })
})
