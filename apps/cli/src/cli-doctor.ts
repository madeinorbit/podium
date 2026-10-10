/** Local diagnostics stay usable while the server is down. Status and doctor share these probes. */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { platform, release } from 'node:os'
import { join } from 'node:path'
import {
  configPath,
  forgetConfig,
  loadConfig,
  type PodiumConfig,
  resolveConnectBaseUrl,
  resolvePort,
  resolvePublicUrl,
  resolveSetting,
  stateDir,
} from '@podium/runtime/config'
import {
  instanceCommandName,
  instanceServiceName,
  resolveInstanceId,
} from '@podium/runtime/instance'
import { listLive, logDir, type RunRecord } from '@podium/runtime/run-registry'
import { httpOriginOf, resolveLocatorRecord } from '@podium/runtime/server-follow'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { declareFlags, parseFlags } from './argv'
import {
  installSystemd,
  parentUnitRenderOptions,
  restartSystemdUnits,
  userUnitDir,
} from './cli-systemd'
import { downloadCloudflared, enableTunnel, resolveCloudflared } from './tunnel-cli'

export const PROBE_TIMEOUT_MS = 1_500
export type Link = 'service' | 'server' | 'tunnel' | 'cloudflared' | 'public' | 'connect'
export interface LinkCheck {
  link: Link
  name: string
  ok: boolean
  detail: string
  fix: string
}
export interface Diagnosis {
  checks: LinkCheck[]
  serverHealthy: boolean
  currentUrl?: string
  stableLink?: string
}

export function capture(cmd: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        resolve(stdout.trim() || stderr.trim() || (error ? `${cmd} could not run.` : ''))
      },
    )
  })
}

