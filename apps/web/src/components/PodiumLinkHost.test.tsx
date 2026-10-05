import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asIssueId } from '@podium/model'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostStore = vi.hoisted(() => {
  const allIssues = [
    { id: 'iss_one', prefix: 'POD', seq: 1710, displayRef: 'POD-1710' },
    { id: 'iss_two', prefix: 'POD', seq: 1711, displayRef: 'POD-1711' },
  ]
  let issues = [...allIssues]
  let namedIssues = new Map(issues.flatMap(row => [[row.id, row], [row.displayRef, row]] as const))
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    allIssues,
    get issues() {
      return issues
    },
    set issues(rows: typeof issues) {
      issues = rows
      namedIssues = new Map(rows.flatMap(row => [[row.id, row], [row.displayRef, row]] as const))
      revision++
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => revision,
    setOpenIssueId: vi.fn(),
    setView: vi.fn(),
    navigateToSession: vi.fn(),
    openArtifact: vi.fn(),
    openFileInWorktree: vi.fn(),
    readIssues: vi.fn(),
    readSessions: vi.fn(),
    readIssue: vi.fn(),
    readSession: vi.fn(),
    namedIssue: (identifier: string) => namedIssues.get(identifier) ?? namedIssues.get(identifier.trim()),
  }
})

vi.mock('@/app/shell-data', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useShellActions: () => ({
      httpOrigin: 'http://127.0.0.1:18787',
      setOpenIssueId: hostStore.setOpenIssueId,
      setView: hostStore.setView,
      navigateToSession: hostStore.navigateToSession,
      openArtifact: hostStore.openArtifact,
      openFileInWorktree: hostStore.openFileInWorktree,
    }),
    useShellLinks: () => {
      useSyncExternalStore(hostStore.subscribe, hostStore.snapshot)
      return {
        readIssue: hostStore.readIssue,
        readSession: hostStore.readSession,
        artifactIssue: () => undefined,
      }
    },
  }
})

import {
  PODIUM_LINK_QUEUE_CAPACITY,
  PODIUM_LINK_RESOLUTION_TIMEOUT_MS,
  PodiumLinkHost,
} from './PodiumLinkHost'
import { setKnownPodiumOrigins } from '@/lib/podium-link'

interface NativeOpenWindow extends Window {
  __PODIUM_DELIVER_NATIVE_OPEN__?: (raw: unknown) => void
  __PODIUM_NATIVE_OPEN_ACK__?: (raw: unknown) => void
  __PODIUM_NATIVE_OPEN_READY__?: (value?: boolean) => void
}

const nativeWindow = window as NativeOpenWindow
const nativeOpenBridge = readFileSync(
  join(__dirname, '../../../desktop/src-tauri/native-open.js'),
  'utf8',
)
const appShellSource = readFileSync(join(__dirname, '../app/AppShell.tsx'), 'utf8')
const appMainSource = readFileSync(join(__dirname, '../app/main.tsx'), 'utf8')

