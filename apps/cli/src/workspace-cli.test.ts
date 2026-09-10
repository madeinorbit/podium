import { describe, expect, it } from 'vitest'
import { runWorkspaceCli } from './workspace-cli'

/**
 * `podium workspace` — the read-only peek at another machine's worktree.
 *
 * POD-3836: `fetch` picked the first bare token as the ref and ignored every
 * flag, so `podium workspace fetch #12 --branch main` fetched the default and
 * said nothing about the flag it dropped.
 */
const relayEndpoint = 'http://127.0.0.1:1/issue/s1'

const okFetch = (result: unknown) =>
  (async () => new Response(JSON.stringify({ ok: true, result }), { status: 200 })) as typeof fetch

describe('runWorkspaceCli', () => {
  it('refuses a flag no workspace command declares', async () => {
    const out = await runWorkspaceCli(['fetch', '#12', '--branch', 'main'], {
      relayEndpoint,
      fetchImpl: okFetch({}),
    })
    expect(out.exitCode).toBe(1)
    expect(out.text).toMatch(/unknown flag --branch/)
  })

  it('refuses a flag on clean too', async () => {
    const out = await runWorkspaceCli(['clean', '--all'], {
      relayEndpoint,
      fetchImpl: okFetch({ removed: [] }),
    })
    expect(out.exitCode).toBe(1)
    expect(out.text).toMatch(/unknown flag --all/)
  })

  it('still fetches by ref', async () => {
    const out = await runWorkspaceCli(['fetch', '#12'], {
      relayEndpoint,
      fetchImpl: okFetch({
        sourceMachine: 'box',
        branch: 'issue/12',
        headSha: 'abcdef0123456789',
        dirty: false,
        path: '/peek/12',
      }),
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('/peek/12')
  })
})
