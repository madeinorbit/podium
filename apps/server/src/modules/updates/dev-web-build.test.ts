import { describe, expect, it, vi } from 'vitest'
import {
  createDevWebBuilder,
  DEV_WEB_BUILD_STEPS,
  type DevWebBuildStamp,
  webDistMatchesHead,
} from './dev-web-build'

function builder(opts: {
  stamps: (DevWebBuildStamp | null)[]
  runStep?: (step: { role: string }) => Promise<void>
}) {
  const stamps = [...opts.stamps]
  let reads = 0
  const readStamp = () => {
    reads++
    return stamps.length > 1 ? (stamps.shift() ?? null) : (stamps[0] ?? null)
  }
  const runStep = opts.runStep ?? (() => Promise.resolve())
  return {
    web: createDevWebBuilder({
      root: '/repo',
      instanceId: 'default',
      headSha: () => 'aaaaaaa',
      readStamp,
      runStep,
    }),
    reads: () => reads,
  }
}

describe('development web build', () => {
  it('recognises a dist built from this commit', () => {
    expect(webDistMatchesHead({ sourceSha: 'aaaaaaa' }, 'aaaaaaa')).toBe(true)
    expect(webDistMatchesHead({ sourceSha: 'bbbbbbb' }, 'aaaaaaa')).toBe(false)
    expect(webDistMatchesHead({}, 'aaaaaaa')).toBe(false)
    expect(webDistMatchesHead(null, 'aaaaaaa')).toBe(false)
  })

  it('costs nothing when the dist is already at HEAD', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { web } = builder({ stamps: [{ sourceSha: 'aaaaaaa' }], runStep: run })
    await web.ensure('aaaaaaa')
    // `/version` asks on every read, so the common case must not spawn anything.
    expect(run).not.toHaveBeenCalled()
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('runs the web build then the mobile build when the dist is stale', async () => {
    const roles: string[] = []
    const { web } = builder({
      stamps: [{ sourceSha: 'old' }, { sourceSha: 'aaaaaaa' }],
      runStep: (step) => {
        roles.push(step.role)
        return Promise.resolve()
      },
    })
    await web.ensure('aaaaaaa')
    expect(roles).toEqual(DEV_WEB_BUILD_STEPS.map((step) => step.role))
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('shares one build between concurrent callers', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { web } = builder({
      stamps: [{ sourceSha: 'old' }, { sourceSha: 'old' }, { sourceSha: 'aaaaaaa' }],
      runStep: run,
    })
    const both = Promise.all([web.ensure('aaaaaaa'), web.ensure('aaaaaaa')])
    await both
    expect(run).toHaveBeenCalledTimes(DEV_WEB_BUILD_STEPS.length)
  })

  it('reports the transient unit names while building', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const { web } = builder({
      stamps: [{ sourceSha: 'old' }, { sourceSha: 'aaaaaaa' }],
      runStep: (step) => (step.role === 'dev-web-build' ? pending : Promise.resolve()),
    })
    const done = web.ensure('aaaaaaa')
    // `RemainAfterExit=yes` used to make this answerable with `systemctl status`;
    // naming the live units keeps it answerable that way too.
    expect(web.state()).toEqual({
      state: 'building',
      headSha: 'aaaaaaa',
      units: ['podium-dev-web-build.scope', 'podium-dev-mobile-build.scope'],
    })
    release()
    await done
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('fails when the finished build did not stamp this commit', async () => {
    // HEAD moving mid-build would otherwise pass here and be refused later,
    // deep inside the compile, having already paid for it.
    const { web } = builder({ stamps: [{ sourceSha: 'old' }, { sourceSha: 'moved!!' }] })
    await expect(web.ensure('aaaaaaa')).rejects.toThrow(/not stamped at aaaaaaa/)
    expect(web.state()).toMatchObject({ state: 'failed', headSha: 'aaaaaaa' })
  })

  it('surfaces a failing step and lets the next request retry', async () => {
    let attempt = 0
    const { web } = builder({
      stamps: [{ sourceSha: 'old' }, { sourceSha: 'old' }, { sourceSha: 'aaaaaaa' }],
      runStep: () => {
        attempt++
        return attempt === 1 ? Promise.reject(new Error('vite blew up')) : Promise.resolve()
      },
    })
    await expect(web.ensure('aaaaaaa')).rejects.toThrow('vite blew up')
    expect(web.state()).toMatchObject({ state: 'failed', reason: 'vite blew up' })
    await web.ensure('aaaaaaa')
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })
})
