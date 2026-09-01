import { asIssueId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostStore = vi.hoisted(() => ({
  issues: [
    { id: 'iss_one', prefix: 'POD', seq: 1710, displayRef: 'POD-1710' },
    { id: 'iss_two', prefix: 'POD', seq: 1711, displayRef: 'POD-1711' },
  ],
  setOpenIssueId: vi.fn(),
  setView: vi.fn(),
  navigateToSession: vi.fn(),
  openArtifact: vi.fn(),
  openFileInWorktree: vi.fn(),
}))

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => hostStore.issues,
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({
      httpOrigin: 'http://127.0.0.1:18787',
      sessions: [],
      setOpenIssueId: hostStore.setOpenIssueId,
      setView: hostStore.setView,
      navigateToSession: hostStore.navigateToSession,
      openArtifact: hostStore.openArtifact,
      openFileInWorktree: hostStore.openFileInWorktree,
    }),
}))

import { PodiumLinkHost } from './PodiumLinkHost'

interface NativeOpenWindow extends Window {
  __PODIUM_NATIVE_OPEN_READY__?: (value?: boolean) => void
}

const nativeWindow = window as NativeOpenWindow

describe('PodiumLinkHost native delivery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete nativeWindow.__PODIUM_NATIVE_OPEN_READY__
  })

  it('activates every URL in a synchronous cold queue in delivery order', () => {
    const ready = vi.fn()
    nativeWindow.__PODIUM_NATIVE_OPEN_READY__ = ready

    act(() => root.render(<PodiumLinkHost />))
    expect(ready).toHaveBeenCalledWith(true)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('podium:native-open', { detail: 'podium://issues/POD-1710' }),
      )
      window.dispatchEvent(
        new CustomEvent('podium:native-open', { detail: 'podium://issues/POD-1711' }),
      )
    })

    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(1, asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(2, asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(2)
  })
})
