import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeEdit } from '@podium/harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyHomeEdits, type HomeEditPorts, nodeHomeEditPorts } from './harness-home-edits.js'

const F = '/home/u/.claude.json'

/** An in-memory home: a map of path → body, with every write and log line recorded. */
function memoryPorts() {
  const fs = new Map<string, string>()
  const writes: { path: string; contents: string }[] = []
  const logs: { message: string; fields: Record<string, unknown> }[] = []
  const ports: HomeEditPorts = {
    async readFile(path) {
      await Promise.resolve()
      return fs.get(path)
    },
    async writeFileAtomic(path, contents) {
      await Promise.resolve()
      writes.push({ path, contents })
      fs.set(path, contents)
    },
    log(message, fields) {
      logs.push({ message, fields })
    },
  }
  const get = (path: string): string => {
    const body = fs.get(path)
    if (body === undefined) throw new Error(`no file at ${path}`)
    return body
  }
  return { fs, get, writes, logs, ports }
}

const trust = (root: string): HomeEdit => ({
  kind: 'json-key',
  file: F,
  path: ['projects', root, 'hasTrustDialogAccepted'],
  value: true,
  serves: 'workspace-trust',
})

describe('applyHomeEdits', () => {
  it('sets one key and leaves every other key and its order', async () => {
    const { fs, get, ports } = memoryPorts()
    fs.set(F, '{"a":1,"projects":{"/x":{"k":2}},"z":[3]}')
    const out = await applyHomeEdits(
      [
        {
          kind: 'json-key',
          file: F,
          path: ['projects', '/r', 'hasTrustDialogAccepted'],
          value: true,
          serves: 'workspace-trust',
        },
      ],
      ports,
    )
    expect(out[0]?.status).toBe('applied')
    expect(JSON.parse(get(F))).toEqual({
      a: 1,
      projects: { '/x': { k: 2 }, '/r': { hasTrustDialogAccepted: true } },
      z: [3],
    })
    expect(Object.keys(JSON.parse(get(F)))).toEqual(['a', 'projects', 'z'])
  })

  it('keeps the file’s indentation and trailing newline', async () => {
    const { fs, get, ports } = memoryPorts()
    fs.set(F, `${JSON.stringify({ a: 1, projects: {} }, null, 2)}\n`)
    await applyHomeEdits([trust('/r')], ports)
    expect(get(F)).toBe(
      `${JSON.stringify({ a: 1, projects: { '/r': { hasTrustDialogAccepted: true } } }, null, 2)}\n`,
    )
  })

  it('writes nothing when the value is already there', async () => {
    const { fs, writes, logs, ports } = memoryPorts()
    fs.set(F, '{"projects":{"/r":{"hasTrustDialogAccepted":true,"other":1}}}')
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out).toEqual([{ edit: trust('/r'), status: 'already' }])
    expect(writes).toEqual([])
    expect(logs).toEqual([])
  })

  it('runs two edits to one file one after the other, and both keys end up set', async () => {
    const { fs, get, writes, ports } = memoryPorts()
    fs.set(F, '{"projects":{}}')
    // Two separate calls, as two sessions starting together would make them.
    const first = applyHomeEdits([trust('/a')], ports)
    const second = applyHomeEdits([trust('/b')], ports)
    const [a, b] = await Promise.all([first, second])
    expect(a[0]?.status).toBe('applied')
    expect(b[0]?.status).toBe('applied')
    expect(JSON.parse(get(F))).toEqual({
      projects: { '/a': { hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: true } },
    })
    expect(writes).toHaveLength(2)
  })

  it('retries once when the file changed between read and write, then fails', async () => {
    const { writes, ports } = memoryPorts()
    let n = 0
    // Another program rewrites the file between every two reads.
    ports.readFile = async () => JSON.stringify({ projects: {}, counter: n++ })
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out[0]?.status).toBe('failed')
    expect(out[0]?.status === 'failed' && out[0].reason).toMatch(/another program/)
    expect(writes).toEqual([])
    expect(n).toBe(4)
  })

  it('succeeds on the retry when the other writer settles', async () => {
    const { fs, get, writes, ports } = memoryPorts()
    fs.set(F, '{"projects":{},"v":1}')
    const read = ports.readFile
    let reads = 0
    ports.readFile = async (path) => {
      reads++
      // The second read of the first attempt sees a newer file.
      if (reads === 2) fs.set(F, '{"projects":{},"v":2}')
      return read(path)
    }
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out[0]?.status).toBe('applied')
    expect(writes).toHaveLength(1)
    // The newer file was the base: its v=2 survived.
    expect(JSON.parse(get(F))).toEqual({
      projects: { '/r': { hasTrustDialogAccepted: true } },
      v: 2,
    })
  })

  it('retries when another writer undid the key after the write, then fails if it keeps undoing it', async () => {
    const { fs, writes, ports } = memoryPorts()
    fs.set(F, '{"projects":{}}')
    const write = ports.writeFileAtomic
    // A writer holding an older copy saves it right after each of ours.
    ports.writeFileAtomic = async (path, contents) => {
      await write(path, contents)
      fs.set(F, '{"projects":{}}')
    }
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out[0]?.status).toBe('failed')
    expect(out[0]?.status === 'failed' && out[0].reason).toMatch(/another program/)
    expect(writes).toHaveLength(2)
  })

  it('fails on a JSON file that does not exist yet and creates nothing', async () => {
    const { fs, writes, ports } = memoryPorts()
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out[0]?.status).toBe('failed')
    expect(out[0]?.status === 'failed' && out[0].reason).toMatch(/has not created this file yet/)
    expect(writes).toEqual([])
    expect(fs.has(F)).toBe(false)
  })

  it('fails on a file that is not JSON and leaves it untouched', async () => {
    const { fs, get, writes, ports } = memoryPorts()
    fs.set(F, '{"projects": {')
    const out = await applyHomeEdits([trust('/r')], ports)
    expect(out[0]?.status).toBe('failed')
    expect(out[0]?.status === 'failed' && out[0].reason).toMatch(/not JSON/)
    expect(writes).toEqual([])
    expect(get(F)).toBe('{"projects": {')
  })

  it('fails when a step of the key path is not an object, and leaves the file untouched', async () => {
    const { fs, writes, ports } = memoryPorts()
    for (const body of [
      '[1]',
      '{"projects":[]}',
      '{"projects":{"/r":"yes"}}',
      '{"projects":null}',
    ]) {
      fs.set(F, body)
      const out = await applyHomeEdits([trust('/r')], ports)
      expect(out[0]?.status, body).toBe('failed')
      expect(fs.get(F)).toBe(body)
    }
    expect(writes).toEqual([])
  })

  it('sets a key named like an object prototype member as data', async () => {
    const { fs, get, ports } = memoryPorts()
    fs.set(F, '{"projects":{}}')
    const out = await applyHomeEdits([trust('__proto__')], ports)
    expect(out[0]?.status).toBe('applied')
    expect(get(F)).toBe('{"projects":{"__proto__":{"hasTrustDialogAccepted":true}}}')
    const again = await applyHomeEdits([trust('__proto__')], ports)
    expect(again[0]?.status).toBe('already')
  })

  it('creates an owned file with its folder, and rewrites it only when its contents differ', async () => {
    const { fs, writes, ports } = memoryPorts()
    const owned: HomeEdit = {
      kind: 'owned-file',
      file: '/home/u/.codex/rules/podium.rules',
      contents: 'allow podium\n',
      serves: 'podium-cli',
    }
    expect((await applyHomeEdits([owned], ports))[0]?.status).toBe('applied')
    expect(fs.get(owned.file)).toBe('allow podium\n')
    expect((await applyHomeEdits([owned], ports))[0]?.status).toBe('already')
    expect(writes).toHaveLength(1)
    fs.set(owned.file, 'stale\n')
    expect((await applyHomeEdits([owned], ports))[0]?.status).toBe('applied')
    expect(fs.get(owned.file)).toBe('allow podium\n')
    expect(writes).toHaveLength(2)
  })

  it('logs one line per applied edit with the file and the key', async () => {
    const { fs, logs, ports } = memoryPorts()
    fs.set(F, '{"projects":{"/done":{"hasTrustDialogAccepted":true}}}')
    const owned: HomeEdit = {
      kind: 'owned-file',
      file: '/h/rules/p.rules',
      contents: 'x',
      serves: 'podium-cli',
    }
    await applyHomeEdits(
      [trust('/r'), trust('/done'), owned, { ...trust('/r'), file: '/missing.json' }],
      ports,
    )
    expect(logs).toEqual([
      {
        message: expect.any(String),
        fields: {
          kind: 'json-key',
          file: F,
          key: ['projects', '/r', 'hasTrustDialogAccepted'],
          serves: 'workspace-trust',
        },
      },
      {
        message: expect.any(String),
        fields: { kind: 'owned-file', file: '/h/rules/p.rules', serves: 'podium-cli' },
      },
    ])
  })

  it('turns a port that throws into a failed outcome and goes on to the next edit', async () => {
    const { fs, ports } = memoryPorts()
    fs.set(F, '{"projects":{}}')
    ports.writeFileAtomic = async () => {
      throw new Error('EACCES: permission denied')
    }
    const owned: HomeEdit = {
      kind: 'owned-file',
      file: '/h/p.rules',
      contents: 'x',
      serves: 'podium-cli',
    }
    const out = await applyHomeEdits([trust('/r'), owned], ports)
    expect(out.map((o) => o.status)).toEqual(['failed', 'failed'])
    expect(out[0]?.status === 'failed' && out[0].reason).toMatch(/EACCES/)
  })

  it('refuses an empty key path', async () => {
    const { fs, writes, ports } = memoryPorts()
    fs.set(F, '{}')
    const out = await applyHomeEdits([{ ...trust('/r'), path: [] }], ports)
    expect(out[0]?.status).toBe('failed')
    expect(writes).toEqual([])
  })
})

describe('nodeHomeEditPorts', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'home-edits-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a missing file as undefined and creates the folder on write', async () => {
    const ports = nodeHomeEditPorts(() => {})
    const file = join(dir, 'a', 'b', 'owned.rules')
    expect(await ports.readFile(file)).toBeUndefined()
    await ports.writeFileAtomic(file, 'x')
    expect(await readFile(file, 'utf8')).toBe('x')
  })

  it('keeps the file mode and writes through a symlink to its target', async () => {
    const ports = nodeHomeEditPorts(() => {})
    const target = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    await writeFile(target, '{}')
    await chmod(target, 0o600)
    await symlink(target, link)
    await ports.writeFileAtomic(link, '{"a":1}')
    expect(await readFile(target, 'utf8')).toBe('{"a":1}')
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    // The link is still a link.
    expect(await ports.readFile(link)).toBe('{"a":1}')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
})
