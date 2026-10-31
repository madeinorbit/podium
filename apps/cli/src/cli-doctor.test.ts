import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetConfig, type PodiumConfig } from '@podium/runtime/config'
import { instanceServiceName, resolveInstanceId } from '@podium/runtime/instance'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type DiagnoseDeps,
  type Diagnosis,
  diagnose,
  doctorCommand,
  type LinkCheck,
  redactConfig,
  redactText,
  renderChecks,
  repairLink,
  writeDoctorReport,
} from './cli-doctor'
import { inspectSystemd, installSystemd, renderParentUnit } from './cli-systemd'
import { enableTunnel, inspectTunnel, type TunnelCliDeps } from './tunnel-cli'

const URL_A = 'https://one.trycloudflare.com'
const ID = `pdm_${'a'.repeat(43)}`
const version = { wireVersion: 1, appVersion: 'dev', installationId: ID }
const green = (): DiagnoseDeps => ({
  config: {
    mode: 'server',
    persistence: 'systemd',
    networkOption: 'cloudflare-tunnel',
    publicUrl: URL_A,
  },
  env: {},
  live: [],
  tunnel: () => ({ ok: true, detail: 'Running; enabled for reboot.' }),
  systemd: () => ({ ok: true, detail: 'Running; survives logout and reboot.' }),
  cloudflared: () => '/bin/cloudflared',
  version: async (url) => (url.endsWith('/health') ? { status: 'ok' } : version),
  control: async () => ({ connect: { enabled: true, installationId: ID, generation: 1 } }),
  locator: async () => ({
    generation: 1,
    issuedAt: '2026-10-10T00:00:00Z',
    expiresAt: null,
    endpoints: [{ url: URL_A, priority: 100 }],
  }),
})
afterEach(() => {
  process.exitCode = 0
  vi.unstubAllEnvs()
  forgetConfig()
})

describe('service chain diagnosis', () => {
  it('checks in dependency order and exposes an address only when it answers', async () => {
    const result = await diagnose(green())
    expect(result.checks.map((check) => check.link)).toEqual([
      'service',
      'server',
      'tunnel',
      'cloudflared',
      'public',
      'connect',
    ])
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.currentUrl).toBe(URL_A)
  })
  it('starts independent probes together and scopes service names to the selected instance', async () => {
    const started: string[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const deps = green()
    const running = diagnose({
      ...deps,
      env: { PODIUM_INSTANCE: 'blue' },
      systemd: async (_port, instance) => {
        started.push(instanceServiceName('parent', instance))
        await pending
        return { ok: true, detail: 'Running.' }
      },
      tunnel: async (_config, env) => {
        started.push(instanceServiceName('tunnel', resolveInstanceId(env)))
        await pending
        return { ok: true, detail: 'Running.' }
      },
      version: async (url) => {
        started.push(url)
        await pending
        return url.endsWith('/health') ? { status: 'ok' } : version
      },
      control: async (path) => {
        started.push(path)
        await pending
        return { connect: { enabled: true, installationId: ID, generation: 1 } }
      },
    })
    await Promise.resolve()
    expect(started).toEqual(
      expect.arrayContaining([
        'podium-blue.service',
        'podium-blue-tunnel.service',
        `${URL_A}/version`,
        '/v1/diagnostics',
      ]),
    )
    expect(started.filter((name) => name.startsWith('http'))).toHaveLength(3)
    release()
    expect((await running).checks.every((check) => check.ok)).toBe(true)
  })
  it('keeps a recorded URL out of status when its tunnel is down, even if a proxy answers', async () => {
    const result = await diagnose({
      ...green(),
      tunnel: () => ({ ok: false, detail: 'Tunnel is stopped.' }),
    })
    expect(result.currentUrl).toBeUndefined()
    expect(result.checks.find((check) => !check.ok)?.link).toBe('tunnel')
    expect(renderChecks(result.checks)).toContain(
      'FAILED Tunnel service: Tunnel is stopped. Run: podium doctor --fix',
    )
  })
  it('works with the server down and does not assume the control socket answers', async () => {
    const result = await diagnose({
      ...green(),
      tunnel: () => ({ ok: false, detail: 'Tunnel is stopped.' }),
      systemd: () => ({ ok: false, detail: 'Podium is stopped.' }),
      version: async () => undefined,
      control: async () => {
        throw new Error('offline')
      },
    })
    expect(result.serverHealthy).toBe(false)
    expect(result.checks[0]).toMatchObject({ link: 'service', ok: false })
    expect(result.currentUrl).toBeUndefined()
    expect(result.checks.at(-1)?.detail).toContain('server must answer')
  })
  it('rejects the wrong server and an old Connect address', async () => {
    const deps = green()
    const result = await diagnose({
      ...deps,
      version: async (url) =>
        url.startsWith(URL_A)
          ? { ...version, installationId: `pdm_${'b'.repeat(43)}` }
          : deps.version?.(url),
      locator: async () => ({
        generation: 1,
        issuedAt: 'today',
        expiresAt: null,
        endpoints: [{ url: 'https://old.example', priority: 100 }],
      }),
    })
    expect(result.checks.find((check) => check.link === 'public')).toMatchObject({
      ok: false,
      detail: 'The address answers from a different Podium.',
    })
    expect(result.checks.find((check) => check.link === 'connect')?.ok).toBe(false)
  })
  it('reports a missing binary and leaves unmanaged public addresses to setup', async () => {
    expect(
      (await diagnose({ ...green(), cloudflared: () => undefined })).checks.find(
        (check) => check.link === 'cloudflared',
      )?.ok,
    ).toBe(false)
    const result = await diagnose({
      ...green(),
      config: { mode: 'server', publicUrl: 'https://proxy.example', networkOption: 'manual' },
      version: async () => undefined,
    })
    expect(result.checks.map((check) => check.link)).not.toContain('tunnel')
    expect(result.checks.find((check) => check.link === 'public')?.fix).toBe('podium setup')
  })
  it('does not probe server-only links on a joined machine', async () => {
    const result = await diagnose({
      config: { mode: 'daemon' },
      env: {},
      live: [{ role: 'daemon', pid: 1, startedAt: 'today' }],
    })
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.ok).toBe(true)
  })
})