/** An absolute deadline, including the body, with a cap on what a proxy can send us. */
export async function probeVersion(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!res.ok || Number(res.headers.get('content-length')) > 64 * 1024) return undefined
    const reader = res.body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 64 * 1024) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (new URL(url).pathname === '/health' && text.trim() === 'ok') return { status: 'ok' }
    const body: unknown = JSON.parse(text)
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Never use TCP for local repairs: the socket cannot be reached through the tunnel. */
export function controlRequest(path: string, body?: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: serverControlSocketPath(),
        path,
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
          if (text.length > 64 * 1024) req.destroy(new Error('The server answer is too large.'))
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const value = JSON.parse(text) as Record<string, unknown>
            if (res.statusCode !== 200)
              reject(
                new Error(
                  typeof value.error === 'string'
                    ? value.error
                    : 'The server refused this request.',
                ),
              )
            else resolve(value)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    const timer = setTimeout(
      () => req.destroy(new Error('The server did not answer.')),
      PROBE_TIMEOUT_MS,
    )
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

export interface DiagnoseDeps {
  config?: PodiumConfig
  env?: NodeJS.ProcessEnv
  live?: RunRecord[]
  version?: typeof probeVersion
  unit?: (unit: string) => Promise<boolean>
  cloudflared?: () => string | undefined
  control?: typeof controlRequest
  locator?: typeof resolveLocatorRecord
}

export async function diagnose(deps: DiagnoseDeps = {}): Promise<Diagnosis> {
  const config = deps.config ?? loadConfig()
  const env = deps.env ?? process.env
  const instance = resolveInstanceId(env)
  const command = instanceCommandName(instance)
  const fix = `${command} doctor --fix`
  const checks: LinkCheck[] = []
  const add = (link: Link, name: string, ok: boolean, detail: string, remedy = fix): void => {
    checks.push({ link, name, ok, detail, fix: remedy })
  }
  const host = ['server', 'all-in-one'].includes(resolveSetting('mode', config, env).value ?? '')
  const managed = config.networkOption === 'cloudflare-tunnel' && host
  const port = resolvePort(config, env)
  const publicUrl = host ? resolvePublicUrl(config, env) : undefined
  const origin = publicUrl ? httpOriginOf(publicUrl) : undefined
  const version = deps.version ?? probeVersion
  const unit =
    deps.unit ??
    (async (name) => (await capture('systemctl', ['--user', 'is-active', name])) === 'active')
  const live = deps.live ?? listLive()
  const serviceTask =
    config.persistence === 'systemd'
      ? unit(instanceServiceName('parent', instance))
      : Promise.resolve(
          live.some(
            (r) =>
              r.role === 'parent' ||
              r.role === 'all-in-one' ||
              r.role === (host ? 'server' : 'daemon'),
          ),
        )
  // Every independent request begins together. Connect's read depends only on the local identity.
  const [service, health, local, tunnel, publicVersion, diagnostics] = await Promise.all([
    serviceTask,
    host ? version(`http://127.0.0.1:${port}/health`) : undefined,
    host ? version(`http://127.0.0.1:${port}/version`) : undefined,
    managed ? unit(instanceServiceName('tunnel', instance)) : true,
    origin ? version(`${origin}/version`) : undefined,
    host ? (deps.control ?? controlRequest)('/v1/diagnostics').catch(() => undefined) : undefined,
  ])
  add('service', 'Podium service', service, service ? 'Running.' : 'Podium is stopped.')
  if (!host) return { checks, serverHealthy: false }
  const validVersion = (v: Record<string, unknown> | undefined): boolean =>
    typeof v?.wireVersion === 'number' && typeof v.appVersion === 'string'
  const serverHealthy = health?.status === 'ok' && validVersion(local)
  add(
    'server',
    'Server',
    serverHealthy,
    serverHealthy ? `Answering on port ${port}.` : `The server is not answering on port ${port}.`,
  )
  const cloudflared = managed ? (deps.cloudflared ?? (() => resolveCloudflared(env)))() : undefined
  if (managed) {
    add('tunnel', 'Tunnel service', tunnel, tunnel ? 'Running.' : 'The tunnel is stopped.')
    add(
      'cloudflared',
      'cloudflared',
      !!cloudflared,
      cloudflared ? 'Installed.' : 'cloudflared is missing.',
    )
  }
  const sameServer =
    !local?.installationId || publicVersion?.installationId === local.installationId
  const publicOk =
    !!origin && validVersion(publicVersion) && sameServer && (!managed || (tunnel && !!cloudflared))
  add(
    'public',
    'Public address',
    publicOk,
    publicOk
      ? `${origin} is answering.`
      : !origin
        ? 'No public address is set.'
        : !sameServer && validVersion(publicVersion)
          ? 'The address answers from a different Podium.'
          : 'The public address is not answering.',
    managed && origin ? fix : `${command} setup`,
  )
  const connect = diagnostics?.connect as
    | { enabled?: boolean; installationId?: string; generation?: number }
    | undefined
  if (connect?.enabled === false) {
    add('connect', 'Podium Connect', true, 'Turned off in Settings.')
  } else if (!connect?.installationId) {
    add(
      'connect',
      'Podium Connect',
      false,
      'The server must answer before its address record can be checked.',
    )
  } else {
    const record = await (deps.locator ?? resolveLocatorRecord)({
      baseUrl: resolveConnectBaseUrl(config, env),
      installationId: connect.installationId,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const current =
      !!origin &&
      record?.endpoints.some((endpoint) => httpOriginOf(endpoint.url) === origin) === true &&
      record.generation === connect.generation &&
      (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())
    add(
      'connect',
      'Podium Connect',
      current,
      current ? 'Has the current address.' : 'Connect does not have the current address.',
    )
  }
  return {
    checks,
    serverHealthy,
    ...(publicOk ? { currentUrl: origin } : {}),
    ...(typeof local?.stableLink === 'string' ? { stableLink: local.stableLink } : {}),
  }
}

export function renderChecks(checks: LinkCheck[]): string {
  return checks
    .map((c) => `  ${c.ok ? 'OK' : 'FAILED'} ${c.name}: ${c.detail}${c.ok ? '' : ` Run: ${c.fix}`}`)
    .join('\n')
}

export async function repairLink(link: Link): Promise<string | undefined> {
  forgetConfig()
  const config = loadConfig()
  const mode = resolveSetting('mode', config).value
  if (link === 'service' || link === 'server') {
    if (config.persistence === 'systemd') {
      const instance = resolveInstanceId()
      let renderOptions: ReturnType<typeof parentUnitRenderOptions> | undefined
      try {
        renderOptions = parentUnitRenderOptions(
          readFileSync(join(userUnitDir(), instanceServiceName('parent', instance)), 'utf8'),
        )
      } catch {
        /* Fresh install. */
      }
      const installed = installSystemd(mode, resolvePort(config), instance, {
        ...(renderOptions ? { renderOptions } : {}),
      })
      if (!installed.ok) throw new Error(installed.reason)
      restartSystemdUnits([instanceServiceName('parent', resolveInstanceId())])
      const { waitForHealth } = await import('./cli-spawn')
      if (mode === 'server' || mode === 'all-in-one') {
        await waitForHealth(resolvePort(config), config.bindHost)
      }
      if (installed.lingerRemedy) return installed.lingerRemedy
    } else {
      const { restartCommand } = await import('./cli-lifecycle')
      await restartCommand()
    }
  } else if (
    (link === 'cloudflared' || link === 'tunnel' || link === 'public') &&
    config.networkOption === 'cloudflare-tunnel'
  ) {
    if (!resolveCloudflared()) await downloadCloudflared()
    const result = enableTunnel({ config })
    if (!result.ok) throw new Error(result.reason)
    return 'The tunnel is starting. A new address can take a minute to answer.'
  } else if (link === 'connect') {
    await controlRequest('/v1/connect-publish', {})
    return 'The address was queued for publishing. Run podium doctor again in a few seconds.'
  } else return 'This link needs the command shown above.'
  return undefined
}

const SECRET_KEY =
  /token|password|pair.?code|api.?key|secret|credential|private.?key|authorization|cookie/i

/** Remove secret fields recursively and retain their values for scrubbing every report section. */
export function redactConfig(value: unknown, secrets: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SECRET_KEY.test(key)) {
        const collect = (v: unknown): void => {
          if (typeof v === 'string' && v.length > 0) secrets.add(v)
          else if (v && typeof v === 'object') Object.values(v).forEach(collect)
        }
        collect(entry)
        return [key, '[removed]']
      }
      return [key, redactConfig(entry, secrets)]
    }),
  )
}

