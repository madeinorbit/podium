import { type AgentRuntimeState, asSessionId, asUserId, type UserId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../bus'
import { type NotifyDeps, NotifyService, type SessionNoticeInfo } from './service'

/**
 * THE PER-USER TELEGRAM GATE, WHICH NOTHING COVERED (POD-3263).
 *
 * `telegramRouteAvailable` is the fail-closed answer to "is this user's chat
 * actually bound?", and it became a durable read in the async flip. Nothing
 * asserted on it: `notify.test.ts` exercises the pure notice builders and never
 * constructs the service, so the gate could be disabled outright and every test
 * stayed green.
 *
 * That matters more than an ordinary coverage hole because of HOW the flip
 * breaks a predicate. Dropping the `await` does not produce `false` — it
 * produces a promise, and a promise is truthy, so the gate reads OPEN for every
 * user. The failure is a notice delivered on behalf of somebody whose route was
 * never bound, and it is silent. Both answers are pinned here.
 */
const NOW = Date.parse('2026-09-06T09:00:00.000Z')
const OWNER = asUserId('owner')

const info = (): SessionNoticeInfo => ({
  sessionId: asSessionId('s1'),
  name: 'podium / keyboard',
  title: 'keyboard',
  cwd: '/repo',
  agentKind: 'claude-code',
})

const state = (phase: AgentRuntimeState['phase']): AgentRuntimeState => ({
  phase,
  since: new Date(NOW).toISOString(),
  nativeSubagentCount: 0,
})

/** Every port resolves, the way the real ones do — a synchronous fake would
 *  satisfy the un-awaited spelling too and so could not fail on a dropped await. */
function harness(input: { routeAvailable: boolean }) {
  const requested: Array<{ ownerUserId: UserId; text: string }> = []
  const pushed: Array<{ chatId: string }> = []
  const settings = PodiumSettings.parse({
    notifications: { web: true, ntfyTopic: '', telegramChatId: '4242' },
  })
  const deps: NotifyDeps = {
    getSettings: async () => settings,
    telegramBotToken: async () => 'bot-token',
    telegramRouteAvailable: async () => input.routeAvailable,
    requestTelegram: (request) => {
      requested.push({ ownerUserId: request.ownerUserId, text: request.text })
    },
    appendEvent: () => {},
    now: () => NOW,
    clients: () => [],
    sessionInfo: () => info(),
    sessionStates: () => [],
  }
  const bus = new EventBus()
  const service = new NotifyService(
    deps,
    { ntfy: () => {}, telegram: (config) => pushed.push({ chatId: config.chatId }) },
    bus,
  )
  return { service, bus, requested, pushed }
}

/** The bus schedules listeners; it does not await them. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('the per-user Telegram route gate', () => {
  it('delivers to a user whose route is bound', async () => {
    const h = harness({ routeAvailable: true })

    h.bus.emit('session.stateChanged', {
      sessionId: asSessionId('s1'),
      ownerUserId: OWNER,
      prev: state('working'),
      next: state('needs_user'),
    })
    await settle()

    expect(h.requested.map((r) => r.ownerUserId)).toEqual([OWNER])
  })

  it('stays silent for a user whose route is NOT bound', async () => {
    const h = harness({ routeAvailable: false })

    h.bus.emit('session.stateChanged', {
      sessionId: asSessionId('s1'),
      ownerUserId: OWNER,
      prev: state('working'),
      next: state('needs_user'),
    })
    await settle()

    // Neither the per-user request nor the raw push: an unbound route is not a
    // reason to fall back to the instance-wide chat id.
    expect(h.requested).toEqual([])
    expect(h.pushed).toEqual([])
  })
})