const failed = (link: LinkCheck['link']): LinkCheck => ({
  link,
  name: link,
  ok: false,
  detail: 'Stopped.',
  fix: 'podium doctor --fix',
})

describe('install-required service state', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fixture(instance = 'default', mode: PodiumConfig['mode'] = 'daemon') {
    const dir = mkdtempSync(join(tmpdir(), 'podium-doctor-service-'))
    dirs.push(dir)
    const port = 23456
    const unit = instanceServiceName('parent', instance)
    const path = join(dir, unit)
    const config: PodiumConfig = { mode, port, persistence: 'systemd', publicUrl: URL_A }
    const env = { PODIUM_INSTANCE: instance }
    const state = {
      active: false,
      enabled: false,
      linger: false,
      allowLinger: true,
      allowEnable: true,
      systemctl: true,
      userManager: true,
    }
    const run = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'loginctl') {
        if (!state.allowLinger) throw new Error('Linger access denied')
        state.linger = true
      } else if (args.includes('enable')) {
        if (!state.allowEnable) throw new Error('Enable access denied')
        state.enabled = true
        if (args.includes('--now')) state.active = true
      }
    })
    const systemdDeps = {
      hasSystemctl: () => state.systemctl,
      hasUserSystemd: () => state.userManager,
      unitDir: () => dir,
      unitActive: (name: string) => name === unit && state.active,
      unitEnabled: (name: string) => name === unit && state.enabled,
      lingerEnabled: () => state.linger,
      run,
    }
    const install = vi.fn((mode: PodiumConfig['mode'], port: number, instance = 'default') =>
      installSystemd(mode, port, instance, systemdDeps),
    )
    // Use setup's installer to establish the baseline, rather than inventing a healthy definition.
    expect(install(mode, port, instance)).toEqual({ ok: true })
    install.mockClear()
    run.mockClear()
    const check = () =>
      diagnose({
        ...green(),
        config,
        env,
        systemd: (port, instance) => inspectSystemd(port, instance, systemdDeps),
      })
    const restart = vi.fn(() => {
      state.active = true
    })
    const waitForHealth = vi.fn(async () => true)
    const repair = vi.fn((link: LinkCheck['link']) =>
      repairLink(link, { config, env, install, restart, waitForHealth }),
    )
    return {
      config,
      env,
      state,
      path,
      unit,
      port,
      run,
      install,
      restart,
      waitForHealth,
      check,
      repair,
    }
  }

  it.each([
    ['running but disabled', 'default', 'not enabled for reboot'],
    ['stopped', 'default', 'Podium is stopped'],
    ['stopped and disabled', 'default', 'not enabled for reboot'],
    ['missing', 'blue', 'definition is missing'],
    ['outdated', 'blue', 'definition is out of date'],
    ['linger disabled', 'default', 'stops at logout'],
  ])('detects %s read-only, then --fix restores the install contract', async (broken, instance, detail) => {
    const f = fixture(instance)
    expect((await f.check()).checks.every((check) => check.ok)).toBe(true)
    if (broken.includes('stopped')) f.state.active = false
    if (broken.includes('disabled') && broken !== 'linger disabled') f.state.enabled = false
    if (broken === 'missing') {
      rmSync(f.path)
      f.state.active = f.state.enabled = false
    }
    if (broken === 'outdated')
      writeFileSync(
        f.path,
        readFileSync(f.path, 'utf8').replace('WatchdogSec=90', 'WatchdogSec=60'),
      )
    if (broken === 'linger disabled') f.state.linger = false
    const before = broken === 'missing' ? undefined : readFileSync(f.path, 'utf8')
    const beforeState = { ...f.state }
    const lines: string[] = []
    await doctorCommand([], {
      diagnose: f.check,
      repair: f.repair,
      out: (line) => lines.push(line),
    })
    expect(lines[0]).toContain(detail)
    expect(lines).not.toContain('All links are working.')
    expect(process.exitCode).toBe(1)
    expect(f.repair).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.state).toEqual(beforeState)
    if (before !== undefined) expect(readFileSync(f.path, 'utf8')).toBe(before)
    else expect(() => readFileSync(f.path)).toThrow()

    process.exitCode = 0
    lines.length = 0
    await doctorCommand(['--fix'], {
      diagnose: f.check,
      repair: f.repair,
      out: (line) => lines.push(line),
    })
    expect(f.install).toHaveBeenCalledExactlyOnceWith('daemon', f.port, instance)
    expect(f.run).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', f.unit])
    expect(f.state).toMatchObject({ enabled: true, active: true, linger: true })
    expect(readFileSync(f.path, 'utf8')).toBe(
      renderParentUnit({ instanceId: instance, port: f.port }),
    )
    expect((await f.check()).checks.every((check) => check.ok)).toBe(true)
    expect(lines.at(-1)).toBe('All links are working.')
    expect(process.exitCode).toBe(0)
  })

  it.each([
    'server',
    'all-in-one',
    'daemon',
    'supervisor',
  ] as const)('repairs persistence for %s mode using the selected instance', async (mode) => {
    const f = fixture('blue', mode)
    f.state.enabled = false
    await doctorCommand(['--fix'], { diagnose: f.check, repair: f.repair, out: () => {} })
    expect(f.install).toHaveBeenCalledExactlyOnceWith(mode, f.port, 'blue')
    expect(f.restart).toHaveBeenCalledExactlyOnceWith(['podium-blue.service'])
    expect(f.waitForHealth).toHaveBeenCalledTimes(
      mode === 'server' || mode === 'all-in-one' ? 1 : 0,
    )
    expect((await f.check()).checks.every((check) => check.ok)).toBe(true)
  })

  it('keeps a generated development profile and operator-owned service definitions', async () => {
    const f = fixture('blue')
    const development = renderParentUnit({
      instanceId: 'blue',
      port: f.port,
      profile: 'dev',
      home: '/home/operator',
      repoRoot: '/src/podium',
    })
    writeFileSync(f.path, development.replace('WatchdogSec=90', 'WatchdogSec=60'))
    await doctorCommand(['--fix'], { diagnose: f.check, repair: f.repair, out: () => {} })
    expect(readFileSync(f.path, 'utf8')).toBe(development)

    const custom = '[Service]\nExecStart=/opt/podium parent\n[Install]\nWantedBy=default.target\n'
    writeFileSync(f.path, custom)
    f.state.enabled = false
    await doctorCommand(['--fix'], { diagnose: f.check, repair: f.repair, out: () => {} })
    expect(f.state.enabled).toBe(true)
    expect(readFileSync(f.path, 'utf8')).toBe(custom)
  })

  it.each([
    'enable',
    'linger',
    'systemctl',
    'user manager',
  ])('keeps failed %s persistence visible after --fix', async (failure) => {
    const f = fixture()
    f.state.enabled = false
    if (failure === 'enable') f.state.allowEnable = false
    if (failure === 'linger') {
      f.state.allowLinger = f.state.linger = false
    }
    if (failure === 'systemctl') f.state.systemctl = false
    if (failure === 'user manager') f.state.userManager = false
    const lines: string[] = []
    await doctorCommand(['--fix'], {
      diagnose: f.check,
      repair: f.repair,
      out: (line) => lines.push(line),
    })
    expect(lines.at(-1)).toContain('Still broken: Podium service.')
    expect(process.exitCode).toBe(1)
    if (failure === 'linger') expect(lines.join('\n')).toContain('sudo loginctl enable-linger')
    else expect(f.restart).not.toHaveBeenCalled()
    if (failure === 'systemctl' || failure === 'user manager') expect(f.run).not.toHaveBeenCalled()
    expect(f.config.persistence).toBe('systemd')
  })

  it('reports a failed health gate instead of claiming a successful repair', async () => {
    const f = fixture('blue', 'server')
    f.waitForHealth.mockResolvedValue(false)
    await expect(f.repair('server')).rejects.toThrow('The server did not answer after repair.')
  })
})

