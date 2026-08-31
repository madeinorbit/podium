// @vitest-environment happy-dom

import { asMachineId } from '@podium/model'
import { MODEL_CATALOG_MAX_AGE_MS } from '@podium/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const catalog = vi.fn()
const refresh = vi.fn()
const trpc = { models: { catalog: { query: catalog }, refresh: { mutate: refresh } } }
let activeTrpc: unknown = trpc

vi.mock('./provider', () => ({
  useStoreSelector: (select: (store: { trpc: unknown }) => unknown) => select({ trpc: activeTrpc }),
}))

const { useModelCatalog, useModelCatalogState } = await import('./use-model-catalog')

function Probe() {
  const models = useModelCatalog()
  return <div>{models.codex?.map((model) => model.label).join(', ')}</div>
}

function StatusProbe({ machineId }: { machineId: ReturnType<typeof asMachineId> }) {
  const state = useModelCatalogState(machineId)
  return (
    <div>
      <span>{state.status}</span>
      <span>{state.catalog.codex?.map((model) => model.label).join(', ')}</span>
    </div>
  )
}

describe('useModelCatalog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    activeTrpc = trpc
    catalog.mockReset()
    refresh.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('revalidates while a picker stays mounted', async () => {
    const machineId = asMachineId('27942783-fbcc-45d4-a613-d0ee7759143d')
    const firstFetchedAt = Date.now()
    catalog.mockResolvedValue({
      machineId,
      byAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      fetchedAt: firstFetchedAt,
    })
    refresh.mockImplementation(async () => ({
      machineId,
      byAgent: { codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }] },
      fetchedAt: Date.now(),
    }))

    render(<Probe />)
    await act(async () => {})
    expect(screen.getByText('GPT-5.5')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_CATALOG_MAX_AGE_MS)
    })
    expect(screen.getByText('GPT-5.6-Sol')).toBeTruthy()
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('revalidates a near-expiry query at the snapshot deadline', async () => {
    const machineId = asMachineId('199a3c18-931d-4d59-a101-3097b331fd38')
    const deadlineDelay = 1_000
    let resolveFresh: ((snapshot: unknown) => void) | undefined
    catalog
      .mockResolvedValueOnce({
        machineId,
        byAgent: { codex: [{ value: 'near-expiry', label: 'Near expiry' }] },
        fetchedAt: Date.now() - MODEL_CATALOG_MAX_AGE_MS + deadlineDelay,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFresh = resolve
        }),
      )

    render(<StatusProbe machineId={machineId} />)
    await act(async () => {})
    expect(screen.getByText('ready')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(deadlineDelay - 1)
    })
    expect(catalog).toHaveBeenCalledOnce()
    expect(screen.getByText('ready')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(screen.getByText('loading')).toBeTruthy()
    expect(screen.getByText('Near expiry')).toBeTruthy()

    await act(async () => {
      resolveFresh?.({
        machineId,
        byAgent: { codex: [{ value: 'fresh', label: 'Fresh' }] },
        fetchedAt: Date.now(),
      })
    })
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('Fresh')).toBeTruthy()
  })

  it('renders an expired cached snapshot non-ready on remount and recovers', async () => {
    const machineId = asMachineId('8d637611-fe58-47f9-8ac8-d2432c9a03ba')
    let resolveFresh: ((snapshot: unknown) => void) | undefined
    catalog
      .mockResolvedValueOnce({
        machineId,
        byAgent: { codex: [{ value: 'cached', label: 'Cached' }] },
        fetchedAt: Date.now(),
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFresh = resolve
        }),
      )

    const firstView = render(<StatusProbe machineId={machineId} />)
    await act(async () => {})
    expect(screen.getByText('ready')).toBeTruthy()
    firstView.unmount()

    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_MAX_AGE_MS)
    render(<StatusProbe machineId={machineId} />)

    expect(screen.getByText('loading')).toBeTruthy()
    expect(screen.getByText('Cached')).toBeTruthy()
    await act(async () => {})
    expect(catalog).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveFresh?.({
        machineId,
        byAgent: { codex: [{ value: 'fresh', label: 'Fresh after remount' }] },
        fetchedAt: Date.now(),
      })
    })
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('Fresh after remount')).toBeTruthy()
  })

  it('reports loading until the first catalog read resolves', () => {
    const machineId = asMachineId('ca532a8b-9994-4d58-9bb8-ddcba18548a1')
    catalog.mockReturnValue(new Promise(() => {}))

    render(<StatusProbe machineId={machineId} />)

    expect(screen.getByText('loading')).toBeTruthy()
  })

  it('reports an unavailable first read so launch controls can fail closed', async () => {
    const machineId = asMachineId('b6e665b2-04f7-48d4-b035-6dce5ed0cd4f')
    catalog.mockRejectedValue(new Error('offline'))

    render(<StatusProbe machineId={machineId} />)
    await act(async () => {})

    expect(screen.getByText('unavailable')).toBeTruthy()
  })

  it('keeps a stale query non-ready while refresh is pending but retains its data', async () => {
    const machineId = asMachineId('75c55a26-b2d5-401d-87a8-c1bf21a4b1c3')
    catalog.mockResolvedValue({
      machineId,
      byAgent: { codex: [{ value: 'retired', label: 'Last known' }] },
      fetchedAt: Date.now() - MODEL_CATALOG_MAX_AGE_MS,
    })
    refresh.mockReturnValue(new Promise(() => {}))

    render(<StatusProbe machineId={machineId} />)
    await act(async () => {})

    expect(screen.getByText('loading')).toBeTruthy()
    expect(screen.getByText('Last known')).toBeTruthy()
  })

  it('marks a stale query unavailable when its refresh fails', async () => {
    const machineId = asMachineId('f3ea4e1d-a33b-4821-ab56-fe9cb96e424d')
    catalog.mockResolvedValue({
      machineId,
      byAgent: { codex: [{ value: 'retired', label: 'Last known' }] },
      fetchedAt: Date.now() - MODEL_CATALOG_MAX_AGE_MS,
    })
    refresh.mockRejectedValue(new Error('offline'))

    render(<StatusProbe machineId={machineId} />)
    await act(async () => {})
    expect(screen.getByText('unavailable')).toBeTruthy()
    expect(screen.getByText('Last known')).toBeTruthy()
  })

  it('recovers from a failed stale refresh to a later fresh catalog', async () => {
    const machineId = asMachineId('fc4c5682-f6c1-4f6b-87a9-297ff6355d9d')
    catalog
      .mockResolvedValueOnce({
        machineId,
        byAgent: { codex: [{ value: 'retired', label: 'Last known' }] },
        fetchedAt: Date.now() - MODEL_CATALOG_MAX_AGE_MS,
      })
      .mockImplementationOnce(async () => ({
        machineId,
        byAgent: { codex: [{ value: 'gpt-current', label: 'Current' }] },
        fetchedAt: Date.now(),
      }))
    refresh.mockRejectedValueOnce(new Error('offline'))

    render(<StatusProbe machineId={machineId} />)
    await act(async () => {})
    expect(screen.getByText('unavailable')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_CATALOG_MAX_AGE_MS)
    })
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('Current')).toBeTruthy()
  })

  it('starts loading from an empty scope when the API identity changes', async () => {
    const machineId = asMachineId('b156e096-031e-4fcc-8557-cc09652b8260')
    catalog.mockResolvedValue({
      machineId,
      byAgent: { codex: [{ value: 'old-server', label: 'Old server' }] },
      fetchedAt: Date.now(),
    })
    const secondCatalog = vi.fn()
    const secondRefresh = vi.fn()
    let resolveSecond: ((snapshot: unknown) => void) | undefined
    secondCatalog.mockReturnValue(
      new Promise((resolve) => {
        resolveSecond = resolve
      }),
    )
    const secondTrpc = {
      models: { catalog: { query: secondCatalog }, refresh: { mutate: secondRefresh } },
    }

    const view = render(<StatusProbe machineId={machineId} />)
    await act(async () => {})
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('Old server')).toBeTruthy()

    activeTrpc = secondTrpc
    view.rerender(<StatusProbe machineId={machineId} />)
    expect(screen.getByText('loading')).toBeTruthy()
    expect(screen.queryByText('Old server')).toBeNull()
    expect(secondCatalog).toHaveBeenCalledOnce()

    await act(async () => {
      resolveSecond?.({
        machineId,
        byAgent: { codex: [{ value: 'new-server', label: 'New server' }] },
        fetchedAt: Date.now(),
      })
    })
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('New server')).toBeTruthy()
    expect(secondRefresh).not.toHaveBeenCalled()
  })
})
