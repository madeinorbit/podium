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
  recordPublicUrlNow,
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
/** Every flow checks its URL right after setting it; by default, hermetically: Connect
 *  "could not ask", and this machine reaches it. Tests about the check override both. */
const HERMETIC = {
  checkReachability: async (): Promise<CheckResult | undefined> => undefined,
  checkInside: async () => true,
  // Never the real control socket: the address goes straight into config.
  recordPublicUrl: async (url: string) => saveConfig({ ...loadConfig(), publicUrl: url }),
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
      const { io } = scriptedIO([mode, 's3cret', true, MANUAL, 'https://hub.example'])
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
      const { io, prompts } = scriptedIO(['s3cret', true, MANUAL, 'https://vps.ts.net'])

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

      const { io } = scriptedIO(['s3cret', true, MANUAL, 'https://vps.ts.net'])
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
      const { io } = scriptedIO(['all-in-one', 's3cret', true, MANUAL, 'https://hub.example'])
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
      const { io } = scriptedIO(['all-in-one', 's3cret', true, MANUAL, 'https://hub.example'])
      await runCliSetup(io, 18787, {
        ...HERMETIC,
        hasCommand: () => true,
        setPassword: vi.fn(async () => {}),
        startBackend,
      })
      expect(persistenceAtBoot).toBeUndefined()
    })

    it('host a server here (all-in-one) → password, start, then the URL', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net'], setPw)
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(loadConfig().networkOption).toBe('manual')
      expect(setPw).toHaveBeenCalledWith('s3cret')
      expect(loadConfig().persistence).toBe('detached') // answered "n" to systemd
    })

    it('host the relay only (server) persists mode=server', async () => {
      await run(['server', '', true, true, MANUAL, 'https://relay.ts.net'])
      expect(loadConfig().mode).toBe('server')
      expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
      expect(loadConfig().networkOption).toBe('manual')
      expect(loadConfig().persistence).toBe('systemd') // answered "y"
    })

    it('a blank password leaves the host open only after explicit confirmation', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', '', true, false, MANUAL, 'https://box.ts.net'], setPw)
      expect(setPw).not.toHaveBeenCalled()
    })

    it('persistence: a blank answer defaults to systemd and starts the backend', async () => {
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'ok',
      }))
      // `undefined` = the operator pressed Enter without choosing, so the confirm's
      // initialValue (systemd, the recommended option) stands.
      const { io } = scriptedIO(['all-in-one', 's3cret', undefined, MANUAL, 'https://box.ts.net'])
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
      const { io } = scriptedIO(['all-in-one', 's3cret'])
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
      const { prompts, done } = start(['all-in-one', '', true, false, MANUAL, 'https://box.ts.net'])
      await done
      expect(prompts).toContain('Podium login password (leave blank for no login)')
      expect(prompts).toContain('Run without a password?')
    })

    it('re-prompts for a password when no-password confirmation is not typed', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', '', false, 's3cret', false, MANUAL, 'https://box.ts.net'], setPw)
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
      await run(['all-in-one', 'pw', false, MANUAL, 'nope', 'https://box.ts.net'])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('Ctrl-C/EOF during the password step leaves the box UNCONFIGURED (#21)', async () => {
      // stdin only ever yields '' (EOF) at the password: no password, no explicit
      // "open" ack → the flow must abort WITHOUT writing anything.
      await run(['all-in-one'])
      expect(loadConfig()).toEqual({})
    })

    it('declining the no-password ack repeatedly aborts without saving (#21)', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', '', false, '', false, '', false, '', false, '', false], setPw)
      expect(setPw).not.toHaveBeenCalled()
      expect(loadConfig()).toEqual({})
    })

    it('gives up (bounded) when the URL prompt only ever returns empty', async () => {
      // Pick all-in-one and a network option, then never paste a URL. The queue drains,
      // which is the scripted stand-in for Ctrl-C, and the flow must END rather than spin —
      // the condition readline could only report as '' forever.
      const { output, done } = start(['all-in-one', 's3cret', false, MANUAL, '', '', ''])
      await done
      expect(loadConfig().publicUrl).toBeUndefined()
      // The protected server keeps running on this machine; the address can come later.
      expect(loadConfig().mode).toBe('all-in-one')
      expect(output.join('\n')).toContain('without a public address yet')
    })

    it('sets the password and starts the server BEFORE asking how it is reached', async () => {
      const events: string[] = []
      const s = scriptedIO(['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net'])
      await runCliSetup(s.io, 18787, {
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
        recordPublicUrl: async (url) => {
          events.push(`url ${url}`)
        },
        checkInside: async () => {
          events.push('check')
          return true
        },
      })
      expect(events).toEqual(['password', 'backend', 'url https://box.ts.net', 'check'])
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel'],
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-serve'],
        deps,
      )
      await done
      expect(runs).toEqual(['tailscale serve --bg 18787'])
      expect(loadConfig().networkOption).toBe('tailscale-serve')
    })

    it('not installed: boxes install, start and sign-in in that order, then carries on once it is ready', async () => {
      const { deps, runs } = fakeTailscale([{ kind: 'missing' }, READY('mgw')])
      const { commands, done } = runTailscale(
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', true],
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', true],
        deps,
      )
      await done
      expect(commands[0]).toBe('sudo tailscale up')
      expect(commands).not.toContain('curl -fsSL https://tailscale.com/install.sh | sh')
    })

    it('giving up before Tailscale is ready records no address', async () => {
      const { deps } = fakeTailscale([{ kind: 'stopped' }])
      const { output, done } = runTailscale(
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', false],
        deps,
      )
      await done
      expect(loadConfig().publicUrl).toBeUndefined()
      expect(output.join('\n')).toContain('without a public address yet')
    })

    it('no operator yet: asks, makes this user the operator, then turns Funnel on', async () => {
      const { deps, runs } = fakeTailscale([READY(undefined)])
      const { prompts, done } = runTailscale(
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', true],
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', true],
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-funnel', true],
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
        ['all-in-one', 's3cret', false, 'tailscale', 'tailscale-serve'],
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
      const s = scriptedIO(['all-in-one', 's3cret', false, MANUAL, 'https://proxy.example'])
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

    it('runs right after the URL is set, and a failure kept leaves the URL and completes the flow', async () => {
      const setPw = vi.fn(async () => {})
      const { output, prompts, done } = probeRun(
        ['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net', 'keep'],
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
      // Right after the address was saved, while the answer can still be acted on.
      expect(output.indexOf("Saved https://box.ts.net as this instance's address.")).toBeLessThan(
        output.findIndex((line) => line.includes('Nothing is listening on that port')),
      )
    })

    it('a failure answered "change" walks the reachability step again and checks the new URL', async () => {
      const checkReachability = async (url: string): Promise<CheckResult | undefined> =>
        url === 'https://bad.example'
          ? { ok: false, error: 'DNS_FAILED', detail: '' }
          : { ok: true, url, resolvedTo: [] }
      const { output, prompts, done } = probeRun(
        [
          'all-in-one',
          'pw',
          false,
          MANUAL,
          'https://bad.example',
          'change',
          MANUAL,
          'https://good.ts.net',
        ],
        checkReachability,
      )
      await done
      // The re-asked URL replaced the one that failed, and the flow completed.
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

    it('CONNECT_UNAVAILABLE and no-opinion both fall back to a check from this machine', async () => {
      const answers = ['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net']
      const base = await runFresh(answers, { checkReachability: noOpinion })
      const down = await runFresh(answers, { checkReachability: unavailable })
      expect(down.prompts).toEqual(base.prompts)
      expect(down.output).toEqual(base.output)
      expect(down.transcript).toEqual(base.transcript)
      expect(base.output).toContain('Reachable from this machine — https://box.ts.net answers.')
    })

    it('when neither Connect nor this machine reaches it, the operator decides at once', async () => {
      const inside = vi.fn(async () => false)
      const s = scriptedIO(['all-in-one', 's3cret', false, MANUAL, 'https://typo.example', 'keep'])
      await runCliSetup(s.io, 18787, {
        ...HERMETIC,
        setPassword: vi.fn(async () => {}),
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
        hasCommand: () => true,
        checkReachability: noOpinion,
        checkInside: inside,
      })
      // A short try, not the 90 s a brand-new tunnel name gets.
      expect(inside).toHaveBeenCalledWith('https://typo.example', 20_000)
      expect(s.output.join('\n')).toContain(
        'https://typo.example did not answer from this machine.',
      )
      expect(s.prompts).toContain('What now?')
      expect(loadConfig().publicUrl).toBe('https://typo.example')
    })

    it('a failed check offers to correct the typed address, then checks the corrected one', async () => {
      const checked: string[] = []
      const checkReachability = async (url: string): Promise<CheckResult | undefined> => {
        checked.push(url)
        return url === 'https://good.example'
          ? { ok: true, url, resolvedTo: [] }
          : { ok: false, error: 'DNS_FAILED', detail: '' }
      }
      const { prompts, done } = probeRun(
        ['all-in-one', 'pw', false, MANUAL, 'https://gdoo.example', 'fix', 'https://good.example'],
        checkReachability,
      )
      await done
      expect(prompts).toContain('The correct https:// URL')
      expect(checked).toEqual(['https://gdoo.example', 'https://good.example'])
      expect(loadConfig().publicUrl).toBe('https://good.example')
      // Replacing an address that just failed strands nobody: no question about it.
      expect(prompts.some((p) => p.startsWith('Replace it with'))).toBe(false)
    })

    it('"check again" checks the same address again', async () => {
      let calls = 0
      const checkReachability = async (url: string): Promise<CheckResult | undefined> =>
        ++calls === 1
          ? { ok: false, error: 'PORT_NOT_REACHABLE', detail: '' }
          : { ok: true, url, resolvedTo: [] }
      const { output, done } = probeRun(
        ['all-in-one', 'pw', false, MANUAL, 'https://box.ts.net', 'again'],
        checkReachability,
      )
      await done
      expect(calls).toBe(2)
      expect(output.join('\n')).toContain(
        'Reachable — an outside probe connected to https://box.ts.net.',
      )
    })

    it('only a typed address offers "Correct the address"', async () => {
      const { deps } = {
        deps: {
          probe: () => ({
            kind: 'ready' as const,
            dnsName: 'box.tail1234.ts.net',
            operator: 'mgw',
            operatorKnown: true,
          }),
          run: () => true,
          forwards: () => true,
          user: () => 'mgw',
          isRoot: () => false,
        },
      }
      const s = scriptedIO(['all-in-one', 's3cret', false, 'tailscale', 'tailscale-serve', 'keep'])
      await runCliSetup(s.io, 18787, {
        ...HERMETIC,
        setPassword: vi.fn(async () => {}),
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
        hasCommand: () => true,
        checkInside: async () => false,
        tailscale: deps,
      })
      expect(s.prompts).toContain('What now?')
      expect(s.prompts).not.toContain('Correct the address')
      expect(s.prompts.some((p) => p.startsWith('Check again'))).toBe(true)
    })

    it('a cloud answer the CLI predates still asks instead of crashing', async () => {
      // The verdict arrives as a cast: a newer code, or a missing detail, must degrade to a
      // generic warning and the same override — never a throw inside setup.
      const future = async (): Promise<CheckResult> =>
        ({ ok: false, error: 'SOME_FUTURE_CODE', detail: undefined }) as unknown as CheckResult
      const { output, prompts, done } = probeRun(
        ['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net', 'keep'],
        future,
      )
      await done
      expect(output.join('\n')).toContain('SOME_FUTURE_CODE')
      expect(prompts).toContain('What now?')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('a reachable URL is acknowledged in one line and the flow carries on', async () => {
      const { output, done } = probeRun(
        ['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net'],
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

    it('waits while Connect does not know the installation yet, then checks (POD-3274)', async () => {
      seedIdentity(dir)
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          ++calls < 3
            ? Response.json(
                { error: 'UNKNOWN_INSTALLATION', message: 'no such installation' },
                { status: 404 },
              )
            : Response.json({ ok: true, url: 'https://box.ts.net', resolvedTo: [] }),
        ),
      )
      try {
        const { io } = scriptedIO([])
        const result = await realCheckReachability('https://box.ts.net', io, {
          registrationWaitMs: 10_000,
        })
        expect(result).toMatchObject({ ok: true })
        expect(calls).toBe(3)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('a server that never registers is "Connect unavailable" once the wait is spent', async () => {
      seedIdentity(dir)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ error: 'UNKNOWN_INSTALLATION', message: 'no' }, { status: 404 }),
        ),
      )
      try {
        const { io } = scriptedIO([])
        expect(
          await realCheckReachability('https://box.ts.net', io, { registrationWaitMs: 0 }),
        ).toMatchObject({ ok: false, error: 'CONNECT_UNAVAILABLE', detail: 'UNKNOWN_INSTALLATION' })
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('with no server on the control socket, the address goes straight into config', async () => {
      saveConfig({ mode: 'all-in-one' })
      await recordPublicUrlNow('https://box.ts.net')
      expect(loadConfig()).toMatchObject({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
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
      // No confirmation: with Podium Connect on, everything that joined at the old URL
      // finds the new one (PDM-26, POD-5921).
      await run(['url', MANUAL, 'https://new.ts.net'], setPw)
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
  })

  // Telemetry is not asked in setup at all: it is a setting (Settings → Privacy, or
  // `podium telemetry`), never a question on the way to a working install.
  it('never asks about telemetry, on any path, and writes no consent', async () => {
    const host = start(['all-in-one', 's3cret', false, MANUAL, 'https://box.ts.net'])
    await host.done
    expect(host.prompts.some((p) => /telemetry|usage reports|crash reports/i.test(p))).toBe(false)
    expect(loadConfig().mode).toBe('all-in-one')
    expect(loadConfig().telemetry).toBeUndefined()
    const menu = start([])
    await menu.done
    expect(menu.prompts.join('\n')).not.toContain('telemetry')
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

  it('with Podium Connect on, replacing a live URL asks nothing and says who follows', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { out, done } = run(['url', MANUAL, 'https://b.example'])
    await done
    expect(out.join('\n')).toContain(
      'Machines and apps that joined at https://a.example find the new address through Podium Connect.',
    )
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('with Connect off, asks before replacing a live public URL, and leaves it alone on a no', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { out, done } = run(['url', MANUAL, 'https://b.example', false])
    await done
    expect(out.join('\n')).toMatch(/Podium Connect is off, so machines and apps that joined/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })

  it('with Connect off, replaces it on a yes', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', MANUAL, 'https://b.example', true])
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('--confirm-url-change answers the question ahead of a prompt that cannot be shown', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', MANUAL, 'https://b.example'], { confirmUrlChange: true })
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('re-pasting the SAME URL is never a change and is never questioned', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { out, done } = run(['url', MANUAL, 'https://a.example'])
    await done
    expect(out.join('\n')).not.toMatch(/Podium Connect is off/)
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
describe('runCliSetup: Cloudflare quick tunnel managed by Podium', () => {
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
        stableLink: async () => undefined,
        ...over,
      },
    })
    return { ...s, events, done }
  }

  it('says who follows the address, and offers the stable link to bookmark (POD-5921)', async () => {
    const link = `https://connect.podium.do/to/pdm_${'a'.repeat(43)}`
    const { output, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE], {
      stableLink: async () => link,
    })
    await done
    const text = output.join('\n')
    expect(text).toContain(
      'Joined machines and the desktop and mobile apps follow it on their own.',
    )
    expect(text).toContain(`In a browser, bookmark this link instead: ${link}`)
    expect(text).not.toContain('do not follow it yet')
  })

  it('asks for no URL, starts the tunnel AFTER the server, and shows the address it got', async () => {
    const { prompts, output, events, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE])
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
    const s = scriptedIO(['all-in-one', 's3cret', true, CLOUDFLARE])
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
        stableLink: async () => undefined,
      },
    })
    expect(outside).not.toHaveBeenCalled()
    expect(inside).toHaveBeenCalledWith(TUNNEL_URL)
    expect(s.output).toContain(`Reachable — ${TUNNEL_URL} answers through Cloudflare.`)
  })

  it('labels the row as managed by Podium, never as "not installed"', async () => {
    const { prompts, done } = runTunnel(['all-in-one', 's3cret', true])
    await done
    expect(prompts.some((p) => p.startsWith('Cloudflare quick tunnel, managed by Podium'))).toBe(
      true,
    )
    expect(prompts.some((p) => p.includes('cloudflared is not installed —'))).toBe(false)
  })

  it('downloads cloudflared when missing — after asking, once the server runs', async () => {
    const { prompts, events, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE, true], {
      hasCloudflared: () => false,
    })
    await done
    expect(
      prompts.some((p) => p.startsWith('cloudflared is not installed. Download it now?')),
    ).toBe(true)
    expect(events).toEqual(['password', 'backend', 'download', 'enable'])
  })

  it('declining the download records no address and boxes the install command instead', async () => {
    const { commands, events, done } = runTunnel(
      ['all-in-one', 's3cret', true, CLOUDFLARE, false],
      {
        hasCloudflared: () => false,
      },
    )
    await done
    expect(events).toEqual(['password', 'backend'])
    expect(commands.some((c) => c.includes('cloudflared-linux-'))).toBe(true)
    expect(loadConfig().publicUrl).toBeUndefined()
    expect(loadConfig().networkOption).toBeUndefined()
  })

  it('a failed download records no address and says why', async () => {
    const { output, events, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE, true], {
      hasCloudflared: () => false,
      download: async () => {
        throw new Error('download failed: 404 Not Found')
      },
    })
    await done
    expect(events).toEqual(['password', 'backend'])
    expect(output.join('\n')).toContain('Could not download cloudflared: download failed: 404')
    expect(loadConfig().publicUrl).toBeUndefined()
  })

  it('no address in time: says where to look, and the setup itself still stands', async () => {
    const { commands, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE], {
      waitForUrl: async () => undefined,
    })
    await done
    expect(commands).toContain('journalctl --user -u podium-tunnel.service -f')
    expect(loadConfig().networkOption).toBe('cloudflare-tunnel')
  })

  it('without a systemd user session, falls back to running cloudflared by hand and pasting', async () => {
    const { commands, events, done } = runTunnel(
      ['all-in-one', 's3cret', true, CLOUDFLARE, TUNNEL_URL],
      { canSupervise: () => false },
    )
    await done
    expect(commands).toContain('cloudflared tunnel --url http://127.0.0.1:18787')
    expect(events).not.toContain('enable')
    expect(loadConfig().publicUrl).toBe(TUNNEL_URL)
  })

  it('replacing an earlier quick-tunnel address asks nothing, even with Connect off', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    try {
      saveConfig({ ...loadConfig(), publicUrl: 'https://old-one.trycloudflare.com' })
      const { prompts, events, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE])
      await done
      expect(prompts.some((p) => p.startsWith('Replace it with'))).toBe(false)
      expect(events).toContain('enable')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('with Connect off, replacing a durable address asks first', async () => {
    vi.stubEnv('PODIUM_CONNECT', 'off')
    try {
      saveConfig({ ...loadConfig(), publicUrl: 'https://box.ts.net' })
      const { prompts, events, done } = runTunnel(['all-in-one', 's3cret', true, CLOUDFLARE, false])
      await done
      expect(prompts).toContain('Replace it with a Cloudflare quick tunnel?')
      expect(events).toEqual(['password', 'backend'])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
