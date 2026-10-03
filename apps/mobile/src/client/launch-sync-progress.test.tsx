import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchBoundary } from './launch'
import { MobileSyncBoundary } from './MobileSyncBoundary'
import { MobileSyncProgressStore } from './mobile-sync-progress'

vi.mock('expo-router', () => ({
  SplashScreen: {
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: vi.fn(async () => {}),
  },
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const splash = (host: HTMLElement, text: string) =>
  vi.waitFor(() => expect(host.textContent).toContain(text))
/** The measured bar's fill width, or null when the splash shows no bar. */
const bar = (host: HTMLElement, width: string | null) =>
  vi.waitFor(() => {
    const track = host.querySelector<HTMLElement>('[role="progressbar"]')
    expect(track?.querySelector<HTMLElement>('div')?.style.width ?? null).toBe(width)
  })

/**
 * A cold first sync on the phone, as the production web export runs it: a real
 * root, NOT an act() environment. act() drains every lane before returning, so
 * it cannot show work a lower lane leaves behind while a buffered NDJSON body
 * publishes progress once per frame with only microtasks between frames.
 * [POD-5390]
 */
describe('cold sync progress on the launch splash', () => {
  let host: HTMLElement
  let root: Root
  let actEnvironment: boolean | undefined
  beforeEach(() => {
    actEnvironment = reactGlobals.IS_REACT_ACT_ENVIRONMENT
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = false
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    root.unmount()
    host.remove()
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  function mount(store: MobileSyncProgressStore): void {
    root.render(
      <LaunchBoundary fontsReady={false}>
        <MobileSyncBoundary store={store}>
          <Text>unfinished workspace</Text>
        </MobileSyncBoundary>
      </LaunchBoundary>,
    )
  }

  // React allows 50 nested updates. The per-tick pushed status passed 45
  // frames and threw on the 51st, so 45 is the control both designs pass;
  // 89 frames is an 11,392-row first sync at 128 rows per frame. The server
  // may legally send any frame size up to 500 rows.
  it.each([
    45, 55, 89,
  ])('publishes %i 128-row frames back to back without a nested-update loop', async (frames) => {
    const rows = frames * 128
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    mount(store)
    await macrotask()
    store.beginAttempt()
    store.noteMeta(rows)
    await macrotask()

    for (let frame = 0; frame < frames; frame++) {
      store.noteReceived(128)
      for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    }
    await splash(host, 'LOADING WORKSPACE...')
    await splash(host, `${rows.toLocaleString('en-US')} of ${rows.toLocaleString('en-US')} items`)
    await bar(host, '100%')
  })

  it('shows the cold label, count and measured bar exactly as the sync reports them', async () => {
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    mount(store)
    await splash(host, 'CONNECTING...')
    await bar(host, null)

    store.beginAttempt()
    store.noteReceived(1_200)
    await splash(host, 'LOADING WORKSPACE...')
    await splash(host, '1,200 items received')
    await bar(host, null)

    store.noteMeta(4_800)
    await splash(host, '1,200 of 4,800 items')
    await bar(host, '25%')

    store.noteSaving()
    await splash(host, 'SAVING WORKSPACE...')

    store.noteEvent({
      type: 'bootstrap-installed',
      cause: 'cold-start',
      snapshotSeq: 1,
      entityCount: 4_800,
      bufferedFramesApplied: 0,
    })
    // Installed: the boundary no longer describes the splash, which falls back
    // to its own default label while the route lays out underneath.
    await splash(host, 'LOADING...')
    await vi.waitFor(() => expect(host.textContent).not.toContain('items'))
    await splash(host, 'unfinished workspace')
  })
})
