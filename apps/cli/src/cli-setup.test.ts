import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_CONFIG_VERSION, loadConfig, saveConfig } from '@podium/runtime/config'
import {
  CHECK_ERROR_SENTENCES,
  type CheckError,
  type CheckResult,
  describeCheckError,
} from '@podium/runtime/connect-check'
import { writeConnectivity } from '@podium/runtime/connectivity'
import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  mintInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { encodeJoin } from '@podium/runtime/join'
import { machinePublicKeyWire, readMachineCredential } from '@podium/runtime/machine-credential'
import { loadSupervisorState } from '@podium/runtime/machine-supervisor'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCheckIdentity, realCheckReachability } from './cli-reachability'
import {
  repairConfig,
  runCliSetup,
  runJoinSetup,
  runVpsSetup,
  shouldRunCliSetup,
  waitForDaemonEnrollment,
} from './cli-setup'
import type { TailscaleDeps, TailscaleState } from './setup-tailscale'
import { scriptedIO } from './setup-ui'

const priorStateDir = process.env.PODIUM_STATE_DIR!

/** Reachability rows, as the menu's `select` returns them (POD-3274: Tailscale is one row
 *  with a nested Funnel/Serve choice, and is walked by its own tests below). */
const MANUAL = 'manual'
const CLOUDFLARE_ROW = 'cloudflare-tunnel'
/** Every flow checks its URL once the server is up; by default, hermetically: "could not
 *  ask", which prints one line and changes nothing. Tests about the check override it. */
const HERMETIC = {
  checkReachability: async (): Promise<CheckResult | undefined> => undefined,
  checkInside: async () => true,
}
/** A backend stub that never spawns a process and echoes the persistence it was asked for. */
const echoBackend = async (o: { persistence: 'systemd' | 'detached' }) => ({
  effectivePersistence: o.persistence,
  message: '',
})

describe('shouldRunCliSetup (when `podium setup` launches the terminal flow)', () => {
  it('does not launch setup for a bare `podium` on an already-configured box', () => {
    expect(shouldRunCliSetup({ forceSetup: false, firstRunNeedsSetup: false, isTTY: true })).toBe(
      false,
    )
  })
  it('never runs the interactive flow without a TTY (headless/systemd/piped)', () => {
    expect(shouldRunCliSetup({ forceSetup: true, firstRunNeedsSetup: false, isTTY: false })).toBe(
      false,
    )
  })
  it('runs for any install on a TTY via explicit `setup` — menu lets you switch mode', () => {
    expect(shouldRunCliSetup({ forceSetup: true, firstRunNeedsSetup: false, isTTY: true })).toBe(
      true,
    )
  })
  it('launches setup for a still-unconfigured packaged/headless TTY launch', () => {
    expect(shouldRunCliSetup({ forceSetup: false, firstRunNeedsSetup: true, isTTY: true })).toBe(
      true,
    )
  })
  it('does NOT block a fresh box when non-interactive — headless serves the web setup URL', () => {
    expect(shouldRunCliSetup({ forceSetup: false, firstRunNeedsSetup: true, isTTY: false })).toBe(
      false,
    )
  })
})

