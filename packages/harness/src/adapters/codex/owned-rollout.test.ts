import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnedCodexRolloutResolver, type ProcessInspection } from './owned-rollout.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function psDate(ms: number): string {
  const [weekday, day, month, year, time] = new Date(ms).toUTCString().split(' ')
  return `${weekday?.slice(0, 3)} ${month} ${day} ${time} ${year}`
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-owned-'))
  roots.push(home)
  const root = join(home, 'sessions')
  await mkdir(root)
  const now = Math.floor(Date.now() / 1_000) * 1_000
  let owner: { pid: number; generation: object } | undefined = { pid: 101, generation: {} }
  const processes = new Map([[101, { parent: 1, started: now }]])
  const files = new Map<number, string[]>()
  const inspect = vi.fn<ProcessInspection>(async (command, args, limits) => {
    expect(limits.timeout).toBeGreaterThan(0)
    expect(limits.timeout).toBeLessThanOrEqual(1_000)
    expect(limits.maxBuffer).toBeLessThanOrEqual(512 * 1024)
    if (command === 'ps') {
      return args[1]!
        .split(',')
        .map(Number)
        .map((pid) => {
          const row = processes.get(pid)
          return row ? `${pid} ${row.parent} ${psDate(row.started)}\n` : ''
        })
        .join('')
    }
    if (command === 'pgrep') {
      return [...processes]
        .filter(([, row]) => row.parent === Number(args[1]))
        .map(([pid]) => pid)
        .join('\n')
    }
    if (command === 'lsof') {
      expect(args).toEqual(['-nP', '-a', '-p', expect.any(String), '-F0pfn'])
      return args[3]!
        .split(',')
        .map(Number)
        .map(
          (pid) =>
            `p${pid}\0\n${(files.get(pid) ?? []).map((path, i) => `f${i}\0n${path}\0\n`).join('')}`,
        )
        .join('')
    }
    throw new Error(`unexpected tool ${command}`)
  })
  async function rollout(options: { source?: unknown; timestamp?: number; path?: string } = {}) {
    const id = randomUUID()
    const path = options.path ?? join(root, `rollout-${id}.jsonl`)
    await writeFile(
      path,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          cwd: '/same/repo',
          source: options.source ?? 'cli',
          timestamp: new Date(options.timestamp ?? now).toISOString(),
        },
      }) + '\n',
    )
    return { id, path }
  }
  const resolver = (options: Partial<Parameters<typeof createOwnedCodexRolloutResolver>[0]> = {}) =>
    createOwnedCodexRolloutResolver({
      ownedProcess: () => owner,
      sessionsRoot: root,
      startedAtMs: now,
      platform: 'darwin',
      inspect,
      ...options,
    })
  return {
    home,
    root,
    now,
    processes,
    files,
    inspect,
    rollout,
    resolver,
    setOwner(value: typeof owner) {
      owner = value
    },
  }
}

