/**
 * THE TERMINAL FAMILY'S INSTRUMENTATION MECHANISM (POD-4472): install + ingest.
 *
 * Hook install layouts, payload codecs and transports live in
 * `adapters/<h>/instrumentation.ts`, one authoritative definition per harness
 * (spec §4). This module keeps only the mechanism — the install gate (a
 * required install that fails is a spawn REFUSAL, not a warning), the
 * per-home serialization, the loopback ingest server hooks post to, and the
 * degradation report — and never names a harness: every install receives the
 * session adapter's instrumentation sections as a handed typed subset
 * ({@link TerminalInstrumentationSections}) and calls through them. The
 * payload shape is adapter knowledge; the transport is family machinery.
 *
 * Re-homed from the daemon's `runtime/terminal-instrumentation.ts` (gate +
 * host-side installer) and `hook-ingest.ts` (loopback server), with the
 * harness switch replaced by section dispatch — which is what deletes the
 * `harness-branching` violations those files carried.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { DriverCapabilities, SessionSpec } from '../../host.js'
import {
  type AgentManifest,
  type HarnessCapabilities,
  type HarnessInstrumentation,
  type InstalledInstrumentation,
  type InstrumentationDestination,
} from '../../../manifest.js'
import {
  HOOK_INGEST_ENDPOINT,
  listenStableLoopbackPort,
  type StablePortConflict,
} from './loopback-listen.js'

/** The daemon-side name for an install result. Alias, not a second type. */
export type InstalledTerminalInstrumentation = InstalledInstrumentation

/**
 * THE SECTIONS THE TERMINAL FAMILY OWNS (spec §4.1).
 *
 * A Driver is not handed the whole Adapter: it receives a typed subset, the
 * sections it owns, so the read restriction is a type rather than a rule. The
 * daemon's session composition resolves the manifest by harness kind once and
 * hands this in; the family has no parameter that accepts a manifest and no
 * import that could fetch one, so reaching a section it was not handed fails
 * compilation, not review (the same narrowing POD-4497 applied to engine
 * supervision with `Pick<EngineSupervisor, 'scopeUnitFor'>`).
 */
export interface TerminalInstrumentationSections {
  /** The harness's own install layout, payload codec and transport. */
  instrumentation: HarnessInstrumentation
  /** Only the home selector: which env var redirects the harness home. */
  environment: Pick<AgentManifest['environment'], 'instanceHome'>
  /** Which install layout applies: per-session args or a shared global home. */
  hookInstall: HarnessCapabilities['hookInstall']
}

/**
 * Receives Claude Code `type: "http"` hook POSTs at /hooks/<podiumSessionId>.
 * The path segment is OUR session id (baked into the per-session settings file
 * at spawn), which is how harness events correlate to Podium sessions without
 * trusting the payload.
 *
 * By default acks 200 {} without steering: hooks run inline in the agent's
 * lifecycle, and Podium must observe, never delay. An optional `respondTo` may
 * return injected context as the body, but it is strictly bounded by a timeout
 * so the agent is never held past it.
 */
export interface HookIngest {
  port: number
  /**
   * Set when the preferred port was taken and ingest bound an ephemeral one
   * instead. Ingest works; it is the STABILITY that was lost, so the caller is
   * expected to report this where a person sees it. See {@link DEFAULT_HOOK_PORT}.
   */
  portConflict?: StablePortConflict
  /** Stable, instance-scoped harness endpoint when configured. */
  socketPath?: string
  endpointFor(sessionId: SessionId): string
  close(): Promise<void>
}

/**
 * Default is a FIXED, instance-owned port, not ephemeral: hook URLs live in settings files of
 * durable (abduco) sessions that outlive this process. A daemon restart
 * must come back on the same port or surviving agents post into the void.
 *
 * Wanting it is not the same as getting it. When something else already holds
 * the port, this ingest binds an ephemeral one and reports `portConflict`
 * rather than refusing to start (POD-1229) — the stability was already gone the
 * moment another process answered on that address, and taking the whole daemon
 * host down with it only hides the cause behind an offline machine. See
 * `loopback-listen.ts` for why the server port does not get the same treatment.
 */
export const DEFAULT_HOOK_PORT = 45777