export function redactText(text: string, secrets: ReadonlySet<string>): string {
  let clean = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    clean = clean.split(secret).join('[removed]')
  return clean
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [removed]')
    .replace(
      /((?:token|password|pair.?code|api.?key|secret|credential|private.?key|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[removed]',
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[removed]@')
    .replace(/([?&](?:token|key|api_key|secret|code|password)=)[^&\s"']+/gi, '$1[removed]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[removed]')
}

export async function writeDoctorReport(deps: { capture?: typeof capture } = {}): Promise<string> {
  const run = deps.capture ?? capture
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    raw = { error: 'Config is missing or unreadable.' }
  }
  const secrets = new Set<string>()
  const config = redactConfig(raw, secrets)
  const instance = resolveInstanceId()
  const units = [instanceServiceName('parent', instance), instanceServiceName('tunnel', instance)]
  const cloudflared = resolveCloudflared()
  const [unitStatus, journal, logs, cloudflaredVersion] = await Promise.all([
    Promise.all(
      units.map(async (unit) => ({
        unit,
        output: await run('systemctl', ['--user', 'status', '--no-pager', '--full', unit], 3_000),
      })),
    ),
    Promise.all(
      (['parent', 'server', 'daemon', 'tunnel'] as const).map(async (role) => ({
        unit: instanceServiceName(role, instance),
        output: await run(
          'journalctl',
          ['--user', '-u', instanceServiceName(role, instance), '--no-pager', '-n', '300', '-o', 'cat'],
          3_000,
        ),
      })),
    ),
    Promise.all(
      ['parent', 'server', 'daemon', 'tunnel'].flatMap((role) =>
        ['log', 'ndjson'].map(async (ext) => {
          const path = join(logDir(), `${role}.${ext}`)
          return {
            component: `${role}.${ext}`,
            output: await run('tail', ['-n', '300', path], 3_000),
          }
        }),
      ),
    ),
    cloudflared ? run(cloudflared, ['--version'], 3_000) : 'Missing.',
  ])
  const report = {
    kind: 'podium-doctor-report',
    exportedAt: new Date().toISOString(),
    instanceId: instance,
    versions: {
      podium: process.env.PODIUM_APP_VERSION ?? 'dev',
      cloudflared: cloudflaredVersion,
      os: `${platform()} ${release()}`,
    },
    config,
    unitStatus,
    journal,
    logs,
  }
  const dir = join(stateDir(), 'reports')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `doctor-${Date.now()}-${process.pid}.json`)
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, secrets)
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)]))
    return value
  }
  writeFileSync(path, `${JSON.stringify(scrub(report), null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return path
}

export async function doctorCommand(
  argv: string[],
  deps: {
    diagnose?: typeof diagnose
    repair?: typeof repairLink
    report?: typeof writeDoctorReport
    out?: (line: string) => void
  } = {},
): Promise<void> {
  const out = deps.out ?? console.log
  if (argv.some((arg) => ['--help', '-h', 'help'].includes(arg))) {
    out(
      'podium doctor [--fix] [--report]\nFind the first broken link. --fix repairs local services. --report writes a support file with secrets removed.',
    )
    return
  }
  try {
    const parsed = parseFlags(argv, declareFlags({ known: [], booleans: ['fix', 'report'] }), {
      usage: 'podium doctor',
      keys: 'raw',
    })
    if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`)
    let result = await (deps.diagnose ?? diagnose)()
    const first = result.checks.find((check) => !check.ok)
    out(first ? `First broken link: ${first.name}. ${first.detail}` : 'All links are working.')
    out(renderChecks(result.checks))
    if (parsed.args.fix === true && first) {
      const attempted = new Set<Link>()
      for (;;) {
        const broken = result.checks.find((check) => !check.ok && !attempted.has(check.link))
        if (!broken) break
        attempted.add(broken.link)
        // One tunnel restart repairs all three managed-tunnel links together.
        if (
          ['tunnel', 'cloudflared'].includes(broken.link) ||
          (broken.link === 'public' && loadConfig().networkOption === 'cloudflare-tunnel')
        ) {
          for (const link of ['tunnel', 'cloudflared', 'public'] as const) attempted.add(link)
        }
        try {
          const note = await (deps.repair ?? repairLink)(broken.link)
          out(`Repair ${broken.name}: ${note ?? 'Restarted.'}`)
        } catch (error) {
          out(`Repair ${broken.name}: ${(error as Error).message}`)
        }
        forgetConfig()
        result = await (deps.diagnose ?? diagnose)()
      }
      out('After repairs:')
      out(renderChecks(result.checks))
      const remaining = result.checks.find((check) => !check.ok)
      out(
        remaining
          ? `Still broken: ${remaining.name}. ${remaining.detail}`
          : 'All links are working.',
      )
    }
    if (parsed.args.report === true)
      out(`Support file: ${await (deps.report ?? writeDoctorReport)()}`)
    if (result.checks.some((check) => !check.ok)) process.exitCode = 1
  } catch (error) {
    out(`podium doctor: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
