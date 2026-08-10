import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { indexedDB } from 'fake-indexeddb'
import type { Trpc } from '@/app/trpc'
import { openKernelAssembly } from './kernelReplica'
import { resolveReplicaPrincipal, useKernelReplica } from './use-kernel-replica'

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('offline replica principal resolution', () => {
  it('uses the authenticated server principal when reachable', async () => {
    await expect(
      resolveReplicaPrincipal({ fetchStatus: async () => response({ userId: 'alice' }) }),
    ).resolves.toBe('alice')
  })

  it('uses exactly one existing namespaced principal after a network failure', async () => {
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () => {
          throw new TypeError('offline')
        },
        inspectNamespaces: () => ['alice'],
      }),
    ).resolves.toBe('alice')
  })

  it('fails closed when no namespace or multiple namespaces could own the slice', async () => {
    const offline = async (): Promise<Response> => {
      throw new TypeError('offline')
    }
    await expect(
      resolveReplicaPrincipal({ fetchStatus: offline, inspectNamespaces: () => [] }),
    ).rejects.toThrow('no authenticated principal namespace')
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: offline,
        inspectNamespaces: () => ['alice', 'bob'],
      }),
    ).rejects.toThrow('principal is ambiguous')
  })

  it('never adopts a retained namespace after an authoritative auth refusal', async () => {
    const inspectNamespaces = vi.fn(() => ['alice'])
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () => response({ userId: null }, 401),
        inspectNamespaces,
      }),
    ).rejects.toThrow('authenticated account is unavailable')
    expect(inspectNamespaces).not.toHaveBeenCalled()
  })
})

describe('private replica boot failure', () => {
  it('rejects an unavailable IndexedDB store at the composition root', async () => {
    const factory = {
      open: () => {
        throw new DOMException('IndexedDB is blocked', 'SecurityError')
      },
      deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB),
    }

    await expect(
      openKernelAssembly({
        trpc: {} as Trpc,
        principal: 'alice',
        evidence: { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['alice'] },
        factory: factory as NonNullable<Parameters<typeof openKernelAssembly>[0]['factory']>,
      }),
    ).rejects.toThrow('IndexedDB is blocked')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stays fatal when the supported private replica cannot open', async () => {
    const resolvePrincipal = vi.fn(async () => 'alice')
    const openAssembly = vi.fn(async () => {
      throw new DOMException('IndexedDB is blocked', 'SecurityError')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook(() =>
      useKernelReplica({ trpc: {} as Trpc, resolvePrincipal, openAssembly }),
    )

    await waitFor(() => {
      expect(result.current).toEqual({
        status: 'failed',
        failure: 'IndexedDB is blocked',
      })
    })
    expect(globalThis.__podiumReplicaPath).toBeUndefined()
  })
})
