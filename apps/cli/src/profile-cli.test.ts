import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENTS_DIR,
  ProfileCliError,
  type ProfileClient,
  type ProfileFs,
  parseCandidate,
  runProfileCli,
} from './profile-cli'

const BUILD = {
  id: 'agp_seed_build',
  name: 'build',
  description: 'Implements a scoped change.',
  candidates: [
    { harness: 'claude-code', model: 'auto', effort: 'high' },
    { harness: 'codex', model: 'auto', effort: 'high' },
  ],
  machineId: null,
  machineName: null,
  instructions: 'Build it.',
  updatedAt: 't0',
}

function fakeClient() {
  const calls: Array<[string, unknown]> = []
  const proc = (name: string, answer: (input: unknown) => unknown) => ({
    query: async (input?: unknown) => {
      calls.push([name, input])
      return answer(input)
    },
    mutate: async (input?: unknown) => {
      calls.push([name, input])
      return answer(input)
    },
  })
  const client: ProfileClient = {
    agentProfiles: {
      list: proc('list', () => [BUILD]),
      show: proc('show', () => BUILD),
      export: proc('export', () => [{ name: 'build', text: '---\nname: build\n---\n' }]),
      create: proc('create', (input) => ({ ...BUILD, ...(input as object) })),
      update: proc('update', (input) => ({ ...BUILD, ...(input as object) })),
      delete: proc('delete', () => ({ id: BUILD.id, name: 'build' })),
      import: proc('import', (input) =>
        (input as { files: Array<{ name: string }> }).files.map((f) => ({
          name: f.name,
          action: 'created',
        })),
      ),
    },
  }
  return { client, calls }
}

function fakeFs(files: Record<string, string>) {
  const written: Record<string, string> = {}
  const fs: ProfileFs = {
    readText: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    writeText: (path, text) => {
      written[path] = text
    },
    listMarkdown: (dir) => {
      const inside = Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md'))
      return inside.length > 0 ? inside.sort() : null
    },
    ensureDir: () => {},
  }
  return { fs, written }
}

describe('podium profile', () => {
  it('lists profiles with their candidates', async () => {
    const { client } = fakeClient()
    const text = await runProfileCli(['list'], { client, cwd: '/repo' })
    expect(text).toContain('build')
    expect(text).toContain('claude-code/auto/high, codex/auto/high')
  })

  it('creates a profile from flags, keeping candidate order and reading an instructions file', async () => {
    const { client, calls } = fakeClient()
    const { fs } = fakeFs({ '/repo/notes.md': '# Be brief' })
    await runProfileCli(
      [
        'create',
        'docs',
        '--candidate',
        'codex/gpt-6.1-sol/xhigh',
        '--candidate=claude-code',
        '--machine',
        'flatblock',
        '--instructions-file',
        'notes.md',
      ],
      { client, cwd: '/repo', fs },
    )
    expect(calls).toEqual([
      [
        'create',
        {
          name: 'docs',
          candidates: [
            { harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
            { harness: 'claude-code', model: 'auto', effort: 'auto' },
          ],
          machine: 'flatblock',
          instructions: '# Be brief',
        },
      ],
    ])
  })

  it('update sends only the named fields; --machine none clears; an empty update is refused', async () => {
    const { client, calls } = fakeClient()
    await runProfileCli(['update', 'build', '--machine', 'none', '--name', 'make'], {
      client,
      cwd: '/r',
    })
    expect(calls).toEqual([['update', { ref: 'build', machine: null, name: 'make' }]])
    await expect(runProfileCli(['update', 'build'], { client, cwd: '/r' })).rejects.toThrow(
      /no fields given/,
    )
  })

  it('imports every .md in .podium/agents by default, naming each by its file', async () => {
    const { client, calls } = fakeClient()
    const { fs } = fakeFs({
      [`/repo/${DEFAULT_AGENTS_DIR}/a.md`]: 'A',
      [`/repo/${DEFAULT_AGENTS_DIR}/b.md`]: 'B',
    })
    const text = await runProfileCli(['import'], { client, cwd: '/repo', fs })
    expect(calls[0]).toEqual([
      'import',
      {
        files: [
          { name: 'a', text: 'A' },
          { name: 'b', text: 'B' },
        ],
      },
    ])
    expect(text).toBe('created a\ncreated b')
  })

  it('exports into <dir>/<name>.md', async () => {
    const { client } = fakeClient()
    const { fs, written } = fakeFs({})
    const text = await runProfileCli(['export', 'build', '--dir', 'out'], {
      client,
      cwd: '/repo',
      fs,
    })
    expect(written).toEqual({ '/repo/out/build.md': '---\nname: build\n---\n' })
    expect(text).toBe('wrote /repo/out/build.md')
  })

  it('refuses unknown flags, flags that do not apply, and bad candidates', async () => {
    const { client } = fakeClient()
    await expect(runProfileCli(['list', '--bogus', 'x'], { client, cwd: '/r' })).rejects.toThrow(
      /unknown flag --bogus/,
    )
    await expect(
      runProfileCli(['delete', 'build', '--machine', 'x'], { client, cwd: '/r' }),
    ).rejects.toThrow(/does not apply/)
    expect(() => parseCandidate('vim/x')).toThrow(ProfileCliError)
    expect(() => parseCandidate('codex/a/b/c')).toThrow(/harness/)
  })

  it('prints help with no command', async () => {
    const { client } = fakeClient()
    expect(await runProfileCli([], { client, cwd: '/r' })).toContain('podium profile <command>')
  })
})
