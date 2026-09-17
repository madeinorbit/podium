import { renderHook, waitFor } from '@testing-library/react'
import { indexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { openKernelAssembly } from './kernelReplica'
import {
  resolveReplicaPrincipal,
  STORE_REFRESH_NOTICE,
  useKernelReplica,
} from './use-kernel-replica'

const ALICE = JSON.stringify(['installation-a', 'alice'])
const BOB = JSON.stringify(['installation-a', 'bob'])

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
      resolveReplicaPrincipal({
        fetchStatus: async () =>
          response({ userId: 'alice', memberId: 'alice', syncBoundaryId: 'installation-a' }),
      }),
    ).resolves.toBe(ALICE)
  })

  it('keeps a recovered account switch isolated from a retained namespace', async () => {
    const inspectNamespaces = vi.fn(() => [ALICE])
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () =>
          response({ userId: 'bob', memberId: 'bob', syncBoundaryId: 'installation-a' }),
        inspectNamespaces,
      }),
    ).resolves.toBe(BOB)
    expect(inspectNamespaces).not.toHaveBeenCalled()
  })

  it('resolves the status route against the server origin, not the page origin', async () => {
    // The desktop all-in-one webview runs on tauri://localhost, where a relative
    // /auth/status is answered by the bundled SPA, not the server.
    const fetched: unknown[][] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      fetched.push(args)
      return response({ userId: 'alice', memberId: 'alice', syncBoundaryId: 'installation-a' })
    })
    await expect(resolveReplicaPrincipal({ httpOrigin: 'http://backend.test:1234' })).resolves.toBe(
      ALICE,
    )
    expect(fetched).toEqual([['http://backend.test:1234/auth/status', { credentials: 'include' }]])
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
        inspectNamespaces: () => [ALICE],
      }),
    ).resolves.toBe(ALICE)
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
        inspectNamespaces: () => [ALICE, BOB],
      }),
    ).rejects.toThrow('principal is ambiguous')
  })

  it('never adopts a retained namespace after an authoritative auth refusal', async () => {
    const inspectNamespaces = vi.fn(() => [ALICE])
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
        principal: ALICE,
        evidence: { kind: 'multi-user', signedInAs: ALICE, identitiesEverSignedIn: [ALICE] },
        factory: factory as NonNullable<Parameters<typeof openKernelAssembly>[0]['factory']>,
      }),
    ).rejects.toThrow('IndexedDB is blocked')
  })

  it('hands the server origin to the principal resolver', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => ALICE)
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
      principal: ALICE,
      dispose,
    } as unknown as Awaited<ReturnType<typeof openKernelAssembly>>
    const openAssembly = vi.fn(async () => assembly)

    const { result, rerender, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: { kind: 'principal', principal: ALICE },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('kernel'))
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(openAssembly).toHaveBeenCalledWith(
      expect.objectContaining({ principal: ALICE, trpc: expect.anything() }),
    )
    rerender()
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('a store that was not adopted surfaces as a plain refresh notice, never as the reason code (POD-4002)', async () => {
    const trpc = {} as Trpc
    const assembly = {
      principal: ALICE,
      dispose: async () => {},
    } as unknown as Awaited<ReturnType<typeof openKernelAssembly>>
    const openAssembly = vi.fn(async (options: Parameters<typeof openKernelAssembly>[0]) => {
      options.onDegraded?.({ kind: 'store-not-adopted', reason: 'discarded-multiple-identities' })
      return assembly
    })

    const { result, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: { kind: 'principal', principal: ALICE },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal: vi.fn(async () => ALICE),
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('kernel'))
    const gate = result.current as { notice?: string }
    expect(gate.notice).toBe(STORE_REFRESH_NOTICE)
    expect(gate.notice).toBe('Refreshing your data after the upgrade — this happens once.')
    expect(gate.notice).not.toMatch(/discarded|identit/)
    unmount()
  })

  it('reopens and disposes only when the auth principal changes', async () => {
    const trpc = {} as Trpc
    const aliceDispose = vi.fn(async () => {})
    const bobDispose = vi.fn(async () => {})
    const openAssembly = vi.fn(
      async ({ principal }: Parameters<typeof openKernelAssembly>[0]) =>
        ({
          principal,
          dispose: principal === ALICE ? aliceDispose : bobDispose,
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
      { initialProps: { principal: ALICE } },
    )

    await waitFor(() =>
      expect(result.current).toEqual(
        expect.objectContaining({ status: 'kernel', principal: ALICE }),
      ),
    )
    rerender({ principal: ALICE })
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(aliceDispose).not.toHaveBeenCalled()

    rerender({ principal: BOB })
    await waitFor(() =>
      expect(result.current).toEqual(expect.objectContaining({ status: 'kernel', principal: BOB })),
    )
    expect(openAssembly).toHaveBeenCalledTimes(2)
    expect(aliceDispose).toHaveBeenCalledOnce()
    expect(bobDispose).not.toHaveBeenCalled()

    unmount()
    expect(bobDispose).toHaveBeenCalledOnce()
  })

  it('recovers a provisional first auth failure before opening the replica', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => ALICE)
    const dispose = vi.fn(async () => {})
    const assembly = {
      principal: ALICE,
      dispose,
    } as unknown as Awaited<ReturnType<typeof openKernelAssembly>>
    const openAssembly = vi.fn(async () => assembly)

    const { result, rerender, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: { kind: 'provisional-failure' },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('kernel'))
    expect(resolvePrincipal).toHaveBeenCalledOnce()
    expect(resolvePrincipal).toHaveBeenCalledWith({ httpOrigin: 'http://backend.test:1234' })
    expect(openAssembly).toHaveBeenCalledWith(
      expect.objectContaining({ principal: ALICE, trpc: expect.anything() }),
    )
    rerender()
    expect(resolvePrincipal).toHaveBeenCalledOnce()
    expect(openAssembly).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not re-probe or open after an authoritative auth refusal', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => ALICE)
    const openAssembly = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        auth: {
          kind: 'failure',
          message: 'authenticated account is unavailable',
          failure: { kind: 'auth-refused', status: 401 },
        },
        httpOrigin: 'http://backend.test:1234',
        resolvePrincipal,
        openAssembly,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current).toEqual({
      status: 'failed',
      failure: 'authenticated account is unavailable',
      cause: { kind: 'auth-refused', status: 401 },
    })
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect(openAssembly).not.toHaveBeenCalled()
    unmount()
  })

  it('stays fatal when the supported private replica cannot open', async () => {
    const trpc = {} as Trpc
    const resolvePrincipal = vi.fn(async () => ALICE)
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

it('ignores inactive legacy identities for offline tuple selection', async () => {
  await expect(
    resolveReplicaPrincipal({
      fetchStatus: async () => {
        throw new TypeError('offline')
      },
      inspectNamespaces: () => ['alice', ALICE],
    }),
  ).resolves.toBe(ALICE)
})

it('refuses a live server response missing either identity field', async () => {
  for (const body of [
    { userId: 'alice' },
    { memberId: 'alice' },
    { syncBoundaryId: 'installation-a' },
  ]) {
    await expect(
      resolveReplicaPrincipal({
        fetchStatus: async () => response(body),
        inspectNamespaces: () => [ALICE],
      }),
    ).rejects.toThrow('authenticated account is unavailable')
  }
})