describe('runCliSetup', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-clisetup-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  // One ordered answer queue per run, in the order an operator would give them. Returns the
  // scripted IO so a test can also assert on what was asked and what was printed.
  const start = (answers: unknown[], setPw: () => Promise<void> = vi.fn(async () => {})) => {
    const s = scriptedIO(answers)
    return {
      ...s,
      done: runCliSetup(s.io, 18787, {
        ...HERMETIC,
        setPassword: setPw,
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
        // Hermetic: whether THIS box has tailscale/cloudflared must not decide what the
        // flow prints. The missing-tool path has its own tests below.
        hasCommand: () => true,
      }),
    }
  }
  const run = (answers: unknown[], setPw: () => Promise<void> = vi.fn(async () => {})) =>
    start(answers, setPw).done

  describe('first run (mode menu)', () => {
    it.each([
      'all-in-one',
      'server',
    ] as const)('persists the %s setup request and key before starting the backend', async (mode) => {
      const { io } = scriptedIO([mode, MANUAL, 'https://hub.example', 's3cret', true])
      const startBackend = vi.fn(async (options: { persistence: 'systemd' | 'detached' }) => {
        const state = loadSupervisorState(dir)
        expect(state.setupEnrollment).toMatchObject({
          machineId: state.machineId,
          preauthorized: true,
          agentExecution: mode === 'all-in-one',
        })
        expect(state.setupEnrollment?.publicKey).toBe(
          machinePublicKeyWire(readMachineCredential(dir)!),
        )
        expect(state.enrolledPublicKey).toBeUndefined()
        return { effectivePersistence: options.persistence, message: 'started' }
      })
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
        activateImmediately: true,
      })
      expect(startBackend).toHaveBeenCalled()
    })

    it('sets up a fresh VPS directly as all-in-one without asking topology or telemetry', async () => {
      const startBackend = vi.fn(async () => ({
        effectivePersistence: 'systemd' as const,
        message: 'started',
      }))
      const { io, prompts } = scriptedIO([MANUAL, 'https://vps.ts.net', 's3cret', true])

      await runVpsSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
      })

      expect(prompts).not.toContain('What do you want this machine to do?')
      expect(prompts.some((prompt) => prompt.includes('telemetry'))).toBe(false)
      expect(loadConfig()).toMatchObject({
        mode: 'all-in-one',
        publicUrl: 'https://vps.ts.net',
        networkOption: 'manual',
        persistence: 'systemd',
      })
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
    })

    it('restarts once against the effective config when systemd falls back to detached', async () => {
      const startBackend = vi
        .fn()
        .mockResolvedValueOnce({ effectivePersistence: 'detached', message: 'fallback' })
        .mockResolvedValueOnce({ effectivePersistence: 'detached', message: 'ready' })

      const { io } = scriptedIO([MANUAL, 'https://vps.ts.net', 's3cret', true])
      await runVpsSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
        waitForEnrollment: async () => {},
      })

      expect(startBackend).toHaveBeenNthCalledWith(1, {
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(startBackend).toHaveBeenNthCalledWith(2, {
        persistence: 'detached',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(loadConfig().persistence).toBe('detached')
    })

    it('under activateImmediately the backend FIRST BOOTS against a config that already names the persistence', async () => {
      // The defect this pins, found end-to-end on two containers: `podium install-finish`
      // configured a hub, started it, and printed "Installed." — while /readiness answered
      // `activation_pending / restart_required` with the data plane BLOCKED and
      // `stale: ["persistence"]`, because the value was written after the process it
      // configures had already booted. Minting a join code on the new hub returned
      // `server_not_ready`. A one-paste install must not need a restart to work.
      //
      // Asserted at the MOMENT OF THE CALL, not afterwards: the end state is identical either
      // way, so a test that read the config after the flow would pass on the broken code.
      let persistenceAtBoot: string | undefined
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => {
        persistenceAtBoot = loadConfig().persistence
        return { effectivePersistence: o.persistence, message: 'started' }
      })
      const { io } = scriptedIO(['all-in-one', MANUAL, 'https://hub.example', 's3cret', true])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
        activateImmediately: true,
      })
      expect(persistenceAtBoot).toBe('systemd')
    })

    it('a plain `podium setup` does NOT pre-write it — that box is already running', async () => {
      let persistenceAtBoot: string | undefined
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => {
        persistenceAtBoot = loadConfig().persistence
        return { effectivePersistence: o.persistence, message: 'started' }
      })
      const { io } = scriptedIO(['all-in-one', MANUAL, 'https://hub.example', 's3cret', true])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
      })
      expect(persistenceAtBoot).toBeUndefined()
    })

    it('host a server here (all-in-one) → set URL then password', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false], setPw)
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(loadConfig().networkOption).toBe('manual')
      expect(setPw).toHaveBeenCalledWith('s3cret')
      expect(loadConfig().persistence).toBe('detached') // answered "n" to systemd
    })

    it('host the relay only (server) persists mode=server', async () => {
      await run(['server', MANUAL, 'https://relay.ts.net', '', true, true])
      expect(loadConfig().mode).toBe('server')
      expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
      expect(loadConfig().networkOption).toBe('manual')
      expect(loadConfig().persistence).toBe('systemd') // answered "y"
    })

    it('a blank password leaves the host open only after explicit confirmation', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', MANUAL, 'https://box.ts.net', '', true, false], setPw)
      expect(setPw).not.toHaveBeenCalled()
    })

    it('persistence: a blank answer defaults to systemd and starts the backend', async () => {
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'ok',
      }))
      // `undefined` = the operator pressed Enter without choosing, so the confirm's
      // initialValue (systemd, the recommended option) stands.
      const { io } = scriptedIO(['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', undefined])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
        waitForEnrollment: async () => {},
      })
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(loadConfig().persistence).toBe('systemd')
    })

    it('a CANCEL at the persistence question keeps the recommended systemd path', async () => {
      // The config is already written by the time this is asked, so the backend has to start
      // one way or the other. Ctrl-C here must not silently downgrade to detached, which
      // would leave a machine that quietly fails to come back after a reboot.
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'ok',
      }))
      // Queue ends before the persistence confirm — the scripted stand-in for Ctrl-C.
      const { io } = scriptedIO(['all-in-one', MANUAL, 'https://box.ts.net', 's3cret'])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
        waitForEnrollment: async () => {},
      })
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(loadConfig().persistence).toBe('systemd')
    })

    it('labels blank password as the no-password confirmation path', async () => {
      const { prompts, done } = start(['all-in-one', MANUAL, 'https://box.ts.net', '', true, false])
      await done
      expect(prompts).toContain('Password (leave blank to run without one)')
      expect(prompts).toContain('Run without a password?')
    })

    it('re-prompts for a password when no-password confirmation is not typed', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', MANUAL, 'https://box.ts.net', '', false, 's3cret', false], setPw)
      expect(setPw).toHaveBeenCalledWith('s3cret')
    })

    it('join a server as a worker (daemon), then starts the daemon (persistence choice)', async () => {
      const token = encodeJoin({
        v: 1,
        serverUrl: 'wss://relay.example',
        pairCode: 'ABCD-1234',
        name: 'box',
      })
      const setPw = vi.fn(async () => {})
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: '',
      }))
      // join, then decline systemd → detached
      const { io } = scriptedIO(['daemon', token, false])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: setPw,
        startBackend,
        waitForEnrollment: async () => {},
      })
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().serverUrl).toBe('wss://relay.example')
      expect(loadConfig().persistence).toBe('detached')
      // The join now STARTS the daemon rather than telling the user to restart.
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'detached',
        mode: 'daemon',
        port: 18787,
      })
      expect(setPw).not.toHaveBeenCalled()
    })

    it('a blank join code cancels without writing config', async () => {
      await run(['daemon'])
      expect(loadConfig().mode).toBeUndefined()
    })

    it('re-prompts on an invalid URL', async () => {
      await run(['all-in-one', MANUAL, 'nope', 'https://box.ts.net', 'pw', false])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('Ctrl-C/EOF during the password step leaves the box UNCONFIGURED (#21)', async () => {
      // URL was pasted, then stdin only ever yields '' (EOF): no password, no explicit
      // "open" ack → the flow must abort WITHOUT writing mode/publicUrl.
      await run(['all-in-one', MANUAL, 'https://box.ts.net'])
      expect(loadConfig()).toEqual({})
    })

    it('declining the no-password ack repeatedly aborts without saving (#21)', async () => {
      const setPw = vi.fn(async () => {})
      await run(
        [
          'all-in-one',
          MANUAL,
          'https://box.ts.net',
          '',
          false,
          '',
          false,
          '',
          false,
          '',
          false,
          '',
          false,
        ],
        setPw,
      )
      expect(setPw).not.toHaveBeenCalled()
      expect(loadConfig()).toEqual({})
    })

    it('gives up (bounded) when the URL prompt only ever returns empty', async () => {
      // Pick all-in-one and a network option, then never paste a URL. The queue drains,
      // which is the scripted stand-in for Ctrl-C, and the flow must END rather than spin —
      // the condition readline could only report as '' forever.
      const { output, done } = start(['all-in-one', MANUAL, '', '', ''])
      await done
      expect(loadConfig().publicUrl).toBeUndefined()
      expect(output.join('\n')).toContain('nothing saved')
    })
  })

  /**
   * TAILSCALE (POD-3274): one row, a nested Funnel/Serve choice, and setup acts on the state
   * Tailscale is actually in — never a foreground command, never an address to paste, and
   * never an operator change over somebody else's.
   */
  describe('Tailscale', () => {
    const READY = (operator?: string, operatorKnown = true): TailscaleState => ({
      kind: 'ready',
      dnsName: 'box.tail1234.ts.net',
      operator,
      operatorKnown,
    })

    function fakeTailscale(
      states: TailscaleState[],
      over: Partial<TailscaleDeps> = {},
    ): { deps: TailscaleDeps; runs: string[] } {
      const runs: string[] = []
      const queue = [...states]
      const deps: TailscaleDeps = {
        probe: () =>
          queue.length > 1 ? (queue.shift() as TailscaleState) : (queue[0] as TailscaleState),
        run: (command, args) => {
          runs.push([command, ...args].join(' '))
          return true
        },
        forwards: () => true,
        user: () => 'mgw',
        isRoot: () => false,
        ...over,
      }
      return { deps, runs }
    }

    function runTailscale(
      answers: unknown[],
      tailscale: TailscaleDeps,
      over: Record<string, unknown> = {},
    ) {
      const s = scriptedIO(answers)
      return {
        ...s,
        done: runCliSetup(s.io, 18787, {
          ...HERMETIC,
          hasCommand: () => true,
          setPassword: vi.fn(async () => {}),
          startBackend: echoBackend,
          waitForEnrollment: async () => {},
          tailscale,
          ...over,
        }),
      }
    }

    it('ready and this user is the operator: setup turns Funnel on itself, in the background, and reads the address', async () => {
      const { deps, runs } = fakeTailscale([READY('mgw')])
      const { prompts, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', 's3cret', false],
        deps,
      )
      await done
      expect(runs).toEqual(['tailscale funnel --bg 18787'])
      expect(prompts).toContain('Who should be able to reach it?')
      // Nothing to paste: the address comes from `tailscale status`.
      expect(prompts.some((p) => p.includes('https://'))).toBe(false)
      expect(loadConfig()).toMatchObject({
        publicUrl: 'https://box.tail1234.ts.net',
        networkOption: 'tailscale-funnel',
      })
    })

    it('root runs it too, whoever the operator is', async () => {
      const { deps, runs } = fakeTailscale([READY('alice')], { isRoot: () => true })
      const { done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-serve', 's3cret', false],
        deps,
      )
      await done
      expect(runs).toEqual(['tailscale serve --bg 18787'])
      expect(loadConfig().networkOption).toBe('tailscale-serve')
    })

    it('not installed: boxes install, start and sign-in in that order, then carries on once it is ready', async () => {
      const { deps, runs } = fakeTailscale([{ kind: 'missing' }, READY('mgw')])
      const { commands, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', true, 's3cret', false],
        deps,
      )
      await done
      expect(commands.slice(0, 3)).toEqual([
        'curl -fsSL https://tailscale.com/install.sh | sh',
        'sudo systemctl enable --now tailscaled',
        'sudo tailscale up',
      ])
      expect(runs).toEqual(['tailscale funnel --bg 18787'])
      expect(loadConfig().publicUrl).toBe('https://box.tail1234.ts.net')
    })

    it('signed out: boxes only the sign-in, not the install', async () => {
      const { deps } = fakeTailscale([{ kind: 'signed-out' }, READY('mgw')])
      const { commands, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', true, 's3cret', false],
        deps,
      )
      await done
      expect(commands[0]).toBe('sudo tailscale up')
      expect(commands).not.toContain('curl -fsSL https://tailscale.com/install.sh | sh')
    })

    it('giving up before Tailscale is ready saves nothing', async () => {
      const { deps } = fakeTailscale([{ kind: 'stopped' }])
      const { done } = runTailscale(['all-in-one', 'tailscale', 'tailscale-funnel', false], deps)
      await done
      expect(loadConfig().mode).toBeUndefined()
    })

    it('no operator yet: asks, makes this user the operator, then turns Funnel on', async () => {
      const { deps, runs } = fakeTailscale([READY(undefined)])
      const { prompts, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', true, 's3cret', false],
        deps,
      )
      await done
      expect(
        prompts.some((p) => p.startsWith("Let mgw manage Tailscale's Serve and Funnel?")),
      ).toBe(true)
      expect(runs).toEqual(['sudo tailscale set --operator=mgw', 'tailscale funnel --bg 18787'])
    })

    it('someone else is the operator: leaves it alone and boxes the one sudo command', async () => {
      const { deps, runs } = fakeTailscale([READY('alice')])
      const { commands, output, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', true, 's3cret', false],
        deps,
      )
      await done
      // Never `tailscale set --operator`: that would take it away from alice.
      expect(runs).toEqual([])
      expect(output.join('\n')).toContain("Tailscale's operator is alice")
      expect(commands).toContain('sudo tailscale funnel --bg 18787')
      expect(loadConfig().publicUrl).toBe('https://box.tail1234.ts.net')
    })

    it('an operator it cannot read is never replaced: boxes the sudo command instead', async () => {
      const { deps, runs } = fakeTailscale([READY(undefined, false)])
      const { prompts, commands, output, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-funnel', true, 's3cret', false],
        deps,
      )
      await done
      expect(prompts.some((p) => p.startsWith('Let mgw manage'))).toBe(false)
      expect(runs).toEqual([])
      expect(output.join('\n')).toContain('Could not read whether Tailscale has an operator')
      expect(commands).toContain('sudo tailscale funnel --bg 18787')
    })

    it('Serve is checked from inside the tailnet, never from the internet', async () => {
      const { deps } = fakeTailscale([READY('mgw')])
      const outside = vi.fn(async (): Promise<CheckResult | undefined> => undefined)
      const inside = vi.fn(async () => true)
      const { output, done } = runTailscale(
        ['all-in-one', 'tailscale', 'tailscale-serve', 's3cret', false],
        deps,
        { checkReachability: outside, checkInside: inside },
      )
      await done
      expect(outside).not.toHaveBeenCalled()
      expect(inside).toHaveBeenCalledWith('https://box.tail1234.ts.net')
      expect(output.join('\n')).toContain('answers through your tailnet')
    })
  })

  describe('my own reverse proxy', () => {
    it('says what the proxy has to do, names no proxy, and runs no command', async () => {
      const s = scriptedIO(['all-in-one', MANUAL, 'https://proxy.example', 's3cret', false])
      await runCliSetup(s.io, 18787, {
        ...HERMETIC,
        hasCommand: () => false,
        setPassword: vi.fn(async () => {}),
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
      })
      const text = s.output.join('\n')
      expect(text).toContain('forward everything to http://127.0.0.1:18787')
      expect(text).toContain('WebSocket')
      expect(text).toContain('X-Forwarded-Proto: https')
      expect(text).not.toMatch(/caddy|nginx/i)
      expect(s.commands).toEqual([])
      expect(loadConfig().publicUrl).toBe('https://proxy.example')
    })
  })

  describe('advisory reachability probe (POD-4534)', () => {
    const failWith =
      (error: CheckError, detail = 'probe detail'): (() => Promise<CheckResult>) =>
      async () => ({ ok: false, error, detail })
    const succeed: () => Promise<CheckResult> = async () => ({
      ok: true,
      url: 'https://box.ts.net',
      resolvedTo: ['203.0.113.7'],
    })
    const unavailable: () => Promise<CheckResult> = async () => ({
      ok: false,
      error: 'CONNECT_UNAVAILABLE',
      detail: 'cloud down',
    })
    const noOpinion = async (): Promise<CheckResult | undefined> => undefined

    const probeRun = (
      answers: unknown[],
      checkReachability: (url: string) => Promise<CheckResult | undefined>,
      setPw: () => Promise<void> = vi.fn(async () => {}),
    ) => {
      const s = scriptedIO(answers)
      return {
        ...s,
        setPw,
        done: runCliSetup(s.io, 18787, {
          ...HERMETIC,
          setPassword: setPw,
          startBackend: echoBackend,
          waitForEnrollment: async () => {},
          hasCommand: () => true,
          checkReachability,
        }),
      }
    }

    /** The same flow in an isolated state dir, so transcript comparisons never see a previous run. */
    const runFresh = async (
      answers: unknown[],
      deps: { checkReachability?: (url: string) => Promise<CheckResult | undefined> } = {},
    ) => {
      const fresh = mkdtempSync(join(tmpdir(), 'podium-probe-'))
      const outer = process.env.PODIUM_STATE_DIR
      process.env.PODIUM_STATE_DIR = fresh
      try {
        const s = scriptedIO(answers)
        await runCliSetup(s.io, 18787, {
          ...HERMETIC,
          setPassword: vi.fn(async () => {}),
          startBackend: echoBackend,
          waitForEnrollment: async () => {},
          hasCommand: () => true,
          ...deps,
        })
        return { prompts: s.prompts, output: s.output, transcript: s.transcript }
      } finally {
        process.env.PODIUM_STATE_DIR = outer
        rmSync(fresh, { recursive: true, force: true })
      }
    }

    it('runs once the server is up, and a failure kept leaves the URL and completes the flow', async () => {
      const setPw = vi.fn(async () => {})
      const { output, prompts, done } = probeRun(
        ['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false, 'keep'],
        failWith('PORT_NOT_REACHABLE'),
        setPw,
      )
      await done
      expect(loadConfig()).toMatchObject({
        mode: 'all-in-one',
        publicUrl: 'https://box.ts.net',
        networkOption: 'manual',
        persistence: 'detached',
      })
      expect(setPw).toHaveBeenCalledWith('s3cret')
      // Said in a sentence a non-expert can act on, with the cloud's detail kept.
      expect(output.join('\n')).toContain('Nothing is listening on that port from the outside')
      expect(output.join('\n')).toContain('The probe reported: probe detail')
      expect(prompts).toContain('What now?')
      // AFTER the backend started: on a fresh box nothing could answer before that.
      expect(
        output.indexOf('Saved. This instance is reachable at https://box.ts.net.'),
      ).toBeLessThan(output.findIndex((line) => line.includes('Nothing is listening on that port')))
    })

    it('a failure answered "change" walks the reachability step again and checks the new URL', async () => {
      const checkReachability = async (url: string): Promise<CheckResult | undefined> =>
        url === 'https://bad.example'
          ? { ok: false, error: 'DNS_FAILED', detail: '' }
          : { ok: true, url, resolvedTo: [] }
      const { output, prompts, done } = probeRun(
        [
          'all-in-one',
          MANUAL,
          'https://bad.example',
          'pw',
          false,
          'change',
          MANUAL,
          'https://good.ts.net',
        ],
        checkReachability,
      )
      await done
      // The declined URL was never saved; the re-asked one was, and the flow completed.
      expect(loadConfig().publicUrl).toBe('https://good.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().persistence).toBe('detached')
      expect(output.join('\n')).toContain('does not resolve to an address')
      expect(prompts).toContain('What now?')
      // Checked twice: once for the bad URL, once for the re-asked one, plus the success line.
      expect(output.join('\n')).toContain(
        'Reachable — an outside probe connected to https://good.ts.net.',
      )
    })

    it('every CheckError maps to a sentence a non-expert can act on', async () => {
      const all: CheckError[] = [
        'INVALID_URL',
        'DNS_FAILED',
        'PRIVATE_ADDRESS',
        'REDIRECTED',
        'TLS_INVALID',
        'PORT_NOT_REACHABLE',
        'UNREACHABLE',
        'NOT_PODIUM',
        'IDENTITY_MISMATCH',
        'CONNECT_UNAVAILABLE',
      ]
      // Total: the map covers the union exactly, so adding a code fails here (and at
      // compile time, since the map is a Record over the union) until its sentence exists.
      expect(Object.keys(CHECK_ERROR_SENTENCES).sort()).toEqual([...all].sort())
      for (const error of all) {
        const sentence = describeCheckError(error)
        expect(sentence.trim().length).toBeGreaterThan(20)
        expect(sentence).toMatch(/\.$/)
        // The sentence is the translation — it never leaks the raw code.
        expect(sentence).not.toContain(error)
      }
    })

    it('CONNECT_UNAVAILABLE and no-opinion are byte-identical to the flow that never asked', async () => {
      const answers = ['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false]
      const base = await runFresh(answers, { checkReachability: noOpinion })
      const down = await runFresh(answers, { checkReachability: unavailable })
      expect(down.prompts).toEqual(base.prompts)
      expect(down.output).toEqual(base.output)
      expect(down.transcript).toEqual(base.transcript)
      expect(base.output).toContain(
        'Could not run the outside reachability check right now; skipped it.',
      )
    })

    it('a cloud answer the CLI predates still asks instead of crashing', async () => {
      // The verdict arrives as a cast: a newer code, or a missing detail, must degrade to a
      // generic warning and the same override — never a throw inside setup.
      const future = async (): Promise<CheckResult> =>
        ({ ok: false, error: 'SOME_FUTURE_CODE', detail: undefined }) as unknown as CheckResult
      const { output, prompts, done } = probeRun(
        ['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false, 'keep'],
        future,
      )
      await done
      expect(output.join('\n')).toContain('SOME_FUTURE_CODE')
      expect(prompts).toContain('What now?')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('a reachable URL is acknowledged in one line and the flow carries on', async () => {
      const { output, done } = probeRun(
        ['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false],
        succeed,
      )
      await done
      expect(output.join('\n')).toContain(
        'Reachable — an outside probe connected to https://box.ts.net.',
      )
      expect(output.join('\n')).not.toContain('What now?')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('Connect off short-circuits the default probe before any identity or network', async () => {
      seedIdentity(dir)
      const fetchMock = vi.fn(async () => {
        throw new Error('Connect off must not fetch')
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('PODIUM_CONNECT', 'off')
      try {
        const { io, output } = scriptedIO([])
        expect(await realCheckReachability('https://box.ts.net', io)).toBeUndefined()
        expect(fetchMock).not.toHaveBeenCalled()
        expect(output).toEqual([])
      } finally {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
      }
    })

    it('waits for the identity the server mints on its first boot, then probes (POD-3274)', async () => {
      const seen: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          seen.push(String(url))
          return Response.json({ ok: true, url: 'https://box.ts.net', resolvedTo: [] })
        }),
      )
      try {
        // Fresh box: no identity yet. It appears a moment after the check starts.
        expect(loadCheckIdentity()).toBeUndefined()
        let identity: { installationId: string } | undefined
        setTimeout(() => {
          identity = seedIdentity(dir)
        }, 300)
        const { io } = scriptedIO([])
        const result = await realCheckReachability('https://box.ts.net', io, {
          waitForIdentityMs: 5_000,
        })
        expect(result).toMatchObject({ ok: true })
        expect(seen).toEqual([
          `https://connect.podium.do/v1/installations/${identity?.installationId}/check`,
        ])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('an identity that never appears is "could not ask", with no request sent', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('must not fetch without an identity')
      })
      vi.stubGlobal('fetch', fetchMock)
      try {
        const { io } = scriptedIO([])
        expect(
          await realCheckReachability('https://box.ts.net', io, { waitForIdentityMs: 300 }),
        ).toBeUndefined()
        expect(fetchMock).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('the default probe signs as this installation when it has an identity', async () => {
      const identity = seedIdentity(dir)
      const seen: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          seen.push(String(url))
          return Response.json({ ok: true, url: 'https://box.ts.net', resolvedTo: [] })
        }),
      )
      try {
        expect(loadCheckIdentity()?.installationId).toBe(identity.installationId)
        const { io } = scriptedIO([])
        const result = await realCheckReachability('https://box.ts.net', io)
        expect(result).toEqual({ ok: true, url: 'https://box.ts.net', resolvedTo: [] })
        expect(seen).toEqual([
          `https://connect.podium.do/v1/installations/${identity.installationId}/check`,
        ])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('a cloud failure in the default probe answers CONNECT_UNAVAILABLE, never throws', async () => {
      seedIdentity(dir)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        }),
      )
      try {
        const { io } = scriptedIO([])
        expect(await realCheckReachability('https://box.ts.net', io)).toEqual({
          ok: false,
          error: 'CONNECT_UNAVAILABLE',
          detail: 'fetch failed',
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })

    /** Minimal podium.db carrying just an installation identity for the default-probe tests. */
    function seedIdentity(stateDir: string) {
      const identity = mintInstallationIdentity()
      const { privateKey, ...metadata } = identity
      const db = openDatabase(join(stateDir, 'podium.db'))
      try {
        db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
        db.exec('CREATE TABLE server_secrets (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
          INSTALLATION_META_KEY,
          JSON.stringify(metadata),
        )
        db.prepare('INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)').run(
          INSTALLATION_PRIVATE_KEY,
          privateKey,
          identity.createdAt,
        )
      } finally {
        db.close()
      }
      return identity
    }
  })

  describe('runJoinSetup — non-interactive `podium setup --join` (#20)', () => {
    it('applies the token, starts the daemon with the asked persistence, and records the result', async () => {
      saveConfig({ updateChannel: 'edge' }) // install.sh --channel edge wrote this first
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'started',
      }))
      const token = encodeJoin({
        v: 1,
        serverUrl: 'wss://relay.example',
        pairCode: 'P1',
        name: 'vps',
      })
      const res = await runJoinSetup(token, 'systemd', 18787, {
        startBackend,
        waitForEnrollment: async () => {},
      })
      expect(res.name).toBe('vps')
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'daemon',
        port: 18787,
      })
      expect(loadConfig()).toEqual({
        configVersion: CURRENT_CONFIG_VERSION,
        mode: 'daemon',
        serverUrl: 'wss://relay.example',
        pairCode: 'P1',
        updateChannel: 'edge', // #20: the join no longer reverts the channel
        persistence: 'systemd',
      })
    })
    it('records the EFFECTIVE persistence when systemd falls back to detached', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
      await runJoinSetup(token, 'systemd', 18787, {
        startBackend: async () => ({ effectivePersistence: 'detached', message: 'fallback' }),
        waitForEnrollment: async () => {},
      })
      expect(loadConfig().persistence).toBe('detached')
    })
    it('throws on a malformed token without touching config', async () => {
      saveConfig({ updateChannel: 'edge' })
      await expect(
        runJoinSetup('garbage!', 'systemd', 18787, {
          startBackend: vi.fn(async () => ({
            effectivePersistence: 'systemd' as const,
            message: '',
          })),
        }),
      ).rejects.toThrow()
      expect(loadConfig()).toEqual({ configVersion: CURRENT_CONFIG_VERSION, updateChannel: 'edge' })
    })
  })

  describe('corrupt config protection + --repair (#21)', () => {
    it('runCliSetup refuses to walk the flow over an existing-but-invalid config', async () => {
      writeFileSync(join(dir, 'config.json'), '{not json')
      const { output, prompts, done } = start(['all-in-one'])
      await done
      expect(output.join('\n')).toContain('--repair')
      expect(prompts).toEqual([]) // bailed before asking anything
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{not json') // untouched
    })

    it('repairConfig backs up (never deletes) the invalid file', async () => {
      writeFileSync(join(dir, 'config.json'), '{not json')
      const r = repairConfig()
      expect(r.state).toBe('repaired')
      expect(existsSync(join(dir, 'config.json'))).toBe(false)
      expect(r.backupPath && readFileSync(r.backupPath, 'utf8')).toBe('{not json')
      expect(readdirSync(dir).some((f) => f.startsWith('config.json.invalid-'))).toBe(true)
    })

    it('repairConfig leaves a valid config alone', async () => {
      saveConfig({ mode: 'all-in-one' })
      expect(repairConfig()).toEqual({ state: 'ok' })
      expect(loadConfig().mode).toBe('all-in-one')
    })

    it('repairConfig reports a fresh box as missing', async () => {
      expect(repairConfig()).toEqual({ state: 'missing' })
    })
  })

  describe('already configured as a host (extra edit options)', () => {
    beforeEach(() => {
      saveConfig({ mode: 'all-in-one', publicUrl: 'https://existing.ts.net' })
    })

    it('change the login password only (option 5), leaving the URL', async () => {
      const setPw = vi.fn(async () => {})
      await run(['password', 'rotated-pw'], setPw)
      expect(setPw).toHaveBeenCalledWith('rotated-pw')
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
    })

    it('change the reachable URL only (option 4), leaving the mode + password', async () => {
      const setPw = vi.fn(async () => {})
      // The trailing CHANGE is the confirmation a REPLACEMENT now asks for: this
      // box already has a URL, and every machine that joined at it is about to be
      // stranded (PDM-26).
      await run(['url', MANUAL, 'https://new.ts.net', 'CHANGE'], setPw)
      expect(loadConfig().publicUrl).toBe('https://new.ts.net')
      expect(loadConfig().networkOption).toBe('manual')
      expect(loadConfig().mode).toBe('all-in-one')
      expect(setPw).not.toHaveBeenCalled()
    })

    it('switch an existing host to daemon by pasting a join code', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'EFGH-5678' })
      await run(['daemon', token])
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().serverUrl).toBe('wss://relay.example')
    })

    it('a blank menu choice changes nothing', async () => {
      await run([])
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
    })

    it('change telemetry only (option 6), leaving mode/URL/password alone', async () => {
      const setPw = vi.fn(async () => {})
      await run(['telemetry', true, false], setPw)
      expect(loadConfig().telemetry).toMatchObject({ usage: 'on', crash: 'off' })
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
      expect(setPw).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------
  // Telemetry step [spec:SP-f933]
  // ------------------------------------------------------------------
  describe('telemetry step (the last step of the host flow)', () => {
    const HOST_ANSWERS: unknown[] = ['all-in-one', MANUAL, 'https://box.ts.net', 's3cret', false]

    it('is reached only AFTER the install works (step 8)', async () => {
      const order: string[] = []
      const s = scriptedIO([...HOST_ANSWERS, true, true])
      const io = {
        ...s.io,
        confirm: async (o: { message: string; initialValue?: boolean }) => {
          if (o.message.includes('systemd')) order.push('persistence')
          if (o.message.includes('usage reports')) order.push('telemetry')
          return s.io.confirm(o)
        },
      }
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend: async (o) => {
          order.push('startBackend')
          return { effectivePersistence: o.persistence, message: '' }
        },
      })
      // Telemetry is the last thing asked, and the backend is already up when
      // it is — which is exactly why consent must be read fresh at flush (D9).
      expect(order).toEqual(['persistence', 'startBackend', 'telemetry'])
      expect(loadConfig().telemetry).toMatchObject({ usage: 'on', crash: 'on' })
    })

    it('shows the example report and the opt-out routes in the prompt', async () => {
      const { output, done } = start([...HOST_ANSWERS, false, false])
      await done
      const out = output.join('\n')
      expect(out).toContain('Anonymous telemetry (opt-in)')
      expect(out).toContain('"installAge": "1-7d"')
      expect(out).toContain('podium telemetry off')
      expect(out).toContain('Settings → Privacy')
    })

    it('defaults to NO — Enter-Enter opts out of both', async () => {
      await run([...HOST_ANSWERS, false, false])
      expect(loadConfig().telemetry).toMatchObject({ usage: 'off', crash: 'off' })
      expect(loadConfig().telemetry?.installId).toBeUndefined()
    })

    it('records an explicit off (which is not the same as never asked)', async () => {
      await run([...HOST_ANSWERS, false, false])
      expect(loadConfig().telemetry?.usage).toBe('off')
    })

    it('each tier is consented independently', async () => {
      await run([...HOST_ANSWERS, false, true])
      expect(loadConfig().telemetry).toMatchObject({ usage: 'off', crash: 'on' })
    })

    it('Ctrl-C at the telemetry step leaves a WORKING install with telemetry absent', async () => {
      // The reason this step is last: abandoning it costs the user nothing.
      // stdin EOF resolves '' forever — the bounded prompt must not spin, and
      // '' is a NO, so the box ends up configured with telemetry off.
      await run(HOST_ANSWERS) // nothing left to answer → '' forever
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(loadConfig().persistence).toBe('detached')
      expect(loadConfig().telemetry?.installId).toBeUndefined()
    })

    it('DO_NOT_TRACK suppresses the PROMPT, not just the sending', async () => {
      process.env.DO_NOT_TRACK = '1'
      try {
        const { prompts, done } = start([...HOST_ANSWERS])
        await done
        expect(prompts.some((p) => p.includes('usage reports'))).toBe(false)
        // Not even an 'off' is written: we never asked, so we record nothing.
        expect(loadConfig().telemetry).toBeUndefined()
        expect(loadConfig().mode).toBe('all-in-one') // the install still works
      } finally {
        delete process.env.DO_NOT_TRACK
      }
    })

    it('PODIUM_TELEMETRY=off suppresses the prompt too', async () => {
      process.env.PODIUM_TELEMETRY = 'off'
      try {
        await run([...HOST_ANSWERS, true, true])
        expect(loadConfig().telemetry).toBeUndefined()
      } finally {
        delete process.env.PODIUM_TELEMETRY
      }
    })

    it('the JOIN path is never prompted (D10 — the hub decided)', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'ABCD-1234' })
      const { prompts, done } = start(['daemon', token, false])
      await done
      expect(loadConfig().mode).toBe('daemon')
      expect(prompts.some((p) => p.includes('usage reports'))).toBe(false)
      expect(loadConfig().telemetry).toBeUndefined()
    })

    it('the non-interactive `podium setup --join` never prompts either', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'ABCD-1234' })
      await runJoinSetup(token, 'systemd', 18787, {
        startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
        waitForEnrollment: async () => {},
      })
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().telemetry).toBeUndefined()
    })

    it('the telemetry menu entry is host-only', async () => {
      // Fresh box (no mode): the host-only entries are not OFFERED at all.
      const fresh = start([])
      await fresh.done
      expect(fresh.prompts.join('\n')).not.toContain('Change telemetry')

      saveConfig({ mode: 'all-in-one', publicUrl: 'https://x.ts.net' })
      const host = start([])
      await host.done
      expect(host.prompts.join('\n')).toContain('Change telemetry')
    })
  })
})

