import type { IssuePanelArtifact } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContentActivity, useContentVisible } from '../lib/visible-content'

// The full-screen viewer (boards Artifact, ArtifactDrag): "2 of 3", one page
// per artifact, an opaque ground, a close control.

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../client/server-profile-context', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('expo-blur', () => ({ BlurView: () => null }))
vi.mock('./RichMarkdown', () => ({ RichMarkdown: () => null }))
const media = vi.hoisted(() => ({ video: vi.fn(), fetch: vi.fn() }))
vi.mock('./ArtifactVideo', () => ({
  ArtifactVideo: ({ url }: { url: string }) => {
    media.video(url)
    return null
  },
}))
vi.mock('../client/authenticated-assets', async (original) => ({
  ...(await original<typeof import('../client/authenticated-assets')>()),
  fetchAuthenticatedAsset: media.fetch,
}))
// The dismiss pan's latest config, so tests can see when it is switched off.
const gestures = vi.hoisted(() => ({ pan: {} as { enabled?: boolean; maxPointers?: number } }))
vi.mock('react-native-gesture-handler', async () => {
  const { View } = await import('react-native')
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: unknown }) => children,
    usePanGesture: (config: typeof gestures.pan) => {
      gestures.pan = config
      return {}
    },
    useTapGesture: () => ({}),
  }
})
// The zoom itself is UIKit's; the viewer only hears when an image leaves fit.
vi.mock('./ZoomableImage', () => ({
  ZoomableImage: ({ label, onZoomChange }: { label: string; onZoomChange(z: boolean): void }) => (
    <>
      <button type="button" onClick={() => onZoomChange(true)}>{`zoom ${label}`}</button>
      <button type="button" onClick={() => onZoomChange(false)}>{`fit ${label}`}</button>
    </>
  ),
}))
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native')
  return {
    default: { View },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 0,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ get: () => value, set: () => {} }),
    withSpring: (value: number) => value,
    withTiming: (value: number) => value,
  }
})
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: () => void) => fn() }))

const { ArtifactViewer, HTML_ZOOM_REPORTER, readPageMessage } = await import('./ArtifactViewer')
const { fitInsets, fitSize, isZoomed, maxZoomFor, zoomRectAt } =
  await vi.importActual<typeof import('./ZoomableImage')>('./ZoomableImage')

const art = (path: string): IssuePanelArtifact => ({ path, addedAt: '2026-11-01T00:00:00.000Z' })
const items = ['a.png', 'pricing.png', 'c.png'].map((path) => ({
  key: path,
  artifact: art(path),
  url: `https://podium.local/files/${path}`,
}))

it('covers underlying activity while the actual artifact modal is mounted and resumes on dismissal', () => {
  function Behind() {
    return <span data-testid="behind-artifact">{String(useContentVisible())}</span>
  }
  const scene = (open: boolean) => (
    <ContentActivity>
      <Behind />
      <ArtifactViewer
        artifact={open ? art('one.png') : null}
        url={open ? 'https://podium.local/one.png' : null}
        onClose={() => {}}
      />
    </ContentActivity>
  )
  const view = render(scene(false))
  expect(screen.getByTestId('behind-artifact').textContent).toBe('true')
  view.rerender(scene(true))
  expect(screen.getByTestId('behind-artifact').textContent).toBe('false')
  view.rerender(scene(false))
  expect(screen.getByTestId('behind-artifact').textContent).toBe('true')
})

it('names the opened artifact and its place in the list', () => {
  render(<ArtifactViewer items={items} index={1} onClose={() => {}} />)
  expect(screen.getByRole('heading').textContent).toBe('pricing.png')
  expect(screen.getByTestId('artifact-position').textContent).toBe('2 of 3')
})

it('leaves the counter off a single artifact', () => {
  render(
    <ArtifactViewer artifact={art('one.png')} url="https://podium.local/x" onClose={() => {}} />,
  )
  expect(screen.getByRole('heading').textContent).toBe('one.png')
  expect(screen.queryByTestId('artifact-position')).toBeNull()
})

it('draws on an opaque ground and closes from its control', async () => {
  const onClose = vi.fn()
  render(<ArtifactViewer items={items} index={0} onClose={onClose} />)
  const page = screen.getByTestId('artifact-viewer')
  expect(getComputedStyle(page).backgroundColor).not.toMatch(/rgba\(.*,\s*0?\.\d+\)$/)
  await act(async () => fireEvent.click(screen.getByLabelText('Close artifact')))
  expect(onClose).toHaveBeenCalledOnce()
})

it('renders nothing without an artifact', () => {
  const { container } = render(<ArtifactViewer artifact={null} url={null} onClose={() => {}} />)
  expect(container.textContent).toBe('')
})

it('does not mount neighboring video, document or HTML previews, but loads the selected one', async () => {
  const mixed = ['clip.mp4', 'image.png', 'notes.txt', 'page.html'].map((path) => ({
    key: path,
    artifact: art(path),
    url: `https://podium.local/${path}`,
  }))
  const view = render(<ArtifactViewer items={mixed} index={1} onClose={() => {}} />)
  expect(media.video).not.toHaveBeenCalled()
  expect(media.fetch).not.toHaveBeenCalled()
  expect(document.querySelector('iframe')).toBeNull()
  view.unmount()
  const video = render(<ArtifactViewer items={mixed} index={0} onClose={() => {}} />)
  expect(media.video).toHaveBeenCalledWith(mixed[0]?.url)
  video.unmount()
  media.fetch.mockResolvedValueOnce(new Response('Selected text'))
  render(<ArtifactViewer items={mixed} index={2} onClose={() => {}} />)
  expect(await screen.findByText('Selected text')).toBeTruthy()
  expect(media.fetch).toHaveBeenCalledExactlyOnceWith(mixed[2]?.url, null)
})

