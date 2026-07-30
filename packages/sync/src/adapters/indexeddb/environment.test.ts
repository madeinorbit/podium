// @vitest-environment happy-dom
/**
 * WHAT THE TEST ENVIRONMENTS ACTUALLY PROVIDE — the measurement, pinned.
 *
 * POD-374's acceptance criterion says the conformance suite must be green "under
 * happy-dom/Playwright". The measurement behind how that is satisfied belongs in
 * a test rather than in a sentence, because it is the kind of fact that changes
 * under you: happy-dom v20.10.2 provides `window`, `localStorage` and
 * `DOMException` and provides NO `indexedDB` at all, and neither bun nor node v22
 * provides one either.
 *
 * So the polyfill is the implementation under every non-browser environment, and
 * choosing happy-dom over node changes which DOM globals exist around the adapter
 * — not which IndexedDB it talks to. `conformance.test.ts` runs under happy-dom
 * anyway, because that is the environment shape the web client will have and it
 * costs nothing to assert the adapter tolerates it.
 *
 * THIS TEST FAILS THE DAY HAPPY-DOM SHIPS IndexedDB, and that is the point: at
 * that moment the choice of engine is worth re-opening, and a comment would not
 * have told anybody. See `docs/agents/pod-374-storage-evidence.md`.
 */

import { describe, expect, it } from 'vitest'
import { freshFactory } from './test-support'

describe('the environment this adapter is tested in', () => {
  it('happy-dom provides the DOM globals and NO IndexedDB', () => {
    const globals = globalThis as {
      window?: unknown
      indexedDB?: unknown
      localStorage?: unknown
      DOMException?: unknown
    }
    expect({
      window: typeof globals.window,
      localStorage: typeof globals.localStorage,
      DOMException: typeof globals.DOMException,
      indexedDB: typeof globals.indexedDB,
    }).toEqual({
      window: 'object',
      localStorage: 'object',
      DOMException: 'function',
      // happy-dom v20.10.2. If this becomes 'object', re-read the file header.
      indexedDB: 'undefined',
    })
  })

  it('the injected factory is what makes the suite runnable here at all', async () => {
    // The positive control for the assertion above: an engine IS available, it
    // just is not on the global. Every module in this adapter takes the factory as
    // a parameter, which is why the absence above is a fact about the environment
    // rather than a blocker.
    const factory = freshFactory()
    const db = await new Promise<{ close: () => void }>((resolve, reject) => {
      const request = factory.open('probe', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('rows', { keyPath: 'k' })
      }
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('open failed'))
      }
    })
    expect(db).toBeDefined()
    db.close()
  })
})
