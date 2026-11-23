import { expect, test, vi } from 'vitest'
import { makeIssueClient } from './client'

test('the CLI transport prints the server HTTPS message and setup link', async () => {
  const guidance = {
    error: 'https_required',
    message:
      'This server needs HTTPS for sign-in from other computers. Open https://podium.example and connect again. Admin: run podium setup.',
    httpsUrl: 'https://podium.example',
  }
  const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Response.json(guidance, { status: 400 }),
  )
  const client = makeIssueClient('http://192.0.2.8:18787', {
    sessionToken: 'a.signed-token',
    fetchImpl,
  })
  await expect(client.issues.list.query({})).rejects.toMatchObject({
    message: `${guidance.message}\nHTTPS setup: https://github.com/madeinorbit/podium/blob/main/docs/adding-a-machine.md#https-for-sign-in`,
  })
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has('cookie')).toBe(false)
})

test.each([
  'localhost',
  '127.0.0.1',
])('CLI HTTP %s still sends the same-machine cookie', async (host) => {
  const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Response.json([{ result: { data: [] } }]),
  )
  const client = makeIssueClient(`http://${host}:18787`, {
    sessionToken: 'a.signed-token',
    fetchImpl,
  })
  await expect(client.issues.list.query({})).resolves.toEqual([])
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('cookie')).toContain(
    'a.signed-token',
  )
})
