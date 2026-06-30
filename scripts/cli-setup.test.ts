import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, saveConfig } from '../packages/core/src/config'
import { encodeJoin } from '../packages/core/src/join'
import { runCliSetup, shouldRunCliSetup } from './cli-setup'

describe('shouldRunCliSetup (when `podium setup` launches the terminal flow)', () => {
  it('requires an explicit `podium setup` / --reconfigure', () => {
    expect(shouldRunCliSetup({ forceSetup: false, isTTY: true })).toBe(false)
  })
  it('never runs the interactive flow without a TTY (headless/systemd/piped)', () => {
    expect(shouldRunCliSetup({ forceSetup: true, isTTY: false })).toBe(false)
  })
  it('runs for any install on a TTY — the menu lets you switch mode from anything', () => {
    expect(shouldRunCliSetup({ forceSetup: true, isTTY: true })).toBe(true)
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
    })
  }

  describe('first run (mode menu)', () => {
    it('host a server here (all-in-one) → set URL then password', async () => {
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://box.ts.net', 's3cret'], setPw)
      expect(loadConfig().mode).toBe('all-in-one')
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
      expect(setPw).toHaveBeenCalledWith('s3cret')
    })

    it('host the relay only (server) persists mode=server', async () => {
      await run(['2', '1', 'https://relay.ts.net', ''])
      expect(loadConfig().mode).toBe('server')
      expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
    })

    it('a blank password leaves the host open', async () => {
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://box.ts.net', ''], setPw)
      expect(setPw).not.toHaveBeenCalled()
    })

    it('join a server as a worker (daemon) by pasting a join code', async () => {
      const token = encodeJoin({
        v: 1,
        serverUrl: 'wss://relay.example',
        pairCode: 'ABCD-1234',
        name: 'box',
      })
      const setPw = vi.fn(async () => {})
      await run(['3', token], setPw)
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig().serverUrl).toBe('wss://relay.example')
      expect(setPw).not.toHaveBeenCalled()
    })

    it('a blank join code cancels without writing config', async () => {
      await run(['3', ''])
      expect(loadConfig().mode).toBeUndefined()
    })

    it('re-prompts on an invalid URL', async () => {
      await run(['1', '1', 'nope', 'https://box.ts.net'])
      expect(loadConfig().publicUrl).toBe('https://box.ts.net')
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
  })
})