/**
 * Hard cap on a hook request body. The hook port is baked into every spawned
 * agent's settings file, so a misbehaving/compromised agent could POST an
 * arbitrarily large body and OOM/block the daemon. Real hook payloads are small
 * JSON, so 2 MB is generous; anything over is rejected with 413 before parsing.
 */
export const HOOK_BODY_MAX_BYTES = 2 * 1024 * 1024

export async function startHookIngest(opts: {
  onPayload: (sessionId: SessionId, payload: unknown) => void
  /** Optional durable write that must finish before HTTP 200 acknowledges the hook. */
  beforeAck?: (sessionId: SessionId, payload: unknown) => Promise<void>
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_HOOK_PORT. */
  port?: number
  /** Stable, instance-scoped Unix socket used by harness hooks. */
  socketPath?: string
  /** Driver-owned hidden context, evaluated before optional legacy responders.
   * Removing respondTo must not remove startup/compaction context delivery. */
  boundaryContext?: (sessionId: SessionId, payload: unknown, signal: AbortSignal) => Promise<string | null>
  /**
   * Optional bounded response. When provided, the resolved JSON string is sent
   * as the hook response body (Claude Code reads it as e.g. additionalContext);
   * `null`/timeout/throw all fall back to `'{}'`. `onPayload` still fires for
   * every request. Absent → only the driver boundary is evaluated.
   */
  respondTo?: (sessionId: SessionId, payload: unknown, signal: AbortSignal) => Promise<string | null>
  /** Max time for driver context and legacy responders together before falling back to `'{}'`. Default 3000. */
  respondTimeoutMs?: number
}): Promise<HookIngest> {
  const onRequest: RequestListener = (req, res) => {
    const match = /^\/hooks\/([\w.-]+)$/.exec(req.url ?? '')
    if (!match || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    // DECODE EDGE: the session id comes off the HTTP path (`/agent/<sessionId>`),
    // so this is where an untyped request segment re-enters the branded id space.
    const sessionId = asSessionId(match[1] as string)
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      total += c.length
      if (total > HOOK_BODY_MAX_BYTES) {
        // Over the cap: reject without parsing and stop buffering. Drop what we
        // have so a late chunk can't re-trigger onPayload, and tear down the
        // request so a hostile sender can't keep streaming into the daemon.
        aborted = true
        chunks.length = 0
        res.writeHead(413)
        res.end()
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      void (async () => {
        try {
          await opts.beforeAck?.(sessionId, payload)
        } catch {
          // A 2xx would let the hook process forget evidence that is not durable.
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }

        // State tracking fires only after the durability boundary, then remains
        // fire-and-forget so translation cannot hold the hook process open.
        try {
          opts.onPayload(sessionId, payload)
        } catch {
          // observer must never throw into the response path
        }
        const respondTo = opts.respondTo
        if (!respondTo && !opts.boundaryContext) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        // Optional bounded response: await respondTo, but never delay the agent past the timeout.
        const timeoutMs = opts.respondTimeoutMs ?? 3000
        const responseLifetime = new AbortController()
        let settled = false
        const finish = (bodyText: string): void => {
          if (settled) return
          settled = true
          try {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(bodyText)
          } catch {
            // The client (agent) may have disconnected during the respondTo await
            // window; a late write onto a destroyed socket throws. Nothing to send,
            // so swallow it — the settled guard still prevents any double-send.
          }
        }
        const timer = setTimeout(() => {
          responseLifetime.abort()
          finish('{}')
        }, timeoutMs)
        timer.unref?.()
        // A client disconnect mid-await cancels the pending response so the
        // timer/promise callback becomes a no-op instead of writing to a closed
        // socket (which would otherwise throw uncaught out of the timer callback).
        res.on('close', () => {
          if (!settled) responseLifetime.abort()
          settled = true
          clearTimeout(timer)
        })
        Promise.resolve()
          .then(async () => {
            const signal = responseLifetime.signal
            let context: string | null = null
            try {
              context = await opts.boundaryContext?.(sessionId, payload, signal) ?? null
            } catch {
              // Driver fetch failures remain fail-open for later responders.
            }
            if (signal.aborted) return null
            return context ?? respondTo?.(sessionId, payload, signal) ?? null
          })
          .then((body) => {
            clearTimeout(timer)
            finish(typeof body === 'string' && body.length > 0 ? body : '{}')
          })
          .catch(() => {
            clearTimeout(timer)
            finish('{}')
          })
      })()
    })
  }

  const server = createServer(onRequest)
  const { port, conflict } = await listenStableLoopbackPort(
    server,
    opts.port ?? DEFAULT_HOOK_PORT,
    HOOK_INGEST_ENDPOINT.name,
  )

  let socketServer: Server | undefined
  let socketOwned = false
  if (opts.socketPath) {
    try {
      await prepareSocketPath(opts.socketPath)
      const unixServer = createServer(onRequest)
      socketServer = unixServer
      await new Promise<void>((resolve, reject) => {
        unixServer.once('error', reject)
        unixServer.listen(opts.socketPath, () => resolve())
      })
      socketOwned = true
      // Only this user should be able to impersonate a hook payload.
      await chmod(opts.socketPath, 0o600)
    } catch (err) {
      const failedSocketServer = socketServer
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        failedSocketServer?.listening
          ? new Promise<void>((resolve) => failedSocketServer.close(() => resolve()))
          : Promise.resolve(),
      ])
      if (socketOwned) await rm(opts.socketPath, { force: true })
      throw err
    }
  }

  return {
    port,
    ...(conflict ? { portConflict: conflict } : {}),
    ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
    endpointFor: (sessionId) => `http://127.0.0.1:${port}/hooks/${sessionId}`,
    close: async () => {
      const openSocketServer = socketServer
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        openSocketServer
          ? new Promise<void>((resolve) => openSocketServer.close(() => resolve()))
          : Promise.resolve(),
      ])
      if (opts.socketPath) await rm(opts.socketPath, { force: true })
    },
  }
}