describe('macOS owned Codex rollout', () => {
  it('binds only its interactive file among same-cwd siblings and a guardian', async () => {
    const f = await fixture()
    const own = await f.rollout()
    const sibling = await f.rollout()
    const guardian = await f.rollout({ source: { subagent: { other: 'guardian' } } })
    f.files.set(101, [own.path, guardian.path])
    f.files.set(202, [sibling.path])
    await expect(f.resolver()()).resolves.toMatchObject(own)
    expect(f.inspect.mock.calls.every(([, args]) => !args.includes('202'))).toBe(true)
  })

  it('follows a validated wrapper lineage to the native child', async () => {
    const f = await fixture()
    const own = await f.rollout()
    f.processes.set(102, { parent: 101, started: f.now })
    f.files.set(102, [own.path])
    await expect(f.resolver()()).resolves.toMatchObject(own)
  })

  it('retries lazy creation and discovers a subsequent native thread', async () => {
    const f = await fixture()
    const resolve = f.resolver()
    await expect(resolve()).resolves.toBeUndefined()
    const first = await f.rollout()
    f.files.set(101, [first.path])
    await expect(resolve()).resolves.toMatchObject(first)
    const next = await f.rollout()
    f.files.set(101, [next.path])
    await expect(resolve()).resolves.toMatchObject(next)
  })

  it('rejects stale startup FDs, retaining only an explicitly resumed old thread', async () => {
    const f = await fixture()
    const old = await f.rollout({ timestamp: f.now - 60_000 })
    f.files.set(101, [old.path])
    await expect(f.resolver()()).resolves.toBeUndefined()
    await expect(f.resolver({ resumeValue: old.id })()).resolves.toMatchObject(old)
  })

  it('rejects ambiguous interactive files instead of picking the newest', async () => {
    const f = await fixture()
    f.files.set(101, [(await f.rollout()).path, (await f.rollout()).path])
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it.each(['exec', { subagent: { other: 'guardian' } }])('excludes source %j', async (source) => {
    const f = await fixture()
    f.files.set(101, [(await f.rollout({ source })).path])
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it('preserves documented legacy source compatibility', async () => {
    const f = await fixture()
    const own = await f.rollout()
    await writeFile(
      own.path,
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(f.now).toISOString(),
        payload: { id: own.id, cwd: '/same/repo' },
      }) + '\n',
    )
    f.files.set(101, [own.path])
    await expect(f.resolver()()).resolves.toMatchObject(own)
  })

  it('rejects foreign roots and symlink escapes', async () => {
    const f = await fixture()
    const foreign = await f.rollout({ path: join(f.home, 'foreign.jsonl') })
    const link = join(f.root, 'escape.jsonl')
    await symlink(foreign.path, link)
    f.files.set(101, [foreign.path, link])
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it.each([
    '{broken\n',
    '{"type":"session_meta"}\n',
    'x'.repeat(70 * 1024),
  ])('rejects malformed or oversized metadata (%#)', async (header) => {
    const f = await fixture()
    const own = await f.rollout()
    await writeFile(own.path, header)
    f.files.set(101, [own.path])
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it('waits for a nonzero owned child and rejects ownership loss during inspection', async () => {
    const f = await fixture()
    f.setOwner({ pid: 0, generation: {} })
    await expect(f.resolver()()).resolves.toBeUndefined()
    expect(f.inspect).not.toHaveBeenCalled()
    f.setOwner({ pid: 101, generation: {} })
    const original = f.inspect.getMockImplementation()!
    f.inspect.mockImplementation(async (...args) => {
      const result = await original(...args)
      f.setOwner(undefined)
      return result
    })
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it('rejects an exited or reused PID both within and between polls', async () => {
    const f = await fixture()
    const own = await f.rollout()
    f.files.set(101, [own.path])
    const resolve = f.resolver()
    await expect(resolve()).resolves.toMatchObject(own)
    f.processes.set(101, { parent: 1, started: f.now + 5_000 })
    await expect(resolve()).resolves.toBeUndefined()
    f.processes.delete(101)
    await expect(resolve()).resolves.toBeUndefined()
  })

  it.each([
    'reuse',
    'rotation',
    'generation',
  ])('rejects %s during asynchronous inspection', async (change) => {
    const f = await fixture()
    const own = await f.rollout()
    f.files.set(101, [own.path])
    const original = f.inspect.getMockImplementation()
    if (!original) throw new Error('missing OS fixture')
    let changed = false
    f.inspect.mockImplementation(async (...args) => {
      const output = await original(...args)
      if (args[0] === 'lsof' && !changed) {
        changed = true
        if (change === 'reuse') f.processes.set(101, { parent: 1, started: f.now + 5_000 })
        if (change === 'rotation') f.files.set(101, [])
        if (change === 'generation') f.setOwner({ pid: 101, generation: {} })
      }
      return output
    })
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it.each(['denied', 'timeout', 'missing tool'])('fails closed on %s and can retry', async () => {
    const f = await fixture()
    const own = await f.rollout()
    f.files.set(101, [own.path])
    f.inspect.mockRejectedValueOnce(new Error('OS inspection unavailable'))
    const resolve = f.resolver()
    await expect(resolve()).resolves.toBeUndefined()
    await expect(resolve()).resolves.toMatchObject(own)
  })

  it('bounds output and descendant count', async () => {
    const f = await fixture()
    f.inspect.mockResolvedValueOnce('x'.repeat(512 * 1024 + 1))
    await expect(f.resolver()()).resolves.toBeUndefined()
    for (let pid = 102; pid < 120; pid++) f.processes.set(pid, { parent: 101, started: f.now })
    await expect(f.resolver()()).resolves.toBeUndefined()
  })

  it('never invokes macOS tools on Linux', async () => {
    const f = await fixture()
    await expect(f.resolver({ platform: 'linux' })()).resolves.toBeUndefined()
    expect(f.inspect).not.toHaveBeenCalled()
  })
})
