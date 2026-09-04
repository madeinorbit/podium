import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ServedWebIdentity } from '../../web-bundle-stamp'
import {
  createDevWebBuilder,
  DEV_WEB_BUILD_STEPS,
  type DevWebBuildStamp,
  phoneDistBehindHead,
  readDevPhoneDist,
  webDistMatchesHead,
} from './dev-web-build'

function builder(opts: {
  stamps: (DevWebBuildStamp | null)[]
  /** Defaults to an installation that never exported one, which is not stale. */
  phones?: ServedWebIdentity[]
  runStep?: (step: { role: string }, appVersion?: string) => Promise<void>
}) {
  const stamps = [...opts.stamps]
  let reads = 0
  const readStamp = () => {
    reads++
    return stamps.length > 1 ? (stamps.shift() ?? null) : (stamps[0] ?? null)
  }
  const phones = [...(opts.phones ?? [{ present: false }])]
  const readPhone = () =>
    (phones.length > 1 ? phones.shift() : phones[0]) ?? { present: false as const }
  const runStep = opts.runStep ?? (() => Promise.resolve())
  return {
    web: createDevWebBuilder({
      root: '/repo',
      instanceId: 'default',
      headSha: () => 'aaaaaaa',
      readStamp,
      readPhone,
      runStep,
    }),
    reads: () => reads,
  }
}

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

