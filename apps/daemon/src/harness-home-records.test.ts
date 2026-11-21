import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HomeEdit, harnessCommand, unchangedPosture } from '@podium/harness'
import { ensurePodiumCodexHooks } from '@podium/harness/adapters/codex/instrumentation'
import { ensurePodiumGrokHooks } from '@podium/harness/adapters/grok/instrumentation'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { type HomeEditRecord, InstallLedger } from '@podium/harness/inventory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyHomeEdits, nodeHomeEditPorts, undoHomeEdits } from './harness-home-edits.js'
import { planTomlArrayEntryRemoval } from './harness-home-toml.js'
import {
  listHomeEditRecords,
  recordInstrumentationHookFile,
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
        await prepareLaunch(
          command,
          {
            writeLaunchFile: async () => {},
            homeEdits: ports,
            recordHomeEdit: record,
            log: () => {},
          },
          { noSession: 'a home-edit record test serves no session' },
        )
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

describe('Podium’s hook files in the person’s own folder (POD-7388)', () => {
  let dir: string
  let harnessesDir: string
  const ports = nodeHomeEditPorts(() => {})
  const sha = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'podium-hook-files-'))
    harnessesDir = join(dir, 'harnesses')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function installCodex() {
    const result = await ensurePodiumCodexHooks({
      homeDir: dir,
      verifiedVersion: 'codex-cli 0.169.0',
      launchTrust: true,
    })
    await recordInstrumentationHookFile('codex', {}, result.hookFile, harnessesDir)
    return result
  }
  async function installGrok() {
    const result = await ensurePodiumGrokHooks({ homeDir: dir })
    await recordInstrumentationHookFile('grok', {}, result.hookFile, harnessesDir)
    return result
  }
  const codexHooks = () => join(dir, '.codex', 'hooks.json')
  const grokHooks = () => join(dir, '.grok', 'hooks', 'podium.json')

  it('Codex: a hooks.json Podium created is listed and removed again', async () => {
    await mkdir(join(dir, '.codex'))
    expect((await installCodex()).changed).toBe(true)
    const listed = listHomeEditRecords('codex', harnessesDir)
    expect(listed).toEqual([
      expect.objectContaining({
        harness: 'codex',
        file: await realpath(codexHooks()),
        edit: expect.objectContaining({ kind: 'hook-handlers', marker: 'PODIUM_CODEX_HOOK_URL' }),
        prior: { absent: true },
        serves: 'session-state',
      }),
    ])
    // The next launch finds the handlers in place: one record, first prior kept.
    expect((await installCodex()).changed).toBe(false)
    expect(listHomeEditRecords('codex', harnessesDir)).toEqual(listed)

    const undone = await removeHomeEditRecords('codex', harnessesDir)
    expect(undone.map((outcome) => outcome.status)).toEqual(['restored'])
    expect(existsSync(codexHooks())).toBe(false)
    expect(listHomeEditRecords('codex', harnessesDir)).toEqual([])
  })

  it('Codex: the person’s own hooks.json gets its exact bytes back', async () => {
    await mkdir(join(dir, '.codex'))
    const mine =
      '{\n    "hooks": {\n        "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }]\n    },\n    "note": 1\n}\n'
    await writeFile(codexHooks(), mine)
    const before = await sha(codexHooks())
    await installCodex()
    expect(await sha(codexHooks())).not.toBe(before)
    expect(listHomeEditRecords('codex', harnessesDir)[0]?.prior).toEqual({ contents: mine })

    await removeHomeEditRecords('codex', harnessesDir)
    expect(await sha(codexHooks())).toBe(before)
  })

  it('Codex: hooks the person added since stay; only Podium’s handlers go', async () => {
    await mkdir(join(dir, '.codex'))
    await installCodex()
    const doc = JSON.parse(await readFile(codexHooks(), 'utf8'))
    doc.hooks.Stop[0].hooks.push({ type: 'command', command: 'notify-send stop' })
    doc.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] })
    await writeFile(codexHooks(), JSON.stringify(doc, null, 2))

    expect((await removeHomeEditRecords('codex', harnessesDir))[0]?.status).toBe('restored')
    expect(JSON.parse(await readFile(codexHooks(), 'utf8'))).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send stop' }] }],
      },
    })
  })

  it('Codex: handlers an older Podium left without a record are recorded and removed', async () => {
    await mkdir(join(dir, '.codex'))
    // Installed before Podium recorded hook files: no ledger row.
    await ensurePodiumCodexHooks({ homeDir: dir, verifiedVersion: 'codex-cli 0.169.0' })
    expect(listHomeEditRecords('codex', harnessesDir)).toEqual([])
    expect((await installCodex()).changed).toBe(false)
    expect(listHomeEditRecords('codex', harnessesDir)[0]?.prior).toEqual({ absent: true })
    await removeHomeEditRecords('codex', harnessesDir)
    expect(existsSync(codexHooks())).toBe(false)
  })

  it('Grok: podium.json Podium created is listed and removed again', async () => {
    await mkdir(join(dir, '.grok'))
    expect((await installGrok()).changed).toBe(true)
    expect(listHomeEditRecords('grok', harnessesDir)).toEqual([
      expect.objectContaining({
        file: await realpath(grokHooks()),
        edit: expect.objectContaining({ kind: 'hook-handlers', marker: 'PODIUM_GROK_HOOK_URL' }),
        prior: { absent: true, createdFolder: await realpath(join(dir, '.grok', 'hooks')) },
      }),
    ])
    expect((await removeHomeEditRecords('grok', harnessesDir))[0]?.status).toBe('restored')
    expect(existsSync(grokHooks())).toBe(false)
    // POD-7389: the hooks folder Podium made goes too; the Grok home stays.
    expect(existsSync(join(dir, '.grok', 'hooks'))).toBe(false)
    expect(existsSync(join(dir, '.grok'))).toBe(true)
    expect(listHomeEditRecords('grok', harnessesDir)).toEqual([])
  })

  it('Grok: a hooks folder the person already had stays', async () => {
    await mkdir(join(dir, '.grok', 'hooks'), { recursive: true })
    await installGrok()
    expect(listHomeEditRecords('grok', harnessesDir)[0]?.prior).toEqual({ absent: true })
    await removeHomeEditRecords('grok', harnessesDir)
    expect(existsSync(grokHooks())).toBe(false)
    expect(existsSync(join(dir, '.grok', 'hooks'))).toBe(true)
  })

  it('a hook file the person deleted drops its record and writes nothing', async () => {
    await mkdir(join(dir, '.grok'))
    await installGrok()
    await rm(grokHooks())
    expect((await removeHomeEditRecords('grok', harnessesDir))[0]?.status).toBe('restored')
    expect(existsSync(grokHooks())).toBe(false)
    expect(listHomeEditRecords('grok', harnessesDir)).toEqual([])
  })

  it('a hook file that is no longer JSON is kept and stays recorded', async () => {
    await mkdir(join(dir, '.grok'))
    await installGrok()
    await writeFile(grokHooks(), 'not json')
    expect((await removeHomeEditRecords('grok', harnessesDir))[0]?.status).toBe('changed')
    expect(await readFile(grokHooks(), 'utf8')).toBe('not json')
    expect(listHomeEditRecords('grok', harnessesDir)).toHaveLength(1)
  })

  it('a hook file in a Podium home is not recorded', async () => {
    await mkdir(join(dir, '.grok'))
    const result = await ensurePodiumGrokHooks({ homeDir: dir })
    await recordInstrumentationHookFile(
      'grok',
      { harnessHome: { id: 'podium-test', dir: join(dir, '.grok'), variable: 'GROK_HOME' } },
      result.hookFile,
      harnessesDir,
    )
    expect(listHomeEditRecords('grok', harnessesDir)).toEqual([])
  })
})

