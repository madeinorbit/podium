import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HomeEdit, harnessCommand, unchangedPosture } from '@podium/harness'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { type HomeEditRecord, InstallLedger } from '@podium/harness/inventory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyHomeEdits, nodeHomeEditPorts, undoHomeEdits } from './harness-home-edits.js'
import { planTomlArrayEntryRemoval } from './harness-home-toml.js'
import {
  listHomeEditRecords,
  removeHomeEditRecords,
  undoAllHomeEditRecords,
} from './home-edit-service.js'
import { prepareLaunch } from './session-posture.js'

describe('personal harness home records', () => {
  let dir: string
  let ledger: InstallLedger
  const ports = nodeHomeEditPorts(() => {})
  const record = (value: HomeEditRecord) => {
    ledger.recordHomeEdit(value)
  }
  const kinds = ['json-key', 'owned-file', 'toml-array-entry'] as const

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'podium-home-records-'))
    ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
  })
  afterEach(async () => {
    ledger.close()
    await rm(dir, { recursive: true, force: true })
  })

  function edit(kind: (typeof kinds)[number]): HomeEdit {
    const file = join(dir, kind)
    switch (kind) {
      case 'json-key':
        return {
          kind,
          file,
          path: ['projects', '/r', 'trusted'],
          value: true,
          serves: 'workspace-trust',
        }
      case 'owned-file':
        return { kind, file, contents: 'Podium rule\n', serves: 'podium-cli' }
      case 'toml-array-entry':
        return {
          kind,
          file,
          path: ['permission', 'allow'],
          value: 'Bash(podium *)',
          serves: 'podium-cli',
        }
    }
  }

  async function seed(e: HomeEdit): Promise<string | undefined> {
    const body =
      e.kind === 'json-key'
        ? '{"projects":{"/r":{"trusted":false,"keep":1}},"other":2}\n'
        : e.kind === 'toml-array-entry'
          ? '# header\n[permission]\nallow = ["Bash(git *)"] # keep\n'
          : undefined
    if (body !== undefined) await writeFile(e.file, body)
    return body
  }

  for (const kind of kinds) {
    it(`${kind}: records applied, preserves first prior, and ignores already`, async () => {
      const e = edit(kind)
      await seed(e)
      expect((await applyHomeEdits([e], ports, { harness: 'codex', record }))[0]?.status).toBe(
        'applied',
      )
      const first = ledger.homeEdits()[0]
      expect(first?.file).toBe(await realpath(e.file))
      expect(first?.prior).toEqual(kind === 'json-key' ? { value: false } : { absent: true })
      expect((await applyHomeEdits([e], ports, { harness: 'codex', record }))[0]?.status).toBe(
        'already',
      )
      expect(ledger.homeEdits()).toEqual([first])
      expect(first?.edit.kind).toBe(kind)
      expect(first?.appliedAt).toMatch(/^\d{4}-/)
    })

    it(`${kind}: an existing value has no ownership record`, async () => {
      const e = edit(kind)
      await seed(e)
      await applyHomeEdits([e], ports)
      await applyHomeEdits([e], ports, { harness: 'codex', record })
      expect(ledger.homeEdits()).toEqual([])
    })

    for (const personal of [true, false]) {
      it(`${kind}: launch records ${personal ? 'personal' : 'no Podium'} home edits`, async () => {
        const e = edit(kind)
        await seed(e)
        const context = {
          ...testHarnessContext({ kind: 'codex', home: dir }),
          ...(!personal ? { harnessHome: { id: 'podium-test', dir, variable: 'CODEX_HOME' } } : {}),
        }
        const command = harnessCommand(
          context,
          { args: [] },
          {
            request: {
              mode: 'terminal',
              posture: { mode: 'autonomous' },
              workdir: '/r',
              runtimeDir: dir,
              context,
              grants: {
                podiumCli: { name: 'podium', path: '/bin/podium' },
                uploadsDir: dir,
                mcpServers: [],
              },
            },
            posture: (launch) => ({ ...unchangedPosture(launch), homeEdits: [e] }),
          },
        )
        await prepareLaunch(command, {
          writeLaunchFile: async () => {},
          homeEdits: ports,
          recordHomeEdit: record,
          log: () => {},
        })
        expect(ledger.homeEdits()).toHaveLength(personal ? 1 : 0)
      })
    }

    it(`${kind}: follows a file link and undoes at the original real path`, async () => {
      if (process.platform === 'win32') return
      const e = edit(kind)
      const original = await seed(e)
      if (original === undefined) await writeFile(e.file, 'prior rules\r\n')
      const alias = join(dir, `${kind}-link`)
      await symlink(e.file, alias)
      await applyHomeEdits([{ ...e, file: alias }], ports, { harness: 'codex', record })
      expect(ledger.homeEdits()[0]?.file).toBe(await realpath(e.file))
      const other = join(dir, 'other')
      await writeFile(other, 'unrelated')
      await rm(alias)
      await symlink(other, alias)
      expect((await undoHomeEdits(ledger, ports))[0]?.status).toBe('restored')
      expect(await readFile(other, 'utf8')).toBe('unrelated')
    })

    it(`${kind}: leaves a person's changed value and reports it`, async () => {
      const e = edit(kind)
      await seed(e)
      await applyHomeEdits([e], ports, { harness: 'codex', record })
      const changed =
        kind === 'json-key'
          ? '{"projects":{"/r":{"trusted":"ask"}}}'
          : kind === 'toml-array-entry'
            ? '[permission]\nallow = ["Bash(other *)"]\n'
            : 'personal rules'
      await writeFile(e.file, changed)
      const out = await undoHomeEdits(ledger, ports)
      expect(out[0]?.status).toBe('changed')
      expect(await readFile(e.file, 'utf8')).toBe(changed)
      expect(ledger.homeEdits()).toHaveLength(1)
    })
  }

  it('owned-file restores the original contents byte for byte, including empty contents', async () => {
    const e = edit('owned-file')
    for (const body of ['', '\ufeffprior\r\n# café\n']) {
      await writeFile(e.file, body)
      await applyHomeEdits([e], ports, { harness: 'codex', record })
      expect((await undoHomeEdits(ledger, ports))[0]?.status).toBe('restored')
      expect(await readFile(e.file)).toEqual(Buffer.from(body))
      expect(ledger.homeEdits()).toEqual([])
    }
  })

  it('owned-file removes a file that was absent', async () => {
    const e = edit('owned-file')
    await applyHomeEdits([e], ports, { harness: 'codex', record })
    await undoHomeEdits(ledger, ports)
    await expect(readFile(e.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('json-key restores only the prior key, keeping later edits to siblings', async () => {
    const e = edit('json-key')
    await seed(e)
    await applyHomeEdits([e], ports, { harness: 'claude-code', record })
    await writeFile(e.file, '{"projects":{"/r":{"trusted":true,"keep":9}},"new":"personal"}\n')
    await undoHomeEdits(ledger, ports)
    expect(JSON.parse(await readFile(e.file, 'utf8'))).toEqual({
      projects: { '/r': { trusted: false, keep: 9 } },
      new: 'personal',
    })
  })

  it('json-key remembers absence and null as different prior values', async () => {
    const e = edit('json-key')
    for (const prior of [undefined, null]) {
      await writeFile(e.file, JSON.stringify({ projects: { '/r': { trusted: prior, keep: 1 } } }))
      await applyHomeEdits([e], ports, { harness: 'claude-code', record })
      expect(ledger.homeEdits()[0]?.prior).toEqual(
        prior === undefined ? { absent: true } : { value: null },
      )
      await undoHomeEdits(ledger, ports)
      expect(JSON.parse(await readFile(e.file, 'utf8'))).toEqual({
        projects: { '/r': { ...(prior === null ? { trusted: null } : {}), keep: 1 } },
      })
    }
  })

  it('keeps the prior value from before the first write across a later applied edit', async () => {
    const e = edit('owned-file')
    await writeFile(e.file, 'before')
    await applyHomeEdits([e], ports, { harness: 'codex', record })
    await applyHomeEdits([{ ...e, contents: 'new Podium rules' } as HomeEdit], ports, {
      harness: 'codex',
      record,
    })
    expect(ledger.homeEdits()).toHaveLength(1)
    expect(ledger.homeEdits()[0]?.prior).toEqual({ contents: 'before' })
    await undoHomeEdits(ledger, ports)
    expect(await readFile(e.file, 'utf8')).toBe('before')
  })

  it('toml undo removes only one string, keeping added entries, every comment, line and CRLF', async () => {
    const e = edit('toml-array-entry')
    await seed(e)
    await applyHomeEdits([e], ports, { harness: 'grok', record })
    await writeFile(
      e.file,
      '# before\r\n[permission]\r\nallow = [\r\n  "Bash(git *)", # keep, comma\r\n  "Bash(podium *)", # Podium comment kept\r\n  "Bash(personal *)",\r\n] # after\r\n[other]\r\nx = 2\r\n',
    )
    await undoHomeEdits(ledger, ports)
    expect(await readFile(e.file, 'utf8')).toBe(
      '# before\r\n[permission]\r\nallow = [\r\n  "Bash(git *)", # keep, comma\r\n   # Podium comment kept\r\n  "Bash(personal *)",\r\n] # after\r\n[other]\r\nx = 2\r\n',
    )
  })

  it('scopes an explicit undo to one harness, while machine cleanup undoes all', async () => {
    const a = edit('owned-file')
    const b = edit('json-key')
    await seed(b)
    await applyHomeEdits([a], ports, { harness: 'codex', record })
    await applyHomeEdits([b], ports, { harness: 'claude-code', record })
    const open = InstallLedger.open
    const spy = vi
      .spyOn(InstallLedger, 'open')
      .mockImplementation(() => open({ harnessesDir: join(dir, 'harnesses') }))
    try {
      expect(listHomeEditRecords('codex')).toHaveLength(1)
      expect(listHomeEditRecords()).toHaveLength(2)
      expect((await removeHomeEditRecords('codex')).map((out) => out.record.harness)).toEqual([
        'codex',
      ])
      await expect(readFile(a.file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(listHomeEditRecords().map((row) => row.harness)).toEqual(['claude-code'])
      expect((await undoAllHomeEditRecords()).map((out) => out.status)).toEqual(['restored'])
      expect(listHomeEditRecords()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('re-reads before undo so a racing writer keeps its newer file', async () => {
    const e = edit('owned-file')
    await applyHomeEdits([e], ports, { harness: 'codex', record })
    let reads = 0
    const out = await undoHomeEdits(ledger, {
      ...ports,
      async readFile(path) {
        if (++reads === 2) await writeFile(path, 'new personal contents')
        return ports.readFile(path)
      },
    })
    expect(out[0]?.status).toBe('changed')
    expect(await readFile(e.file, 'utf8')).toBe('new personal contents')
  })

  it('records a new file through a symlinked parent at its real path', async () => {
    if (process.platform === 'win32') return
    const real = join(dir, 'real')
    await mkdir(real)
    const alias = join(dir, 'alias')
    await symlink(real, alias, 'dir')
    const e = { ...edit('owned-file'), file: join(alias, 'rules', 'podium.rules') }
    await applyHomeEdits([e], ports, { harness: 'codex', record })
    expect(ledger.homeEdits()[0]?.file).toBe(await realpath(join(real, 'rules', 'podium.rules')))
  })

  it('does not touch a file replacing the recorded path with a link', async () => {
    if (process.platform === 'win32') return
    const e = edit('owned-file')
    await applyHomeEdits([e], ports, { harness: 'codex', record })
    const other = join(dir, 'other-rules')
    await writeFile(other, 'Podium rule\n')
    await rm(e.file)
    await symlink(other, e.file)
    expect((await undoHomeEdits(ledger, ports))[0]?.status).toBe('changed')
    expect(await readFile(other, 'utf8')).toBe('Podium rule\n')
  })

  it('records a missing symlink target rather than replacing the link', async () => {
    if (process.platform === 'win32') return
    const e = edit('owned-file')
    const target = join(dir, 'not-created', 'rules')
    await symlink(target, e.file)
    expect((await applyHomeEdits([e], ports, { harness: 'codex', record }))[0]?.status).toBe(
      'applied',
    )
    expect(ledger.homeEdits()[0]?.file).toBe(await realpath(target))
    expect(await realpath(e.file)).toBe(await realpath(target))
  })
})

describe('TOML entry undo separators', () => {
  it.each([
    ['["podium"]', '[]'],
    ['["podium",]', '[]'],
    ['["podium", "a"]', '[ "a"]'],
    ['["a", "podium"]', '["a" ]'],
    ['["a", "podium",]', '["a", ]'],
    ['["a", "podium", "b"]', '["a",  "b"]'],
    ['["podium", "podium"]', '[ "podium"]'],
    ['["a", # comment, comma\n "podium"]', '["a" # comment, comma\n ]'],
    [
      '["a", # comment, comma\n "podium", # more, comma\n]',
      '["a", # comment, comma\n  # more, comma\n]',
    ],
  ])('keeps all other bytes for %s', (array, expected) => {
    expect(
      planTomlArrayEntryRemoval(
        `[permission]\nallow = ${array}\n`,
        ['permission', 'allow'],
        'podium',
      ),
    ).toEqual({ next: `[permission]\nallow = ${expected}\n` })
  })
})