describe('PodiumLinkHost native delivery', () => {
  let container: HTMLDivElement
  let root: Root
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  let previousActEnvironment: boolean | undefined

  beforeEach(() => {
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.clearAllMocks()
    hostStore.readIssues.mockImplementation(() => hostStore.issues)
    hostStore.readSessions.mockReturnValue([])
    hostStore.readIssue.mockImplementation(hostStore.namedIssue)
    hostStore.readSession.mockReturnValue(undefined)
    hostStore.issues = [hostStore.allIssues[1]!]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // biome-ignore lint/security/noGlobalEval: Run the trusted checked-in native bridge in this hermetic DOM fixture.
    window.eval(nativeOpenBridge)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__
    delete nativeWindow.__PODIUM_NATIVE_OPEN_ACK__
    delete nativeWindow.__PODIUM_NATIVE_OPEN_READY__
    vi.useRealTimers()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  })

  it('does not acquire either roster while idle and reads fresh issues on activation', () => {
    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.readIssues).not.toHaveBeenCalled()
    expect(hostStore.readSessions).not.toHaveBeenCalled()
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() => nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    hostStore.readIssues.mockClear()
    hostStore.readSessions.mockClear()
    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.readIssues).not.toHaveBeenCalled()
    expect(hostStore.readSessions).not.toHaveBeenCalled()
  })

  it('keeps later cold URLs behind an unresolved queue head', () => {
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1711')

    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() => {
      root.render(<PodiumLinkHost />)
    })

    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(1, asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenNthCalledWith(2, asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(2)

    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(2)
  })

  it('observes an absolute initial target after the active origin is registered', () => {
    setKnownPodiumOrigins([])
    hostStore.issues = []
    act(() => root.render(<PodiumLinkHost initialHref="http://127.0.0.1:18787/issues/POD-1710" />))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()
    const before = hostStore.readIssue.mock.calls.length
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    expect(hostStore.readIssue.mock.calls.length).toBeGreaterThan(before)
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
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
    expect(appShellSource).toContain(
      "replicaReady={!sync.firstSync || sync.hasInstalled || sync.phase === 'ready'}",
    )
    hostStore.issues = []
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')

    act(() => root.render(<PodiumLinkHost replicaReady={false} />))
    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS * 2))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => { hostStore.issues = [hostStore.allIssues[0]!] })
    act(() => root.render(<PodiumLinkHost replicaReady={true} />))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('hands an unresolved native URL to the next host mount exactly once', () => {
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')
    act(() => root.render(<PodiumLinkHost />))
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() => root.render(<PodiumLinkHost />))

    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate an in-flight native URL when StrictMode replays effects', () => {
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')
    act(() =>
      root.render(
        <StrictMode>
          <PodiumLinkHost />
        </StrictMode>,
      ),
    )
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() =>
      root.render(
        <StrictMode>
          <PodiumLinkHost />
        </StrictMode>,
      ),
    )

    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('does not replay the document initial URL on a host remount', () => {
    expect(appMainSource).toContain('const pendingInitialPodiumHref = useRef(initialPodiumHref)')
    expect(appMainSource).toContain('pendingInitialPodiumHref.current = null')
    expect(appShellSource).toContain('const pendingInitialPodiumHref = useRef(initialPodiumHref)')
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    let pendingInitialHref: string | null = 'podium://issues/POD-1710'
    const consumeInitialHref = (): void => {
      pendingInitialHref = null
    }
    act(() =>
      root.render(
        <PodiumLinkHost
          initialHref={pendingInitialHref}
          onInitialHrefConsumed={consumeInitialHref}
        />,
      ),
    )
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    root = createRoot(container)
    act(() =>
      root.render(
        <PodiumLinkHost
          initialHref={pendingInitialHref}
          onInitialHrefConsumed={consumeInitialHref}
        />,
      ),
    )

    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })

  it('retries an unresolved document initial URL on the next host mount', () => {
    let pendingInitialHref: string | null = 'podium://issues/POD-1710'
    const consumeInitialHref = (): void => {
      pendingInitialHref = null
    }
    act(() =>
      root.render(
        <PodiumLinkHost
          initialHref={pendingInitialHref}
          onInitialHrefConsumed={consumeInitialHref}
        />,
      ),
    )
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() =>
      root.render(
        <PodiumLinkHost
          initialHref={pendingInitialHref}
          onInitialHrefConsumed={consumeInitialHref}
        />,
      ),
    )

    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_one'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
    expect(pendingInitialHref).toBeNull()
  })

  it('rejects excess entries without evicting earlier queued work', () => {
    act(() => { hostStore.issues = [...hostStore.allIssues] })
    act(() => root.render(<PodiumLinkHost />))
    const dispatchNativeOpen = (detail: string): void => {
      window.dispatchEvent(new CustomEvent('podium:native-open', { detail }))
    }
    act(() => {
      for (let index = 0; index < PODIUM_LINK_QUEUE_CAPACITY - 1; index += 1) {
        dispatchNativeOpen(`podium://issues/POD-${900_000 + index}`)
      }
      dispatchNativeOpen('podium://issues/POD-1711')
      dispatchNativeOpen('podium://issues/POD-1710')
    })
    expect(hostStore.setOpenIssueId).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith(asIssueId('iss_two'))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(PODIUM_LINK_RESOLUTION_TIMEOUT_MS))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledTimes(1)
  })
})