describe('development web build', () => {
  it('runs the one production build script of each client', () => {
    // POD-3053: `build` is the single recipe per client and a Turbo task, so a dest
    // rebuild produces exactly the bytes a release packages — including the landing
    // size ratchet, which no caller routes around any more.
    const web = DEV_WEB_BUILD_STEPS.find((step) => step.role === 'dev-web-build')
    expect(web?.args).toEqual(['run', '--filter', '@podium/web', 'build'])
    const mobile = DEV_WEB_BUILD_STEPS.find((step) => step.role === 'dev-mobile-build')
    expect(mobile?.args).toEqual(['run', '--filter', '@podium/mobile', 'build'])
  })

  it('recognises a dist built from this commit', () => {
    expect(webDistMatchesHead({ sourceSha: 'aaaaaaa' }, 'aaaaaaa')).toBe(true)
    expect(webDistMatchesHead({ sourceSha: 'bbbbbbb' }, 'aaaaaaa')).toBe(false)
    expect(webDistMatchesHead({}, 'aaaaaaa')).toBe(false)
    expect(webDistMatchesHead(null, 'aaaaaaa')).toBe(false)
  })

  it('recognises a phone export left on another commit', () => {
    expect(phoneDistBehindHead({ present: true, digest: 'bbbbbbb' }, 'aaaaaaa')).toBe(true)
    expect(phoneDistBehindHead({ present: true, digest: 'aaaaaaa' }, 'aaaaaaa')).toBe(false)
    // On disk and naming no commit is the artefact the stamp exists to replace.
    expect(phoneDistBehindHead({ present: true }, 'aaaaaaa')).toBe(true)
    // Never exported here: nothing to rebuild, so never a reason to build.
    expect(phoneDistBehindHead({ present: false }, 'aaaaaaa')).toBe(false)
  })

  it('costs nothing when the dist is already at HEAD', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { web } = builder({ stamps: [{ sourceSha: 'aaaaaaa' }], runStep: run })
    await web.ensure('aaaaaaa')
    // `/version` asks on every read, so the common case must not spawn anything.
    expect(run).not.toHaveBeenCalled()
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('rebuilds and stamps both clients with the approved release version', async () => {
    const versions: Array<string | undefined> = []
    const { web } = builder({
      stamps: [
        { sourceSha: 'aaaaaaa', appVersion: 'old' },
        { sourceSha: 'aaaaaaa', appVersion: '0.1.0-dev.1+aaaaaaa' },
      ],
      phones: [
        { present: true, digest: 'aaaaaaa', appVersion: 'old' },
        {
          present: true,
          digest: 'aaaaaaa',
          appVersion: '0.1.0-dev.1+aaaaaaa',
        },
      ],
      runStep: (_step, appVersion) => {
        versions.push(appVersion)
        return Promise.resolve()
      },
    })

    await web.ensure('aaaaaaa', '0.1.0-dev.1+aaaaaaa')
    expect(versions).toEqual(['0.1.0-dev.1+aaaaaaa', '0.1.0-dev.1+aaaaaaa'])
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

  it('rebuilds for a stale phone export while the desktop dist is at HEAD', async () => {
    // The bug this test exists for (POD-1989): Update offered a rebuild for a
    // phone left on last week's export, and the rebuild returned at once
    // because the DESKTOP half was current — so nothing was exported and the
    // page waited out its own deadline for a build that never started.
    const roles: string[] = []
    const { web } = builder({
      stamps: [{ sourceSha: 'aaaaaaa' }],
      phones: [
        { present: true, digest: 'bbbbbbb' },
        { present: true, digest: 'aaaaaaa' },
      ],
      runStep: (step) => {
        roles.push(step.role)
        return Promise.resolve()
      },
    })
    await web.ensure('aaaaaaa')
    expect(roles).toEqual(DEV_WEB_BUILD_STEPS.map((step) => step.role))
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('leaves an installation that never exported a phone website alone', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { web } = builder({
      stamps: [{ sourceSha: 'aaaaaaa' }],
      phones: [{ present: false }],
      runStep: run,
    })
    await web.ensure('aaaaaaa')
    expect(run).not.toHaveBeenCalled()
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('fails when the finished build left the phone export behind', async () => {
    const { web } = builder({
      stamps: [{ sourceSha: 'aaaaaaa' }],
      phones: [{ present: true, digest: 'bbbbbbb' }],
    })
    await expect(web.ensure('aaaaaaa')).rejects.toThrow(
      /apps\/mobile\/dist is not stamped at aaaaaaa/,
    )
    expect(web.state()).toMatchObject({ state: 'failed', headSha: 'aaaaaaa' })
  })

  it('runs the phone export even when the desktop step failed', async () => {
    // THE WEDGE THIS PINS. The two steps build two INDEPENDENT dists. When the
    // desktop build tripped its SIZE budget it still produced a correct, stamped
    // dist — but stopping there meant the phone export never ran, so the website
    // stayed "not this commit", every poll refused, and no update could publish.
    const roles: string[] = []
    const { web } = builder({
      stamps: [{ sourceSha: 'aaaaaaa' }],
      phones: [
        { present: true, digest: 'bbbbbbb' },
        { present: true, digest: 'aaaaaaa' },
      ],
      runStep: (step) => {
        roles.push(step.role)
        return step.role === 'dev-web-build'
          ? Promise.reject(new Error('bun exited with status 1'))
          : Promise.resolve()
      },
    })

    await web.ensure('aaaaaaa')
    expect(roles).toEqual(DEV_WEB_BUILD_STEPS.map((step) => step.role))
    // The dists say this IS the website for the commit, so it is — whatever the
    // desktop step's exit status said about its size.
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })

  it('still fails, naming the step, when a failure left the website wrong', async () => {
    const { web } = builder({
      stamps: [{ sourceSha: 'old' }, { sourceSha: 'old' }],
      phones: [{ present: true, digest: 'aaaaaaa' }],
      runStep: (step) =>
        step.role === 'dev-web-build'
          ? Promise.reject(new Error('vite blew up'))
          : Promise.resolve(),
    })

    await expect(web.ensure('aaaaaaa')).rejects.toThrow(
      /apps\/web\/dist is not stamped at aaaaaaa.*Steps that failed.*vite blew up/s,
    )
  })

  it('reads the phone export where the export step actually writes it', () => {
    // The seam the unit tests above stub. `bun run --filter @podium/mobile
    // build` writes `apps/mobile/dist/{index.html,podium-build.json}`
    // relative to the source root, and a reader pointed one directory off
    // would report "absent" — which reads as NOT behind, so the defect would
    // come back silently and this file's other tests would still pass.
    const root = mkdtempSync(join(tmpdir(), 'podium-dev-web-'))
    temps.push(root)
    expect(readDevPhoneDist(root)).toEqual({ present: false })

    const dist = join(root, 'apps', 'mobile', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
    // Exactly the stamp a real `expo export -p web` left, per the POD-1980
    // verification note.
    expect(readDevPhoneDist(root)).toEqual({ present: true })
    writeFileSync(
      join(dist, 'podium-build.json'),
      JSON.stringify({
        wireSchemaDigest: 'ba27fe60c4bc59e6',
        appVersion: 'dev+2eed672',
        sourceSha: '2eed672',
      }),
    )
    expect(readDevPhoneDist(root)).toEqual({
      present: true,
      appVersion: 'dev+2eed672',
      digest: '2eed672',
    })
    expect(phoneDistBehindHead(readDevPhoneDist(root), '2eed672')).toBe(false)
    expect(phoneDistBehindHead(readDevPhoneDist(root), 'aaaaaaa')).toBe(true)
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
    // The reason names BOTH what came out wrong and which step failed — the
    // second without the first would send an operator to the vite log for a
    // build whose real problem might be that HEAD moved underneath it.
    const failed = web.state()
    expect(failed.state).toBe('failed')
    expect(failed.state === 'failed' && failed.reason).toContain('vite blew up')
    expect(failed.state === 'failed' && failed.reason).toContain('not stamped at aaaaaaa')
    await web.ensure('aaaaaaa')
    expect(web.state()).toEqual({ state: 'ready', headSha: 'aaaaaaa' })
  })
})
