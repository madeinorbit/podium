import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeServiceWorker, workerFacts } from './sw-observer'

/**
 * The browser's worker lifecycle was the largest unobserved input to the update
 * panel (POD-3224): `needRefresh` comes from it, `assets === 'replaced'` is
 * explained by it, and the reload handshake navigates on it. These pin the two
 * properties that make the observer safe to leave running for a page's whole
 * life — it never acts, and it never double-registers.
 */

type Listener = () => void

function target() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    },
    fire: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

function worker(state: ServiceWorkerState, scriptURL = 'https://podium.test/sw.js') {
  const events = target()
  const value = { addEventListener: events.addEventListener, scriptURL, state }
  return {
    value,
    events,
    setState: (next: ServiceWorkerState) => {
      value.state = next
      events.fire('statechange')
    },
  }
}

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
})
afterEach(() => resetLogging())

const messages = () => logged.map((record) => record.msg)

describe('observeServiceWorker', () => {
  it('records updatefound, per-worker state changes and controllerchange', () => {
    const events = target()
    const installing = worker('installing')
    const registration = {
      addEventListener: events.addEventListener,
      installing: installing.value,
      waiting: null,
      active: null,
    }
    const container = { addEventListener: target().addEventListener, controller: null }

    observeServiceWorker(registration as never, container as never)
    events.fire('updatefound')
    installing.setState('installed')

    expect(messages()).toContain('service worker updatefound')
    expect(messages()).toContain('service worker seen')
    const change = logged.find((record) => record.msg === 'service worker state changed')
    expect(change).toMatchObject({
      ns: 'web:sw',
      level: 'info',
      slot: 'installing',
      state: 'installed',
      scriptURL: 'https://podium.test/sw.js',
    })
  })

  /** A replacement that vanished is a Reload that will find nothing to take over. */
  it('raises a worker that went redundant to warn', () => {
    const installing = worker('installing')
    const registration = {
      addEventListener: target().addEventListener,
      installing: installing.value,
      waiting: null,
      active: null,
    }
    observeServiceWorker(registration as never, undefined)
    installing.setState('redundant')

    expect(logged.at(-1)).toMatchObject({
      level: 'warn',
      msg: 'service worker became redundant',
    })
  })

  it('is idempotent per registration, so a re-reported one does not double every line', () => {
    const events = target()
    const registration = {
      addEventListener: events.addEventListener,
      installing: null,
      waiting: null,
      active: null,
    }
    observeServiceWorker(registration as never, undefined)
    observeServiceWorker(registration as never, undefined)

    expect(events.count('updatefound')).toBe(1)
  })

  it('OBSERVES ONLY: it never messages, updates or reloads', () => {
    const postMessage = vi.fn()
    const update = vi.fn()
    const active = worker('activated')
    const registration = {
      addEventListener: target().addEventListener,
      installing: null,
      waiting: null,
      active: { ...active.value, postMessage },
      update,
    }
    observeServiceWorker(registration as never, undefined)

    expect(postMessage).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('workerFacts', () => {
  it('names every slot, present or not, so an absent one is stated rather than missing', () => {
    const waiting = worker('installed', 'https://podium.test/sw.js?v=2')
    const facts = workerFacts(
      { installing: null, waiting: waiting.value, active: null } as never,
      undefined,
    )
    expect(facts).toMatchObject({
      controller: 'none',
      active: 'none',
      installing: 'none',
      waiting: 'installed',
      waitingURL: 'https://podium.test/sw.js?v=2',
    })
  })
})
