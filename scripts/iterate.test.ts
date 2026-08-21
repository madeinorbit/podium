// scripts/iterate.test.ts
//
// Iteration mode is the ONE sanctioned divergence from the update path
// (POD-2513, updater-convergence spec §7), so the parts that decide what it
// launches are pure and tested here: the port/TLS resolution, the environment
// the Vite child inherits, the argv (which must never be able to build), the
// scoped tailscale mount, and the dist fingerprint that proves an iterate
// session left the served bundle alone.

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertNoBuildArgs,
  describeDistDrift,
  distFingerprint,
  ITERATE_BACKEND_PORT,
  ITERATE_TLS_PORT,
  ITERATE_WEB_PORT,
  iterateChildEnv,
  iterateScopeUnit,
  resolveIterateConfig,
  tailnetHostFromStatus,
  tailscaleServeArgv,
  tailscaleServeOffArgv,
  tlsPortAlreadyServed,
  viteSpawnPlan,
} from './iterate'

const REPO = '/repo'
const config = (env: NodeJS.ProcessEnv = {}, argv: readonly string[] = []) =>
  resolveIterateConfig({ repoRoot: REPO, env, argv })

describe('resolveIterateConfig', () => {
  it('defaults to the iterate ports, beside the live instance rather than on it', () => {
    const resolved = config()
    expect(resolved.webPort).toBe(ITERATE_WEB_PORT)
    expect(resolved.tlsPort).toBe(ITERATE_TLS_PORT)
    expect(resolved.backendPort).toBe(ITERATE_BACKEND_PORT)
    // The whole point: iterate never binds the port the installed server serves on.
    expect(resolved.webPort).not.toBe(resolved.backendPort)
  })

  it('takes ports from the environment', () => {
    const resolved = config({
      PODIUM_ITERATE_WEB_PORT: '4100',
      PODIUM_ITERATE_TLS_PORT: '4101',
      PODIUM_ITERATE_BACKEND_PORT: '4102',
    })
    expect(resolved).toMatchObject({ webPort: 4100, tlsPort: 4101, backendPort: 4102 })
  })

  it('lets flags win over the environment', () => {
    const resolved = config({ PODIUM_ITERATE_WEB_PORT: '4100' }, ['--web-port=4200'])
    expect(resolved.webPort).toBe(4200)
  })

  it('turns TLS off by flag and by environment', () => {
    expect(config({}, ['--no-tls']).tlsPort).toBeNull()
    expect(config({ PODIUM_ITERATE_TLS: '0' }).tlsPort).toBeNull()
  })

  it('refuses a port that is not a port', () => {
    expect(() => config({ PODIUM_ITERATE_WEB_PORT: 'soon' })).toThrow(/PODIUM_ITERATE_WEB_PORT/)
    expect(() => config({}, ['--web-port=0'])).toThrow(/--web-port/)
  })

  it('refuses to bind the backend it is proxying to', () => {
    expect(() => config({}, ['--web-port=18787', '--backend-port=18787'])).toThrow(/backend/i)
  })

  it('refuses a TLS port that collides with the web or backend port', () => {
    expect(() => config({}, ['--tls-port=55566'])).toThrow(/tls/i)
    expect(() => config({}, ['--tls-port=18787'])).toThrow(/tls/i)
  })

  it('collects allowed hosts from the environment and repeated flags', () => {
    const resolved = config({ PODIUM_ALLOWED_HOSTS: 'a.example, b.example' }, [
      '--allow-host=c.example',
    ])
    expect(resolved.allowedHosts).toEqual(['a.example', 'b.example', 'c.example'])
  })

  it('refuses an unknown flag rather than silently ignoring it', () => {
    expect(() => config({}, ['--tsl-port=55565'])).toThrow(/--tsl-port/)
  })
})

