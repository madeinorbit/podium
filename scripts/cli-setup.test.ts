import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/core/src/config'
import { runCliSetup } from './cli-setup'

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
})