describe('setup-required tunnel service state', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    'disabled',
    'stopped',
    'missing',
    'outdated',
  ])('detects a %s tunnel read-only and repairs it through setup', async (broken) => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-doctor-tunnel-'))
    dirs.push(dir)
    const config: PodiumConfig = { ...green().config, persistence: 'detached' }
    const env = {
      PODIUM_INSTANCE: 'blue',
      PODIUM_STATE_DIR: dir,
      PODIUM_TUNNEL_BIN: '/opt/podium-tunnel',
    }
    const unit = 'podium-blue-tunnel.service'
    const path = join(dir, unit)
    const state = { active: false, enabled: false }
    const write = vi.fn((name: string, body: string) => writeFileSync(join(dir, name), body))
    const enableAndStart = vi.fn(() => {
      state.active = state.enabled = true
    })
    const deps: TunnelCliDeps = {
      config,
      env,
      findBinary: () => '/bin/cloudflared',
      fileExists: () => true,
      hasSystemctl: () => true,
      hasUserSystemd: () => true,
      unitDir: () => dir,
      writeUnit: write,
      enableAndStart,
      unitActive: () => state.active,
      unitEnabled: () => state.enabled,
    }
    expect(enableTunnel(deps)).toEqual({ ok: true, unit })
    const expected = readFileSync(path, 'utf8')
    write.mockClear()
    enableAndStart.mockClear()
    if (broken === 'disabled') state.enabled = false
    if (broken === 'stopped') state.active = false
    if (broken === 'missing') rmSync(path)
    if (broken === 'outdated')
      writeFileSync(path, expected.replace('RestartSec=5', 'RestartSec=30'))
    const before = broken === 'missing' ? undefined : readFileSync(path, 'utf8')
    const check = () =>
      diagnose({
        ...green(),
        config,
        env,
        live: [{ role: 'parent', pid: 1, startedAt: 'today' }],
        tunnel: () => inspectTunnel(deps),
      })
    const install = vi.fn((input: Parameters<typeof enableTunnel>[0]) =>
      enableTunnel({ ...deps, ...input }),
    )
    const repair = vi.fn((link: LinkCheck['link']) =>
      repairLink(link, {
        config,
        env,
        enableTunnel: install,
        cloudflared: () => '/bin/cloudflared',
      }),
    )
    await doctorCommand([], { diagnose: check, repair, out: () => {} })
    expect((await check()).checks.find((check) => !check.ok)?.link).toBe('tunnel')
    if (broken !== 'stopped') expect((await check()).currentUrl).toBe(URL_A)
    expect(repair).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(enableAndStart).not.toHaveBeenCalled()
    if (before !== undefined) expect(readFileSync(path, 'utf8')).toBe(before)
    else expect(() => readFileSync(path)).toThrow()
    process.exitCode = 0
    await doctorCommand(['--fix'], { diagnose: check, repair, out: () => {} })
    expect(repair).toHaveBeenCalledExactlyOnceWith('tunnel')
    expect(install).toHaveBeenCalledExactlyOnceWith({ config, env })
    expect(enableAndStart).toHaveBeenCalledExactlyOnceWith(unit)
    expect(readFileSync(path, 'utf8')).toBe(expected)
    expect(state).toEqual({ active: true, enabled: true })
    expect((await check()).checks.every((check) => check.ok)).toBe(true)
    expect(config.persistence).toBe('detached')
    expect(process.exitCode).toBe(0)
  })
})

