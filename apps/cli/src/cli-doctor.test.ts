import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetConfig } from '@podium/runtime/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnose, doctorCommand, redactConfig, redactText, renderChecks, writeDoctorReport, type DiagnoseDeps, type Diagnosis, type LinkCheck } from './cli-doctor'

const URL_A = 'https://one.trycloudflare.com'
const ID = `pdm_${'a'.repeat(43)}`
const version = { wireVersion: 1, appVersion: 'dev', installationId: ID }
const green = (): DiagnoseDeps => ({
  config: { mode: 'server', persistence: 'systemd', networkOption: 'cloudflare-tunnel', publicUrl: URL_A },
  env: {}, live: [], unit: async () => true, cloudflared: () => '/bin/cloudflared',
  version: async (url) => url.endsWith('/health') ? { status: 'ok' } : version,
  control: async () => ({ connect: { enabled: true, installationId: ID, generation: 1 } }),
  locator: async () => ({ generation: 1, issuedAt: '2026-10-10T00:00:00Z', expiresAt: null, endpoints: [{ url: URL_A, priority: 100 }] }),
})
afterEach(() => { process.exitCode = 0; vi.unstubAllEnvs(); forgetConfig() })

describe('service chain diagnosis', () => {
  it('checks in dependency order and exposes an address only when it answers', async () => {
    const result = await diagnose(green())
    expect(result.checks.map((check) => check.link)).toEqual(['service', 'server', 'tunnel', 'cloudflared', 'public', 'connect'])
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.currentUrl).toBe(URL_A)
  })
  it('starts independent probes together and scopes service names to the selected instance', async () => {
    const started: string[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const deps = green()
    const running = diagnose({ ...deps, env: { PODIUM_INSTANCE: 'blue' }, unit: async (name) => { started.push(name); await pending; return true }, version: async (url) => { started.push(url); await pending; return url.endsWith('/health') ? { status: 'ok' } : version }, control: async (path) => { started.push(path); await pending; return deps.control!(path) } })
    expect(started).toEqual(expect.arrayContaining(['podium-blue.service', 'podium-blue-tunnel.service', `${URL_A}/version`, '/v1/diagnostics']))
    expect(started.filter((name) => name.startsWith('http'))).toHaveLength(3)
    release()
    expect((await running).checks.every((check) => check.ok)).toBe(true)
  })
  it('keeps a recorded URL out of status when its tunnel is down, even if a proxy answers', async () => {
    const result = await diagnose({ ...green(), unit: async (unit) => !unit.includes('tunnel') })
    expect(result.currentUrl).toBeUndefined()
    expect(result.checks.find((check) => !check.ok)?.link).toBe('tunnel')
    expect(renderChecks(result.checks)).toContain('FAILED Tunnel service: The tunnel is stopped. Run: podium doctor --fix')
  })
  it('works with the server down and does not assume the control socket answers', async () => {
    const result = await diagnose({ ...green(), unit: async () => false, version: async () => undefined, control: async () => { throw new Error('offline') } })
    expect(result.serverHealthy).toBe(false)
    expect(result.checks[0]).toMatchObject({ link: 'service', ok: false })
    expect(result.currentUrl).toBeUndefined()
    expect(result.checks.at(-1)?.detail).toContain('server must answer')
  })
  it('rejects the wrong server and an old Connect address', async () => {
    const deps = green()
    const result = await diagnose({ ...deps, version: async (url) => url.startsWith(URL_A) ? { ...version, installationId: `pdm_${'b'.repeat(43)}` } : deps.version!(url), locator: async () => ({ generation: 1, issuedAt: 'today', expiresAt: null, endpoints: [{ url: 'https://old.example', priority: 100 }] }) })
    expect(result.checks.find((check) => check.link === 'public')).toMatchObject({ ok: false, detail: 'The address answers from a different Podium.' })
    expect(result.checks.find((check) => check.link === 'connect')?.ok).toBe(false)
  })
  it('reports a missing binary and leaves unmanaged public addresses to setup', async () => {
    expect((await diagnose({ ...green(), cloudflared: () => undefined })).checks.find((check) => check.link === 'cloudflared')?.ok).toBe(false)
    const result = await diagnose({ ...green(), config: { mode: 'server', publicUrl: 'https://proxy.example', networkOption: 'manual' }, version: async () => undefined })
    expect(result.checks.map((check) => check.link)).not.toContain('tunnel')
    expect(result.checks.find((check) => check.link === 'public')?.fix).toBe('podium setup')
  })
  it('does not probe server-only links on a joined machine', async () => {
    const result = await diagnose({ config: { mode: 'daemon' }, env: {}, live: [{ role: 'daemon', pid: 1, startedAt: 'today' }] })
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.ok).toBe(true)
  })
})

