import { Outbox, type OutboxEntry } from '@podium/client-core/outbox'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useClientRuntime } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { messageNotices, pendingInteractionCards } from '@podium/client-core/values'
import { asMutationId, asSessionId, asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { cloneElement } from 'react'
import { Alert } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { noticeFixture } from '../../../../tests/worklist/diagnostics/notice-fixture'
import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
import { createHeaderFixture } from '../../../web/test/header-fixture'
import type { MobilePool } from '../client/mobile-pool'

const state = vi.hoisted(() => ({ host: undefined as MobilePool | undefined, push: vi.fn() }))
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
    useMobilePoolNow: () => state.host!.host.usePoolNow(),
    useMobilePoolProjection: <T,>(
      read: Parameters<MobilePool['host']['usePoolProjection']>[0],
      empty: T,
    ) => state.host!.host.usePoolProjection(read, empty) as T,
  }
})
vi.mock('@podium/client-core/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('@podium/client-core/values')>()
  return {
    ...real,
    messageNotices: vi.fn(real.messageNotices),
    pendingInteractionCards: vi.fn(real.pendingInteractionCards),
  }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
// Clipboard is an OS action of the recovery panel, outside these pool reads.
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }))
vi.mock('../client/ServerProfileGate', () => ({
  useServerProfile: () => ({ profile: { name: 'Synthetic server' } }),
}))

const { createMobilePool } = await import('../client/mobile-pool')
const { MessageNoticeBanner } = await import('./MessageNoticeBanner')
const { PendingInteractionBand } = await import('./PendingInteractionBand')
const { WorkspaceContinuityNotice } = await import('./WorkspaceContinuityNotice')
const { OutboxRecoveryPanel } = await import('./OutboxRecoveryPanel')

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

