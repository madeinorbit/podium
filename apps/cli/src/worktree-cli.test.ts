import { describe, expect, it } from 'vitest'
import { runWorktreeCli } from './worktree-cli'

const okFetch = (
  calls: Array<{ url: string; body: unknown }>,
  result: unknown = { worktree: '/repo' },
) =>
  (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }) as typeof fetch

describe('runWorktreeCli', () => {
  it('POSTs session.setWorktree with the given absolute path and prints the resolved root', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const out = await runWorktreeCli(['/repo/sub'], {
      relayEndpoint: 'http://127.0.0.1:1/issue/s1',
      cwd: '/elsewhere',
      fetchImpl: okFetch(calls),
    })
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:1/issue/s1',
        body: { router: 'session', proc: 'setWorktree', input: { path: '/repo/sub' } },
      },
    ])
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('/repo')
  })

  it('defaults the path to the process cwd and resolves relative paths against it', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const opts = {
      relayEndpoint: 'http://127.0.0.1:1/issue/s1',
      cwd: '/work/tree',
      fetchImpl: okFetch(calls),
    }
    await runWorktreeCli([], opts)
    await runWorktreeCli(['../other'], opts)
    expect(calls.map((c) => (c.body as { input: { path: string } }).input.path)).toEqual([
      '/work/tree',
      '/work/other',
    ])
  })

  it('fails with guidance when PODIUM_ISSUE_RELAY is not set', async () => {
    const out = await runWorktreeCli([], { cwd: '/x' })
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('PODIUM_ISSUE_RELAY')
  })

  it('surfaces a daemon rejection as a failure', async () => {
    const out = await runWorktreeCli(['/nope'], {
      relayEndpoint: 'http://127.0.0.1:1/issue/s1',
      cwd: '/x',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, error: 'no such directory: /nope' }), {
          status: 200,
        })) as typeof fetch,
    })
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('no such directory')
  })
})
