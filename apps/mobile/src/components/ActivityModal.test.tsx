import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { type ReactNode, StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useClock } from '../lib/clock-hooks'
import { ContentActivity, useContentVisible } from '../lib/visible-content'
import { ActivityModal } from './ActivityModal'
import { ImageLightbox } from './ImageLightbox'
import { SelectTextSheet } from './SelectTextSheet'
import { SharedFileViewer } from './SharedFiles'

vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Modal: ({ visible = true, children }: { visible?: boolean; children: ReactNode }) =>
    visible ? <div role="dialog">{children}</div> : null,
}))
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./ZoomableImage', () => ({ ZoomableImage: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('../navigation/use-dismiss-on-root-leave', () => ({ useDismissOnRootLeave: () => {} }))
vi.mock('../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('../client/chat-uploads', () => ({
  useChatItemAttachments: () => [],
  useChatUploadUrl: () => null,
}))
vi.mock('../client/authenticated-assets', () => ({
  authenticatedImageSource: (uri: string) => ({ uri }),
  fetchAuthenticatedAsset: async () => ({ ok: true }),
  readAuthenticatedTextPreview: async () => 'File contents',
}))
function Probe({ name }: { name: string }) {
  return <span data-testid={name}>{String(useContentVisible())}</span>
}
function Clock({ name }: { name: string }) {
  return <span data-testid={name}>{useClock(1000)}</span>
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it.each([
  'image',
  'select',
  'file',
])('covers the screen for the actual %s modal and resumes on unmount', async (kind) => {
  const scene = (open: boolean) => (
    <ContentActivity>
      <Probe name="behind" />
      {kind === 'image' ? (
        <ImageLightbox
          visible={open}
          source={{ uri: 'image.png' }}
          label="Image"
          onClose={() => {}}
        />
      ) : kind === 'select' ? (
        <SelectTextSheet
          text={open ? 'Selected message' : null}
          onClose={() => {}}
          onCopy={() => {}}
        />
      ) : open ? (
        <SharedFileViewer name="report.txt" url="report.txt" bearer={null} onClose={() => {}} />
      ) : null}
    </ContentActivity>
  )
  const view = render(scene(false))
  expect(screen.getByTestId('behind').textContent).toBe('true')
  await act(async () => view.rerender(scene(true)))
  expect(screen.getByTestId('behind').textContent).toBe('false')
  view.rerender(scene(false))
  expect(screen.getByTestId('behind').textContent).toBe('true')
})

it('balances nested coverage in StrictMode and resumes each layer only after its covering modal closes', () => {
  const scene = (outer: boolean, inner: boolean) => (
    <StrictMode>
      <ContentActivity>
        <Clock name="root" />
        <ActivityModal visible={outer}>
          <Clock name="outer" />
          <ActivityModal visible={inner}>
            <Clock name="inner" />
          </ActivityModal>
        </ActivityModal>
      </ContentActivity>
    </StrictMode>
  )
  const view = render(scene(false, false))
  const root = screen.getByTestId('root').textContent
  view.rerender(scene(true, true))
  const outer = screen.getByTestId('outer').textContent
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByTestId('root').textContent).toBe(root)
  expect(screen.getByTestId('outer').textContent).toBe(outer)
  expect(screen.getByTestId('inner').textContent).toBe('2000')
  view.rerender(scene(true, false))
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByTestId('root').textContent).toBe(root)
  expect(screen.getByTestId('outer').textContent).toBe('3000')
  view.rerender(scene(false, false))
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByTestId('root').textContent).toBe('4000')
})

it('keeps every modal primitive on the shared coverage wrapper', () => {
  for (const file of [
    'ArtifactViewer',
    'ImageLightbox',
    'SelectTextSheet',
    'SharedFiles',
    'BottomSheet',
  ]) {
    const source = readFileSync(resolve(process.cwd(), `src/components/${file}.tsx`), 'utf8')
    expect(source).toContain('ActivityModal as Modal')
    expect(source).not.toMatch(/import\s*\{[^}]*\bModal\b[^}]*\}\s*from ['"]react-native['"]/)
  }
})