async function mount() {
  state.host = createMobilePool(false)
  const fixture = createHeaderFixture(3, 3),
    data = noticeFixture(),
    errors: string[] = []
  for (const [entity, rows] of [
    ['message', data.messages],
    ['pendingInteraction', data.interactions],
  ] as const) {
    for (const row of rows)
      fixture.records.set(`${entity}:${row.id}`, {
        entity,
        entityId: row.id,
        value: row,
        provenance: { seq: 1 },
      })
  }
  const sessionTemplate = fixture.records.get('session:synthetic-session-0')!.value
  for (const row of data.sessions) {
    const previous = fixture.records.get(`session:${row.sessionId}`)?.value ?? sessionTemplate
    fixture.records.set(`session:${row.sessionId}`, {
      entity: 'session',
      entityId: row.sessionId,
      provenance: { seq: 1 },
      value: {
        ...(previous as object),
        ...row,
        ...(row.stoppedAt ? { status: 'exited', archived: true } : {}),
      },
    })
  }
  function evict(entity: string, id: string) {
    fixture.records.delete(`${entity}:${id}`)
    fixture.replica.onKernelEvent({ type: 'evicted', entity, entityId: id } as never)
  }
  const dismiss = vi.fn(async ({ id }: { id: string }) => {
    evict('message', id)
    return { ok: true }
  })
  const answer = vi.fn(async ({ id }: { id: string }) => {
    evict('pendingInteraction', id)
    return { ok: true }
  })
  // An answer is a `session.answer` record (POD-6415): the server creates it,
  // runs it (here: `answer`, the delivery) and the record reaches the pool
  // with the delivery's reply as its result.
  const submit = vi.fn(
    async (envelope: {
      command: string
      input: { id: string; kind: string; target: unknown; input: Record<string, unknown> }
    }) => {
      if (envelope.command !== 'effects.create') throw new Error(`unexpected ${envelope.command}`)
      const { id, kind, target, input } = envelope.input
      const reply = await answer({ id: String(input.interactionId), answer: input.answer } as never)
      const at = new Date().toISOString()
      const record = {
        entity: 'effect',
        entityId: id,
        provenance: { seq: 1 },
        value: {
          id,
          kind,
          target,
          input: { via: input.via, interactionId: input.interactionId },
          result: reply,
          cancelRequested: false,
          effect: { status: reply.ok ? 'succeeded' : 'failed', attempts: 1 },
          createdBy: null,
          createdAt: at,
          updatedAt: at,
          revision: 1,
        },
      }
      fixture.records.set(`effect:${id}`, record)
      fixture.replica.onKernelEvent({ type: 'upserted', record, readmitted: false } as never)
      return {
        outcome: 'applied',
        result: { id },
        receipt: { feedId: 'f', epoch: 'e', seq: 0 },
        replayed: false,
      }
    },
  )
  Object.assign(fixture.api, {
    messages: { dismissNotice: { mutate: dismiss } },
    sync: { submit: { mutate: submit } },
  })
  let queued: OutboxEntry[] = [],
    parked: OutboxEntry[] = data.deadLetters.map((row) => ({
      ...row.entry,
      state: 'dead-letter',
      deadLetter: {
        reason: row.reason,
        parkedFrom: row.parkedFrom,
        deadLetteredAt: row.deadLetteredAt,
        attempts: row.attempts,
      },
    }))
  let runtime!: ClientRuntime,
    sessionId = asSessionId('synthetic-session-0'),
    connected = false
  const seen: ReturnType<MobilePool['host']['usePool']>[] = []
  const configured = new WeakSet<ClientRuntime>()
  function Surface() {
    runtime = useClientRuntime() as ClientRuntime
    if (!configured.has(runtime)) {
      const subscribeHealth = runtime.services.connection.hub.onConnectionHealth.bind(
        runtime.services.connection.hub,
      )
      fixture.bindHub(runtime.services.connection.hub, undefined, runtime.live)
      runtime.services.connection.hub.onConnectionHealth = subscribeHealth
      // The socket is a platform edge. Keep the production useConnected hook
      // subscribed to the same runtime hub and drive its exact connected bit.
      Object.defineProperty(runtime.services.connection.hub, 'connected', {
        configurable: true,
        get: () => connected,
      })
      runtime.live.setConnection({
        state: connected ? 'online' : 'offline',
        since: Date.now(),
      })
      configured.add(runtime)
    }

    seen.push(state.host!.host.usePool())
    return (
      <>
        <MessageNoticeBanner />
        <PendingInteractionBand sessionId={sessionId} />
        <WorkspaceContinuityNotice />
        <OutboxRecoveryPanel />
      </>
    )
  }
  const tree = (
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => errors.push(error)}
      createOutboxFn={(callbacks) =>
        new Outbox({
          executors: { issueUpdate: async () => ({ ok: true }) },
          storage: {
            load: () => queued,
            save: (value) => {
              queued = value
            },
          },
          deadLetterStorage: {
            load: () => parked,
            save: (value) => {
              parked = value
            },
          },
          isOnline: () => false,
          onApplied: callbacks.onApplied,
          onSettled: callbacks.onSettled,
          onDeadLetter: callbacks.onDeadLetter,
        }) as never
      }
      attachRuntime={(owner) =>
        state.host!.host.attach(owner, (error) => errors.push(error.message))
      }
    >
      <Surface />
    </StoreProvider>
  )
  storeStats.enable()
  storeStats.reset()
  const view = render(tree)
  await waitFor(
    () => {
      expect(view.getByTestId('message-notice-banner').textContent).toContain(
        'Synthetic unknown words',
      )
      expect(view.getByTestId('workspace-continuity-notice').textContent).toContain(
        '5 changes need review',
      )
      expect(view.getAllByTestId('outbox-recovery-card')).toHaveLength(5)
      expect(view.getByText('Synthetic plan')).toBeTruthy()
    },
    { timeout: 5000 },
  )
  return {
    fixture,
    data,
    view,
    runtime,
    errors,
    dismiss,
    answer,
    evict,
    seen,
    switchSession(next: string) {
      sessionId = asSessionId(next)
      view.rerender(cloneElement(tree, { children: <Surface /> }))
    },
    connect(next: boolean) {
      connected = next
      // This fixture disables the network feed, so publish its condition at
      // the same LiveStore boundary the feed owns in the running client.
      runtime.live.setConnection({ state: next ? 'online' : 'offline', since: Date.now() })
      const hub = runtime.services.connection.hub as unknown as {
        emit(kind: string, value: unknown): void
      }
      hub.emit('connectionHealth', runtime.services.connection.hub.connectionHealth())
    },
  }
}

