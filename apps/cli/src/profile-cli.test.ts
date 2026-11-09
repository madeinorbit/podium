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

/** A client whose reads answer from {@link BUILD} and whose writes are
 *  recorded `sync.submit` envelopes (POD-6676: every profile write is a generic
 *  record write). `refuse` names a command the server refuses. */
function fakeClient(refuse?: { command: string; message: string }) {
  const calls: Array<[string, unknown]> = []
  const submitted: Array<{ command: string; input: unknown }> = []
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
      show: proc('show', (input) => {
        const ref = (input as { ref: string }).ref
        if (ref === 'build' || ref === BUILD.id) return BUILD
        // A profile this client created: its fields, under its id.
        const created = submitted.find(
          (entry) => (entry.input as { id?: string }).id === ref,
        )?.input as { fields?: object } | undefined
        return { ...BUILD, id: ref, ...created?.fields }
      }),
      export: proc('export', () => [{ name: 'build', text: '---\nname: build\n---\n' }]),
    },
    sync: {
      submit: {
        mutate: async (envelope) => {
          submitted.push({ command: envelope.command, input: envelope.input })
          if (envelope.command === refuse?.command) {
            return { outcome: 'rejected', refusal: { kind: 'invalid', message: refuse.message } }
          }
          return {
            outcome: 'applied',
            result: { ok: true },
            receipt: { feedId: 'f', epoch: 'e', seq: 1 },
            replayed: false,
          }
        },
      },
    },
  }
  return { client, calls, submitted }
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
  it('writes generic records on sync.submit, with the handler message on a refusal', async () => {
    const { client, submitted } = fakeClient({
      command: 'records.agentProfile.remove',
      message: 'build is used by an open issue',
    })
    const text = await runProfileCli(['create', 'review', '--candidate', 'codex'], {
      client,
      cwd: '/repo',
    })
    expect(text).toContain('created profile review')
    expect(submitted[0]?.command).toBe('records.agentProfile.create')
    // The id is minted here (ADR 12 D4).
    expect((submitted[0]?.input as { id: string }).id).toMatch(/^agp_[0-9a-f-]{36}$/)
    await expect(runProfileCli(['delete', 'build'], { client, cwd: '/repo' })).rejects.toThrow(
      'build is used by an open issue',
    )
    expect(submitted.at(-1)).toEqual({
      command: 'records.agentProfile.remove',
      input: { id: BUILD.id },
    })
  })

  it('lists profiles with their candidates', async () => {
    const { client } = fakeClient()
    const text = await runProfileCli(['list'], { client, cwd: '/repo' })
    expect(text).toContain('build')
    expect(text).toContain('claude-code/auto/high, codex/auto/high')
  })

  it('creates a profile from flags, keeping candidate order and reading an instructions file', async () => {
    const { client, submitted } = fakeClient()
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
    expect(submitted.map(({ command }) => command)).toEqual(['records.agentProfile.create'])
    expect((submitted[0]?.input as { fields: unknown }).fields).toEqual({
      name: 'docs',
      candidates: [
        { harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
        { harness: 'claude-code', model: 'auto', effort: 'auto' },
      ],
      machineId: 'flatblock',
      instructions: '# Be brief',
    })
  })

  it('update sends only the named fields of the id the name resolves to; --machine none clears; an empty update is refused', async () => {
    const { client, submitted } = fakeClient()
    await runProfileCli(['update', 'build', '--machine', 'none', '--name', 'make'], {
      client,
      cwd: '/r',
    })
    expect(submitted).toEqual([
      {
        command: 'records.agentProfile.edit',
        input: { id: BUILD.id, patch: { machineId: null, name: 'make' } },
      },
    ])
    await expect(runProfileCli(['update', 'build'], { client, cwd: '/r' })).rejects.toThrow(
      /no fields given/,
    )
  })

  it('imports every .md in .podium/agents by default: an edit for a name that exists, else a create', async () => {
    const { client, submitted } = fakeClient()
    const { fs } = fakeFs({
      [`/repo/${DEFAULT_AGENTS_DIR}/build.md`]: '---\ndescription: Builds\n---\nBuild it well.',
      [`/repo/${DEFAULT_AGENTS_DIR}/triage.md`]: '---\nmodel: auto\n---\nSort them.',
    })
    const text = await runProfileCli(['import'], { client, cwd: '/repo', fs })
    expect(submitted.map(({ command }) => command)).toEqual([
      'records.agentProfile.edit',
      'records.agentProfile.create',
    ])
    expect(submitted[0]?.input).toMatchObject({
      id: BUILD.id,
      patch: { description: 'Builds', instructions: 'Build it well.' },
    })
    expect(submitted[1]?.input).toMatchObject({
      fields: { name: 'triage', instructions: 'Sort them.' },
    })
    expect(text).toBe('updated build\ncreated triage')
  })

  it('imports nothing when one file is bad', async () => {
    const { client, submitted } = fakeClient()
    const { fs } = fakeFs({
      [`/repo/${DEFAULT_AGENTS_DIR}/ok.md`]: '---\nname: ok\n---\n',
      [`/repo/${DEFAULT_AGENTS_DIR}/zbad.md`]: 'no frontmatter',
    })
    await expect(runProfileCli(['import'], { client, cwd: '/repo', fs })).rejects.toThrow(
      ProfileCliError,
    )
    expect(submitted).toEqual([])
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
