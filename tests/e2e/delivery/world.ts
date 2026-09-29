/**
 * THE DELIVERY-OUTAGE WORLD (POD-4779).
 *
 * One real server and one real daemon, each in its own process so either can
 * be SIGKILLed; the daemon's link to the server runs through a proxy the lane
 * can cut, stall, slow or make lose a frame; every agent is a Claude-shaped
 * double that writes down each prompt it was given; and every device runs the
 * apps' own send queue and conversation controller.
 *
 *     device(s) ──tRPC/ws──▶ server ◀──ws── [link proxy] ◀──ws── daemon ──pty──▶ fake claude
 *
 * What stays fixed across every restart, because a restart that came back as
 * something else would fail for a reason that has nothing to do with delivery:
 * the state dir (so the server's database and the daemon's journals), the
 * server's port, the machine credential, the daemon's hook port (the agents
 * outlive the daemon and keep posting to it), and each device's disk.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionId } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { runSessionCli, type SessionControlClient } from '../../../apps/cli/src/session-cli'
import type { AppRouter } from '../../../apps/server/src/router'
import { makeRelayIssueClient } from '../../../packages/issue-client/src/client'
import {
  type DaemonProcessHandle,
  startDaemonProcess,
  startEntryProcess,
} from '../daemon-restart-harness'
import {
  type DeviceObservation,
  type Observation,
  rowsFor,
  type ServerRow,
  type TrackedMessage,
  type TypedPrompt,
} from './delivery-oracle'
import { Device, type DeviceApi, type DeviceDisk, newDeviceDisk } from './device'
import { FAKE_CLAUDE_SOURCE } from './fake-claude'
import { LinkProxy } from './link-proxy'
import type { ServerProcessConfig } from './server-process'

const SERVER_ENTRY = fileURLToPath(new URL('./server-process.ts', import.meta.url))

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** SIGKILL every process whose environment holds `key=value` (Linux /proc). */
function killProcessesWithEnv(key: string, value: string): void {
  if (process.platform !== 'linux') return
  const needle = `${key}=${value}`
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      if (environ.includes(needle)) process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

const OPERATOR_PASSWORD = 'delivery-outage-operator-password'

/** The operator's session cookie, as the web's login form gets it. */
async function login(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  })
  if (res.status !== 200) throw new Error(`login answered ${res.status}: ${await res.text()}`)
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie) throw new Error('login set no cookie')
  return cookie
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** `detail` is evaluated only on the timeout path, so a wait on another
 *  process can attach that process's log without paying for it per poll. */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
  detail?: () => string,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    let ok = false
    try {
      ok = await pred()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor(${what}): timed out after ${timeoutMs}ms${detail ? `\n${detail()}` : ''}`,
      )
    }
    await sleep(100)
  }
}

export interface WorldOptions {
  /** A short directory the world lives under (socket paths have a length
   *  budget) — the harness base `applyHarnessEnv` returned. */
  readonly root: string
  /** Agent sessions to start. */
  readonly sessions: number
  /** Put every session on one issue (in a scratch git repo), as agents that
   *  message each other are — an issueless session only takes messages from
   *  its parent or the operator. */
  readonly issue?: boolean
  /** Device names; each gets its own disk. */
  readonly devices: readonly string[]
  /** `PODIUM_LOG` for both children — their logs are the only narration. */
  readonly logLevel?: string
}

interface SubmitRecord {
  readonly t: string
  readonly prompt?: string
  readonly event?: string
  readonly status?: number
  readonly at: number
  readonly pid: number
}

export class DeliveryWorld {
  readonly sessionIds: SessionId[] = []
  readonly devices = new Map<string, Device>()
  private readonly disks = new Map<string, DeviceDisk>()

  private constructor(
    readonly tmp: string,
    readonly recordDir: string,
    readonly serverPort: number,
    readonly relayPort: number,
    readonly server: DaemonProcessHandle,
    readonly link: LinkProxy,
    readonly daemon: DaemonProcessHandle,
    /** The lane's own view of the server — never gated, never reloaded. */
    readonly api: DeviceApi,
    /** The operator's login; every device carries it. */
    private readonly cookie: string,
    private readonly previousStateDir: string | undefined,
  ) {}

  static async start(options: WorldOptions): Promise<DeliveryWorld> {
    const world = await DeliveryWorld.boot(options)
    try {
      await world.populate(options)
    } catch (error) {
      await world.close()
      throw error
    }
    return world
  }

  /** The processes and the link, up and logged in; no sessions yet. */
  private static async boot(options: WorldOptions): Promise<DeliveryWorld> {
    const tmp = mkdtempSync(join(options.root, 'w-'))
    const recordDir = join(tmp, 'records')
    const agentHome = join(tmp, 'agent-home')
    mkdirSync(recordDir, { recursive: true })
    mkdirSync(agentHome, { recursive: true })
    const fake = join(tmp, 'fake-claude.cjs')
    writeFileSync(fake, FAKE_CLAUDE_SOURCE)
    // `claude` on the daemon's PATH is the double. The daemon finds it the way
    // it finds the real one — inventory probes `claude --version`, the adapter
    // launches `claude <its own argv>` — so no launch seam is involved and a
    // second session is not refused as "claude-code is not installed".
    const bin = join(tmp, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
      { mode: 0o755 },
    )

    const serverPort = await freePort()
    const hookPort = await freePort()
    const relayPort = await freePort()
    const machineToken = randomUUID()
    const logEnv: Record<string, string> = options.logLevel ? { PODIUM_LOG: options.logLevel } : {}

    // Each world its own state dir: a server database or daemon journal left by
    // the previous scenario would be a fault this one did not inject. Both
    // children inherit it, and so does this process's own machine-id read.
    const stateDir = join(tmp, 'state')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const previousStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = stateDir
    const started: {
      server?: DaemonProcessHandle
      link?: LinkProxy
      daemon?: DaemonProcessHandle
    } = {}
    const abandon = async (): Promise<void> => {
      await started.link?.close().catch(() => undefined)
      if (started.daemon?.alive()) await started.daemon.crash().catch(() => undefined)
      if (started.server?.alive()) await started.server.crash().catch(() => undefined)
      killProcessesWithEnv('PODIUM_TEST_DELIVERY_DIR', recordDir)
      if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previousStateDir
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
    try {
      // A real install's first run: the mode on disk, then setup (which sets the
      // operator password and back-fills the rest), then a restart to adopt it,
      // then a login. The devices are that logged-in operator.
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
      const serverDir = join(tmp, 'server')
      mkdirSync(serverDir, { recursive: true, mode: 0o700 })
      const serverConfig: ServerProcessConfig = {
        port: serverPort,
        machineToken,
        readyFile: join(serverDir, 'server-process.ready'),
      }
      const serverConfigPath = join(serverDir, 'server-process.json')
      writeFileSync(serverConfigPath, JSON.stringify(serverConfig), { mode: 0o600 })
      const server = await startEntryProcess({
        what: 'server',
        entry: SERVER_ENTRY,
        configPath: serverConfigPath,
        readyFile: serverConfig.readyFile,
        env: logEnv,
        readyTimeoutMs: 120_000,
      })
      started.server = server

      const anonymous = createTRPCClient<AppRouter>({
        links: [httpBatchLink({ url: `http://127.0.0.1:${serverPort}/trpc` })],
      })
      await anonymous.setup.complete.mutate({
        publicUrl: `http://127.0.0.1:${serverPort}`,
        password: OPERATOR_PASSWORD,
      })
      await server.stop()
      // Setup records the loopback address it was reached on as the public URL,
      // and a boot refuses to publish a loopback origin to other machines. The
      // upgrade lane strips it the same way (`upgrade-4428.integration.test.ts`).
      const configPath = join(stateDir, 'config.json')
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      delete written.publicUrl
      writeFileSync(configPath, JSON.stringify(written))
      await server.restart()
      const cookie = await login(serverPort)

      const link = await LinkProxy.start(`ws://127.0.0.1:${serverPort}`)
      started.link = link
      const daemon = await startDaemonProcess({
        dir: join(tmp, 'daemon'),
        options: {
          serverUrl: `ws://127.0.0.1:${link.port}`,
          machineToken,
          machineId: readOrCreateLocalMachineId(),
          identityDir: join(tmp, 'daemon-identity'),
          // A durable process is required for every spawn (POD-4617), and it is
          // what lets the agents outlive a daemon kill.
          backend: 'host',
          discovery: {
            background: false,
            cachePath: join(tmp, 'discovery.db'),
            homeDir: agentHome,
          },
          metrics: { background: false },
          hooks: { port: hookPort, settingsDir: join(tmp, 'hooks') },
          // Fixed like the hook port: the agents' CLI keeps posting to it across a
          // daemon restart.
          agentRelay: { port: relayPort },
        },
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ...logEnv,
          PODIUM_TEST_DELIVERY_DIR: recordDir,
          PODIUM_TEST_DELIVERY_HOOK_PORT: String(hookPort),
          PODIUM_TEST_DELIVERY_HOME: agentHome,
        },
        readyTimeoutMs: 120_000,
      })
      started.daemon = daemon

      const api = createTRPCClient<AppRouter>({
        links: [httpBatchLink({ url: `http://127.0.0.1:${serverPort}/trpc`, headers: { cookie } })],
      })
      return new DeliveryWorld(
        tmp,
        recordDir,
        serverPort,
        relayPort,
        server,
        link,
        daemon,
        api,
        cookie,
        previousStateDir,
      )
    } catch (error) {
      await abandon()
      throw error
    }
  }

  /** Sessions and devices, on a world whose processes are up. */
  private async populate(options: WorldOptions): Promise<void> {
    const { daemon, link, tmp } = this
    await waitFor(
      () => link.connected,
      60_000,
      'the daemon to connect through the link',
      () => daemon.output(4000),
    )
    let issueId: string | undefined
    const repo = join(tmp, 'repo')
    if (options.issue) {
      mkdirSync(repo, { recursive: true })
      const git = (...args: string[]): void => {
        execFileSync(
          'git',
          ['-C', repo, '-c', 'user.name=lane', '-c', 'user.email=lane@example.invalid', ...args],
          { stdio: 'ignore' },
        )
      }
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'root')
      const issue = (await this.api.issues.create.mutate({
        repoPath: repo,
        title: 'delivery outage lane',
        startNow: false,
        machineId: readOrCreateLocalMachineId(),
      })) as { id?: string }
      if (!issue.id) throw new Error(`issues.create answered ${JSON.stringify(issue)}`)
      issueId = issue.id
    }
    for (let index = 0; index < options.sessions; index += 1) {
      const cwd = options.issue ? repo : join(tmp, `work-${index}`)
      mkdirSync(cwd, { recursive: true })
      const created = (await this.api.sessions.create.mutate({
        agentKind: 'claude-code',
        cwd,
        ...(issueId ? { issueId: issueId as never } : {}),
      })) as { sessionId?: string }
      if (!created.sessionId) throw new Error(`sessions.create answered ${JSON.stringify(created)}`)
      this.sessionIds.push(created.sessionId as SessionId)
    }
    for (const sessionId of this.sessionIds) {
      await waitFor(
        async () => (await this.session(sessionId))?.status === 'live',
        60_000,
        `${sessionId} live`,
        () => daemon.output(4000),
      )
      await waitFor(
        () => this.booted(sessionId),
        30_000,
        `${sessionId}'s agent to boot`,
        () => daemon.output(4000),
      )
    }
    for (const name of options.devices) {
      const disk = newDeviceDisk()
      this.disks.set(name, disk)
      this.devices.set(
        name,
        await Device.open({
          name,
          serverPort: this.serverPort,
          cookie: this.cookie,
          sessionIds: this.sessionIds,
          disk,
        }),
      )
    }
  }

  device(name: string): Device {
    const device = this.devices.get(name)
    if (!device) throw new Error(`no device ${name}`)
    return device
  }

  async session(
    sessionId: SessionId,
  ): Promise<
    { status?: string; queuedMessageCount?: number; agentState?: { phase?: string } } | undefined
  > {
    const list = (await this.api.sessions.list.query()) as { sessionId: string; status?: string }[]
    return list.find((session) => session.sessionId === sessionId)
  }

  /** How long each of the agent's turns works (it cannot be typed into meanwhile). */
  setTurnMs(sessionId: SessionId, ms: number): void {
    writeFileSync(join(this.recordDir, `${sessionId}.turn-ms`), String(ms))
  }

  /** How long after a submit the agent shows any sign of having taken it. */
  setHookDelayMs(sessionId: SessionId, ms: number): void {
    writeFileSync(join(this.recordDir, `${sessionId}.hook-delay-ms`), String(ms))
  }

  private records(sessionId: string): SubmitRecord[] {
    const file = join(this.recordDir, `${sessionId}.jsonl`)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SubmitRecord]
        } catch {
          return []
        }
      })
  }

  /** Did the daemon accept a hook of this kind from the session's agent? */
  hookAccepted(sessionId: SessionId, event: string): boolean {
    return this.records(sessionId).some(
      (record) => record.t === 'hook' && record.event === event && record.status === 200,
    )
  }

  private booted(sessionId: SessionId): boolean {
    return this.records(sessionId).some((record) => record.t === 'boot')
  }

  /** Every prompt any agent was given, in the order each agent received them. */
  typed(): TypedPrompt[] {
    const sessions = existsSync(this.recordDir)
      ? readdirSync(this.recordDir)
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => name.slice(0, -'.jsonl'.length))
      : []
    return sessions.flatMap((sessionId) =>
      this.records(sessionId)
        .filter((record) => record.t === 'submit' && typeof record.prompt === 'string')
        .map((record) => ({ sessionId, prompt: record.prompt as string, at: record.at })),
    )
  }

  typedCount(id: string): number {
    return this.typed().filter((prompt) => prompt.prompt.includes(`[${id}]`)).length
  }

  /** The server's rows for every session, as the ledger serves them. */
  async rows(): Promise<ServerRow[]> {
    const rows: ServerRow[] = []
    for (const sessionId of this.sessionIds) {
      const page = (await this.api.messages.ledger.query({ sessionId, limit: 500 })) as Record<
        string,
        unknown
      >[]
      for (const row of page) {
        if (typeof row.id !== 'string' || row.to !== `session:${sessionId}`) continue
        rows.push({
          id: row.id,
          sessionId,
          body: typeof row.body === 'string' ? row.body : '',
          deliveryStatus: row.deliveryStatus as ServerRow['deliveryStatus'],
          ...(typeof row.deliveryDeferredReason === 'string'
            ? { reason: row.deliveryDeferredReason }
            : {}),
        })
      }
    }
    return rows
  }

  async observe(messages: readonly TrackedMessage[]): Promise<Observation> {
    for (const device of this.devices.values()) await device.refresh()
    const devices: DeviceObservation[] = []
    const outboxes = new Map<string, Map<string, 'sending' | 'failed'>>()
    for (const device of this.devices.values()) {
      const held = new Map<string, 'sending' | 'failed'>()
      for (const sessionId of this.sessionIds) {
        devices.push({ device: device.name, sessionId, screen: device.screen(sessionId) })
        for (const send of device.heldSends(sessionId)) held.set(send.mutationId, send.state)
      }
      outboxes.set(device.name, held)
    }
    return { messages, typed: this.typed(), rows: await this.rows(), devices, outboxes }
  }

  /**
   * Wait for the chain to come to rest: every tracked message either ended on
   * the server (a terminal status or `unknown`) or is held "not sent" by its
   * device, and nothing — prompts, statuses, screens — changed for `quietMs`.
   * A chain that never rests is itself the finding: after `timeoutMs` this
   * returns anyway and the oracle reports what is still stuck.
   */
  async settle(
    messages: readonly TrackedMessage[],
    options: { quietMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const quietMs = options.quietMs ?? 6_000
    const deadline = Date.now() + (options.timeoutMs ?? 90_000)
    let last = ''
    let stableSince = Date.now()
    while (Date.now() < deadline) {
      let snapshot = ''
      let resting = false
      try {
        const observed = await this.observe(messages)
        const byId = new Map(observed.rows.map((row) => [row.id, row.deliveryStatus]))
        resting = messages.every((message) => {
          const status = rowsFor(message, observed.rows).primary?.deliveryStatus
          if (status === undefined) {
            const held = message.sender
              ? observed.outboxes.get(message.sender)?.get(message.id)
              : undefined
            return held === 'failed'
          }
          return ['confirmed', 'cancelled', 'failed', 'expired', 'unknown'].includes(status)
        })
        snapshot = JSON.stringify({
          rows: [...byId].sort(),
          typed: observed.typed.length,
          screens: observed.devices.map((device) => [
            device.device,
            device.sessionId,
            [...device.screen].sort(),
          ]),
          held: [...observed.outboxes].map(([device, held]) => [device, [...held].sort()]),
        })
      } catch {
        snapshot = `unreachable@${Date.now()}`
      }
      if (snapshot !== last) {
        last = snapshot
        stableSince = Date.now()
      } else if (resting && Date.now() - stableSince >= quietMs) {
        return
      }
      await sleep(500)
    }
  }

  /** Close every device's app and open it again over the same disk. */
  async reloadDevice(name: string): Promise<void> {
    await this.device(name).reload()
  }

  async restartServer(how: 'crash' | 'stop'): Promise<void> {
    if (how === 'crash') await this.server.crash()
    else await this.server.stop()
    await this.server.restart()
  }

  async restartDaemon(how: 'crash' | 'stop'): Promise<void> {
    if (how === 'crash') await this.daemon.crash()
    else await this.daemon.stop()
    await this.daemon.restart()
  }

  /** The tail of both children's logs, for a failure message. */
  logs(maxChars = 6_000): string {
    return `--- server ---\n${this.server.output(maxChars)}\n--- daemon ---\n${this.daemon.output(maxChars)}`
  }

  /**
   * An agent running `podium session send <to> --text <text>`: the CLI's own
   * code (`runSessionCli`) over its own relay client, posting to the daemon's
   * agent relay as the SENDING session — so whatever the CLI does about ids and
   * repeats is what this lane exercises. Resolves with the CLI's output, or
   * rejects with its error.
   */
  async cliSend(from: SessionId, to: SessionId, text: string): Promise<string> {
    const client = makeRelayIssueClient(`http://127.0.0.1:${this.relayPort}/session/${from}`)
    return await runSessionCli(
      ['send', to, '--text', text],
      client as unknown as SessionControlClient,
      {
        hasRelay: true,
      },
    )
  }

  async close(): Promise<void> {
    // DELIVERY_OUTAGE_LOG_DIR keeps both children's logs past the world, for
    // proving a finding's mechanism after the run.
    const keep = process.env.DELIVERY_OUTAGE_LOG_DIR
    if (keep) {
      mkdirSync(keep, { recursive: true })
      const name = this.tmp.split('/').at(-1) ?? 'world'
      writeFileSync(join(keep, `${name}.server.log`), this.server.output())
      writeFileSync(join(keep, `${name}.daemon.log`), this.daemon.output())
    }
    for (const device of this.devices.values()) device.close()
    this.devices.clear()
    await this.link.close().catch(() => undefined)
    if (this.daemon.alive()) await this.daemon.crash().catch(() => undefined)
    if (this.server.alive()) await this.server.crash().catch(() => undefined)
    // The daemon reaps nothing on its way out, and its agents outlive it by
    // design (podium-host). Everything this world's daemon spawned carries the
    // record dir in its environment; that is how they are found and stopped.
    killProcessesWithEnv('PODIUM_TEST_DELIVERY_DIR', this.recordDir)
    if (this.previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = this.previousStateDir
    rmSync(this.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