it('ignores a document response after selection changes and accepts the current response', async () => {
  let resolveOld!: (response: Response) => void
  media.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      }),
  )
  media.fetch.mockResolvedValueOnce(new Response('Current document'))
  const view = render(
    <ArtifactViewer
      artifact={art('old.txt')}
      url="https://podium.local/old.txt"
      onClose={() => {}}
    />,
  )
  view.rerender(
    <ArtifactViewer
      artifact={art('new.txt')}
      url="https://podium.local/new.txt"
      onClose={() => {}}
    />,
  )
  expect(await screen.findByText('Current document')).toBeTruthy()
  await act(async () => {
    resolveOld(new Response('Stale document'))
  })
  expect(screen.queryByText('Stale document')).toBeNull()
  expect(screen.getByText('Current document')).toBeTruthy()
})

const pagerLocked = () =>
  getComputedStyle(screen.getByTestId('artifact-pager')).overflowX === 'hidden'

it('holds the pager and pull-to-dismiss still while the image is zoomed, never for a pinch', async () => {
  render(<ArtifactViewer items={items} index={1} onClose={() => {}} />)
  expect(gestures.pan.maxPointers).toBe(1)
  expect(gestures.pan.enabled).toBe(true)
  expect(pagerLocked()).toBe(false)

  await act(async () => fireEvent.click(screen.getByText('zoom pricing.png')))
  expect(gestures.pan.enabled).toBe(false)
  expect(pagerLocked()).toBe(true)

  await act(async () => fireEvent.click(screen.getByText('fit pricing.png')))
  expect(gestures.pan.enabled).toBe(true)
  expect(pagerLocked()).toBe(false)
})

it('pages at fit, dropping the old page and its zoom; the next page starts at fit', async () => {
  render(<ArtifactViewer items={items} index={0} onClose={() => {}} />)
  await act(async () => fireEvent.click(screen.getByText('zoom a.png')))
  await act(async () => fireEvent.click(screen.getByText('fit a.png')))
  const pager = screen.getByTestId('artifact-pager')
  const { Dimensions } = await import('react-native')
  // One page over (the test DOM reports a zero-wide window; the viewer pages by max(1, width)).
  const page = Math.max(1, Dimensions.get('window').width)
  Object.defineProperty(pager, 'scrollLeft', { configurable: true, value: page })
  await act(async () => fireEvent.scroll(pager))
  expect(screen.getByTestId('artifact-position').textContent).toBe('2 of 3')
  // Only the open page mounts its image, so a zoom never survives a page turn.
  expect(screen.queryByText('zoom a.png')).toBeNull()
  expect(gestures.pan.enabled).toBe(true)
  expect(pagerLocked()).toBe(false)
  await act(async () => fireEvent.click(screen.getByText('zoom pricing.png')))
  expect(pagerLocked()).toBe(true)
})

it('shows a PDF in the page instead of its bytes as text', () => {
  render(
    <ArtifactViewer
      artifact={art('spec.pdf')}
      url="https://podium.local/files/spec.pdf"
      onClose={() => {}}
    />,
  )
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
    'https://podium.local/files/spec.pdf',
  )
  expect(media.fetch).not.toHaveBeenCalled()
})

it("reads only its own messages from an artifact page and never limits the page's zoom", () => {
  expect(readPageMessage('podium-zoom:1')).toEqual({ zoomed: true })
  expect(readPageMessage('podium-zoom:0')).toEqual({ zoomed: false })
  expect(readPageMessage('podium-pull-close')).toEqual({ pullClose: true })
  expect(readPageMessage('hello from the page')).toBeNull()
  expect(readPageMessage(1)).toBeNull()
  expect(HTML_ZOOM_REPORTER).not.toMatch(/viewport|maximum-scale|user-scalable|preventDefault/)
  // Pull-to-close only from an unzoomed page, past the same 72pt as documents.
  expect(HTML_ZOOM_REPORTER).toContain('!zoomed && window.scrollY < -72')
})

it('fits, bounds and aims image zoom like Photos', () => {
  const box = { width: 400, height: 800 }
  // Wide image: fills the width, centred vertically by the scroll view.
  expect(fitSize({ width: 2000, height: 1000 }, box)).toEqual({ width: 400, height: 200 })
  // Small image: scaled up to fit too.
  expect(fitSize({ width: 100, height: 100 }, box)).toEqual({ width: 400, height: 400 })
  expect(fitSize(null, box)).toBe(box)
  // Centred at fit: the leftover space split on both sides.
  expect(fitInsets({ width: 400, height: 200 }, box)).toEqual({
    top: 300,
    bottom: 300,
    left: 0,
    right: 0,
  })
  expect(isZoomed(1)).toBe(false)
  expect(isZoomed(1.005)).toBe(false)
  expect(isZoomed(undefined)).toBe(false)
  expect(isZoomed(1.5)).toBe(true)
  // At least 4x; a high-resolution image may go to 2x its pixels, capped at 8x.
  expect(maxZoomFor(null, box, 3)).toBe(4)
  expect(maxZoomFor({ width: 1200, height: 600 }, { width: 400, height: 200 }, 3)).toBe(4)
  expect(maxZoomFor({ width: 4800, height: 2400 }, { width: 400, height: 200 }, 3)).toBe(8)
  expect(maxZoomFor({ width: 3600, height: 1800 }, { width: 400, height: 200 }, 3)).toBe(6)
  // Double tap: a 2.5x window centred on the tap.
  expect(zoomRectAt({ x: 200, y: 100 }, box, 2.5)).toEqual({
    x: 120,
    y: -60,
    width: 160,
    height: 320,
  })
})