/**
 * A crashed daemon can leave the filesystem name behind. Remove only a stale
 * socket; never unlink a listener belonging to another Podium instance.
 */
async function prepareSocketPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy()
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') resolve(false)
      else reject(err)
    })
  })
  if (live) {
    const err = new Error(`hook ingest socket already in use: ${path}`) as NodeJS.ErrnoException
    err.code = 'EADDRINUSE'
    throw err
  }
  await rm(path, { force: true })
}

// ---------------------------------------------------------------------------
// Install gate + host-side installer.
// ---------------------------------------------------------------------------

/** Both driver create/resume and wire-originated terminal creation use this gate. */
export async function prepareTerminalInstrumentation(
  capabilities: Pick<DriverCapabilities, 'instrumentation'>,
  spec: Pick<SessionSpec, 'instrumentation'>,
  install: () => Promise<InstalledTerminalInstrumentation>,
): Promise<InstalledTerminalInstrumentation> {
  if (capabilities.instrumentation === 'none') return { args: [] }
  if (!spec.instrumentation?.endpointUrl.trim()) {
    throw new Error('driver requires a per-session instrumentation endpoint')
  }
  return install()
}

// The global installers use atomic replacement with a fixed temporary path.
// Serialize sessions sharing a home; a failed install must not poison retries.
const installations = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, install: () => Promise<T>): Promise<T> {
  const previous = installations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(install)
  installations.set(key, next)
  try {
    return await next
  } finally {
    if (installations.get(key) === next) installations.delete(key)
  }
}