describe('service ownership', () => {
  it.each([
    'systemd',
    'detached',
    undefined,
  ] as const)('leaves client mode alone with %s persistence', async (persistence) => {
    const systemd = vi.fn(() => ({ ok: false, detail: 'Should not probe services.' }))
    const install = vi.fn()
    const restartDetached = vi.fn()
    const config: PodiumConfig = { mode: 'client', persistence }
    const check = () => diagnose({ config, env: {}, live: [], systemd })
    const repair = vi.fn((link: LinkCheck['link']) =>
      repairLink(link, { config, env: {}, install, restartDetached }),
    )
    await doctorCommand(['--fix'], { diagnose: check, repair, out: () => {} })
    expect((await check()).checks).toEqual([
      expect.objectContaining({ ok: true, detail: expect.stringContaining('Client mode') }),
    ])
    expect(systemd).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
    await repair('service')
    expect(install).not.toHaveBeenCalled()
    expect(restartDetached).not.toHaveBeenCalled()
  })

  it('repairs a stopped detached backend without creating a platform service', async () => {
    const config: PodiumConfig = { mode: 'daemon', persistence: 'detached' }
    const live: NonNullable<DiagnoseDeps['live']> = []
    const systemd = vi.fn()
    const install = vi.fn()
    const restartDetached = vi.fn(async () => {
      live.push({ role: 'parent', pid: 1, startedAt: 'today' })
    })
    const check = () => diagnose({ config, env: {}, live, systemd })
    await doctorCommand(['--fix'], {
      diagnose: check,
      repair: (link) => repairLink(link, { config, env: {}, install, restartDetached }),
      out: () => {},
    })
    expect(restartDetached).toHaveBeenCalledTimes(1)
    expect(systemd).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(config.persistence).toBe('detached')
    expect((await check()).checks[0]?.ok).toBe(true)
  })

  it('leaves desktop-owned services to the desktop app even with saved systemd persistence', async () => {
    const config: PodiumConfig = { mode: 'daemon', persistence: 'systemd' }
    const env = { PODIUM_DESKTOP_SUPERVISED: '1' }
    const systemd = vi.fn()
    const install = vi.fn()
    const restartDetached = vi.fn()
    const lines: string[] = []
    await doctorCommand(['--fix'], {
      diagnose: () => diagnose({ config, env, live: [], systemd }),
      repair: (link) => repairLink(link, { config, env, install, restartDetached }),
      out: (line) => lines.push(line),
    })
    expect(systemd).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(restartDetached).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Open the Podium desktop app')
    expect(process.exitCode).toBe(1)
  })
})