describe('folders Podium created for a home edit (POD-7389)', () => {
  let dir: string
  let ledger: InstallLedger
  const ports = nodeHomeEditPorts(() => {})
  const record = (value: HomeEditRecord) => {
    ledger.recordHomeEdit(value)
  }
  const rule = (file: string): HomeEdit => ({
    kind: 'owned-file',
    file,
    contents: 'prefix_rule(pattern=["podium"], decision="allow")\n',
    serves: 'podium-cli',
  })

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'podium-home-folders-')))
    ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    await mkdir(join(dir, '.codex'))
  })
  afterEach(async () => {
    ledger.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('removes the rules folder Podium created and keeps the Codex home', async () => {
    const file = join(dir, '.codex', 'rules', 'podium.rules')
    await applyHomeEdits([rule(file)], ports, { harness: 'codex', record })
    expect(ledger.homeEdits()[0]?.prior).toEqual({
      absent: true,
      createdFolder: join(dir, '.codex', 'rules'),
    })
    expect((await undoHomeEdits(ledger, ports))[0]?.status).toBe('restored')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, '.codex', 'rules'))).toBe(false)
    expect(existsSync(join(dir, '.codex'))).toBe(true)
  })

  it('keeps a created folder the person put a file in', async () => {
    const file = join(dir, '.codex', 'rules', 'podium.rules')
    await applyHomeEdits([rule(file)], ports, { harness: 'codex', record })
    await writeFile(join(dir, '.codex', 'rules', 'mine.rules'), 'mine\n')
    expect((await undoHomeEdits(ledger, ports))[0]?.status).toBe('restored')
    expect(existsSync(file)).toBe(false)
    expect(await readFile(join(dir, '.codex', 'rules', 'mine.rules'), 'utf8')).toBe('mine\n')
  })

  it('keeps a folder that was there before', async () => {
    await mkdir(join(dir, '.codex', 'rules'))
    const file = join(dir, '.codex', 'rules', 'podium.rules')
    await applyHomeEdits([rule(file)], ports, { harness: 'codex', record })
    expect(ledger.homeEdits()[0]?.prior).toEqual({ absent: true })
    await undoHomeEdits(ledger, ports)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, '.codex', 'rules'))).toBe(true)
  })

  it('removes nested created folders up to the first one the person filled', async () => {
    const file = join(dir, '.codex', 'a', 'b', 'podium.rules')
    await applyHomeEdits([rule(file)], ports, { harness: 'codex', record })
    expect(ledger.homeEdits()[0]?.prior).toEqual({
      absent: true,
      createdFolder: join(dir, '.codex', 'a'),
    })
    await writeFile(join(dir, '.codex', 'a', 'keep'), 'x')
    await undoHomeEdits(ledger, ports)
    expect(existsSync(join(dir, '.codex', 'a', 'b'))).toBe(false)
    expect(existsSync(join(dir, '.codex', 'a', 'keep'))).toBe(true)
  })

  it('a JSON key in a file Podium created removes the file’s new folder too', async () => {
    const file = join(dir, '.codex', 'new', 'settings.json')
    const key: HomeEdit = {
      kind: 'json-key',
      file,
      path: ['trusted'],
      value: true,
      serves: 'workspace-trust',
      createIfMissing: true,
    }
    await applyHomeEdits([key], ports, { harness: 'codex', record })
    expect(ledger.homeEdits()[0]?.prior).toEqual({
      absent: true,
      createdFolder: join(dir, '.codex', 'new'),
    })
  })
})
