import { type AgentRuntimeState, asIssueId, asSessionId, asUserId, type UserId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
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
    requestTelegram: async (request) => {
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

/**
 * `requestTelegram` USED TO BE TYPED `=> void` (POD-3820).
 *
 * That is the shape section 3 of the POD-3802 report lists, and the shape that
 * wedged the lock queue: a dependency whose declared return type says "nothing
 * comes back" wired to something asynchronous that touches the store. Under the
 * async executor the inner transaction JOINS whatever span the caller has open,
 * as a savepoint. Drop the promise and the caller's next statement addresses a
 * frame with an open child — refused — while the orphaned savepoint dies when
 * the span closes.
 *
 * `void` was not a description of the dep, it was a PROHIBITION on the fix: the
 * caller could not await what the type said did not exist. So this pins the fix
 * from the outside, with a production-shaped dep — one that opens a REAL store
 * transaction, which is the single thing a `vi.fn()` stub cannot show.
 */
describe('NotifyService under the async store (POD-3820)', () => {
  async function spanHarness() {
    const store = await openTestStore(':memory:')
    const requested: UserId[] = []
    const settings = PodiumSettings.parse({
      notifications: { web: false, ntfyTopic: '', telegramChatId: '4242' },
    })
    const deps: NotifyDeps = {
      getSettings: async () => settings,
      telegramBotToken: async () => 'bot-token',
      telegramRouteAvailable: async () => true,
      // Production-shaped: the bus listener behind this request is
      // `MessagingService.sendUserNotice`, which opens its own store
      // transaction. Nothing here is a mock.
      requestTelegram: async (request) => {
        requested.push(request.ownerUserId)
        await store.transact(async () => {
          await store.issues.getIssue(asIssueId('iss_telegram'))
        })
      },
      appendEvent: () => {},
      now: () => NOW,
      clients: () => [],
      sessionInfo: () => info(),
      sessionStates: () => [],
    }
    const service = new NotifyService(deps, { ntfy: () => {}, telegram: () => {} }, new EventBus())
    return { service, store, requested }
  }

  it('a telegram request that opens its own transaction leaves the span it was made in usable', async () => {
    const { service, store, requested } = await spanHarness()

    await store.transact(async () => {
      await service.notifyExternal({ title: 'ship it', body: 'the branch is green' }, OWNER)
      // The statement the lock bug died on: the same span, one line after the
      // fire-and-forget writer. A dropped promise makes this a refusal.
      await store.issues.getIssue(asIssueId('iss_after'))
    })

    expect(requested).toEqual([OWNER])
  })

  it('the request is not dropped when there is no span at all', async () => {
    const { service, requested } = await spanHarness()

    await service.notifyExternal({ title: 'ship it', body: 'the branch is green' }, OWNER)

    // Awaiting `notifyExternal` now means the route request has been handed
    // over — under the old `void` dep the caller returned first and the
    // assertion below needed a timer to pass.
    expect(requested).toEqual([OWNER])
  })
})