/**
 * What the DEPLOYMENT owns, `podium setup` may not write (PDM-26) — and
 * replacing a live public URL is a decision, not a step.
 */
describe('runCliSetup under a deployment that owns the answers', () => {
  let dir: string
  const priorDir = process.env.PODIUM_STATE_DIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-clisetup-env-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    process.env.PODIUM_STATE_DIR = priorDir
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (answers: unknown[], deps: Record<string, unknown> = {}) => {
    const s = scriptedIO(answers)
    return {
      out: s.output,
      done: runCliSetup(s.io, 18787, {
        ...HERMETIC,
        setPassword: vi.fn(async () => {}),
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
        hasCommand: () => true,
        ...deps,
      }),
    }
  }

  it('refuses the mode menu items under PODIUM_MODE, before asking anything else', async () => {
    vi.stubEnv('PODIUM_MODE', 'server')
    const { out, done } = run(['all-in-one'])
    await done
    expect(out.join('\n')).toMatch(/PODIUM_MODE is set in this deployment's environment/)
    expect(loadConfig().mode).toBeUndefined()
  })

  it('refuses the URL edit under PODIUM_PUBLIC_URL', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    vi.stubEnv('PODIUM_PUBLIC_URL', 'https://forced.example')
    const { out, done } = run(['url'])
    await done
    expect(out.join('\n')).toMatch(/PODIUM_PUBLIC_URL is set in this deployment's environment/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })

  it('asks before replacing a live public URL, and leaves it alone on a refusal', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    // menu 4 → network option 4 (manual) → the new URL → the confirmation word
    // A blank confirmation is a refusal: the prompt says "leave blank to keep".
    const { out, done } = run(['url', MANUAL, 'https://b.example', ''])
    await done
    expect(out.join('\n')).toMatch(/strands every machine that joined at the old URL/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })

  it('replaces it when the operator types the word', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', MANUAL, 'https://b.example', 'CHANGE'])
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('--confirm-url-change answers the question ahead of a prompt that cannot be shown', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', MANUAL, 'https://b.example'], { confirmUrlChange: true })
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('re-pasting the SAME URL is never a change and is never questioned', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { out, done } = run(['url', MANUAL, 'https://a.example'])
    await done
    expect(out.join('\n')).not.toMatch(/strands every machine/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })
})

/**
 * POD-3826. `connectivity.json` is shared by every process that has ever held this
 * machine's link, and a record outlives the daemon that wrote it. The join wait is the
 * reader with the worst consequence: `podium setup --join` is a one-shot operation an
 * operator performs once and then trusts, and all three of its terminal branches read
 * the raw file — a stale `connected` returns success with no live link, a stale
 * `unauthorized`/`blocked` throws an error naming a rejection that may be long over.
 *
 * The fence is the writer's `processId` (POD-3815). Suppressing the dead writer's record
 * fixes all three at once: the loop then sees nothing, which is exactly the state of a
 * join that has not happened yet, and keeps waiting for the real daemon until its
 * deadline. Suppression is only ever on PROOF — a record naming no writer still counts.
 */
describe('waitForDaemonEnrollment ignores a dead daemon s leftover record (POD-3826)', () => {
  let dir: string
  const priorDir = process.env.PODIUM_STATE_DIR
  /** Beyond pid_max — guaranteed not alive. */
  const deadPid = 2 ** 30

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-joinwait-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorDir
    rmSync(dir, { recursive: true, force: true })
  })

  /** A clock the wait drives itself: every poll sleep advances it, so the deadline is
   *  reached in five iterations rather than thirty real seconds. */
  const scriptedClock = () => {
    let t = 0
    let sleeps = 0
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps += 1
        t += ms
      },
      get sleeps() {
        return sleeps
      },
    }
  }
  const wait = (clock: ReturnType<typeof scriptedClock>) =>
    waitForDaemonEnrollment({ timeoutMs: 500, pollMs: 100, now: clock.now, sleep: clock.sleep })

  it('returns as soon as the LIVE daemon reports connected', async () => {
    writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    const clock = scriptedClock()
    await expect(wait(clock)).resolves.toBeUndefined()
    expect(clock.sleeps, 'a live record ends the wait on the first poll').toBe(0)
  })

  it('keeps waiting through a dead daemon s connected record instead of declaring success', async () => {
    writeConnectivity({ state: 'connected', processId: deadPid }, dir)
    const clock = scriptedClock()
    await expect(wait(clock)).rejects.toThrow(/did not connect within 1 second/)
    expect(clock.sleeps, 'it polls to the deadline, as for a join that has not happened').toBe(5)
  })

  /** One rejection, two questions: it must be the deadline, and it must not carry the
   *  dead daemon's refusal reason at an operator whose join is not being refused. */
  const failureOf = async (clock: ReturnType<typeof scriptedClock>) => {
    const error = await wait(clock).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    if (!error) throw new Error('the wait returned success on a dead daemon s record')
    return error.message
  }

  it('does not throw a dead daemon s unauthorized rejection at a join that is fine', async () => {
    writeConnectivity(
      { state: 'unauthorized', processId: deadPid, authorizationReason: 'bad-token' },
      dir,
    )
    const message = await failureOf(scriptedClock())
    expect(message, 'a rejection nobody is making must not be named').not.toContain('bad-token')
    expect(message).toMatch(/did not connect within/)
  })

  it('does not throw a dead daemon s blocked refusal at a join that is fine', async () => {
    writeConnectivity(
      { state: 'blocked', processId: deadPid, blockedReason: 'machine-revoked' },
      dir,
    )
    const message = await failureOf(scriptedClock())
    expect(message, 'a refusal that is long over must not be named').not.toContain(
      'machine-revoked',
    )
    expect(message).toMatch(/did not connect within/)
  })

  it('still trusts a record that names no writer — absence is not proof of staleness', async () => {
    writeConnectivity({ state: 'connected' }, dir)
    await expect(wait(scriptedClock())).resolves.toBeUndefined()
  })
})

/**
 * THE MANAGED QUICK TUNNEL (POD-3274): picking Cloudflare means Podium runs it. No URL
 * to paste — the address is unknown until the tunnel starts, which needs the server up.
 */
describe('runCliSetup: Cloudflare quick tunnel run by Podium', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-clisetup-tunnel-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  const TUNNEL_URL = 'https://quiet-river-1234.trycloudflare.com'
  const CLOUDFLARE = CLOUDFLARE_ROW

  function runTunnel(answers: unknown[], over: Record<string, unknown> = {}) {
    const events: string[] = []
    const s = scriptedIO(answers)
    const done = runCliSetup(s.io, 18787, {
      ...HERMETIC,
      hasCommand: () => true,
      setPassword: vi.fn(async () => {
        events.push('password')
      }),
      startBackend: async (o) => {
        events.push('backend')
        return { effectivePersistence: o.persistence, message: '' }
      },
      waitForEnrollment: async () => {},
      managedTunnel: {
        hasCloudflared: () => true,
        canSupervise: () => true,
        download: async () => {
          events.push('download')
          return '/home/u/.podium/bin/cloudflared'
        },
        enable: () => {
          events.push('enable')
          return { ok: true, unit: 'podium-tunnel.service' }
        },
        waitForUrl: async () => TUNNEL_URL,
        ...over,
      },
    })
    return { ...s, events, done }
  }

  it('asks for no URL, starts the tunnel AFTER the server, and shows the address it got', async () => {
    const { prompts, output, events, done } = runTunnel(['all-in-one', CLOUDFLARE, 's3cret', true])
    await done
    expect(prompts.some((p) => p.includes('trycloudflare.com URL'))).toBe(false)
    expect(events).toEqual(['password', 'backend', 'enable'])
    expect(output).toContain(`The Cloudflare tunnel is up at ${TUNNEL_URL}`)
    expect(loadConfig()).toMatchObject({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel' })
    // No URL is saved by setup: the server records the tunnel's own.
    expect(loadConfig().publicUrl).toBeUndefined()
  })

  it('checks the tunnel address from this machine, through Cloudflare, not with the outside probe', async () => {
    const outside = vi.fn(async (): Promise<CheckResult | undefined> => undefined)
    const inside = vi.fn(async () => true)
    const s = scriptedIO(['all-in-one', CLOUDFLARE, 's3cret', true])
    await runCliSetup(s.io, 18787, {
      hasCommand: () => true,
      setPassword: vi.fn(async () => {}),
      startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
      waitForEnrollment: async () => {},
      checkReachability: outside,
      checkInside: inside,
      managedTunnel: {
        hasCloudflared: () => true,
        canSupervise: () => true,
        enable: () => ({ ok: true, unit: 'podium-tunnel.service' }),
        waitForUrl: async () => TUNNEL_URL,
      },
    })
    expect(outside).not.toHaveBeenCalled()
    expect(inside).toHaveBeenCalledWith(TUNNEL_URL)
    expect(s.output).toContain(`Reachable — ${TUNNEL_URL} answers through Cloudflare.`)
  })

  it('labels the row as run by Podium, never as "not installed"', async () => {
    const { prompts, done } = runTunnel(['all-in-one'])
    await done
    expect(prompts.some((p) => p.startsWith('Cloudflare quick tunnel, run by Podium'))).toBe(true)
    expect(prompts.some((p) => p.includes('cloudflared is not installed —'))).toBe(false)
  })

  it('downloads cloudflared when missing — after asking, and before the password', async () => {
    const { prompts, events, done } = runTunnel(['all-in-one', CLOUDFLARE, true, 's3cret', true], {
      hasCloudflared: () => false,
    })
    await done
    expect(
      prompts.some((p) => p.startsWith('cloudflared is not installed. Download it now?')),
    ).toBe(true)
    expect(events).toEqual(['download', 'password', 'backend', 'enable'])
  })

  it('declining the download saves nothing and boxes the install command instead', async () => {
    const { commands, events, done } = runTunnel(['all-in-one', CLOUDFLARE, false], {
      hasCloudflared: () => false,
    })
    await done
    expect(events).toEqual([])
    expect(commands.some((c) => c.includes('cloudflared-linux-'))).toBe(true)
    expect(loadConfig().mode).toBeUndefined()
  })

  it('a failed download saves nothing and says why', async () => {
    const { output, events, done } = runTunnel(['all-in-one', CLOUDFLARE, true], {
      hasCloudflared: () => false,
      download: async () => {
        throw new Error('download failed: 404 Not Found')
      },
    })
    await done
    expect(events).toEqual([])
    expect(output.join('\n')).toContain('Could not download cloudflared: download failed: 404')
    expect(loadConfig().mode).toBeUndefined()
  })

  it('no address in time: says where to look, and the setup itself still stands', async () => {
    const { commands, done } = runTunnel(['all-in-one', CLOUDFLARE, 's3cret', true], {
      waitForUrl: async () => undefined,
    })
    await done
    expect(commands).toContain('journalctl --user -u podium-tunnel.service -f')
    expect(loadConfig().networkOption).toBe('cloudflare-tunnel')
  })

  it('without a systemd user session, falls back to running cloudflared by hand and pasting', async () => {
    const { commands, events, done } = runTunnel(
      ['all-in-one', CLOUDFLARE, TUNNEL_URL, 's3cret', true],
      { canSupervise: () => false },
    )
    await done
    expect(commands).toContain('cloudflared tunnel --url http://127.0.0.1:18787')
    expect(events).not.toContain('enable')
    expect(loadConfig().publicUrl).toBe(TUNNEL_URL)
  })

  it('replacing an earlier quick-tunnel address does not demand CHANGE', async () => {
    saveConfig({ ...loadConfig(), publicUrl: 'https://old-one.trycloudflare.com' })
    const { prompts, events, done } = runTunnel(['all-in-one', CLOUDFLARE, 's3cret', true])
    await done
    expect(prompts.some((p) => p.startsWith('Type CHANGE'))).toBe(false)
    expect(events).toContain('enable')
  })

  it('replacing a durable address still asks first', async () => {
    saveConfig({ ...loadConfig(), publicUrl: 'https://box.ts.net' })
    const { prompts, events, done } = runTunnel(['all-in-one', CLOUDFLARE, ''])
    await done
    expect(prompts).toContain('Type CHANGE to replace it with a Cloudflare quick tunnel')
    expect(events).toEqual([])
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
  })
})
