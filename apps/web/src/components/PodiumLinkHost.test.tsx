import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asIssueId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostStore = vi.hoisted(() => {
  const allIssues = [
    { id: 'iss_one', prefix: 'POD', seq: 1710, displayRef: 'POD-1710' },
    { id: 'iss_two', prefix: 'POD', seq: 1711, displayRef: 'POD-1711' },
  ]
  return {
    allIssues,
    issues: [...allIssues],
    setOpenIssueId: vi.fn(),
    setView: vi.fn(),
    navigateToSession: vi.fn(),
    openArtifact: vi.fn(),
    openFileInWorktree: vi.fn(),
  }
})

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

import {
  PODIUM_LINK_QUEUE_CAPACITY,
  PODIUM_LINK_RESOLUTION_TIMEOUT_MS,
  PodiumLinkHost,
} from './PodiumLinkHost'

interface NativeOpenWindow extends Window {
  __PODIUM_DELIVER_NATIVE_OPEN__?: (raw: unknown) => void
  __PODIUM_NATIVE_OPEN_READY__?: (value?: boolean) => void
}

const nativeWindow = window as NativeOpenWindow
const nativeOpenBridge = readFileSync(
  join(__dirname, '../../../desktop/src-tauri/native-open.js'),
  'utf8',
)
const appShellSource = readFileSync(join(__dirname, '../app/AppShell.tsx'), 'utf8')

describe('PodiumLinkHost native delivery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    hostStore.issues = [hostStore.allIssues[1]!]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.eval(nativeOpenBridge)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__
    delete nativeWindow.__PODIUM_NATIVE_OPEN_READY__
    vi.useRealTimers()
  })

  it('keeps later cold URLs behind an unresolved queue head', () => {
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1711')

    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    hostStore.issues = [...hostStore.allIssues]
    act(() => {
      root.render(<PodiumLinkHost />)
    })

    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(1, asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(2, asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(2)

    hostStore.issues = [...hostStore.allIssues]
    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(2)
  })

  it('expires an unavailable head and delivers the next URL once', () => {
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-999999')
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1711')

    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('does not spend the resolution deadline before the initial replica is ready', () => {
    expect(appShellSource).toContain("replicaReady={!sync.firstSync || sync.phase === 'ready'}")
    hostStore.issues = []
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')

    act(() => root.render(<PodiumLinkHost replicaReady={false} />))
    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS * 2))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    hostStore.issues = [hostStore.allIssues[0]!]
    act(() => root.render(<PodiumLinkHost replicaReady={true} />))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('rejects excess entries without evicting earlier queued work', () => {
    act(() => root.render(<PodiumLinkHost />))
    const dispatchNativeOpen = (detail: string): void => {
      window.dispatchEvent(new CustomEvent('podium:native-open', { detail }))
    }
    act(() => {
      for (let index = 0; index < PODIUM_LINK_QUEUE_CAPACITY - 1; index += 1) {
        dispatchNativeOpen(`podium://issues/POD-${900_000 + index}`)
      }
      dispatchNativeOpen('podium://issues/POD-1711')
      dispatchNativeOpen('podium://issues/POD-1711')
    })
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })
})
