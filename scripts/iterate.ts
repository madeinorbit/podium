/**
 * ITERATION MODE — the one sanctioned divergence from the update path.
 *
 * `bun run iterate` starts a Vite dev server for `apps/web` NEXT TO the live
 * installed instance, on its own ports, and proxies the API and both WebSockets
 * to the installed server. Editing a component on the VPS is then visible in an
 * attached browser in seconds, while the installed app keeps serving its own
 * built `dist` to everyone else and the updater carries on as if this process
 * did not exist.
 *
 * WHY THIS IS A SEPARATE COMMAND AND NOT `bun run host`.
 *
 * `bun run host` is the local all-in-one: a source Vite server IN FRONT OF a
 * source backend (`scripts/host.ts`), a second instance with its own state.
 * That is the right shape on a laptop and the wrong one on the VPS, where the
 * data, the sessions and the agents live in the INSTALLED instance — iterating
 * against a second empty backend is iterating against nothing. So iterate mode
 * keeps exactly one half from source (the web UI) and borrows the other half
 * live. Server-side changes are NOT in scope here and need no extra mechanism:
 * they iterate through a dev release (updater-convergence spec §8c decision 3).
 *
 * WHAT KEEPS IT OUT OF THE UPDATER'S WAY.
 *
 *  - It never writes `apps/web/dist`. A dev server has no reason to, but the
 *    served dist IS the installed UI, so the argv is checked (`assertNoBuildArgs`)
 *    and the directory is fingerprinted around the session — a violation is
 *    reported at exit rather than assumed impossible.
 *  - It publishes no release, so no offer appears and no machine converges.
 *  - The page says so: `PODIUM_ITERATION_MODE` reaches the bundle as a define
 *    and the app frames itself (`apps/web/src/app/IterationModeFrame.tsx`), so a
 *    tab showing source can never be mistaken for the installed UI. This is the
 *    browser-side twin of the desktop shell's `DebugBuild` updater refusal.
 *
 * WHERE IT LISTENS. The live instance is `:55555` (TLS, via `tailscale serve`)
 * in front of the installed server on `:18787`; `bun run host` owns `:55556`.
 * Iterate takes the next block — `:55566` plain HTTP and, when tailscale can
 * serve, `:55565` for TLS — and the mount it makes is scoped to that one port
 * and removed on exit, so the live `:55555` mount is never touched. TLS is worth
 * having because a secure context is what the clipboard and paste APIs need;
 * `--no-tls` skips it.
 *
 * NOT A SERVICE. Foreground, never auto-started, gone when you press Ctrl-C.
 * It does run in a batch-tier systemd scope (the pattern from
 * `apps/server/src/modules/updates/build-scope.ts`): the dev server's transforms
 * must never out-prioritise the live server or the agent sessions sharing the
 * box.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canScopeDevBuild,
  devBuildCommand,
  devBuildScopeArgv,
  userRuntimeDir,
} from '../apps/server/src/modules/updates/build-scope'

/** Plain-HTTP origin of the iterate dev server. */
export const ITERATE_WEB_PORT = 55566
/** `tailscale serve` HTTPS port for the same origin. Never the live `:55555`. */
export const ITERATE_TLS_PORT = 55565
/** The installed server this proxies to — `podium-server.service`'s port. */
export const ITERATE_BACKEND_PORT = 18787

export interface IterateConfig {
  repoRoot: string
  /** Where Vite binds, plain HTTP. */
  webPort: number
  /** The installed server the proxy forwards `/trpc`, `/client`, `/daemon` to. */
  backendPort: number
  /** `tailscale serve` HTTPS port, or null when TLS is off. */
  tlsPort: number | null
  /** Hosts Vite will answer for — the tailnet name is added at runtime. */
  allowedHosts: string[]
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a port between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

function splitHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
}

/**
 * Ports, TLS and allowed hosts, from defaults then the environment then flags.
 *
 * Every refusal here is a collision that would otherwise be discovered as a
 * confusing runtime failure: Vite binding the installed server's port, or a
 * tailscale mount landing on a port something else already answers.
 */
