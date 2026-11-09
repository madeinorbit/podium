// @vitest-environment happy-dom
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { asUserId } from '@podium/model'
import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { StoreServerConfig } from '../engine/types'
import type { OutboxDeadLetterEntry, OutboxEntry } from '../outbox'
import { asClientPrincipal } from '../principal'
import { StoreProvider } from '../react/provider'
import { useLive, useOutboxRecovery, useRuntime } from '../react/runtime-root'
import { memoryStorage } from '../replica/contract'
import type { SocketHub } from '../socket-transport'
import type { VisibilitySource } from './connection/visibility'
import type { EngineOutbox } from './outbox/wiring'
import { createRuntimeRoot, type RuntimeRoot, type RuntimeRootInit } from './root'

/**
 * THE RUNTIME ROOT (POD-6681): one per signed-in user, created at sign-in,
 * disposed at sign-out, and safe across a React StrictMode remount.
 */

class FakeHub {
  connects = 0
  connectNows = 0
  disposes = 0
  readonly topics = new Set<string>()
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  }
  listeners(kind: string): number {
    return this.handlers.get(kind)?.size ?? 0
  }
  emit(kind: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(kind) ?? [])]) cb(...args)
  }
  connectionHealth() {
    return { status: 'ok' as const, rttMs: null, since: 0 }
  }
  subscribeTopic(kind: string, id: string, listener: { onState?: (s: unknown) => void }) {
    const key = `${kind}:${id}`
    this.topics.add(key)
    listener.onState?.({ status: 'pending' })
    return () => this.topics.delete(key)
  }
  serverIdentity(): null {
    return null
  }
  clockSkewMs(): null {
    return null
  }
  readonly connected = false
  seedMetadata(): void {}
  connect(): void {
    this.connects += 1
  }
  connectNow(): void {
    this.connectNows += 1
  }
  dispose(): void {
    this.disposes += 1
  }
  setViewState(): void {}
  setVisible(): void {}
  sendSessionDraft(): void {}
}

class FakeQueue implements Partial<EngineOutbox> {
  attaches = 0
  disposes = 0
  drains = 0
  parked: OutboxDeadLetterEntry[] = []
  private listeners = new Set<(size: number) => void>()
  attach(): void {
    this.attaches += 1
  }
  dispose(): void {
    this.disposes += 1
  }
  subscribe(listener: (size: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  subscribers(): number {
    return this.listeners.size
  }
  size(): number {
    return 0
  }
  pending(): OutboxEntry[] {
    return []
  }
  awaiting(): OutboxEntry[] {
    return []
  }
  deadLetters(): OutboxDeadLetterEntry[] {
    return this.parked
  }
  retry(): void {}
  edit(): void {}
  discard(): void {}
  notifyConnected(): void {
    this.drains += 1
  }
  async flushLocalWrites(): Promise<void> {}
}

function fakeVisibility(): VisibilitySource & { set(v: boolean): void; subscribers(): number } {
  let visible = true
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    set: (v) => {
      visible = v
      for (const cb of [...listeners]) cb()
    },
    subscribers: () => listeners.size,
  }
}

const config: StoreServerConfig = { httpOrigin: 'http://x', wsClientUrl: 'ws://x' }
const principal = asClientPrincipal(asUserId('operator'))

function parts() {
  const hub = new FakeHub()
  const queue = new FakeQueue()
  const visibility = fakeVisibility()
  const replicas: string[] = []
  const init: RuntimeRootInit = {
    principal,
    config,
    api: {} as PodiumClientApi,
    onFatalError: () => {},
    formatError: (_e, f) => f,
    notices: { error: () => {}, info: () => {} },
    createReplicaFn: (who) => {
      replicas.push(who.userId)
      return createReplicaFixture({ storage: memoryStorage() })
    },
    createHub: () => hub as unknown as SocketHub,
    createOutboxFn: () => queue as unknown as EngineOutbox,
    visibility,
  }
  return { hub, queue, visibility, replicas, init }
}

const roots: RuntimeRoot[] = []
afterEach(() => {
  cleanup()
  for (const root of roots.splice(0)) root.disposeNow()
  vi.useRealTimers()
})

describe('the runtime root', () => {
  it('opens one replica for its principal and holds the LiveStore and services', () => {
    const { init, replicas, hub, queue } = parts()
    const root = createRuntimeRoot(init)
    roots.push(root)
    expect(replicas).toEqual(['operator'])
    expect(root.principal).toBe(principal)
    expect(root.httpOrigin).toBe('http://x')
    expect(root.services.connection.hub).toBe(hub)
    expect(root.services.outbox.queue).toBe(queue)
    expect(root.live.connection.state).toBe('connecting')
  })

  it('refuses to build without a replica factory', () => {
    const { init } = parts()
    expect(() => createRuntimeRoot({ ...init, createReplicaFn: undefined as never })).toThrow(
      /requires createReplicaFn/,
    )
  })

  it('starts nothing twice across start, stop, start', () => {
    vi.useFakeTimers()
    const { init, hub, queue, visibility } = parts()
    const root = createRuntimeRoot(init)
    roots.push(root)
    root.start()
    root.start()
    root.stop()
    root.start()
    vi.runAllTimers()
    expect(hub.connects).toBe(1)
    expect(queue.attaches).toBe(2)
    expect(queue.subscribers()).toBe(1)
    expect(visibility.subscribers()).toBe(1)
    expect([...hub.topics]).toEqual(['account.quota:operator'])
    expect(hub.listeners('connectionHealth')).toBe(2)
  })

  it('fires nothing after sign-out, and never starts again', async () => {
    vi.useFakeTimers()
    const { init, hub, queue, visibility } = parts()
    const root = createRuntimeRoot(init)
    roots.push(root)
    root.start()
    root.ownConversations({} as never)
    await root.dispose()
    expect(root.isDisposed).toBe(true)
    expect(root.live.isDisposed).toBe(true)
    expect(root.conversations).toBeUndefined()
    expect(() => root.ownConversations({} as never)).toThrow(/owner has changed/)
    root.start()
    vi.runAllTimers()
    visibility.set(false)
    visibility.set(true)
    hub.emit('connectionHealth', { status: 'down', rttMs: null, since: 1 })
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 2 })
    expect(hub.connects).toBe(0)
    expect(hub.connectNows).toBe(0)
    expect(queue.drains).toBe(0)
    expect(queue.attaches).toBe(1)
    expect(hub.disposes).toBe(1)
    expect(queue.disposes).toBe(1)
    expect(hub.topics.size).toBe(0)
    expect(visibility.subscribers()).toBe(0)
  })
})

