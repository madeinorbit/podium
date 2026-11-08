import type { FSWatcher, watch } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { checkoutTopicId, topicKey } from '@podium/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { registerCheckoutWatch, watchCheckout } from './checkout-watch'
import { TopicWatchRegistry } from './watch-registry'

const roots: string[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'checkout-watch-'))
  roots.push(root)
  const metadata = join(root, '.meta')
  await Promise.all([
    mkdir(join(root, 'src', 'nested'), { recursive: true }),
    mkdir(join(root, 'node_modules', 'deep'), { recursive: true }),
    mkdir(join(metadata, 'refs', 'heads'), { recursive: true }),
  ])
  await writeFile(join(root, '.git'), `gitdir: ${metadata}`)
  const callbacks = new Map<string, (event: string, name: string) => void>()
  const closed: string[] = []
  const watchDir = vi.fn((path: string, callback: (event: string, name: string) => void) => {
    callbacks.set(String(path), callback)
    return { on: () => {}, close: () => closed.push(String(path)) } as unknown as FSWatcher
  }) as unknown as typeof watch
  const runGit = vi.fn(async (_root: string, args: string[]) => {
    if (args[0] === 'check-ignore') return 'node_modules\n.meta\n'
    if (args[1] === '--absolute-git-dir' || args[1] === '--git-common-dir') return metadata
    return ''
  })
  return { root, metadata, callbacks, closed, watchDir, runGit }
}
it('watches working files and linked-worktree metadata, ignoring heavy trees; bursts coalesce and close releases every watcher', async () => {
  const f = await fixture()
  const at: number[] = []
  const stop = watchCheckout(f.root, () => at.push(Date.now()), {
    watch: f.watchDir,
    git: f.runGit,
  })
  stops.push(stop)
  await vi.waitFor(() => expect(at).toHaveLength(1))
  expect([...f.callbacks.keys()]).toContain(join(f.root, 'src', 'nested'))
  expect([...f.callbacks.keys()]).toContain(f.metadata)
  expect([...f.callbacks.keys()]).toContain(join(f.metadata, 'refs', 'heads'))
  expect([...f.callbacks.keys()].some((path) => path.includes('node_modules'))).toBe(false)
  vi.useFakeTimers()
  for (let n = 0; n < 20; n++) f.callbacks.get(join(f.root, 'src'))!('change', 'file.ts')
  expect(at).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(at).toHaveLength(2)
  f.callbacks.get(f.metadata)!('rename', 'HEAD')
  f.callbacks.get(f.metadata)!('rename', 'index')
  f.callbacks.get(join(f.metadata, 'refs', 'heads'))!('change', 'main')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(at).toHaveLength(3)
  for (let n = 1; n < at.length; n++) expect(at[n]! - at[n - 1]!).toBeGreaterThanOrEqual(1_000)
  stop()
  expect(new Set(f.closed)).toEqual(new Set(f.callbacks.keys()))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(at).toHaveLength(3)
})
it('OS watch exhaustion uses a demand-bound status fallback and sees edits to an already dirty file', async () => {
  const f = await fixture()
  let diff = 'first edit'
  const runGit = vi.fn(async (root: string, args: string[]) =>
    args[0] === 'diff' ? diff : f.runGit(root, args),
  )
  const signal = vi.fn()
  const watchDir = (() => {
    throw Object.assign(new Error('watch limit'), { code: 'ENOSPC' })
  }) as unknown as typeof watch
  const stop = watchCheckout(f.root, signal, { watch: watchDir, git: runGit })
  stops.push(stop)
  await vi.waitFor(() => expect(signal).toHaveBeenCalledTimes(1))
  vi.useFakeTimers()
  // The interval was created before fake timers; restart under fake time.
  stop()
  const second = watchCheckout(f.root, signal, { watch: watchDir, git: runGit })
  stops.push(second)
  await vi.waitFor(() => expect(signal).toHaveBeenCalledTimes(2))
  diff = 'second edit'
  await vi.advanceTimersByTimeAsync(2_000)
  expect(signal).toHaveBeenCalledTimes(3)
  expect(runGit.mock.calls.some(([, args]) => args.includes('--porcelain=v2'))).toBe(true)
  second()
  const reads = runGit.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(runGit).toHaveBeenCalledTimes(reads)
})
it('the registry starts exactly one watcher per demanded checkout and stops on unsubscribe/reset', () => {
  const watches = new TopicWatchRegistry()
  const stop = vi.fn()
  const start = vi.fn(() => stop)
  registerCheckoutWatch({ machineId: asMachineId('self'), watches, send: vi.fn(), watch: start })
  const key = topicKey('checkout.changed', checkoutTopicId(asMachineId('self'), '/repo'))
  watches.apply(key, true)
  watches.apply(key, true)
  expect(start).toHaveBeenCalledTimes(1)
  watches.apply(key, false)
  expect(stop).toHaveBeenCalledTimes(1)
  watches.apply(key, true)
  watches.reset()
  expect(stop).toHaveBeenCalledTimes(2)
  watches.apply(topicKey('checkout.changed', checkoutTopicId(asMachineId('other'), '/repo')), true)
  expect(start).toHaveBeenCalledTimes(2)
})
