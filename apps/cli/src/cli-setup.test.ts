import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reconcilePendingPersistence,
  repairConfig,
  runCliSetup,
  runJoinSetup,
  shouldRunCliSetup,
} from './cli-setup'

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
  it('launches setup automatically for a bare `podium` on a fresh/unconfigured box (TTY)', () => {
    // The headline fix: an unconfigured install run interactively walks straight into setup
    // instead of silently starting all-in-one.
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
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (answers: string[], setPw: () => Promise<void> = vi.fn(async () => {})) => {
    let i = 0
    return runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
      setPassword: setPw,
      // Stub the backend starter so tests never spawn processes; echo the requested persistence.
      startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
    })
  }

  describe('first run (mode menu)', () => {
    it('host a server here (all-in-one) → set URL then password', async () => {
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://box.ts.net', 's3cret', 'n'], setPw)
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(setPw).toHaveBeenCalledWith('s3cret')
      expect(loadConfig().persistence).toBe('detached') // answered "n" to systemd
    })

    it('host the relay only (server) persists mode=server', async () => {
      await run(['2', '1', 'https://relay.ts.net', '', 'open', 'y'])
      expect(loadConfig().mode).toBe('server')
      expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
      expect(loadConfig().persistence).toBe('systemd') // answered "y"
    })

    it('a blank password leaves the host open only after explicit confirmation', async () => {
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://box.ts.net', '', 'open', 'n'], setPw)
      expect(setPw).not.toHaveBeenCalled()
    })

    it('persistence: a blank answer defaults to systemd and starts the backend', async () => {
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'ok',
      }))
      let i = 0
      const answers = ['1', '1', 'https://box.ts.net', 's3cret', ''] // blank persistence → systemd
      await runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
        setPassword: vi.fn(async () => {}),
        startBackend,
      })
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(loadConfig().persistence).toBe('systemd')
    })

    it('labels blank password as the no-password confirmation path', async () => {
      const prompts: string[] = []
      let i = 0
      const answers = ['1', '1', 'https://box.ts.net', '', 'open', 'n']
      await runCliSetup(
        {
          prompt: async (q) => {
            prompts.push(q)
            return answers[i++] ?? ''
          },
          print: () => {},
        },
        18787,
        {
          setPassword: vi.fn(async () => {}),
          startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
        },
      )
      expect(prompts).toContain('Password (recommended; blank starts no-password confirmation): ')
      expect(prompts).toContain('Type "open" to run without a password: ')
    })

    it('re-prompts for a password when no-password confirmation is not typed', async () => {
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://box.ts.net', '', 'no', 's3cret', 'n'], setPw)
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
      let i = 0
      const answers = ['3', token, 'n'] // join, then decline systemd → detached
      await runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
        setPassword: setPw,
        startBackend,
      })
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().serverUrl).toBe('wss://relay.example')
      expect(loadConfig().persistence).toBe('detached')
      // The intent was fulfilled in-flow — no leftover pendingPersistence (#20).
      expect(loadConfig().pendingPersistence).toBeUndefined()
      // The join now STARTS the daemon rather than telling the user to restart.
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'detached',
        mode: 'daemon',
        port: 18787,
      })
      expect(setPw).not.toHaveBeenCalled()
    })

    it('a blank join code cancels without writing config', async () => {
      await run(['3', ''])
      expect(loadConfig().mode).toBeUndefined()
    })

    it('re-prompts on an invalid URL', async () => {
      await run(['1', '1', 'nope', 'https://box.ts.net', 'pw', 'n'])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    })

    it('Ctrl-C/EOF during the password step leaves the box UNCONFIGURED (#21)', async () => {
      // URL was pasted, then stdin only ever yields '' (EOF): no password, no explicit
      // "open" ack → the flow must abort WITHOUT writing mode/publicUrl.
      await run(['1', '1', 'https://box.ts.net'])
      expect(loadConfig()).toEqual({})
    })

    it('declining the no-password ack repeatedly aborts without saving (#21)', async () => {
      const setPw = vi.fn(async () => {})
      await run(
        ['1', '1', 'https://box.ts.net', '', 'no', '', 'no', '', 'no', '', 'no', '', 'no'],
        setPw,
      )
      expect(setPw).not.toHaveBeenCalled()
      expect(loadConfig()).toEqual({})
    })

    it('gives up (bounded) when the URL prompt only ever returns empty', async () => {
      const out: string[] = []
      let calls = 0
      await runCliSetup(
        {
          prompt: async () => {
            calls++
            return calls === 1 ? '1' : '' // pick all-in-one, then never paste a URL
          },
          print: (s) => out.push(s),
        },
        18787,
      )
      expect(loadConfig().publicUrl).toBeUndefined()
      expect(calls).toBeLessThan(50)
      expect(out.join('\n')).toContain('giving up')
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
      const res = await runJoinSetup(token, 'systemd', 18787, { startBackend })
      expect(res.name).toBe('vps')
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'daemon',
        port: 18787,
      })
      expect(loadConfig()).toEqual({
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
      })
      expect(loadConfig().persistence).toBe('detached')
      expect(loadConfig().pendingPersistence).toBeUndefined()
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
      expect(loadConfig()).toEqual({ updateChannel: 'edge' })
    })
  })

  describe('reconcilePendingPersistence — web setup finished, next `podium` starts the backend (#20)', () => {
    it('starts the backend under the recorded intent and flips it to persistence', async () => {
      // What the web setup.complete leaves behind on a headless box.
      saveConfig({
        mode: 'all-in-one',
        publicUrl: 'https://box.ts.net',
        pendingPersistence: 'systemd',
      })
      const startBackend = vi.fn(async (o: { persistence: 'systemd' | 'detached' }) => ({
        effectivePersistence: o.persistence,
        message: 'up',
      }))
      const res = await reconcilePendingPersistence(18787, { startBackend })
      expect(res?.message).toBe('up')
      expect(startBackend).toHaveBeenCalledWith({
        persistence: 'systemd',
        mode: 'all-in-one',
        port: 18787,
      })
      expect(loadConfig()).toEqual({
        mode: 'all-in-one',
        publicUrl: 'https://box.ts.net',
        persistence: 'systemd',
      })
    })
    it('no-ops when nothing is pending or persistence is already set', async () => {
      const startBackend = vi.fn(async () => ({
        effectivePersistence: 'systemd' as const,
        message: '',
      }))
      saveConfig({ mode: 'all-in-one', persistence: 'detached' })
      expect(await reconcilePendingPersistence(18787, { startBackend })).toBeUndefined()
      saveConfig({ mode: 'all-in-one' })
      expect(await reconcilePendingPersistence(18787, { startBackend })).toBeUndefined()
      expect(startBackend).not.toHaveBeenCalled()
    })
  })

  describe('corrupt config protection + --repair (#21)', () => {
    it('runCliSetup refuses to walk the flow over an existing-but-invalid config', async () => {
      writeFileSync(join(dir, 'config.json'), '{not json')
      const out: string[] = []
      const prompt = vi.fn(async () => '1')
      await runCliSetup({ prompt, print: (s) => out.push(s) }, 18787, {
        setPassword: vi.fn(async () => {}),
        startBackend: vi.fn(async () => ({
          effectivePersistence: 'systemd' as const,
          message: '',
        })),
      })
      expect(out.join('\n')).toContain('--repair')
      expect(prompt).not.toHaveBeenCalled() // bailed before any prompt
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
      await run(['5', 'rotated-pw'], setPw)
      expect(setPw).toHaveBeenCalledWith('rotated-pw')
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
    })

    it('change the reachable URL only (option 4), leaving the mode + password', async () => {
      const setPw = vi.fn(async () => {})
      await run(['4', '1', 'https://new.ts.net'], setPw)
      expect(loadConfig().publicUrl).toBe('https://new.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
      expect(setPw).not.toHaveBeenCalled()
    })

    it('switch an existing host to daemon by pasting a join code', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'EFGH-5678' })
      await run(['3', token])
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().serverUrl).toBe('wss://relay.example')
    })

    it('a blank menu choice changes nothing', async () => {
      await run([''])
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(loadConfig().mode).toBe('all-in-one')
    })

    it('change telemetry only (option 6), leaving mode/URL/password alone', async () => {
      const setPw = vi.fn(async () => {})
      await run(['6', 'y', 'n'], setPw)
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
    const HOST_ANSWERS = ['1', '1', 'https://box.ts.net', 's3cret', 'n']

    it('is reached only AFTER the install works (step 8)', async () => {
      const order: string[] = []
      const answers = [...HOST_ANSWERS, 'y', 'y']
      let i = 0
      await runCliSetup(
        {
          prompt: async (q) => {
            if (q.includes('systemd')) order.push('persistence')
            if (q.includes('usage reports')) order.push('telemetry')
            return answers[i++] ?? ''
          },
          print: () => {},
        },
        18787,
        {
          setPassword: vi.fn(async () => {}),
          startBackend: async (o) => {
            order.push('startBackend')
            return { effectivePersistence: o.persistence, message: '' }
          },
        },
      )
      // Telemetry is the last thing asked, and the backend is already up when
      // it is — which is exactly why consent must be read fresh at flush (D9).
      expect(order).toEqual(['persistence', 'startBackend', 'telemetry'])
      expect(loadConfig().telemetry).toMatchObject({ usage: 'on', crash: 'on' })
    })

    it('shows the example report and the opt-out routes in the prompt', async () => {
      const printed: string[] = []
      let i = 0
      const answers = [...HOST_ANSWERS, 'n', 'n']
      await runCliSetup(
        {
          prompt: async () => answers[i++] ?? '',
          print: (s) => printed.push(s),
        },
        18787,
        {
          setPassword: vi.fn(async () => {}),
          startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
        },
      )
      const out = printed.join('\n')
      expect(out).toContain('Anonymous telemetry (opt-in)')
      expect(out).toContain('"installAge": "1-7d"')
      expect(out).toContain('podium telemetry off')
      expect(out).toContain('Settings → Privacy')
    })

    it('defaults to NO — Enter-Enter opts out of both', async () => {
      await run([...HOST_ANSWERS, '', ''])
      expect(loadConfig().telemetry).toMatchObject({ usage: 'off', crash: 'off' })
      expect(loadConfig().telemetry?.installId).toBeUndefined()
    })

    it('records an explicit off (which is not the same as never asked)', async () => {
      await run([...HOST_ANSWERS, 'n', 'n'])
      expect(loadConfig().telemetry?.usage).toBe('off')
    })

    it('each tier is consented independently', async () => {
      await run([...HOST_ANSWERS, 'n', 'y'])
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
        const prompts: string[] = []
        let i = 0
        const answers = [...HOST_ANSWERS]
        await runCliSetup(
          {
            prompt: async (q) => {
              prompts.push(q)
              return answers[i++] ?? ''
            },
            print: () => {},
          },
          18787,
          {
            setPassword: vi.fn(async () => {}),
            startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
          },
        )
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
        await run([...HOST_ANSWERS, 'y', 'y'])
        expect(loadConfig().telemetry).toBeUndefined()
      } finally {
        delete process.env.PODIUM_TELEMETRY
      }
    })

    it('the JOIN path is never prompted (D10 — the hub decided)', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'ABCD-1234' })
      const prompts: string[] = []
      let i = 0
      const answers = ['3', token, 'n']
      await runCliSetup(
        {
          prompt: async (q) => {
            prompts.push(q)
            return answers[i++] ?? ''
          },
          print: () => {},
        },
        18787,
        {
          setPassword: vi.fn(async () => {}),
          startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
        },
      )
      expect(loadConfig().mode).toBe('daemon')
      expect(prompts.some((p) => p.includes('usage reports'))).toBe(false)
      expect(loadConfig().telemetry).toBeUndefined()
    })

    it('the non-interactive `podium setup --join` never prompts either', async () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'ABCD-1234' })
      await runJoinSetup(token, 'systemd', 18787, {
        startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
      })
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().telemetry).toBeUndefined()
    })

    it('the telemetry menu entry is host-only', async () => {
      const printed: string[] = []
      await runCliSetup({ prompt: async () => '', print: (s) => printed.push(s) }, 18787, {
        setPassword: vi.fn(async () => {}),
        startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
      })
      // Fresh box (no mode): no host-only entries at all.
      expect(printed.join('\n')).not.toContain('Change telemetry')

      saveConfig({ mode: 'all-in-one', publicUrl: 'https://x.ts.net' })
      const hostPrinted: string[] = []
      await runCliSetup({ prompt: async () => '', print: (s) => hostPrinted.push(s) }, 18787, {
        setPassword: vi.fn(async () => {}),
        startBackend: async (o) => ({ effectivePersistence: o.persistence, message: '' }),
      })
      expect(hostPrinted.join('\n')).toContain('6) Change telemetry')
    })
  })
})