describe('doctor', () => {
  it('names the first broken link and checks again after each attempted repair', async () => {
    let fixed = false
    const check = vi.fn(
      async (): Promise<Diagnosis> => ({
        serverHealthy: fixed,
        checks: fixed
          ? [{ ...failed('service'), ok: true }]
          : [failed('service'), failed('server')],
      }),
    )
    const repair = vi.fn(async () => {
      fixed = true
      return undefined
    })
    const lines: string[] = []
    await doctorCommand(['--fix'], { diagnose: check, repair, out: (line) => lines.push(line) })
    expect(lines[0]).toBe('First broken link: service. Stopped.')
    expect(repair).toHaveBeenCalledExactlyOnceWith('service')
    expect(check).toHaveBeenCalledTimes(2)
    expect(lines.at(-1)).toBe('All links are working.')
  })
  it('reports remaining failures and still writes a support report after a refused repair', async () => {
    const repair = vi.fn(async () => {
      throw new Error('No user systemd session.')
    })
    const lines: string[] = []
    await doctorCommand(['--fix', '--report'], {
      diagnose: async () => ({ serverHealthy: false, checks: [failed('service')] }),
      repair,
      report: async () => '/tmp/report.json',
      out: (line) => lines.push(line),
    })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('Still broken: service.')
    expect(lines.at(-1)).toBe('Support file: /tmp/report.json')
    expect(process.exitCode).toBe(1)
  })
  it('does not restart one managed tunnel repeatedly while its address is coming up', async () => {
    const repair = vi.fn(async () => undefined)
    await doctorCommand(['--fix'], {
      diagnose: async () => ({
        serverHealthy: true,
        checks: [failed('tunnel'), failed('cloudflared'), failed('public')],
      }),
      repair,
      out: () => {},
    })
    expect(repair).toHaveBeenCalledExactlyOnceWith('tunnel')
  })
  it('rejects unknown flags without starting checks', async () => {
    const check = vi.fn()
    await doctorCommand(['--fiz'], { diagnose: check, out: () => {} })
    expect(check).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

describe('support report redaction', () => {
  it('removes nested credentials and scrubs their appearances in logs', () => {
    const secrets = new Set<string>()
    const config = redactConfig(
      {
        mode: 'server',
        upstream: { token: 'long-token', serverUrl: 'https://box' },
        pairCode: 'pair-me',
        apiKeys: { anthropic: 'key-value' },
        nested: [{ clientSecret: 'client-value' }],
      },
      secrets,
    )
    const text = redactText(
      JSON.stringify({
        config,
        log: 'long-token pair-me key-value client-value Bearer abc.def https://user:pass@box/?api_key=other',
      }),
      secrets,
    )
    for (const secret of [
      'long-token',
      'pair-me',
      'key-value',
      'client-value',
      'abc.def',
      'user:pass',
      '=other',
    ])
      expect(text).not.toContain(secret)
    expect(config).toMatchObject({
      mode: 'server',
      pairCode: '[removed]',
      upstream: { serverUrl: 'https://box', token: '[removed]' },
    })
  })
  it('writes valid private JSON, unit status, bounded logs and versions while offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-doctor-'))
    vi.stubEnv('PODIUM_STATE_DIR', dir)
    vi.stubEnv('PODIUM_INSTANCE', 'default')
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        upstream: { token: 'top-secret-value' },
        pairCode: 'pair-value',
        mode: 'server',
      }),
    )
    const run = vi.fn(
      async (cmd: string) => `${cmd}: token="top-secret-value" pair-value Bearer another-secret`,
    )
    try {
      const path = await writeDoctorReport({ capture: run })
      const bytes = readFileSync(path, 'utf8')
      expect(() => JSON.parse(bytes)).not.toThrow()
      const report = JSON.parse(bytes)
      expect(report.unitStatus.map((value: { unit: string }) => value.unit)).toEqual([
        'podium.service',
        'podium-tunnel.service',
      ])
      expect(report.logs).toHaveLength(8)
      expect(report.journal.map((entry: { unit: string }) => entry.unit)).toEqual([
        'podium.service',
        'podium-server.service',
        'podium-daemon.service',
        'podium-tunnel.service',
      ])
      expect(report.versions.os).toBeTruthy()
      expect(statSync(path).mode & 0o777).toBe(0o600)
      for (const secret of ['top-secret-value', 'pair-value', 'another-secret'])
        expect(bytes).not.toContain(secret)
      expect(run.mock.calls.some((call) => call[0] === 'journalctl')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
