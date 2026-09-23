/**
 * A HEADLESS SESSION'S FOLLOW-UP, SENT THE WAY THE WEB SENDS IT (POD-4647).
 *
 * The chat composer's send is `sessions.sendText` → `mail.send` →
 * `MessageDeliveryService.send`, as the operator, urgency `next-turn`. That
 * service HOLDS a next-turn message while the target reads `working` and hands
 * it to the session inbox only when the phase reaches idle. So a session whose
 * finished turn never reads idle keeps the follow-up as a queued ledger row
 * with no `injectedAt` — the web's "pending · sends after this turn" — and the
 * daemon never sees it. Driving `sessions.queueText` directly skips that hold,
 * which is why a test on that route saw the follow-up forwarded while the
 * session was stuck.
 *
 * The events are the opencode-server order recorded from a live run: the turn
 * verdict first, then the state it folds.
 */
import { firstAdminMemberId } from '@podium/model'
import type { ControlMessage, RuntimeEvent } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'

const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 10, 7, second)).toISOString()

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function headlessOpencode() {
  const store = await openTestStore(':memory:')
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  const commands: ControlMessage[] = []
  await store.machines.upsertMachine({
    id: store.hostMachineId, name: 'Host', hostname: 'test', tokenHash: 'test',
    ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(store.hostMachineId, (message) => commands.push(message))
  const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'opencode', cwd: '/project' })
  await registry.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind', sessionId, cmd: 'opencode serve (opencode-server)', cwd: '/project', agentKind: 'opencode',
    geometry: { cols: 80, rows: 24 }, driverId: 'opencode-server',
  })
  let seq = 0
  const emit = async (body: Record<string, unknown>, second: number) => {
    seq += 1
    const event = {
      ...body,
      at: at(second),
      provenance: 'live',
      cursor: { segmentId: 'opencode-server-segment', components: { seq } },
      observerGeneration: 1,
      turnEpoch: 1,
    } as unknown as RuntimeEvent
    await registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent', sessionId, deliveryId: `opencode-${seq}`, event,
    })
  }
  const phase = async () => (await registry.modules.sessions.sessionById(sessionId))?.agentState?.phase
  const handedToDaemon = (text: string) =>
    commands.filter((message) =>
      (message.type === 'runtimeSendRequest' || message.type === 'runtimeDurableSendRequest') &&
      message.sessionId === sessionId && JSON.stringify(message).includes(JSON.stringify(text)))
  return { store, registry, sessionId, emit, phase, handedToDaemon }
}

describe('a headless follow-up sent through the web route (POD-4647)', () => {
  it('reaches the daemon once the first turn has ended', async () => {
    const s = await headlessOpencode()
    await s.emit({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } }, 16)
    await s.emit({ t: 'item', item: { kind: 'complete', item: { id: 'u1', cursor: 'u1', role: 'user', text: 'Reply with exactly the word: first', ts: at(18) } } }, 18)
    await s.emit({ t: 'state', change: { kind: 'activity' } }, 19)
    await s.emit({ t: 'item', item: { kind: 'complete', item: { id: 'a1', cursor: 'a1', role: 'assistant', text: 'first', ts: at(24) } } }, 24)
    await s.emit({ t: 'state', change: { kind: 'activity' } }, 24)
    expect(await s.phase()).toBe('working')
    await s.emit({ t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } }, 24)
    await s.emit({ t: 'state', change: { kind: 'turn_completed', verdict: { kind: 'done' } } }, 24)
    expect(await s.phase()).toBe('idle')

    const text = 'Reply with exactly the word: second'
    const sent = await s.registry.modules.messages.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: s.sessionId }, body: text, urgency: 'next-turn', lifecycle: 'wait' },
    )
    // Not held behind a turn that has already ended.
    expect(sent.disposition).not.toBe('queued')
    await vi.waitFor(() => expect(s.handedToDaemon(text)).toHaveLength(1))
  })

  it('control arm: while a turn really is running, the same send waits for its end', async () => {
    const s = await headlessOpencode()
    await s.emit({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } }, 16)
    await s.emit({ t: 'state', change: { kind: 'activity' } }, 19)
    expect(await s.phase()).toBe('working')

    const text = 'wait for the boundary'
    const sent = await s.registry.modules.messages.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: s.sessionId }, body: text, urgency: 'next-turn', lifecycle: 'wait' },
    )
    expect(sent.disposition).toBe('queued')
    const row = await s.store.messages.getMessage(sent.message.id)
    expect(row).toMatchObject({ status: 'queued', injectedAt: null })
    expect(s.handedToDaemon(text)).toHaveLength(0)

    // The turn's own end releases it.
    await s.emit({ t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } }, 24)
    await s.emit({ t: 'state', change: { kind: 'turn_completed', verdict: { kind: 'done' } } }, 24)
    await vi.waitFor(() => expect(s.handedToDaemon(text)).toHaveLength(1))
  })
})