function expectPoolReadersOnly(runtime: ClientRuntime) {
  expect(readRuntimeStoreStats(runtime)?.selectorRuns ?? 0).toBe(0)
  expect(messageNotices).not.toHaveBeenCalled()
  expect(pendingInteractionCards).not.toHaveBeenCalled()
}

it('preserves the accepted banners through pool attachment', async () => {
  const reactErrors = vi.spyOn(console, 'error')
  const enabled = await mount()
  expect(enabled.seen[0]).toBeNull()
  expect(enabled.seen.some((pool) => pool !== null)).toBe(true)
  expect(enabled.view.getByTestId('message-notice-banner').textContent).toContain(
    'Synthetic unknown words',
  )
  expect(enabled.view.getAllByTestId('outbox-recovery-card')).toHaveLength(5)
  expect(enabled.view.getByText('Synthetic plan')).toBeTruthy()
  expect(enabled.errors).toEqual([])
  expectPoolReadersOnly(enabled.runtime)
  expect(reactErrors.mock.calls).toEqual([])
})

it('reacts to message, session-label and ask updates without legacy work', async () => {
  const enabled = await mount()
  await act(async () => {
    enabled.fixture.patch('message', 'notice-message-2', { body: 'Updated synthetic message' })
    enabled.fixture.patch('pendingInteraction', 'notice-ask-7', {
      payload: { v: 1, plan: 'Updated synthetic plan' },
    })
    enabled.fixture.activity(1)
  })
  expect(enabled.view.getByTestId('message-notice-banner').textContent).toContain(
    'Updated synthetic message',
  )
  expect(enabled.view.getByText('Updated synthetic plan')).toBeTruthy()
  await act(async () =>
    enabled.fixture.patch('pendingInteraction', 'notice-ask-7', {
      sessionId: 'synthetic-session-1',
    }),
  )
  expect(enabled.view.queryByText('Updated synthetic plan')).toBeNull()
  await act(async () => enabled.switchSession('synthetic-session-1'))
  expect(enabled.view.getByText('Updated synthetic plan')).toBeTruthy()
  await act(async () => {
    enabled.evict('message', 'notice-message-2')
    enabled.fixture.patch('session', 'cold-notice-session', { title: 'Updated saved agent' })
  })
  expect(enabled.view.getByTestId('message-notice-banner').textContent).toContain(
    'To Updated saved agent:',
  )
  expectPoolReadersOnly(enabled.runtime)
  expect(enabled.errors).toEqual([])
})

