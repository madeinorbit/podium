import { renderHook, waitFor } from '@testing-library/react'
import { indexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { openKernelAssembly } from './kernelReplica'
import { resolveReplicaPrincipal, useKernelReplica } from './use-kernel-replica'

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const replicaPathDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__podiumReplicaPath')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (replicaPathDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, '__podiumReplicaPath')
  } else {
    Object.defineProperty(globalThis, '__podiumReplicaPath', replicaPathDescriptor)
  }
})

describe('offline replica principal resolution', () => {
  it('uses the authenticated server principal when reachable', async () => {
    await expect(
      resolveReplicaPrincipal({ fetchStatus: async () => response({ userId: 'alice' }) }),
    ).resolves.toBe('alice')
  })

  it('keeps a recovered account switch isolated from a retained namespace', async () => {
    const inspectNamespaces = vi.fn(() => ['alice'])
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () => response({ userId: 'bob' }),
        inspectNamespaces,
      }),
    ).resolves.toBe('bob')
    expect(inspectNamespaces).not.toHaveBeenCalled()
  })

  it('resolves the status route against the server origin, not the page origin', async () => {
    // The desktop all-in-one webview runs on tauri://localhost, where a relative
    // /auth/status is answered by the bundled SPA, not the server.
    const fetched: unknown[][] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      fetched.push(args)
      return response({ userId: 'alice' })
    })
    await expect(resolveReplicaPrincipal({ httpOrigin: 'http://backend.test:1234' })).resolves.toBe(
      'alice',
    )
    expect(fetched).toEqual([
      ['http://backend.test:1234/auth/status', { credentials: 'include' }],
    ])
  })

  it('treats an HTML 200 answer as an unavailable account, not a parse crash', async () => {
    // A backend (or SPA fallback) serving index.html for /auth/status must fail
    // closed with the gate's own message, not WebKit's bare SyntaxError.
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () =>
          new Response('<!doctype html><html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }),
    ).rejects.toThrow('authenticated account is unavailable')
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

  it('fails closed on a fresh offline browser with no retained account', async () => {
    const offline = async (): Promise<Response> => {
      throw new TypeError('offline')
    }
    await expect(
      resolveReplicaPrincipal({ fetchStatus: offline, inspectNamespaces: () => [] }),
    ).rejects.toThrow('no authenticated principal namespace')
  })

  it('fails closed when multiple retained accounts could own the offline slice', async () => {
    const offline = async (): Promise<Response> => {
      throw new TypeError('offline')
    }
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

  it('hands the server origin to the principal resolver', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => 'alice')
    const openAssembly = vi.fn(async () => {
      throw new DOMException('IndexedDB is blocked', 'SecurityError')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(resolvePrincipal).toHaveBeenCalledWith({ httpOrigin: 'http://backend.test:1234' })
    unmount()
  })

  it('opens from the auth bootstrap without resolving the principal again', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => 'wrong-principal')
    const dispose = vi.fn(async () => {})
    const assembly = {
      principal: 'alice',
      dispose,
    } as unknown as Awaited<ReturnType<typeof openKernelAssembly>>
    const openAssembly = vi.fn(async () => assembly)

    const { result, rerender, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: { kind: 'principal', principal: 'alice' },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('kernel'))
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(openAssembly).toHaveBeenCalledWith(
      expect.objectContaining({ principal: 'alice', trpc: expect.anything() }),
    )
    rerender()
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reopens and disposes only when the auth principal changes', async () => {
    const trpc = {} as Trpc
    const aliceDispose = vi.fn(async () => {})
    const bobDispose = vi.fn(async () => {})
    const openAssembly = vi.fn(
      async ({ principal }: Parameters<typeof openKernelAssembly>[0]) =>
        ({
          principal,
          dispose: principal === 'alice' ? aliceDispose : bobDispose,
        }) as unknown as Awaited<ReturnType<typeof openKernelAssembly>>,
    )

    const { result, rerender, unmount } = renderHook(
      ({ principal }: { principal: string }) =>
        useKernelReplica({
          trpc,
          auth: { kind: 'principal', principal },
          httpOrigin: 'http://backend.test:1234',
          openAssembly,
        }),
      { initialProps: { principal: 'alice' } },
    )

    await waitFor(() =>
      expect(result.current).toEqual(
        expect.objectContaining({ status: 'kernel', principal: 'alice' }),
      ),
    )
    rerender({ principal: 'alice' })
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(aliceDispose).not.toHaveBeenCalled()

    rerender({ principal: 'bob' })
    await waitFor(() =>
      expect(result.current).toEqual(
        expect.objectContaining({ status: 'kernel', principal: 'bob' }),
      ),
    )
    expect(openAssembly).toHaveBeenCalledTimes(2)
    expect(aliceDispose).toHaveBeenCalledOnce()
    expect(bobDispose).not.toHaveBeenCalled()

    unmount()
    expect(bobDispose).toHaveBeenCalledOnce()
  })

  it('recovers a failed first auth request before opening the replica', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => 'alice')
    const dispose = vi.fn(async () => {})
    const assembly = {
      principal: 'alice',
      dispose,
    } as unknown as Awaited<ReturnType<typeof openKernelAssembly>>
    const openAssembly = vi.fn(async () => assembly)

    const { result, rerender, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: { kind: 'unreachable' },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('kernel'))
    expect(resolvePrincipal).toHaveBeenCalledOnce()
    expect(resolvePrincipal).toHaveBeenCalledWith({ httpOrigin: 'http://backend.test:1234' })
    expect(openAssembly).toHaveBeenCalledWith(
      expect.objectContaining({ principal: 'alice', trpc: expect.anything() }),
    )
    rerender()
    expect(resolvePrincipal).toHaveBeenCalledOnce()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('stays fatal when the supported private replica cannot open', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => 'alice')
    const openAssembly = vi.fn(async () => {
      throw new DOMException('IndexedDB is blocked', 'SecurityError')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result, unmount } = renderHook(() =>
      useKernelReplica({ trpc, httpOrigin: '', resolvePrincipal, openAssembly }),
    )

    await waitFor(() => {
      expect(result.current).toEqual({
        status: 'failed',
        failure: 'IndexedDB is blocked',
        // The principal resolved, so the fault is the browser's own store and
        // not anything upstream of it — which is a different screen (POD-1304).
        cause: { kind: 'replica-blocked' },
      })
    })
    expect(globalThis.__podiumReplicaPath).toBeUndefined()
    unmount()
  })
})