export function resolveIterateConfig(opts: {
  repoRoot: string
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
}): IterateConfig {
  const env = opts.env ?? {}
  const argv = opts.argv ?? []

  let webPort = env.PODIUM_ITERATE_WEB_PORT
    ? parsePort(env.PODIUM_ITERATE_WEB_PORT, 'PODIUM_ITERATE_WEB_PORT')
    : ITERATE_WEB_PORT
  let backendPort = env.PODIUM_ITERATE_BACKEND_PORT
    ? parsePort(env.PODIUM_ITERATE_BACKEND_PORT, 'PODIUM_ITERATE_BACKEND_PORT')
    : ITERATE_BACKEND_PORT
  let tlsPort: number | null = env.PODIUM_ITERATE_TLS_PORT
    ? parsePort(env.PODIUM_ITERATE_TLS_PORT, 'PODIUM_ITERATE_TLS_PORT')
    : ITERATE_TLS_PORT
  if (env.PODIUM_ITERATE_TLS === '0') tlsPort = null
  const allowedHosts = splitHosts(env.PODIUM_ALLOWED_HOSTS)

  for (const arg of argv) {
    const [flag, value = ''] = arg.split(/=(.*)/s)
    switch (flag) {
      case '--no-tls':
        tlsPort = null
        break
      case '--web-port':
        webPort = parsePort(value, '--web-port')
        break
      case '--backend-port':
        backendPort = parsePort(value, '--backend-port')
        break
      case '--tls-port':
        tlsPort = parsePort(value, '--tls-port')
        break
      case '--allow-host':
        if (value.trim()) allowedHosts.push(value.trim())
        break
      default:
        throw new Error(
          `unknown option ${flag} — iterate takes --no-tls, --web-port=, --backend-port=, ` +
            '--tls-port=, --allow-host=',
        )
    }
  }

  if (webPort === backendPort) {
    throw new Error(
      `the dev server cannot bind ${webPort}: that is the backend port it proxies to. ` +
        'Iterate runs BESIDE the installed instance, never on top of it.',
    )
  }
  if (tlsPort !== null && (tlsPort === webPort || tlsPort === backendPort)) {
    throw new Error(`--tls-port ${tlsPort} collides with the web or backend port`)
  }

  return { repoRoot: opts.repoRoot, webPort, backendPort, tlsPort, allowedHosts }
}

/**
 * The environment the Vite child reads (`apps/web/vite.config.ts`).
 *
 * `PODIUM_APP_VERSION` is deliberately STRIPPED rather than passed through: it
 * is the release identity a packaged build carries, and an iterate page is
 * source. Left inherited from a shell that had exported one, the About panel
 * and the web logs would report a version this page is not.
 */
export function iterateChildEnv(config: IterateConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.PODIUM_APP_VERSION
  env.PODIUM_PORT = String(config.backendPort)
  env.PODIUM_WEB_PORT = String(config.webPort)
  env.PODIUM_ALLOWED_HOSTS = config.allowedHosts.join(',')
  env.PODIUM_ITERATION_MODE = '1'
  const runtimeDir = userRuntimeDir()
  if (runtimeDir) env.XDG_RUNTIME_DIR = runtimeDir
  return env
}

export interface IterateSpawnPlan {
  file: string
  args: string[]
  cwd: string
}

/** Transient scope name, keyed by port so two iterate sessions never collide. */
export function iterateScopeUnit(webPort: number): string {
  return `podium-iterate-${webPort}.scope`
}

/**
 * Signals this session must outlive by just long enough to give the box back.
 *
 * SIGHUP EARNS ITS PLACE BY MEASUREMENT (POD-2513 review). It was missing, and a
 * hangup — which is what closing the ssh session sends, the ordinary ending for
 * a foreground command on a VPS — killed the parent outright: the dev server
 * kept the port under its surviving scope, the tailnet HTTPS mount stayed in
 * tailscaled's config, and the next start on that port refused because the
 * reclaim will not stop a live scope. Self-perpetuating, and recoverable only by
 * hand. Keep this list and `teardown` together.
 */