describe('the runtime root in React', () => {
  it('a StrictMode remount starts nothing twice, and components see no services', () => {
    vi.useFakeTimers()
    const { queue, visibility, replicas } = parts()
    // The provider builds a real hub; its dials are the sockets it asks for.
    const dials: string[] = []
    const makeSocket = (url: string) => {
      dials.push(url)
      return {
        send: () => {},
        close: () => {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      }
    }
    const parked = [{ entry: { mutationId: 'p' } } as unknown as OutboxDeadLetterEntry]
    queue.parked = parked
    const seen: { keys: string[]; parked: unknown; recovery: unknown }[] = []
    function Reader() {
      const view = useRuntime()
      seen.push({
        keys: Object.keys(view).sort(),
        parked: useLive().outbox.deadLetters,
        recovery: Object.keys(useOutboxRecovery()).sort(),
      })
      return null
    }
    const { unmount } = render(
      <StrictMode>
        <StoreProvider
          principal={principal}
          config={config}
          api={{} as PodiumClientApi}
          onFatalError={() => {}}
          createReplicaFn={() => {
            replicas.push('provider')
            return createReplicaFixture({ storage: memoryStorage() })
          }}
          createOutboxFn={() => queue as unknown as EngineOutbox}
          visibility={visibility}
          makeSocket={makeSocket as never}
        >
          <Reader />
        </StoreProvider>
      </StrictMode>,
    )
    vi.advanceTimersByTime(0)
    expect(dials).toHaveLength(1)
    expect(replicas).toEqual(['provider'])
    // One subscription each, though React mounted, cleaned up and re-mounted:
    // the queue's is the outbox service's; the visibility source has the
    // connection service's and the UI persistence's.
    expect(queue.subscribers()).toBe(1)
    expect(visibility.subscribers()).toBe(2)
    expect(queue.attaches).toBe(2)
    expect(seen.at(-1)).toEqual({
      keys: ['live', 'principal'],
      parked,
      recovery: ['discard', 'edit', 'retry'],
    })
    unmount()
    expect(queue.subscribers()).toBe(0)
    expect(visibility.subscribers()).toBe(0)
  })
})
