import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_CONFIG_VERSION, loadConfig, saveConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { NETWORK_OPTIONS } from '@podium/runtime/setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  repairConfig,
  runCliSetup,
  runJoinSetup,
  runVpsSetup,
  shouldRunCliSetup,
} from './cli-setup'
import { scriptedIO } from './setup-ui'

const priorStateDir = process.env.PODIUM_STATE_DIR!

/** The reachability `select` hands back the whole NETWORK_OPTIONS entry, so a scripted
 *  answer names one by index: 0 = Tailscale Funnel, 3 = manual reverse proxy. */
const net = (i: number) => NETWORK_OPTIONS[i]
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
        setPassword: setPw,
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
      }),
    }
  }
  const run = (answers: unknown[], setPw: () => Promise<void> = vi.fn(async () => {})) =>
    start(answers, setPw).done

  describe('first run (mode menu)', () => {
    it('sets up a fresh VPS directly as all-in-one without asking topology or telemetry', async () => {
      const startBackend = vi.fn(async () => ({
        effectivePersistence: 'systemd' as const,
        message: 'started',
      }))
      const { io, prompts } = scriptedIO([net(0), 'https://vps.ts.net', 's3cret', true])

      await runVpsSetup(io, 18787, { setPassword: vi.fn(async () => {}), startBackend })

      expect(prompts).not.toContain('What do you want this machine to do?')
      expect(prompts.some((prompt) => prompt.includes('telemetry'))).toBe(false)
      expect(loadConfig()).toMatchObject({
        mode: 'all-in-one',
        publicUrl: 'https://vps.ts.net',
        networkOption: 'tailscale-funnel',
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

      const { io } = scriptedIO([net(0), 'https://vps.ts.net', 's3cret', true])
      await runVpsSetup(io, 18787, {
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

    it('host a server here (all-in-one) → set URL then password', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', net(0), 'https://box.ts.net', 's3cret', false], setPw)
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(loadConfig().networkOption).toBe('tailscale-funnel')
      expect(setPw).toHaveBeenCalledWith('s3cret')
      expect(loadConfig().persistence).toBe('detached') // answered "n" to systemd
    })

    it('host the relay only (server) persists mode=server', async () => {
      await run(['server', net(0), 'https://relay.ts.net', '', true, true])
      expect(loadConfig().mode).toBe('server')
      expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
      expect(loadConfig().networkOption).toBe('tailscale-funnel')
      expect(loadConfig().persistence).toBe('systemd') // answered "y"
    })

    it('a blank password leaves the host open only after explicit confirmation', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', net(0), 'https://box.ts.net', '', true, false], setPw)
      expect(setPw).not.toHaveBeenCalled()
    })

    it('persistence: a blank answer defaults to systemd and starts the backend', async () => {
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'ok',
      }))
      // `undefined` = the operator pressed Enter without choosing, so the confirm's
      // initialValue (systemd, the recommended option) stands.
      const { io } = scriptedIO(['all-in-one', net(0), 'https://box.ts.net', 's3cret', undefined])
      await runCliSetup(io, 18787, {
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
      const { io } = scriptedIO(['all-in-one', net(0), 'https://box.ts.net', 's3cret'])
      await runCliSetup(io, 18787, {
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
      const { prompts, done } = start(['all-in-one', net(0), 'https://box.ts.net', '', true, false])
      await done
      expect(prompts).toContain('Password (leave blank to run without one)')
      expect(prompts).toContain('Run without a password?')
    })

    it('re-prompts for a password when no-password confirmation is not typed', async () => {
      const setPw = vi.fn(async () => {})
      await run(['all-in-one', net(0), 'https://box.ts.net', '', false, 's3cret', false], setPw)
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
      await run(['all-in-one', net(0), 'nope', 'https://box.ts.net', 'pw', false])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('Ctrl-C/EOF during the password step leaves the box UNCONFIGURED (#21)', async () => {
      // URL was pasted, then stdin only ever yields '' (EOF): no password, no explicit
      // "open" ack → the flow must abort WITHOUT writing mode/publicUrl.
      await run(['all-in-one', net(0), 'https://box.ts.net'])
      expect(loadConfig()).toEqual({})
    })

    it('declining the no-password ack repeatedly aborts without saving (#21)', async () => {
      const setPw = vi.fn(async () => {})
      await run(
        [
          'all-in-one',
          net(0),
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
      const { output, done } = start(['all-in-one', net(0), '', '', ''])
      await done
      expect(loadConfig().publicUrl).toBeUndefined()
      expect(output.join('\n')).toContain('nothing saved')
    })
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
      await run(['url', net(0), 'https://new.ts.net', 'CHANGE'], setPw)
      expect(loadConfig().publicUrl).toBe('https://new.ts.net')
      expect(loadConfig().networkOption).toBe('tailscale-funnel')
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
    const HOST_ANSWERS: unknown[] = ['all-in-one', net(0), 'https://box.ts.net', 's3cret', false]

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
        setPassword: vi.fn(async () => {}),
        startBackend: echoBackend,
        waitForEnrollment: async () => {},
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
    const { out, done } = run(['url', net(3), 'https://b.example', ''])
    await done
    expect(out.join('\n')).toMatch(/strands every machine that joined at the old URL/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })

  it('replaces it when the operator types the word', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', net(3), 'https://b.example', 'CHANGE'])
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('--confirm-url-change answers the question ahead of a prompt that cannot be shown', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { done } = run(['url', net(3), 'https://b.example'], { confirmUrlChange: true })
    await done
    expect(loadConfig().publicUrl).toBe('https://b.example')
  })

  it('re-pasting the SAME URL is never a change and is never questioned', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://a.example' })
    const { out, done } = run(['url', net(3), 'https://a.example'])
    await done
    expect(out.join('\n')).not.toMatch(/strands every machine/)
    expect(loadConfig().publicUrl).toBe('https://a.example')
  })
})