export const TEARDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * What actually gets spawned: `bun run dev` in `apps/web`, optionally wrapped in
 * a batch-tier scope. Pure, so the unscoped fallback (macOS, a container) is a
 * table rather than a branch nobody can see.
 */
export function viteSpawnPlan(
  config: IterateConfig,
  opts: { scoped: boolean; unit: string; bun: string },
): IterateSpawnPlan {
  const command = [opts.bun, 'run', 'dev'] as const
  const cwd = join(config.repoRoot, 'apps', 'web')
  if (!opts.scoped) return { file: opts.bun, args: ['run', 'dev'], cwd }
  return {
    file: 'systemd-run',
    args: devBuildScopeArgv(opts.unit, [...command], {
      description: `Podium iteration mode (web dev server :${config.webPort})`,
    }),
    cwd,
  }
}

/**
 * THE DIST GUARDRAIL, ON THE ARGV.
 *
 * `apps/web/dist` is what the installed server serves — overwriting it from an
 * iterate session would change the live UI for everyone, which is the one thing
 * this mode promises never to do. A dev server does not write it, so this exists
 * to stop the command from ever being *edited* into one that does.
 */
export function assertNoBuildArgs(args: readonly string[]): void {
  const offender = args.find((arg) => /^(build|build:.+|preview)$/.test(arg))
  if (offender) {
    throw new Error(
      `iterate must never run \`${offender}\`: that writes apps/web/dist, which is the ` +
        'bundle the installed server serves.',
    )
  }
}

/**
 * The identity of a built dist: every file's path, size and CONTENT HASH.
 *
 * TIMESTAMPS WERE THE FIRST FORM AND THEY DO NOT WORK HERE. `mtimeMs` cannot
 * separate two writes inside one millisecond, and reaching for the nanosecond
 * fields does not fix it under the runtime this actually runs on: Bun's
 * `statSync(path, { bigint: true })` synthesises `mtimeNs` from the millisecond
 * value, so it has exactly the same resolution (measured — Node reports the two
 * writes apart, Bun reports them identical). A guardrail that reports "dist
 * untouched" over a dist that was just rewritten is worse than none.
 *
 * Hashing the bytes also states the promise more honestly than a clock could:
 * what the acceptance asks is that the bundle the installed server serves is
 * the same bundle afterwards. A `touch` that changed nothing is not a
 * violation, and a rewrite is caught whenever it changed a byte. Reading a
 * ~20 MB dist twice per session costs milliseconds.
 *
 * Null when the checkout has never built, which is a perfectly normal state to
 * iterate from.
 */
export function distFingerprint(distDir: string): string | null {
  if (!existsSync(distDir)) return null
  const hash = createHash('sha256')
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path, rel)
        continue
      }
      const bytes = readFileSync(path)
      hash.update(
        `${rel}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}\n`,
      )
    }
  }
  walk(distDir, '')
  return hash.digest('hex')
}

/** The sentence to print when a session did touch the served bundle. */
export function describeDistDrift(before: string | null, after: string | null): string | null {
  if (before === after) return null
  if (before === null) return 'apps/web/dist APPEARED during this iterate session'
  if (after === null) return 'apps/web/dist was REMOVED during this iterate session'
  return 'apps/web/dist CHANGED during this iterate session'
}

/** `tailscale` argv for a background HTTPS mount at one port. */
export function tailscaleServeArgv(tlsPort: number, webPort: number): string[] {
  return ['serve', '--bg', '--yes', `--https=${tlsPort}`, `http://127.0.0.1:${webPort}`]
}

/** Teardown, scoped to the one port this session mounted. */
export function tailscaleServeOffArgv(tlsPort: number): string[] {
  return ['serve', `--https=${tlsPort}`, 'off']
}

/**
 * Is something already served on this HTTPS port? Reading `tailscale serve
 * status --json` rather than assuming: the live instance's own `:55555` mount
 * lives in the same config, and taking it over would take the installed app off
 * the air for the whole tailnet.
 */
export function tlsPortAlreadyServed(status: unknown, tlsPort: number): boolean {
  const tcp = (status as { TCP?: Record<string, unknown> } | null)?.TCP
  return Boolean(tcp && Object.hasOwn(tcp, String(tlsPort)))
}

