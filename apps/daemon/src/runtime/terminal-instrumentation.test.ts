import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSpec } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as codexHooks from '@podium/harness/adapters/codex/instrumentation'
import { terminalInstrumentationSectionsFor, terminalProfileFor } from './registry'
import {
  installTerminalInstrumentation,
  prepareTerminalInstrumentation,
  reportInstrumentationDegradation,
} from '@podium/harness/driver/families/terminal/instrumentation'

const directories: string[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'podium-instrumentation-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function spec(harness: string, endpointUrl = 'http://127.0.0.1:1234/hooks/session'): SessionSpec {
  return {
    harness,
    selection: { auth: 'unknown', platform: 'linux', available: [] },
    workdir: '/project',
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
    instrumentation: { endpointUrl },
  }
}

describe('terminal instrumentation installation', () => {
  it('requires instrumentation for every hook-installing manifest', () => {
    for (const harness of ['claude-code', 'codex', 'grok'] as const) {
      expect(terminalProfileFor(harness)?.instrumentationRequired).toBe(true)
    }
    for (const harness of ['opencode', 'pi', 'cursor'] as const) {
      expect(terminalProfileFor(harness)?.instrumentationRequired).toBe(false)
    }
  })

  it('does not call the installer for a channel-free driver', async () => {
    const install = vi.fn(async () => ({ args: [] }))
    expect(await prepareTerminalInstrumentation({ instrumentation: 'none' }, {}, install)).toEqual({
      args: [],
    })
    expect(install).not.toHaveBeenCalled()
  })

  it('writes separate Claude settings before returning their launch arguments', async () => {
    const settingsDir = await directory()
    for (const name of ['blue', 'green']) {
      const endpoint = `http://127.0.0.1:1234/hooks/${name}`
      const wiring = await installTerminalInstrumentation({
        sessionId: asSessionId(name),
        harness: 'claude-code',
        spec: spec('claude-code', endpoint),
        sections: terminalInstrumentationSectionsFor('claude-code'),
        settingsDir,
      })
      const path = join(settingsDir, `${name}.json`)
      expect(wiring.args).toEqual(['--settings', path])
      expect(await readFile(path, 'utf8')).toContain(endpoint)
    }
    expect(await readFile(join(settingsDir, 'blue.json'), 'utf8')).not.toContain('/hooks/green')
  })

  it('degrades a settings write failure without passing a missing file to the CLI', async () => {
    const homeDir = await directory()
    const settingsDir = join(homeDir, 'not-a-directory')
    await writeFile(settingsDir, 'untouched')
    const result = await installTerminalInstrumentation({
      sessionId: asSessionId('claude'),
      harness: 'claude-code',
      spec: spec('claude-code'),
      sections: terminalInstrumentationSectionsFor('claude-code'),
      settingsDir,
    })
    expect(result.args).toEqual([])
    expect(result.degradedReason).toBeTruthy()
    expect(await readFile(settingsDir, 'utf8')).toBe('untouched')
  })

  it('deduplicates by machine owner, harness, and reason', () => {
    const owner = {}
    const send = vi.fn()
    const failure = {
      args: [],
      degradedReason: 'unreadable hooks.json',
      degradedKind: 'unreadable-hooks-json' as const,
    }
    reportInstrumentationDegradation(owner, 'codex', failure, send)
    reportInstrumentationDegradation(owner, 'codex', failure, send)
    reportInstrumentationDegradation(owner, 'grok', failure, send)
    reportInstrumentationDegradation(
      owner,
      'codex',
      { ...failure, degradedReason: 'no ~/.codex', degradedKind: 'no-home' },
      send,
    )
    reportInstrumentationDegradation({}, 'codex', failure, send)
    expect(send).toHaveBeenCalledTimes(4)
    expect(new Set(send.mock.calls.map(([message]) => message.code)).size).toBe(3)
  })

  it('deduplicates changing exception details and keeps them out of the code', async () => {
    const owner = {}
    const send = vi.fn()
    // The family installs through the adapter section: stub the section's
    // install, the way the old test stubbed the daemon's ensure call.
    const install = vi.spyOn(codexHooks.codexInstrumentation, 'install')
    for (const message of ['EACCES /home/one/hooks.json', 'EIO /home/two/hooks.json']) {
      install.mockRejectedValueOnce(new Error(message))
      const result = await installTerminalInstrumentation({
        sessionId: asSessionId('failure'),
        harness: 'codex',
        spec: spec('codex'),
        sections: terminalInstrumentationSectionsFor('codex'),
        settingsDir: '/unused',
      })
      expect(result).toMatchObject({ degradedKind: 'error', degradedReason: message })
      reportInstrumentationDegradation(owner, 'codex', result, send)
    }
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'codex-hooks-error',
        body: expect.stringContaining('EACCES /home/one/hooks.json'),
      }),
    )
  })

  it('keeps successful already-installed hooks silent', async () => {
    vi.spyOn(codexHooks.codexInstrumentation, 'install').mockResolvedValue({
      args: [],
      env: { PODIUM_CODEX_HOOK_URL: 'http://127.0.0.1:1234/hooks/installed' },
    })
    const send = vi.fn()
    const result = await installTerminalInstrumentation({
      sessionId: asSessionId('installed'),
      harness: 'codex',
      spec: spec('codex'),
      sections: terminalInstrumentationSectionsFor('codex'),
      settingsDir: '/unused',
    })
    reportInstrumentationDegradation({}, 'codex', result, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('serializes simultaneous Grok installs and returns each session endpoint', async () => {
    const homeDir = await directory()
    await mkdir(join(homeDir, '.grok'))
    const results = await Promise.all(
      ['one', 'two'].map((name) =>
        installTerminalInstrumentation({
          sessionId: asSessionId(name),
          harness: 'grok',
          spec: spec('grok', `http://localhost/hooks/${name}`),
          sections: terminalInstrumentationSectionsFor('grok'),
          homeDir,
          settingsDir: join(homeDir, 'settings'),
        }),
      ),
    )
    expect(
      JSON.parse(await readFile(join(homeDir, '.grok/hooks/podium.json'), 'utf8')).hooks,
    ).toBeDefined()
    expect(Object.values(results[0]?.env ?? {})).toContain('http://localhost/hooks/one')
    expect(Object.values(results[1]?.env ?? {})).toContain('http://localhost/hooks/two')
  })

  it('retains wiring for an unreadable global hook file without replacing it', async () => {
    const homeDir = await directory()
    const hooksDir = join(homeDir, '.grok/hooks')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(join(hooksDir, 'podium.json'), 'not json')
    await expect(
      installTerminalInstrumentation({
        sessionId: asSessionId('broken'),
        harness: 'grok',
        spec: spec('grok'),
        sections: terminalInstrumentationSectionsFor('grok'),
        homeDir,
        settingsDir: join(homeDir, 'settings'),
      }),
    ).resolves.toMatchObject({
      degradedReason: expect.stringContaining('unreadable'),
      env: expect.any(Object),
    })
    expect(await readFile(join(hooksDir, 'podium.json'), 'utf8')).toBe('not json')
  })

  it('uses the instance Codex home over inherited or session overrides and returns degradation', async () => {
    const homeDir = await directory()
    const install = vi.spyOn(codexHooks.codexInstrumentation, 'install').mockResolvedValue({
      args: [],
      env: { PODIUM_CODEX_HOOK_URL: 'http://127.0.0.1:1234/hooks/codex' },
      degradedReason: 'unsupported codex version',
      degradedKind: 'unsupported-version',
    })
    await expect(
      installTerminalInstrumentation({
        sessionId: asSessionId('codex'),
        harness: 'codex',
        spec: { ...spec('codex'), env: { CODEX_HOME: '/foreign/codex' } },
        sections: terminalInstrumentationSectionsFor('codex'),
        homeDir,
        settingsDir: join(homeDir, 'settings'),
      }),
    ).resolves.toMatchObject({
      degradedReason: 'unsupported codex version',
      env: expect.any(Object),
    })
    // The instance home (not the session's CODEX_HOME override) reaches the section.
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ harnessHome: join(homeDir, '.codex') }),
    )
  })

  it('degrades an installed-but-untrusted Codex home as poll-only with the /hooks remedy', async () => {
    const homeDir = await directory()
    vi.spyOn(codexHooks.codexInstrumentation, 'install').mockResolvedValue({
      args: [],
      env: { PODIUM_CODEX_HOOK_URL: 'http://127.0.0.1:1234/hooks/codex-untrusted' },
      // The remedy wording is adapter knowledge: the section reports it, the
      // family only quotes it in the diagnostic body (spec §4.1).
      degradedReason:
        "Codex hooks are installed but Codex has not trusted them (missing trust for: Stop); approve them in Codex's /hooks flow. Sessions run poll-only until then.",
      degradedKind: 'untrusted',
    })
    const result = await installTerminalInstrumentation({
      sessionId: asSessionId('codex-untrusted'),
      harness: 'codex',
      spec: spec('codex'),
      sections: terminalInstrumentationSectionsFor('codex'),
      homeDir,
      settingsDir: join(homeDir, 'settings'),
    })
    expect(result).toMatchObject({
      degradedKind: 'untrusted',
      degradedReason: expect.stringContaining('has not trusted them'),
    })
    // Wiring is retained: the session starts poll-only, it is not refused.
    expect(result.env).toEqual(expect.any(Object))

    const send = vi.fn()
    reportInstrumentationDegradation({}, 'codex', result, send)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'machineDiagnostic',
        code: 'codex-hooks-untrusted',
        // The family description is harness-free; the adapter's remedy travels
        // in the body it quotes.
        description: 'codex hook installation failed; sessions can still start.',
        body: expect.stringContaining('/hooks'),
      }),
    )
  })

  it('keeps a trusted Codex install silent', async () => {
    const homeDir = await directory()
    vi.spyOn(codexHooks.codexInstrumentation, 'install').mockResolvedValue({
      args: [],
      env: { PODIUM_CODEX_HOOK_URL: 'http://127.0.0.1:1234/hooks/codex-trusted' },
    })
    const send = vi.fn()
    const result = await installTerminalInstrumentation({
      sessionId: asSessionId('codex-trusted'),
      harness: 'codex',
      spec: spec('codex'),
      sections: terminalInstrumentationSectionsFor('codex'),
      homeDir,
      settingsDir: join(homeDir, 'settings'),
    })
    expect(result.degradedReason).toBeUndefined()
    reportInstrumentationDegradation({}, 'codex', result, send)
    expect(send).not.toHaveBeenCalled()
  })
})
