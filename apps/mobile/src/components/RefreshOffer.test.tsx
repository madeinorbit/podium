import { PRODUCT_VERSION_META } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
vi.mock('lucide-react-native', () => ({ RefreshCw: () => null }))

const { RefreshOffer } = await import('./RefreshOffer')

/** The reload IS the refresh here — /mobile has no service worker to hand to. */
const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

/** What the running document says it is — the meta the build stamp injects. */
function stampPage(version: string): void {
  document.head.innerHTML = `<meta name="${PRODUCT_VERSION_META}" content="${version}">`
}

/** What the server is serving right now. */
function serve(appVersion: string | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ appVersion }) })),
  )
}

beforeEach(() => {
  reload.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

describe('RefreshOffer', () => {
  it('says nothing while the server serves the build this page is running', async () => {
    stampPage('0.1.1-edge.1')
    serve('0.1.1-edge.1')

    render(<RefreshOffer />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('served-build-refresh')).toBeNull()
  })

  it('offers a refresh once a newer build is being served, and takes it', async () => {
    stampPage('0.1.1-edge.1')
    serve('0.1.1-edge.2')

    render(<RefreshOffer />)

    const offer = await screen.findByTestId('served-build-refresh')
    expect(offer.textContent).toContain('A newer Podium is ready')
    fireEvent.click(screen.getByLabelText('Refresh to the new version of Podium'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the page cannot name the build it is running', async () => {
    // No meta: an unstamped export, or the Expo dev server. `appVersion()`
    // answers `dev`, which is not a version anything can be behind.
    serve('0.1.1-edge.2')

    render(<RefreshOffer />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('served-build-refresh')).toBeNull()
  })
})