/**
 * The tailnet name the browser will send as `Host`. Vite refuses hosts it was
 * not told about, so without this the TLS URL answers with "Blocked request".
 */
export function tailnetHostFromStatus(status: unknown): string | null {
  const name = (status as { Self?: { DNSName?: string } } | null)?.Self?.DNSName
  return name ? name.replace(/\.$/, '') : null
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function say(message: string): void {
  console.log(`[iterate] ${message}`)
}

function tailscaleJson(args: string[]): unknown {
  const run = spawnSync('tailscale', args, { encoding: 'utf8', timeout: 8000 })
  if (run.status !== 0 || !run.stdout) return null
  try {
    return JSON.parse(run.stdout)
  } catch {
    return null
  }
}

async function backendIsUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return response.ok
  } catch {
    return false
  }
}

function unitIsActive(unit: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit], { env }).status === 0
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const config = resolveIterateConfig({ repoRoot, env: process.env, argv: process.argv.slice(2) })

  /**
   * THE CHECKOUT MUST OWN ITS DEPENDENCIES (POD-746). Without a local
   * `node_modules`, resolution walks UP the filesystem into whatever sibling
   * checkout has one, and the `@podium/source` condition then faithfully serves
   * MAIN's sources from a worktree — a dev server that hot-reloads code that is
   * not the code you are editing. Refuse rather than serve a lie.
   */
  if (!existsSync(join(repoRoot, 'node_modules', 'vite'))) {
    console.error(
      `[iterate] ${repoRoot} has no node_modules/vite. Run \`bun install\` here first — ` +
        'without it Vite resolves out of a sibling checkout and serves code you are not editing.',
    )
    process.exit(1)
  }

  if (!(await backendIsUp(config.backendPort))) {
    console.error(
      `[iterate] nothing answered http://127.0.0.1:${config.backendPort}/health. Iteration mode ` +
        'serves the web UI from source against the LIVE installed server; start it first ' +
        '(`systemctl --user start podium-server`), or point elsewhere with --backend-port=.',
    )
    process.exit(1)
  }

  const distDir = join(repoRoot, 'apps', 'web', 'dist')
  const distBefore = distFingerprint(distDir)

  /**
   * OUTSIDE THE TLS BRANCH, and that placement is the bug fix (POD-2513 review).
   * The tailnet name is the `Host` a browser sends on BOTH URLs — Vite refuses a
   * host it was not told about either way. Resolved here, `--no-tls` still
   * answers at `http://<tailnet-name>:<port>`, which is the URL the docs give.
   */
  const tailnetHost = tailnetHostFromStatus(tailscaleJson(['status', '--json']))
  if (tailnetHost && !config.allowedHosts.includes(tailnetHost)) {
    config.allowedHosts.push(tailnetHost)
  }

  let tlsPort = config.tlsPort
  if (tlsPort !== null) {
    const status = tailscaleJson(['serve', 'status', '--json'])
    if (status === null) {
      say('tailscale is not answering — continuing on plain HTTP only')
      tlsPort = null
    } else if (tlsPortAlreadyServed(status, tlsPort)) {
      console.error(
        `[iterate] tailscale already serves :${tlsPort} — refusing to take it over. ` +
          'Pick another with --tls-port=, or run with --no-tls.',
      )
      process.exit(1)
    }
  }

  const unit = iterateScopeUnit(config.webPort)
  const scoped = canScopeDevBuild()
  const env = iterateChildEnv(config, process.env)
  if (scoped) {
    if (unitIsActive(unit, env)) {
      console.error(
        `[iterate] ${unit} is already running — another iterate session owns :${config.webPort}. ` +
          'Stop it, or use --web-port= for a second one.',
      )
      process.exit(1)
    }
    // Frees a dead name (`unit already exists` after a crash). Never stops a live one:
    // that would be this session killing someone else's.
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore', env })
  }

  const plan = viteSpawnPlan(config, { scoped, unit, bun: devBuildCommand() })
  assertNoBuildArgs(plan.args)

  let mounted = false
  if (tlsPort !== null) {
    const mount = spawnSync('tailscale', tailscaleServeArgv(tlsPort, config.webPort), {
      stdio: 'ignore',
    })
    mounted = mount.status === 0
    if (!mounted) say(`could not mount tailscale TLS on :${tlsPort} — plain HTTP only`)
  }

  /**
   * EVERYTHING THIS SESSION PUT ON THE BOX COMES OFF AGAIN.
   *
   * Idempotent and fully synchronous, which is what lets it also run from
   * `process.on('exit')` — the backstop that covers every way out except
   * SIGKILL, including an unhandled signal and a throw.
   *
   * STOPPING THE SCOPE IS PART OF IT (POD-2513 review). A scoped process
   * SURVIVES its parent and reparents to the user manager — build-scope.ts says
   * so, and it was measured here: after a hangup the parent was gone while vite
   * still held the port and the scope was still active. Worse, the next
   * `iterate` on that port then refuses, because the reclaim deliberately never
   * stops a live scope (it cannot tell someone else's from an orphan). This can,
   * because it is stopping the unit THIS session created, at a name it already
   * verified was free.
   */
  let torndown = false
  const teardown = () => {
    if (torndown) return
    torndown = true
    if (mounted && tlsPort !== null) {
      spawnSync('tailscale', tailscaleServeOffArgv(tlsPort), { stdio: 'ignore' })
      mounted = false
    }
    if (scoped && unitIsActive(unit, env)) {
      spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', env })
    }
    const drift = describeDistDrift(distBefore, distFingerprint(distDir))
    if (drift) {
      console.error(`[iterate] GUARDRAIL: ${drift}. The installed UI may have changed — check it.`)
    } else if (distBefore === null) {
      // SAY WHAT WAS ACTUALLY CHECKED. This checkout has never built, so the
      // guardrail read nothing — reporting "untouched" would be a pass issued by
      // an instrument that never looked (POD-2513 review, finding 3).
      say(`no built dist at ${distDir} — nothing here for an iterate session to disturb`)
    } else {
      say(`${distDir} untouched; the installed app and the updater are as you left them`)
    }
  }

  const hosts = config.allowedHosts[0]
  say(`web UI from source, proxying /trpc + /client + /daemon to :${config.backendPort}`)
  if (tlsPort !== null && mounted) say(`  https://${hosts ?? '<tailnet-host>'}:${tlsPort}`)
  say(`  http://${hosts ?? 'localhost'}:${config.webPort}`)
  say(`the installed instance keeps serving its own build; ${scoped ? 'batch tier' : 'unscoped'}`)

  const child = spawn(plan.file, plan.args, { cwd: plan.cwd, env, stdio: 'inherit' })
  let closing = false
  const forward = (signal: NodeJS.Signals) => {
    // A second signal means the first one did not take. Stop asking politely:
    // tear down what we put on the box and go, rather than hanging on a child
    // that is not listening.
    if (closing) {
      teardown()
      process.exit(1)
    }
    closing = true
    child.kill(signal)
  }
  /**
   * SIGHUP IS THE ORDINARY ENDING HERE, not an exotic one (POD-2513 review):
   * this is a foreground command on a VPS, so closing the ssh session is how it
   * usually stops. Left unhandled it killed the parent outright — teardown never
   * ran, vite kept the port, the scope stayed active and the tailscale mount
   * stayed in tailscaled's config, and the next start on that port refused.
   *
   * (Measure a hangup with `setsid`, never `nohup`: nohup sets SIGHUP to IGNORED
   * in the child, so the test passes without proving anything. Check bit 0 of
   * SigIgn in /proc/PID/status.)
   */
  for (const signal of TEARDOWN_SIGNALS) process.on(signal, () => forward(signal))
  // The last line of defence: any exit path that reaches here — a throw, a
  // signal nobody handled — still gives back the port, the scope and the mount.
  process.on('exit', teardown)

  const status = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      console.error(`[iterate] could not start the dev server: ${error.message}`)
      resolve(1)
    })
    child.once('close', (code) => resolve(code ?? 0))
  })
  teardown()
  process.exit(status)
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`[iterate] ${error.message}`)
    process.exit(1)
  })
}
