import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../packages/core/src/config'
import { applySetup } from '../packages/core/src/setup'
import { runCliSetup, shouldRunCliSetup } from './cli-setup'

describe('shouldRunCliSetup (when does `podium setup` launch the terminal flow)', () => {
  const base = { forceSetup: true, isTTY: true, needsSetup: false, mode: 'all-in-one' as const }

  it('requires an explicit `podium setup` / --reconfigure', () => {
    expect(shouldRunCliSetup({ ...base, forceSetup: false })).toBe(false)
  })

  it('never runs the interactive flow without a TTY (headless/systemd/piped)', () => {
    expect(shouldRunCliSetup({ ...base, isTTY: false })).toBe(false)
  })

  it('always runs on first-run (needsSetup), whatever the mode', () => {
    expect(shouldRunCliSetup({ ...base, needsSetup: true, mode: 'client' })).toBe(true)
  })

  it('runs for relay-hosting modes even when already configured', () => {
    expect(shouldRunCliSetup({ ...base, mode: 'all-in-one' })).toBe(true)
    expect(shouldRunCliSetup({ ...base, mode: 'server' })).toBe(true)
  })

  it('does NOT run for client/daemon installs (they configure via join-config)', () => {
    expect(shouldRunCliSetup({ ...base, mode: 'client' })).toBe(false)
    expect(shouldRunCliSetup({ ...base, mode: 'daemon' })).toBe(false)
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

  it('walks option choice → paste URL → persists publicUrl', async () => {
    const answers = ['1', 'https://box.ts.net'] // choose option 1 (funnel), then paste URL
    const out: string[] = []
    let i = 0
    await runCliSetup({ prompt: async () => answers[i++], print: (s) => out.push(s) }, 18787)
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    expect(out.join('\n')).toContain('tailscale funnel 18787')
  })

  it('re-prompts on an invalid URL', async () => {
    const answers = ['1', 'nope', 'https://box.ts.net']
    let i = 0
    await runCliSetup({ prompt: async () => answers[i++], print: () => {} }, 18787)
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
  })

  it('prompts for a password after the URL and sets it when one is entered', async () => {
    const answers = ['1', 'https://box.ts.net', 's3cret'] // option, URL, password
    let i = 0
    const setPw = vi.fn(async () => {})
    await runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
      setPassword: setPw,
    })
    expect(setPw).toHaveBeenCalledWith('s3cret')
  })

  it('skips the password (runs open) when the prompt is left blank', async () => {
    const answers = ['1', 'https://box.ts.net', ''] // blank password = opt out
    let i = 0
    const setPw = vi.fn(async () => {})
    await runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
      setPassword: setPw,
    })
    expect(setPw).not.toHaveBeenCalled()
  })

  it('gives up (does not hang) when prompt only ever returns empty input', async () => {
    // Simulates stdin EOF/Ctrl-D: prompt always resolves '' → bounded loop must terminate.
    const out: string[] = []
    let calls = 0
    await runCliSetup(
      {
        prompt: async () => {
          calls++
          return ''
        },
        print: (s) => out.push(s),
      },
      18787,
    )
    expect(loadConfig().publicUrl).toBeUndefined()
    expect(calls).toBeLessThan(50) // bounded, not an infinite spin
    expect(out.join('\n')).toContain('giving up')
  })

  describe('when already configured (jump-to-step)', () => {
    const run = (answers: string[], setPw: () => Promise<void>) => {
      let i = 0
      return runCliSetup({ prompt: async () => answers[i++] ?? '', print: () => {} }, 18787, {
        setPassword: setPw,
      })
    }

    it('jumps straight to the password step, leaving the URL untouched', async () => {
      applySetup({ publicUrl: 'https://existing.ts.net' })
      const setPw = vi.fn(async () => {})
      await run(['2', 'rotated-pw'], setPw) // menu: password → enter it
      expect(setPw).toHaveBeenCalledWith('rotated-pw')
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
    })

    it('jumps straight to the reachability step, leaving the password untouched', async () => {
      applySetup({ publicUrl: 'https://existing.ts.net' })
      const setPw = vi.fn(async () => {})
      await run(['1', '1', 'https://new.ts.net'], setPw) // menu: reachability → option 1 → new URL
      expect(loadConfig().publicUrl).toBe('https://new.ts.net')
      expect(setPw).not.toHaveBeenCalled()
    })

    it('cancels on a blank menu choice, changing nothing', async () => {
      applySetup({ publicUrl: 'https://existing.ts.net' })
      const setPw = vi.fn(async () => {})
      await run([''], setPw)
      expect(loadConfig().publicUrl).toBe('https://existing.ts.net')
      expect(setPw).not.toHaveBeenCalled()
    })
  })
})
