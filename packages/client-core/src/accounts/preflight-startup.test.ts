import { CLIENT_WIRE_VERSION, MIN_CLIENT_WIRE_VERSION } from '@podium/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { preflightServer } from './pairing'

afterEach(() => vi.unstubAllGlobals())

const version = () =>
  new Response(
    JSON.stringify({
      wireVersion: CLIENT_WIRE_VERSION,
      minSupportedVersion: MIN_CLIENT_WIRE_VERSION,
      instanceId: 'instance',
      workspaceId: 'workspace',
    }),
  )

it('starts both public probes before either responds and waits for both validations', async () => {
  let releaseVersion = (_response: Response) => {}
  let releaseAuth = (_response: Response) => {}
  const fetch = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseVersion = resolve
      }),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseAuth = resolve
      }),
    )
  vi.stubGlobal('fetch', fetch)
  const done = vi.fn()
  const pending = preflightServer('https://podium.example', 'workspace').then(done)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, init] of fetch.mock.calls) {
    expect(init.credentials).toBe('omit')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    expect(new Headers(init.headers).get('Podium-Workspace-Id')).toBe('workspace')
  }
  releaseAuth(new Response(JSON.stringify({ needsAuth: true, authed: false })))
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  releaseVersion(version())
  await pending
  expect(done).toHaveBeenCalledWith(
    expect.objectContaining({ ok: true, mode: 'protected', instanceId: 'instance' }),
  )
})

it('keeps identity refusal authoritative even when the parallel auth probe fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(version())
      .mockRejectedValueOnce(new Error('network unavailable')),
  )
  expect(await preflightServer('https://podium.example', 'other-workspace')).toMatchObject({
    ok: false,
    kind: 'workspace-mismatch',
  })
})

it('reports an auth network failure after a valid version without opening the profile', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(version())
      .mockRejectedValueOnce(new Error('network unavailable')),
  )
  expect(await preflightServer('https://podium.example', 'workspace')).toMatchObject({
    ok: false,
    kind: 'unreachable',
  })
})
