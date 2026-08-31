// @vitest-environment happy-dom

import { asMachineId } from '@podium/model'
import { MODEL_CATALOG_MAX_AGE_MS } from '@podium/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const catalog = vi.fn()
const refresh = vi.fn()
const trpc = { models: { catalog: { query: catalog }, refresh: { mutate: refresh } } }

vi.mock('./provider', () => ({
  useStoreSelector: (select: (store: { trpc: unknown }) => unknown) => select({ trpc }),
}))

const { useModelCatalog, useModelCatalogState } = await import('./use-model-catalog')

function Probe() {
  const models = useModelCatalog()
  return <div>{models.codex?.map((model) => model.label).join(', ')}</div>
}

function StatusProbe({ machineId }: { machineId: ReturnType<typeof asMachineId> }) {
  const state = useModelCatalogState(machineId)
  return <div>{state.status}</div>
}

describe('useModelCatalog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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
})