describe('iterateChildEnv', () => {
  it('points the Vite proxy at the installed backend and marks the page', () => {
    const env = iterateChildEnv(config(), { PATH: '/usr/bin' })
    expect(env.PODIUM_PORT).toBe(String(ITERATE_BACKEND_PORT))
    expect(env.PODIUM_WEB_PORT).toBe(String(ITERATE_WEB_PORT))
    expect(env.PODIUM_ITERATION_MODE).toBe('1')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('publishes every allowed host, tailnet name included', () => {
    const resolved = { ...config(), allowedHosts: ['ludovico.example.ts.net', 'b.example'] }
    expect(iterateChildEnv(resolved, {}).PODIUM_ALLOWED_HOSTS).toBe(
      'ludovico.example.ts.net,b.example',
    )
  })

  it('never carries a version stamp — an iterate page is source, not a release', () => {
    const env = iterateChildEnv(config(), { PODIUM_APP_VERSION: '0.1.1' })
    expect(env.PODIUM_APP_VERSION).toBeUndefined()
  })
})

describe('viteSpawnPlan', () => {
  it('runs the web package dev server from its own directory', () => {
    const plan = viteSpawnPlan(config(), { scoped: false, unit: 'x.scope', bun: '/usr/bin/bun' })
    expect(plan.file).toBe('/usr/bin/bun')
    expect(plan.args).toEqual(['run', 'dev'])
    expect(plan.cwd).toBe(join(REPO, 'apps', 'web'))
  })

  it('wraps the same command in a batch-tier scope when systemd can', () => {
    const plan = viteSpawnPlan(config(), {
      scoped: true,
      unit: 'podium-iterate-55566.scope',
      bun: '/usr/bin/bun',
    })
    expect(plan.file).toBe('systemd-run')
    expect(plan.args).toContain('--property=CPUWeight=50')
    expect(plan.args).toContain('--unit=podium-iterate-55566.scope')
    // The command still ends the argv, after the `--` separator.
    expect(plan.args.slice(plan.args.indexOf('--') + 1)).toEqual(['/usr/bin/bun', 'run', 'dev'])
  })

  it('cannot be talked into a build — the guardrail is on the argv itself', () => {
    const plan = viteSpawnPlan(config(), { scoped: false, unit: 'x.scope', bun: 'bun' })
    expect(() => assertNoBuildArgs(plan.args)).not.toThrow()
    expect(() => assertNoBuildArgs(['run', 'build'])).toThrow(/dist/i)
    expect(() => assertNoBuildArgs(['run', 'build:dev'])).toThrow(/dist/i)
    expect(() => assertNoBuildArgs(['run', 'preview'])).toThrow(/dist/i)
  })
})

describe('iterateScopeUnit', () => {
  it('names the unit after the port, so two iterate sessions never reclaim each other', () => {
    expect(iterateScopeUnit(55566)).toBe('podium-iterate-55566.scope')
    expect(iterateScopeUnit(4100)).not.toBe(iterateScopeUnit(4200))
  })
})

describe('tailscale mount', () => {
  it('mounts only its own HTTPS port, in the background, at the Vite origin', () => {
    expect(tailscaleServeArgv(55565, 55566)).toEqual([
      'serve',
      '--bg',
      '--yes',
      '--https=55565',
      'http://127.0.0.1:55566',
    ])
  })

  it('tears down only its own port', () => {
    expect(tailscaleServeOffArgv(55565)).toEqual(['serve', '--https=55565', 'off'])
  })

  it('sees a port the live instance already serves on', () => {
    const status = { TCP: { '443': { HTTPS: true }, '55555': { HTTPS: true } } }
    expect(tlsPortAlreadyServed(status, 55555)).toBe(true)
    expect(tlsPortAlreadyServed(status, 55565)).toBe(false)
    expect(tlsPortAlreadyServed({}, 55565)).toBe(false)
  })

  it('reads the tailnet name the browser will send as Host', () => {
    expect(tailnetHostFromStatus({ Self: { DNSName: 'ludovico.example.ts.net.' } })).toBe(
      'ludovico.example.ts.net',
    )
    expect(tailnetHostFromStatus({})).toBeNull()
  })
})

describe('dist guardrail', () => {
  const seedDist = () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-dist-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'podium-build.json'), '{"appVersion":"0.1.1"}')
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    return dir
  }

  it('is stable across reads of an untouched dist', () => {
    const dir = seedDist()
    expect(distFingerprint(dir)).toBe(distFingerprint(dir))
  })

  it('is null for a checkout that has never built', () => {
    expect(distFingerprint(join(tmpdir(), 'iterate-dist-does-not-exist'))).toBeNull()
  })

  // Same length, and fast enough to land in the same millisecond — the case a
  // timestamp fingerprint could not see under Bun (see distFingerprint's note).
  it('changes when a served file changes, and says so', () => {
    const dir = seedDist()
    const before = distFingerprint(dir)
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(2)')
    const after = distFingerprint(dir)
    expect(after).not.toBe(before)
    expect(describeDistDrift(before, after)).toMatch(/dist/i)
  })

  it('does not cry wolf over a clock that moved without a byte changing', () => {
    const dir = seedDist()
    const before = distFingerprint(dir)
    utimesSync(join(dir, 'index.html'), new Date(0), new Date(0))
    expect(distFingerprint(dir)).toBe(before)
  })

  it('reports no drift when nothing moved, including for a never-built checkout', () => {
    const dir = seedDist()
    const fingerprint = distFingerprint(dir)
    expect(describeDistDrift(fingerprint, fingerprint)).toBeNull()
    expect(describeDistDrift(null, null)).toBeNull()
  })

  it('reports a dist that appeared during the session', () => {
    const dir = seedDist()
    expect(describeDistDrift(null, distFingerprint(dir))).toMatch(/dist/i)
  })
})