/** The terminal driver's host-side installer. No daemon-boot prerequisite. */
export async function installTerminalInstrumentation(input: {
  sessionId: SessionId
  /**
   * Harness display name for diagnostics and the per-home lock key. A VALUE
   * handed in, never a key to look anything up by — the family cannot resolve
   * it into a manifest even by mistake.
   */
  harness: string
  /**
   * The session channel (callback URL/socket) plus spawn env. A Pick, so the
   * family cannot reach session fields it was not handed either.
   */
  spec: Pick<SessionSpec, 'instrumentation' | 'env'>
  /** The adapter sections this family owns — its only adapter knowledge. */
  sections: TerminalInstrumentationSections
  settingsDir: string
  homeDir?: string
  /** Host telemetry plumbing for the harness version probe (best-effort). */
  reportVersionProbe?: (harness: string, output: string) => void
}): Promise<InstalledTerminalInstrumentation> {
  const { spec, sections } = input
  const channel = spec.instrumentation
  if (!channel) throw new Error('missing terminal instrumentation channel')
  const instrumentation = sections.instrumentation
  if (!instrumentation || sections.hookInstall === 'none') {
    throw new Error(`no instrumentation installer for ${input.harness}`)
  }
  const destination: InstrumentationDestination = {
    sessionId: input.sessionId,
    endpointUrl: channel.endpointUrl,
    ...(channel.socketPath ? { socketPath: channel.socketPath } : {}),
    ...(channel.seedTheme !== undefined ? { seedTheme: channel.seedTheme } : {}),
    settingsDir: input.settingsDir,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(input.reportVersionProbe ? { reportVersionProbe: input.reportVersionProbe } : {}),
  }
  let wiring: InstalledInstrumentation
  try {
    if (sections.hookInstall === 'global-env') {
      // Match the child environment: instance-owned homes override session values.
      // The selector is the handed environment section, never a registry read —
      // this is the same rule `harnessInstanceHomeEnv` states, applied to what
      // the family was given.
      const selector = sections.environment.instanceHome
      const env = {
        ...process.env,
        ...spec.env,
        ...(selector && input.homeDir
          ? { [selector.variable]: join(input.homeDir, selector.relativeDir) }
          : {}),
      }
      const homeDir = input.homeDir ?? env.HOME ?? homedir()
      const harnessHome = selector
        ? env[selector.variable]?.trim() || join(homeDir, selector.relativeDir)
        : homeDir
      destination.harnessHome = harnessHome
      wiring = await serialized(`${input.harness}:${harnessHome}`, () =>
        instrumentation.install(destination),
      )
    } else {
      wiring = await instrumentation.install(destination)
    }
  } catch (error) {
    // A throwing install degrades like a refused one: the session starts
    // poll-only with the reason reported, it is not refused. (Refusal is the
    // prepare gate above, for a required install with no channel at all.)
    const reason = error instanceof Error ? error.message : String(error)
    return { args: [], degradedReason: reason, degradedKind: 'error' }
  }
  if (wiring.file) {
    try {
      await mkdir(dirname(wiring.file.path), { recursive: true })
      await writeFile(wiring.file.path, wiring.file.contents)
    } catch (error) {
      // A missing per-session settings file must not become a fatal CLI argument.
      return {
        args: [],
        ...(wiring.env ? { env: wiring.env } : {}),
        degradedReason: error instanceof Error ? error.message : String(error),
        degradedKind: 'error',
      }
    }
  }
  return {
    args: wiring.args,
    ...(wiring.env ? { env: wiring.env } : {}),
    ...(wiring.degradedReason
      ? {
          degradedReason: wiring.degradedReason,
          ...(wiring.degradedKind ? { degradedKind: wiring.degradedKind } : {}),
        }
      : {}),
  }
}

const warnings = new WeakMap<object, Set<string>>()

/** The owner is machine-scoped, never session-scoped. Server dedupe uses code. */
export function reportInstrumentationDegradation(
  owner: object,
  harness: string,
  installation: InstalledTerminalInstrumentation,
  send: (message: DaemonMessage) => void,
): void {
  const reason = installation.degradedReason
  if (!reason) return
  const kind = installation.degradedKind ?? 'error'
  const code = `${harness}-hooks-${kind}`
  let seen = warnings.get(owner)
  if (!seen) {
    seen = new Set()
    warnings.set(owner, seen)
  }
  if (seen.has(code)) return
  seen.add(code)
  // The description stays harness-free and kind-free on purpose: the remedy
  // for an installed-but-untrusted home (the harness's own hook-review flow)
  // is adapter knowledge and travels in `degradedReason`, which the body
  // quotes below — the family must not name a harness's review flow
  // (spec §4.1). POD-4076's installed-but-dead arm is still poll-only; only
  // the words moved.
  const description = `${harness} hook installation failed; sessions can still start.`
  send({
    type: 'machineDiagnostic',
    code,
    title: `${harness} hooks unavailable`,
    description,
    body: `${harness} instrumentation unavailable: ${reason}. The session will start; hook observations may be missing.`,
  })
}
