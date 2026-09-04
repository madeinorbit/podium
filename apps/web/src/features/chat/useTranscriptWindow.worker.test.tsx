// @vitest-environment happy-dom
/**
 * Regression for the worker-pending transcript path.
 *
 * While the first index request is unresolved, ChatView can re-render from its
 * conversation controller. The derived empty collections must remain the same
 * references across those renders: useChatSend mirrors the blocks into a
 * transcript bridge, and a fresh empty array there feeds the bridge's listener
 * back into ConversationController.patch() until React raises error #185.
 */
import { asSessionId, type SessionMeta } from '@podium/model'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import {
  type UseTranscriptWindowOptions,
  type UseTranscriptWindowResult,
  useTranscriptWindow,
} from './useTranscriptWindow'

const computeClient = vi.hoisted(() => ({
  usesWorker: true,
  compute: vi.fn(() => new Promise<never>(() => {})),
  computeOnMain: vi.fn(),
}))

vi.mock('./transcript-compute-client', () => ({
  transcriptComputeClient: () => computeClient,
}))

const fakeHub = {
  subscribeTranscript: vi.fn(() => () => {}),
}
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query: vi.fn(() => new Promise<never>(() => {})),
    },
  },
}
const options = {
  sessionId: asSessionId('s1'),
  hub: fakeHub,
  trpc: fakeTrpc,
  replica: undefined,
  active: true,
  session: { status: 'live' } as unknown as SessionMeta,
  deferInitialRead: true,
} as unknown as UseTranscriptWindowOptions

let results: UseTranscriptWindowResult[]
let container: HTMLDivElement
let root: Root

function Probe({ tick }: { tick: number }): JSX.Element | null {
  results.push(useTranscriptWindow(options))
  return <div data-tick={tick} />
}

beforeEach(() => {
  results = []
  computeClient.compute.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useTranscriptWindow worker-pending fallbacks', () => {
  it('keeps empty blocks and rows referentially stable across a parent render', () => {
    act(() => root.render(<Probe tick={0} />))
    act(() => root.render(<Probe tick={1} />))

    expect(computeClient.compute).toHaveBeenCalledOnce()
    expect(results).toHaveLength(2)
    expect(results[1]?.blocks).toBe(results[0]?.blocks)
    expect(results[1]?.rows).toBe(results[0]?.rows)
  })
})