it('keeps chat, settings, dismiss and typed-answer actions on the existing owner', async () => {
  const enabled = await mount()
  fireEvent.click(enabled.view.getByRole('button', { name: 'Open the chat with a closed session' }))
  expect(state.push).toHaveBeenCalledWith('/session/missing-session')
  fireEvent.click(enabled.view.getByTestId('workspace-continuity-notice'))
  expect(state.push).toHaveBeenCalledWith('/settings')

  enabled.dismiss.mockRejectedValueOnce(new Error('Synthetic dismiss refusal'))
  fireEvent.click(enabled.view.getByRole('button', { name: 'Dismiss this notice' }))
  await waitFor(() => expect(enabled.view.getByText('Synthetic dismiss refusal')).toBeTruthy())
  fireEvent.click(enabled.view.getByRole('button', { name: 'Dismiss this notice' }))
  await waitFor(() =>
    expect(enabled.view.getByTestId('message-notice-banner').textContent).toContain(
      'To Saved agent:',
    ),
  )
  expect(enabled.dismiss).toHaveBeenLastCalledWith({ id: 'notice-message-2' })

  enabled.answer.mockResolvedValueOnce({ ok: false, reason: 'Synthetic answer refusal' } as never)
  fireEvent.click(enabled.view.getByTestId('pending-interaction-action-approve'))
  await waitFor(() =>
    expect(enabled.view.getAllByText('Synthetic answer refusal').length).toBeGreaterThan(0),
  )
  await act(async () => {
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(
      enabled.view.getByTestId('pending-interaction-action-approve').getAttribute('aria-disabled'),
    ).not.toBe('true'),
  )
  fireEvent.click(enabled.view.getByTestId('pending-interaction-action-approve'))
  await waitFor(() => expect(enabled.answer).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(enabled.view.queryByText('Synthetic plan')).toBeNull())
  expect(enabled.answer).toHaveBeenLastCalledWith({
    id: 'notice-ask-7',
    answer: { kind: 'plan-approval', decision: 'approve' },
  })
  expectPoolReadersOnly(enabled.runtime)
})

it('updates recovery and continuity through the original outbox retry, edit and discard actions', async () => {
  const enabled = await mount(),
    recovery = referenceState(enabled.runtime).recoverOutbox
  const retry = vi.spyOn(recovery, 'retry'),
    edit = vi.spyOn(recovery, 'edit'),
    discard = vi.spyOn(recovery, 'discard')
  const cards = () => enabled.view.getAllByTestId('outbox-recovery-card')
  await act(async () => fireEvent.click(within(cards()[2]!).getByTestId('outbox-retry')))
  expect(retry).toHaveBeenCalledWith(asMutationId('notice-mutation-2'), { expectedRevision: 0 })
  expect(cards()).toHaveLength(4)
  expect(enabled.view.getByTestId('workspace-continuity-notice').textContent).toContain(
    '1 change is queued',
  )

  fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Edit' }))
  fireEvent.change(enabled.view.getByLabelText('Your text'), {
    target: { value: 'Updated authored words' },
  })
  await act(async () => fireEvent.click(enabled.view.getByRole('button', { name: 'Send updated' })))
  expect(edit).toHaveBeenCalledWith(asMutationId('notice-mutation-0'), {
    id: 'invisible-target',
    patch: { title: 'Updated authored words' },
  })
  expect(cards()).toHaveLength(3)
  expect(enabled.view.getByTestId('workspace-continuity-notice').textContent).toContain(
    '2 changes are queued',
  )

  const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {})
  fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Discard' }))
  expect(discard).not.toHaveBeenCalled()
  await act(async () =>
    alert.mock.calls[0]![2]!.find((button) => button.style === 'destructive')!.onPress!(),
  )
  expect(discard).toHaveBeenCalledWith(asMutationId('notice-mutation-1'))
  expect(cards()).toHaveLength(2)
  expect(enabled.runtime.services.outbox.queue.deadLetters()).toHaveLength(2)
  expect(enabled.runtime.services.outbox.queue.pending()).toHaveLength(2)
  expectPoolReadersOnly(enabled.runtime)
})

it('removes empty notices and retains the live offline status without snapshot selectors', async () => {
  const enabled = await mount()
  await act(async () => {
    for (const row of enabled.data.messages) enabled.evict('message', row.id)
    for (const row of enabled.data.interactions) enabled.evict('pendingInteraction', row.id)
    for (const row of enabled.data.deadLetters)
      referenceState(enabled.runtime).recoverOutbox.discard(row.entry.mutationId)
    enabled.connect(true)
  })
  expect(enabled.view.container.textContent).toBe('')
  await act(async () => enabled.connect(false))
  expect(enabled.view.getByTestId('workspace-continuity-notice').textContent).toBe(
    'Offline. Showing saved data for Synthetic server.Settings',
  )
  expectPoolReadersOnly(enabled.runtime)
})