const failed = (link: LinkCheck['link']): LinkCheck => ({ link, name: link, ok: false, detail: 'Stopped.', fix: 'podium doctor --fix' })
describe('doctor', () => {
  it('names the first broken link and checks again after each attempted repair', async () => {
    let fixed = false
    const check = vi.fn(async (): Promise<Diagnosis> => ({ serverHealthy: fixed, checks: fixed ? [{ ...failed('service'), ok: true }] : [failed('service'), failed('server')] }))
    const repair = vi.fn(async () => { fixed = true; return undefined })
    const lines: string[] = []
    await doctorCommand(['--fix'], { diagnose: check, repair, out: (line) => lines.push(line) })
    expect(lines[0]).toBe('First broken link: service. Stopped.')
    expect(repair).toHaveBeenCalledExactlyOnceWith('service')
    expect(check).toHaveBeenCalledTimes(2)
    expect(lines.at(-1)).toBe('All links are working.')
  })
  it('reports remaining failures and still writes a support report after a refused repair', async () => {
    const repair = vi.fn(async () => { throw new Error('No user systemd session.') })
    const lines: string[] = []
    await doctorCommand(['--fix', '--report'], { diagnose: async () => ({ serverHealthy: false, checks: [failed('service')] }), repair, report: async () => '/tmp/report.json', out: (line) => lines.push(line) })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('Still broken: service.')
    expect(lines.at(-1)).toBe('Support file: /tmp/report.json')
    expect(process.exitCode).toBe(1)
  })
  it('does not restart one managed tunnel repeatedly while its address is coming up', async () => {
    const repair = vi.fn(async () => undefined)
    await doctorCommand(['--fix'], { diagnose: async () => ({ serverHealthy: true, checks: [failed('tunnel'), failed('cloudflared'), failed('public')] }), repair, out: () => {} })
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
    const config = redactConfig({ mode: 'server', upstream: { token: 'long-token', serverUrl: 'https://box' }, pairCode: 'pair-me', apiKeys: { anthropic: 'key-value' }, nested: [{ clientSecret: 'client-value' }] }, secrets)
    const text = redactText(JSON.stringify({ config, log: 'long-token pair-me key-value client-value Bearer abc.def https://user:pass@box/?api_key=other' }), secrets)
    for (const secret of ['long-token', 'pair-me', 'key-value', 'client-value', 'abc.def', 'user:pass', '=other']) expect(text).not.toContain(secret)
    expect(config).toMatchObject({ mode: 'server', pairCode: '[removed]', upstream: { serverUrl: 'https://box', token: '[removed]' } })
  })
  it('writes valid private JSON, unit status, bounded logs and versions while offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-doctor-'))
    vi.stubEnv('PODIUM_STATE_DIR', dir)
    vi.stubEnv('PODIUM_INSTANCE', 'default')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ upstream: { token: 'top-secret-value' }, pairCode: 'pair-value', mode: 'server' }))
    const run = vi.fn(async (cmd: string) => `${cmd}: token="top-secret-value" pair-value Bearer another-secret`)
    try {
      const path = await writeDoctorReport({ capture: run })
      const bytes = readFileSync(path, 'utf8')
      expect(() => JSON.parse(bytes)).not.toThrow()
      const report = JSON.parse(bytes)
      expect(report.unitStatus.map((value: { unit: string }) => value.unit)).toEqual(['podium.service', 'podium-tunnel.service'])
      expect(report.logs).toHaveLength(8)
      expect(report.versions.os).toBeTruthy()
      expect(statSync(path).mode & 0o777).toBe(0o600)
      for (const secret of ['top-secret-value', 'pair-value', 'another-secret']) expect(bytes).not.toContain(secret)
      expect(run.mock.calls.some((call) => call[0] === 'journalctl')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
