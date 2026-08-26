import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOAD_HANDSHAKE_BUDGET_MS,
  type ReloadHandshakeDeps,
  startReloadHandshake,
} from './reload-handshake'

type Listener = () => void

function eventTarget() {
  const listeners = new Map<string, Listener[]>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const current = listeners.get(type) ?? []
      current.push(listener as Listener)
      listeners.set(type, current)
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  }
}

function waitingWorker() {
  const events = eventTarget()
  const postMessage = vi.fn()
  let state: ServiceWorkerState = 'installed'
  return {
    worker: {
      addEventListener: events.addEventListener,
      postMessage,
      get state() {
        return state
      },
    } as ReloadHandshakeDeps['waitingWorker'],
    postMessage,
    setState(next: ServiceWorkerState) {
      state = next
      events.dispatch('statechange')
    },
  }
}

function harness(options: { withContainer?: boolean; withWaiting?: boolean } = {}) {
  const containerEvents = eventTarget()
  const waiting = waitingWorker()
  const reload = vi.fn()
  let fireTimer: (() => void) | undefined
  let timerBudget: number | undefined
  startReloadHandshake({
    serviceWorker:
      options.withContainer === false
        ? undefined
        : ({
            addEventListener: containerEvents.addEventListener,
          } as ReloadHandshakeDeps['serviceWorker']),
    waitingWorker: options.withWaiting === false ? null : waiting.worker,
    reload,
    setTimer: (run, ms) => {
      fireTimer = run
      timerBudget = ms
    },
  })
  return { containerEvents, waiting, reload, fireTimer: () => fireTimer?.(), timerBudget }
}

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
})

afterEach(() => {
  vi.useRealTimers()
  resetLogging()
})

describe('startReloadHandshake', () => {
  it('waits for a slow replacement worker instead of reloading the old shell on a timer', () => {
    const run = harness()

    expect(run.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(run.timerBudget).toBe(RELOAD_HANDSHAKE_BUDGET_MS)
    run.fireTimer()
    expect(run.reload).not.toHaveBeenCalled()
    expect(logged.at(-1)).toMatchObject({ level: 'warn', via: 'waiting' })

    run.waiting.setState('activating')
    expect(run.reload).not.toHaveBeenCalled()
    run.waiting.setState('activated')
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(logged.at(-1)).toMatchObject({ level: 'info', via: 'handshake', signal: 'activated' })
  })

  it('reloads when the browser reports that the replacement controls the page', () => {
    const run = harness()
    run.containerEvents.dispatch('controllerchange')
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(logged.at(-1)).toMatchObject({
      level: 'info',
      via: 'handshake',
      signal: 'controllerchange',
    })
  })

  it('latches activation and controllerchange into one reload', () => {
    const run = harness()
    run.waiting.setState('activated')
    run.containerEvents.dispatch('controllerchange')
    expect(run.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads directly when this is not a waiting-worker update', () => {
    const run = harness({ withWaiting: false })
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(run.waiting.postMessage).not.toHaveBeenCalled()
    expect(logged.some((record) => (record as { via?: unknown }).via === 'direct')).toBe(true)
  })

  it('reloads directly in a context without service-worker support', () => {
    const run = harness({ withContainer: false })
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(run.waiting.postMessage).not.toHaveBeenCalled()
    expect(logged.at(-1)?.msg).toContain('no service worker')
  })

  it('does not reload through a replacement worker whose activation failed', () => {
    const run = harness()
    run.waiting.setState('redundant')
    run.fireTimer()
    expect(run.reload).not.toHaveBeenCalled()
    expect(logged.filter((record) => record.level === 'warn')).toHaveLength(1)
    expect(logged.at(-1)).toMatchObject({ via: 'waiting' })
  })
})
