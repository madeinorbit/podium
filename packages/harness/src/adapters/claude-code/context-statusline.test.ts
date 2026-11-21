import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { inheritedClaudeStatusLine } from './context-statusline.js'
import { claudeCodeInstrumentation } from './instrumentation.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-context-settings-'))
  dirs.push(dir)
  const config = join(dir, 'config'),
    workdir = join(dir, 'project'),
    nested = join(workdir, 'src')
  await mkdir(config)
  await mkdir(join(workdir, '.claude'), { recursive: true })
  await mkdir(join(workdir, '.git'))
  await mkdir(nested)
  return { dir, config, workdir, nested }
}

describe('Claude launch-only context instrumentation', () => {
  it('resolves user/project/local status command, keeps options and writes only the launch overlay', async () => {
    const { config, workdir, nested, dir } = await scratch()
    const user = JSON.stringify({
      statusLine: { type: 'command', command: 'printf user', padding: 4, refreshInterval: 7 },
      hooks: { Stop: ['keep-user-hooks'] },
    })
    const project = JSON.stringify({
      statusLine: { type: 'command', command: 'printf project' },
      permissions: { allow: ['keep-project-policy'] },
    })
    const local = JSON.stringify({
      statusLine: { type: 'command', command: "printf 'local quoted output'" },
    })
    await writeFile(join(config, 'settings.json'), user)
    await writeFile(join(workdir, '.claude', 'settings.json'), project)
    await writeFile(join(workdir, '.claude', 'settings.local.json'), local)
    await mkdir(join(nested, '.claude'))
    await writeFile(
      join(nested, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf nested-project' } }),
    )
    await writeFile(
      join(nested, '.claude', 'settings.local.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'printf legacy-local', refreshInterval: 2 },
      }),
    )
    expect(await inheritedClaudeStatusLine(config, nested)).toEqual({
      type: 'command',
      command: "printf 'local quoted output'",
      padding: 4,
      refreshInterval: 2,
    })
    const installed = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1234/hooks/test?token=invented',
      workdir: nested,
      settingsDir: join(dir, 'launch'),
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.319',
        roots: { config },
      }),
    })
    const overlay = JSON.parse(installed.file!.contents)
    expect(installed.args).toEqual(['--settings', join(dir, 'launch', 'test.json')])
    expect(overlay.statusLine).toMatchObject({ type: 'command', padding: 4, refreshInterval: 2 })
    expect(overlay.statusLine.command).toContain('mktemp')
    expect(overlay.hooks.Stop).toHaveLength(1)
    expect(overlay.permissions).toBeUndefined()
    expect(await readFile(join(config, 'settings.json'), 'utf8')).toBe(user)
    expect(await readFile(join(workdir, '.claude', 'settings.json'), 'utf8')).toBe(project)
    expect(await readFile(join(workdir, '.claude', 'settings.local.json'), 'utf8')).toBe(local)
    expect(installed.degradedReason).toBeUndefined()
  })
  it('does not inherit root project settings for a nested launch and preserves command text arguments', async () => {
    const { config, workdir, nested, dir } = await scratch()
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf first' } }),
    )
    await writeFile(
      join(workdir, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf root-project' } }),
    )
    expect((await inheritedClaudeStatusLine(config, nested))?.command).toBe('printf first')
    await mkdir(join(nested, '.claude'))
    await writeFile(
      join(nested, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf second' } }),
    )
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir: nested,
      settingsDir: dir,
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.319',
        roots: { config },
      }),
    })
    const status = JSON.parse(result.file!.contents).statusLine
    expect(status.args).toBeUndefined()
    expect(status.command).toContain('printf second')
  })
  it('preserves a native shell it cannot safely chain', async () => {
    const { config, workdir, dir } = await scratch()
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'Write-Output original', shell: 'powershell' },
      }),
    )
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir,
      settingsDir: dir,
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.319',
        roots: { config },
      }),
    })
    expect(JSON.parse(result.file!.contents).statusLine).toBeUndefined()
    expect(result.degradedReason).toContain('existing status line preserved')
  })
  it('declines rather than guessing the effect of invalid per-source command objects', async () => {
    const { config, workdir, dir } = await scratch()
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf user' } }),
    )
    await writeFile(
      join(workdir, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { command: 'printf partial' } }),
    )
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir,
      settingsDir: dir,
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.319',
        roots: { config },
      }),
    })
    expect(JSON.parse(result.file!.contents).statusLine).toBeUndefined()
    expect(result.degradedReason).toContain('existing status line preserved')
  })
  it('adds a silent bridge when there is no inherited status command', async () => {
    const { config, workdir, dir } = await scratch()
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir,
      settingsDir: dir,
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.330',
        roots: { config },
      }),
    })
    expect(JSON.parse(result.file!.contents).statusLine.type).toBe('command')
    expect(result.degradedReason).toBeUndefined()
  })
  it.each([
    '',
    '2.1.318',
    '3.0.0',
  ])('preserves status behavior on unverified version %s', async (version) => {
    const { config, workdir, dir } = await scratch()
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf unchanged' } }),
    )
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir,
      settingsDir: dir,
      harnessContext: testHarnessContext({ kind: 'claude-code', version, roots: { config } }),
    })
    expect(JSON.parse(result.file!.contents).statusLine).toBeUndefined()
    expect(result.degradedReason).toContain('existing status line preserved')
  })
  it('declines context injection when inherited settings are malformed', async () => {
    const { config, workdir, dir } = await scratch()
    await writeFile(join(config, 'settings.json'), '{broken')
    const result = await claudeCodeInstrumentation.install({
      sessionId: 'test' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/test',
      workdir,
      settingsDir: dir,
      harnessContext: testHarnessContext({
        kind: 'claude-code',
        version: '2.1.319',
        roots: { config },
      }),
    })
    expect(JSON.parse(result.file!.contents).statusLine).toBeUndefined()
    expect(JSON.parse(result.file!.contents).hooks.Stop).toBeDefined()
    expect(result.degradedReason).toContain('could not preserve inherited settings')
  })
  it('routes raw status payloads as observations without producing agent-state changes', async () => {
    const raw = {
      session_id: 'native',
      transcript_path: '/fixture.jsonl',
      version: '2.1.319',
      context_window: null,
    }
    const codec = claudeCodeInstrumentation.payloadCodec
    expect(codec.eventName(raw)).toBe('PodiumContextStatus')
    expect(codec.sessionId(raw)).toBe('native')
    await expect(
      codec.decode(raw, { home: '/fixture', env: {}, roots: { state: '/fixture' } }),
    ).resolves.toEqual([])
  })
})
