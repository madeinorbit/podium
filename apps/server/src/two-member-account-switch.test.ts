/**
 * ONE MEMBER'S QUEUED WORK IS NEVER SENT AS ANOTHER (POD-6292; docs/design/
 * multi-user-instance.md §4.5; acceptance row MU-12).
 *
 * A browser has one cookie jar per origin. After Alice signs out and Bob signs
 * in, a tab or window still bound to Alice (asleep, offline, not yet told) keeps
 * her queued commands. Its next request carries BOB's cookie. Every request a
 * principal-bound client makes therefore names the member it was opened for
 * (the member fence, `@podium/protocol` member-fence.ts), and the server refuses
 * it when the authenticated member is someone else.
 *
 * Each test below plays that stale tab: Bob's cookie, Alice's fence. Without the
 * fence the request is simply Bob's, and Alice's queued edit lands on Bob's task
 * under Bob's name.
 */

import {
  CLIENT_WIRE_VERSION,
  MEMBER_FENCE_HEADER,
  MEMBER_FENCE_PARAM,
  MEMBER_FENCE_REFUSAL,
} from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const ALICE = MEMBERS.alice.id
const BOB = MEMBERS.bob.id

/** The tRPC wire form of Alice's queued title edit on Bob's task. */
const queuedEdit = (title: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: f.tasks.bob, patch: { title } }),
})

const bobTaskTitle = async () =>
  (
    (await (await f.as('bob')).trpc.issues.get.query({ id: f.tasks.bob } as never)) as {
      title: string
    }
  ).title

/** Open `/client` with Bob's cookie and the given query; resolve with the outcome. */
const openSocket = async (query: string): Promise<'open' | number> => {
  const bob = await f.as('bob')
  const url = `ws://127.0.0.1:${f.handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1${query}`
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { cookie: bob.cookie } })
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => resolve(0))
  })
}

describe('MU-12: a client opened for Alice never acts with Bob’s cookie', () => {
  it('refuses Alice’s queued command sent with Bob’s cookie, and nothing changes', async () => {
    const before = await bobTaskTitle()
    const bob = await f.as('bob')
    const response = await bob.fetch('/trpc/issues.update', {
      ...queuedEdit('written by alice’s stale tab'),
      headers: { 'content-type': 'application/json', [MEMBER_FENCE_HEADER]: ALICE },
    })
    // Without the fence: 200, and Bob's task now carries Alice's edit as Bob's.
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: MEMBER_FENCE_REFUSAL })
    expect(await bobTaskTitle()).toBe(before)
  })

  it('control: the same command fenced for Bob is Bob’s and applies', async () => {
    const bob = await f.as('bob')
    const response = await bob.fetch('/trpc/issues.update', {
      ...queuedEdit('bob renames his own task'),
      headers: { 'content-type': 'application/json', [MEMBER_FENCE_HEADER]: BOB },
    })
    expect(response.status).toBe(200)
    expect(await bobTaskTitle()).toBe('bob renames his own task')
  })

  it('control: an unfenced request is judged exactly as before', async () => {
    const bob = await f.as('bob')
    const response = await bob.fetch('/trpc/issues.update', queuedEdit('bob, unfenced'))
    expect(response.status).toBe(200)
    expect(await bobTaskTitle()).toBe('bob, unfenced')
  })

  it('refuses the HTTP feed to a client opened for Alice', async () => {
    const bob = await f.as('bob')
    const fenced = await bob.fetch(
      `/sync/bootstrap?${MEMBER_FENCE_PARAM}=${encodeURIComponent(ALICE)}`,
    )
    expect(fenced.status).toBe(401)
    const own = await bob.fetch(`/sync/bootstrap?${MEMBER_FENCE_PARAM}=${encodeURIComponent(BOB)}`)
    expect(own.status).not.toBe(401)
  })

  it('refuses the live socket to a client opened for Alice', async () => {
    expect(await openSocket(`&${MEMBER_FENCE_PARAM}=${encodeURIComponent(ALICE)}`)).toBe(401)
    expect(await openSocket(`&${MEMBER_FENCE_PARAM}=${encodeURIComponent(BOB)}`)).toBe('open')
    expect(await openSocket('')).toBe('open')
  })
})

describe('MU-12: browsers may send the fence across origins', () => {
  // A custom header makes a cross-origin call preflight first. A preflight that
  // does not admit it would look exactly like the fence refusing every call.
  it.each([
    ['the desktop webview', 'tauri://localhost'],
    ['a loopback page such as the phone web build', 'http://127.0.0.1:8081'],
  ])('admits the header for %s', async (_name, origin) => {
    for (const path of ['/trpc/issues.update', '/sync/bootstrap']) {
      const preflight = await fetch(new URL(path, f.origin), {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': `content-type,${MEMBER_FENCE_HEADER}`,
        },
      })
      expect(preflight.status, path).toBeLessThan(300)
      expect(preflight.headers.get('access-control-allow-origin'), path).toBe(origin)
      expect(
        preflight.headers.get('access-control-allow-headers')?.toLowerCase() ?? '',
        path,
      ).toContain(MEMBER_FENCE_HEADER)
    }
  })
})
