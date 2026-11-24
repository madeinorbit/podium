import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOAD_COMMIT_GRACE_MS,
  registerReloadGuard,
  registerReloadPreparation,
} from './reload-preparation'

const navigateReload = vi.fn()
vi.mock('./navigate', () => ({ navigateReload }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const takeover = await import('./update-takeover')

let visibility: DocumentVisibilityState = 'visible'
let detachPreparation: (() => void) | undefined

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Lets the preparation's promise chain and the navigation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  navigateReload.mockReset()
  vi.mocked(toast.error).mockClear()
  takeover.resetTakeoverForTests()
})

afterEach(async () => {
  // A started navigation holds the shared reload latch for its grace period.
  await vi.advanceTimersByTimeAsync(RELOAD_COMMIT_GRACE_MS)
  vi.useRealTimers()
  detachPreparation?.()
  detachPreparation = undefined
  takeover.resetTakeoverForTests()
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('a new build taking control (POD-7539)', () => {
  it('keeps a visible signed-in screen until the page is hidden, saving the draft first', async () => {
    // The runtime's preparation persists the composer's last keystroke.
    const saved: string[] = []
    let composer = 'half a sentence'
    detachPreparation = registerReloadPreparation(async () => {
      saved.push(composer)
    })
    const deferred = vi.fn()
    takeover.onTakeoverDeferred(deferred)

    expect(takeover.followNewWorker('workbox-controlling')).toBe('deferred')
    // The worker's own question arrives as well; it joins the same deferral.
    expect(takeover.holdTakeoverWhileInUse('interface-build')).toBe(true)
    await settle()
    expect(navigateReload).not.toHaveBeenCalled()
    expect(deferred).toHaveBeenCalledOnce()
    expect(takeover.takeoverDeferred()).toBe(true)

    // Still typing, still visible: nothing moves.
    composer = 'half a sentence, and the rest'
    setVisibility('visible')
    await settle()
    expect(navigateReload).not.toHaveBeenCalled()

    setVisibility('hidden')
    await settle()
    expect(saved).toEqual(['half a sentence, and the rest'])
    expect(navigateReload).toHaveBeenCalledExactlyOnceWith(
      'workbox-controlling',
      'a new worker took control of this page',
      expect.objectContaining({ sources: ['workbox-controlling', 'interface-build'] }),
    )
  })

  it('reloads a hidden page at once', async () => {
    detachPreparation = registerReloadPreparation(async () => {})
    visibility = 'hidden'

    expect(takeover.followNewWorker('workbox-controlling')).toBe('reloading')
    await settle()
    expect(navigateReload).toHaveBeenCalledExactlyOnceWith(
      'workbox-controlling',
      'a new worker took control of this page',
    )
    expect(takeover.holdTakeoverWhileInUse('interface-build')).toBe(false)
  })

  it('reloads a page with no signed-in screen at once', async () => {
    expect(takeover.followNewWorker('workbox-controlling')).toBe('reloading')
    await settle()
    expect(navigateReload).toHaveBeenCalledOnce()
    expect(takeover.takeoverDeferred()).toBe(false)
  })

  it('stays armed when an unsaved editor refuses the hidden reload', async () => {
    detachPreparation = registerReloadPreparation(async () => {})
    let unsaved: string | undefined = 'Save or discard the unsaved file before reloading.'
    const detachGuard = registerReloadGuard(() => unsaved)
    try {
      expect(takeover.followNewWorker('workbox-controlling')).toBe('deferred')
      setVisibility('hidden')
      await settle()
      expect(navigateReload).not.toHaveBeenCalled()
      // Nobody is looking; the refusal is not announced to an empty room.
      expect(toast.error).not.toHaveBeenCalled()

      unsaved = undefined
      setVisibility('visible')
      setVisibility('hidden')
      await settle()
      expect(navigateReload).toHaveBeenCalledOnce()
    } finally {
      detachGuard()
    }
  })

  it('says why a visible reload paused, as the library path did', async () => {
    const detachGuard = registerReloadGuard(
      () => 'Save or discard the unsaved file before reloading.',
    )
    try {
      expect(takeover.followNewWorker('workbox-controlling')).toBe('reloading')
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Save or discard the unsaved file before reloading.',
        ),
      )
      expect(navigateReload).not.toHaveBeenCalled()
    } finally {
      detachGuard()
    }
  })
})
