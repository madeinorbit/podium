import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'
import { openTestStore } from './test-support/open-test-store'

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

async function metaOffer(reg: SessionRegistry, sessionId: string) {
  return (await reg.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)?.offer
}

describe('agent action offer [spec:SP-c7f1]', () => {
  it('setOffer surfaces on session meta with a createdAt; a second offer replaces it', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })

    expect(await metaOffer(reg, sessionId)).toBeUndefined()

    await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    const surfaced = await metaOffer(reg, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    expect(typeof surfaced?.createdAt).toBe('string')

    await reg.modules.sessions.setOffer({ sessionId, message: 'Ready to land', actions: [] })
    expect((await metaOffer(reg, sessionId))?.message).toBe('Ready to land')
    expect((await metaOffer(reg, sessionId))?.actions).toEqual([])
  })

  it('carries artifact references [POD-120] on meta and across a restart', async () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    const artifacts = ['e2e/header-after.png', 'docs/proposal.md']
    await reg.modules.sessions.setOffer({ sessionId, ...OFFER, artifacts })
    expect((await metaOffer(reg, sessionId))?.artifacts).toEqual(artifacts)
    reg.dispose()

    const reg2 = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    expect((await metaOffer(reg2, sessionId))?.artifacts).toEqual(artifacts)

    // A replacing offer WITHOUT artifacts drops them (no sticky column).
    await reg2.modules.sessions.setOffer({ sessionId, ...OFFER })
    expect((await metaOffer(reg2, sessionId))?.artifacts).toBeUndefined()
    reg2.dispose()

    const reg3 = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    expect((await metaOffer(reg3, sessionId))?.artifacts).toBeUndefined()
    reg3.dispose()
  })

  it('clearOffer removes it', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    await reg.modules.sessions.clearOffer(sessionId)
    expect(await metaOffer(reg, sessionId)).toBeUndefined()
  })

  /**
   * THE USER'S DISMISSAL, and the race it must not lose.
   *
   * `dismissOffer` names the offer it dismisses, so the interesting case is not
   * the happy one — it is the click that lands after the agent has already
   * replaced the offer. That click must do NOTHING: the operator has not seen
   * the new offer, so consuming it would drop a question nobody answered.
   */
  it('dismissOffer clears the offer it names, and leaves one that replaced it', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    // The clock is pinned so the two offers cannot share a millisecond — the
    // whole test is about telling them apart by their stamps.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-12T10:00:00.000Z'))
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      const first = (await metaOffer(reg, sessionId))?.createdAt as string

      // A stamp nobody posted is not a licence to clear whatever is standing.
      expect(await reg.modules.sessions.dismissOffer(sessionId, '1999-01-01T00:00:00.000Z')).toBe(false)
      expect((await metaOffer(reg, sessionId))?.createdAt).toBe(first)

      vi.setSystemTime(new Date('2026-08-12T10:00:05.000Z'))
      await reg.modules.sessions.setOffer({ sessionId, message: 'Ready to land', actions: [] })
      const second = (await metaOffer(reg, sessionId))?.createdAt as string
      expect(second).not.toBe(first)

      // The click aimed at the FIRST offer arrives late; the second survives it.
      expect(await reg.modules.sessions.dismissOffer(sessionId, first)).toBe(false)
      expect((await metaOffer(reg, sessionId))?.message).toBe('Ready to land')

      expect(await reg.modules.sessions.dismissOffer(sessionId, second)).toBe(true)
      expect(await metaOffer(reg, sessionId)).toBeUndefined()
      // Dismissing nothing is a no-op, not a throw.
      expect(await reg.modules.sessions.dismissOffer(sessionId, second)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * THE DURABLE ARM OF BOTH OFFER GUARDS [POD-3511].
   *
   * Every offer test above this point uses a session the server still holds in
   * memory, and both guards short-circuit before their durable read on that
   * path: `dismissOffer` takes `session?.offer?.createdAt` and never evaluates
   * the right-hand side of the `??`, and `clearOffer` answers from
   * `clearedInMemory` and never reaches `offerCreatedAt`. So the resident tests
   * cannot see the durable read at all, and stayed green all the way through the
   * defect — which is precisely why the fix needs its own cases.
   *
   * What was wrong: the store went async and both reads were consumed as if they
   * were data. A promise is never `=== undefined` and never `!==`-equal to a
   * stamp string, so neither comparison could go the way it was written. Note
   * these pin the ANSWERS — a `true`, a `false`, a call that must not happen —
   * and not the absence of a throw, because the defect never threw.
   */
  describe('the durable arm of the offer guards [POD-3511]', () => {
    /**
     * THE USER-VISIBLE ONE. "None of these" on a parked or restarted session.
     *
     * `dismissOffer` fell back to the durable stamp, compared a promise against
     * the stamp the user clicked, and refused. It returned false, wrote nothing,
     * and reported no error: the button did nothing and said nothing.
     */
    it('dismisses the offer of a session the server does not hold in memory', async () => {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const gone = asSessionId('dismiss-me-not-in-memory')
      await reg.modules.sessions.setOffer({ sessionId: gone, ...OFFER })
      const stamp = await reg.sessionStore.sessions.offerCreatedAt(gone)
      expect(stamp).toBeTypeOf('string')

      // The TRUE is the claim. An assertion that merely awaited the call would
      // have passed against the defect just as happily.
      expect(await reg.modules.sessions.dismissOffer(gone, stamp as string)).toBe(true)
      expect(await reg.sessionStore.sessions.offerCreatedAt(gone)).toBeUndefined()
    })

    /**
     * ...and the stamp still DISCRIMINATES on that same arm. Without this, a
     * `dismissOffer` that returned true unconditionally would satisfy the case
     * above. The pair is what makes the guard load-bearing rather than merely
     * reachable.
     */
    it('refuses a stamp that does not name the standing offer, durably too', async () => {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const gone = asSessionId('refuse-me-not-in-memory')
      await reg.modules.sessions.setOffer({ sessionId: gone, ...OFFER })

      expect(await reg.modules.sessions.dismissOffer(gone, '1999-01-01T00:00:00.000Z')).toBe(false)
      // The offer the click did not name is still standing.
      expect(await reg.sessionStore.sessions.offerCreatedAt(gone)).toBeTypeOf('string')
    })

    /**
     * THE DEAD EARLY RETURN. `clearOffer`'s "there is nothing to clear" guard
     * compared a promise to `undefined`, which is never true, so the guard never
     * fired and a clear aimed at a session with no row fell straight through to
     * a DELETE for a row that was not there.
     *
     * The resident twin of this is 'clearing when there is no offer writes
     * nothing and says nothing' above; it short-circuits on memory, which is how
     * it stayed green while this arm was broken.
     */
    it('a non-resident session with no offer row is not cleared at all', async () => {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const gone = asSessionId('never-had-an-offer-at-all')
      const deleted = vi.spyOn(reg.sessionStore.sessions, 'clearOffer')

      await reg.modules.sessions.clearOffer(gone)

      expect(deleted).not.toHaveBeenCalled()
      deleted.mockRestore()
    })
  })

  /**
   * WHAT REACHES CLIENTS, not what reaches the database (POD-1104).
   *
   * Both offer writes have an arm that changes the durable `offers` row without
   * going through `repository.persist` — the seam that captures a session change.
   * `broadcastSessions()` does NOT cover for that: it flushes captures, it does
   * not create one, so an arm that marks nothing dirty emits nothing and every
   * client keeps the last SessionMeta it was sent — offer and all.
   *
   * These pin the publication contract on each arm rather than the row alone,
   * which is what the DB-level assertions elsewhere in this file check.
   */
  describe('the durable write and the feed row travel together', () => {
    /** Session changes on the feed since `cursor`, newest state per change. */
    async function sessionChangesSince(reg: SessionRegistry, cursor: number) {
      const res = await reg.modules.sessions.syncChangesSince(cursor)
      // A cursor this recent is always servable as a delta; a snapshot here
      // would mean the assertion silently stopped testing the feed.
      expect(res.kind).toBe('delta')
      return (res as { changes: { entity: string; value?: unknown }[] }).changes.filter(
        (c) => c.entity === 'session',
      )
    }

    async function seeded() {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      reg.modules.sessions.flushBroadcasts()
      return { reg, sessionId, cursor: (await reg.modules.sessions.syncChangesSince(null)).cursor }
    }

    it('clearing a standing offer puts the offer-free meta on the feed', async () => {
      const { reg, sessionId, cursor } = await seeded()
      // The hot path must not pay the durable stamp read: memory answered, so
      // the row is never consulted. Every frequent caller lands here.
      const stampRead = vi.spyOn(reg.sessionStore.sessions, 'offerCreatedAt')
      await reg.modules.sessions.clearOffer(asSessionId(sessionId))
      reg.modules.sessions.flushBroadcasts()
      expect(stampRead).not.toHaveBeenCalled()
      stampRead.mockRestore()

      const changes = await sessionChangesSince(reg, cursor)
      expect(changes).toHaveLength(1)
      expect((changes[0]?.value as { offer?: unknown }).offer).toBeUndefined()
    })

    /**
     * THE REGRESSION. A session still in memory whose durable row outlived its
     * in-memory offer took the early return: DELETE, then a broadcast with
     * nothing marked. The row went, the feed said nothing, and the offer stayed
     * on screen until a reload. Clearing memory's copy directly is how the state
     * is reached here; what matters is that the clear still publishes.
     */
    it('republishes when only the durable row still holds the offer', async () => {
      const { reg, sessionId, cursor } = await seeded()
      const live = (reg as any).modules.sessions.sessions.get(sessionId)
      expect(live.clearOffer()).toBe(true) // memory only — the row survives
      expect(await reg.sessionStore.sessions.offerCreatedAt(asSessionId(sessionId))).toBeTypeOf('string')

      await reg.modules.sessions.clearOffer(asSessionId(sessionId))
      reg.modules.sessions.flushBroadcasts()

      expect(await reg.sessionStore.sessions.offerCreatedAt(asSessionId(sessionId))).toBeUndefined()
      const changes = await sessionChangesSince(reg, cursor)
      expect(changes).toHaveLength(1)
      expect((changes[0]?.value as { offer?: unknown }).offer).toBeUndefined()
    })

    /**
     * …and the way that state is reached WITHOUT reaching into memory. A row
     * whose `actions` JSON is corrupt is dropped by `listOffers` ("corrupt row
     * -> treat as no offer") but still answers `offerCreatedAt`, which reads
     * `created_at` without parsing `actions`. Boot therefore installs a session
     * with no in-memory offer over a row that is still there — and, since the
     * auto-clear callers all gate on the in-memory copy, that row would outlive
     * every turn and every restart. A clear must still retire it.
     */
    it('retires a row that boot could not parse into an in-memory offer', async () => {
      const dir = trackTmp('podium-offer-')
      const file = join(dir, 'store.db')
      const reg = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      reg.dispose()

      const db = openDatabase(file)
      db.prepare('UPDATE offers SET actions = ? WHERE session_id = ?').run('{not json', sessionId)
      db.close()

      const reg2 = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
      // Boot dropped it from memory but left the row standing.
      expect(await metaOffer(reg2, sessionId)).toBeUndefined()
      expect(await reg2.sessionStore.sessions.offerCreatedAt(asSessionId(sessionId))).toBeTypeOf('string')

      await reg2.modules.sessions.clearOffer(asSessionId(sessionId))
      reg2.modules.sessions.flushBroadcasts()
      expect(await reg2.sessionStore.sessions.offerCreatedAt(asSessionId(sessionId))).toBeUndefined()
      reg2.dispose()
    })

    /** The common case. Nothing to clear must cost neither a DELETE nor a feed
     *  row — and must not cost the durable read either, which is why the callers
     *  that clear a standing offer gate on the in-memory copy first. */
    it('clearing when there is no offer writes nothing and says nothing', async () => {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      reg.modules.sessions.flushBroadcasts()
      const cursor = (await reg.modules.sessions.syncChangesSince(null)).cursor
      const deleted = vi.spyOn(reg.sessionStore.sessions, 'clearOffer')

      await reg.modules.sessions.clearOffer(asSessionId(sessionId))
      reg.modules.sessions.flushBroadcasts()
      expect(deleted).not.toHaveBeenCalled()
      expect(await sessionChangesSince(reg, cursor)).toEqual([])
      deleted.mockRestore()
    })

    /**
     * A session the server does not hold in memory has no wire value to publish,
     * so both arms stay silent BY DESIGN — the row write is bookkeeping for the
     * next boot's replay. Safe only because such a session is absent from the
     * change baseline too (kill and issue-delete publish removes; the boot
     * reconcile drops a row it could not load), so no client is holding it.
     */
    it('a non-resident session is durable-only, on both set and clear', async () => {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      reg.modules.sessions.flushBroadcasts()
      const cursor = (await reg.modules.sessions.syncChangesSince(null)).cursor
      const gone = asSessionId('a-session-not-in-memory')

      await reg.modules.sessions.setOffer({ sessionId: gone, ...OFFER })
      reg.modules.sessions.flushBroadcasts()
      expect(await reg.sessionStore.sessions.offerCreatedAt(gone)).toBeTypeOf('string')
      expect(await sessionChangesSince(reg, cursor)).toEqual([])

      await reg.modules.sessions.clearOffer(gone)
      reg.modules.sessions.flushBroadcasts()
      expect(await reg.sessionStore.sessions.offerCreatedAt(gone)).toBeUndefined()
      expect(await sessionChangesSince(reg, cursor)).toEqual([])
    })
  })

  it('persists the offer across a restart (reload from the same store file)', async () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    reg.dispose()

    const reg2 = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    const surfaced = await metaOffer(reg2, sessionId)
    expect(surfaced?.message).toBe(OFFER.message)
    expect(surfaced?.actions).toEqual(OFFER.actions)
    reg2.dispose()
  })

  it('boot reconciliation: user input after the offer drops it on reload', async () => {
    const dir = trackTmp('podium-offer-')
    const file = join(dir, 'store.db')
    const reg = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    const createdAt = (await metaOffer(reg, sessionId))?.createdAt as string
    reg.dispose()

    // The user typed into the session after the offer was posted (e.g. via the
    // raw PTY while the server was down / before the stale-clear shipped).
    const db = openDatabase(file)
    db.prepare('UPDATE sessions SET last_input_at = ? WHERE id = ?').run(
      new Date(Date.parse(createdAt) + 60_000).toISOString(),
      sessionId,
    )
    db.close()

    const reg2 = await SessionRegistry.create(await openTestStore(file), undefined, { instanceId: 'default' })
    expect(await metaOffer(reg2, sessionId)).toBeUndefined()
    reg2.dispose()

    // ...and the offers table row is gone too, not just the in-memory overlay.
    const check = openDatabase(file)
    expect(check.prepare('SELECT COUNT(*) n FROM offers').get()).toEqual({ n: 0 })
    check.close()
  })

  it('clears the offer when a message is queued to the session (a user turn)', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    // A session with no live daemon parks the send into the durable queue, which
    // is the clear-on-turn path a button click also rides through.
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
    await reg.modules.sessions.queueText({ sessionId, text: 'do the thing' })
    expect(await metaOffer(reg, sessionId)).toBeUndefined()
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

    async function seed() {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      const createdAt = (await metaOffer(reg, sessionId))?.createdAt as string
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

    it('entering working after the user typed into the PTY consumes it', async () => {
      const { reg, sessionId, createdAt } = await seed()
      typeIntoPty(reg, sessionId, createdAt)
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect(await metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a forced turn with NO user input (stop-hook/mail wake) preserves it [POD-118]', async () => {
      const { reg, sessionId, createdAt } = await seed()
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    it('a boot replay of the turn that produced the offer (older event-time) leaves it', async () => {
      const { reg, sessionId, createdAt } = await seed()
      typeIntoPty(reg, sessionId, createdAt)
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(minusMinute(createdAt)),
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    it('non-working phases and continued working do not clear', async () => {
      const { reg, sessionId, createdAt } = await seed()
      typeIntoPty(reg, sessionId, createdAt)
      // Turn end after the offer — the offer is exactly for this moment.
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: idle(plusMinute(createdAt)),
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
      // working → working (hook updates mid-turn) never re-triggers: only the
      // ENTRY into working counts, so an offer set mid-turn survives its turn.
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(createdAt)),
      })
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      typeIntoPty(reg, sessionId, createdAt)
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: working(plusMinute(plusMinute(createdAt))),
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })
  })

  // Every causally-observed harness (claude-code, codex, grok) reports phase
  // through 'agentObservation', and the legacy branch above REFUSES those
  // sessions once a checkpoint exists — so the staleness rule has to live on
  // this path too, or a typed continuation never retires the card (POD-378).
  describe('staleness on the causal observation path [POD-378]', () => {
    const shift = (iso: string, seconds: number) =>
      new Date(Date.parse(iso) + seconds * 1000).toISOString()

    async function seed(agentKind: 'claude-code' | 'codex') {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
      const { sessionId } = await reg.modules.sessions.createSession({ agentKind, cwd: '/p' })
      await reg.modules.sessions.setOffer({ sessionId, ...OFFER })
      const createdAt = (await metaOffer(reg, sessionId))?.createdAt as string
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

    it("a human-origin turn_opened consumes it (the harness's own answer)", async () => {
      const { reg, sessionId, observe, turnOpened } = await seed('claude-code')
      observe(turnOpened('human'))
      expect(await metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a controller-origin turn_opened (chat/button) consumes it', async () => {
      const { reg, sessionId, observe, turnOpened } = await seed('claude-code')
      observe(turnOpened('controller'))
      expect(await metaOffer(reg, sessionId)).toBeUndefined()
    })

    it.each([
      'mail',
      'auto_continue',
      'steward',
      'system',
    ] as const)('a %s-origin turn preserves it — nobody saw the offer yet [POD-118]', async (origin) => {
      const { reg, sessionId, observe, turnOpened } = await seed('claude-code')
      observe(turnOpened(origin))
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    // Codex and grok observers stamp every transition 'provider' — they track
    // no origin — so those harnesses fall back to input evidence.
    it('a provider-origin turn consumes it only after the user typed', async () => {
      const withoutTyping = await seed('codex')
      withoutTyping.observe(withoutTyping.turnOpened('provider'))
      expect((await metaOffer(withoutTyping.reg, withoutTyping.sessionId))?.message).toBe(OFFER.message)

      const withTyping = await seed('codex')
      typeIntoPty(withTyping.reg, withTyping.sessionId, shift(withTyping.createdAt, 30))
      withTyping.observe(withTyping.turnOpened('provider'))
      expect(await metaOffer(withTyping.reg, withTyping.sessionId)).toBeUndefined()
    })

    // A mail wake types into the PTY too, so "any input since the offer" is not
    // evidence of a person — only user-origin input counts. The delivery must
    // not consume the offer on its own way in either [POD-118].
    it('a mail delivery neither clears the offer nor counts as input evidence', async () => {
      const { reg, sessionId, observe, turnOpened } = await seed('codex')
      await reg.modules.sessions.sendText({
        sessionId: asSessionId(sessionId),
        text: 'a message from another agent',
        inputOrigin: 'mail',
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
      observe(turnOpened('provider'))
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    it('a chat send still clears it on the way in', async () => {
      const { reg, sessionId } = await seed('codex')
      await reg.modules.sessions.sendText({
        sessionId: asSessionId(sessionId),
        text: 'carry on',
      })
      expect(await metaOffer(reg, sessionId)).toBeUndefined()
    })

    it('a turn that opened BEFORE the offer cannot consume it', async () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = await seed('claude-code')
      const early = turnOpened('human')
      observe({ ...early, receivedAt: shift(createdAt, -30), providerAt: shift(createdAt, -30) })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    it('mid-turn activity and the turn end that posts the offer leave it', async () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = await seed('claude-code')
      const open = turnOpened('human')
      observe({
        ...open,
        transitionKind: 'activity',
        sourceEventKind: 'PostToolUse',
        transitionId: 'turn-1-activity',
      })
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
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
      expect((await metaOffer(reg, sessionId))?.message).toBe(OFFER.message)
    })

    // The same branch divergence dropped the POD-98 git refresh (POD-381).
    it('a turn ending on this path fires the issue git-state refresh [POD-381]', async () => {
      const { reg, sessionId, createdAt, observe, turnOpened } = await seed('claude-code')
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
