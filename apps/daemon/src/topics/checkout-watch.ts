import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { MachineId } from '@podium/model'
import { parseCheckoutTopicId, topicKey } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { TopicWatchRegistry } from './watch-registry'

const exec = promisify(execFile)
const git = async (root: string, args: string[]): Promise<string> =>
  (await exec('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout

/** One demanded checkout. Watch directories rather than recursive fs.watch so
 * ignored trees never consume OS watches. HEAD/index parents survive atomic saves,
 * and common refs cover commits made in another linked worktree. */
export function watchCheckout(
  root: string,
  signal: () => void,
  deps: {
    watch?: typeof watch
    git?: typeof git
    onError?: (error: unknown) => void
  } = {},
): () => void {
  const runGit = deps.git ?? git
  const watchDir = deps.watch ?? watch
  const watches = new Map<string, FSWatcher>()
  const scanning = new Set<string>()
  const worktreeDirs = new Set<string>()
  let stopped = false
  let fallback: ReturnType<typeof setInterval> | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  let lastSignal = -Infinity
  let fingerprint: string | undefined
  let reading = false
  let ignored = new Set<string>()

  const changed = (): void => {
    if (stopped || pending) return
    const delay = lastSignal + 1_000 - Date.now()
    if (delay <= 0) {
      lastSignal = Date.now()
      signal()
      return
    }
    pending = setTimeout(() => {
      pending = undefined
      changed()
    }, delay)
    pending.unref?.()
  }
  const closeWatches = (): void => {
    for (const watcher of watches.values()) watcher.close()
    watches.clear()
    worktreeDirs.clear()
  }
  const sample = async (): Promise<void> => {
    if (stopped || reading) return
    reading = true
    try {
      const status = await runGit(root, [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
      ])
      // Status alone misses a second edit to an already dirty file.
      const diff = await runGit(root, ['diff', '--no-ext-diff', 'HEAD'])
      const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
      const stamps = await Promise.all(
        untracked
          .split('\0')
          .filter(Boolean)
          .map(async (path) => {
            try {
              const s = await stat(join(root, path))
              return [path, s.mtimeMs, s.ctimeMs, s.size]
            } catch {
              return [path]
            }
          }),
      )
      const next = createHash('sha256')
        .update(status)
        .update(diff)
        .update(JSON.stringify(stamps))
        .digest('hex')
      if (!stopped && fingerprint !== next) {
        fingerprint = next
        changed()
      }
    } catch (error) {
      if (!stopped) deps.onError?.(error)
    } finally {
      reading = false
    }
  }
  const fail = (error: unknown): void => {
    if (stopped || fallback) return
    deps.onError?.(error)
    closeWatches()
    // OS watch exhaustion: the only polling fallback, on the source, with demand.
    fallback = setInterval(() => void sample(), 2_000)
    fallback.unref?.()
    void sample()
  }
  const excluded = (path: string): boolean => {
    const part = relative(root, path).split(/[\\/]/)[0]
    return part === '.git' || (part !== undefined && ignored.has(part))
  }
  const tree = async (dir: string, worktree: boolean): Promise<void> => {
    if (stopped || fallback || scanning.has(dir) || (worktree && excluded(dir))) return
    scanning.add(dir)
    try {
      if (!watches.has(dir)) {
        const watcher = watchDir(dir, (_event, name) => {
          if (worktree && name && excluded(join(dir, String(name)))) return
          changed()
          // Renames can add/remove a subtree. A watched directory replaced by an
          // atomic rename must acquire a fresh inode watch as well.
          if (dir === root && String(name) === '.gitignore') void tree(root, true).then(changed)
          if (_event === 'rename') {
            if (name) {
              const child = join(dir, String(name))
              for (const [path, held] of watches)
                if (path === child || path.startsWith(`${child}${sep}`)) {
                  held.close()
                  watches.delete(path)
                  worktreeDirs.delete(path)
                }
            }
            void tree(dir, worktree).then(changed)
          }
        })
        watcher.on('error', fail)
        if (stopped || fallback) watcher.close()
        else {
          watches.set(dir, watcher)
          if (worktree) worktreeDirs.add(dir)
        }
      }
      const entries = await readdir(dir, { withFileTypes: true })
      if (worktree && dir === root) {
        const dirs = entries
          .filter((entry) => entry.isDirectory() && entry.name !== '.git')
          .map((entry) => entry.name)
        try {
          ignored = dirs.length
            ? new Set(
                (await runGit(root, ['check-ignore', '-z', '--', ...dirs]))
                  .split('\0')
                  .filter(Boolean),
              )
            : new Set()
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error
          ignored.clear()
        }
        for (const path of worktreeDirs)
          if (excluded(path)) {
            watches.get(path)?.close()
            watches.delete(path)
            worktreeDirs.delete(path)
          }
      }
      if (stopped || fallback) return
      for (const [path, watcher] of watches) {
        if (
          path !== dir &&
          path.startsWith(`${dir}${sep}`) &&
          !entries.some(
            (e) => path === join(dir, e.name) || path.startsWith(`${join(dir, e.name)}${sep}`),
          )
        ) {
          watcher.close()
          watches.delete(path)
          worktreeDirs.delete(path)
        }
      }
      await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map((entry) => tree(join(dir, entry.name), worktree)),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(error)
    } finally {
      scanning.delete(dir)
    }
  }
  const start = async (): Promise<void> => {
    try {
      const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim()
      const common = (await runGit(root, ['rev-parse', '--git-common-dir'])).trim()
      const commonDir = isAbsolute(common) ? common : resolve(root, common)
      await tree(root, true)
      // Only the metadata directories matter, never objects or logs.
      for (const dir of new Set([gitDir, commonDir])) {
        if (stopped || fallback || watches.has(dir)) continue
        const watcher = watchDir(dir, (_event, name) => {
          if (!name || /^(HEAD|index|packed-refs|refs|config|commondir)$/.test(String(name)))
            changed()
          if (String(name) === 'refs') void tree(join(dir, 'refs'), false).then(changed)
        })
        watcher.on('error', fail)
        watches.set(dir, watcher)
        await tree(join(dir, 'refs'), false)
      }
      if (!fallback) changed()
    } catch (error) {
      fail(error)
    }
  }
  void start()
  return () => {
    stopped = true
    closeWatches()
    if (pending) clearTimeout(pending)
    if (fallback) clearInterval(fallback)
  }
}

export function registerCheckoutWatch(deps: {
  machineId: MachineId
  watches: TopicWatchRegistry
  send: (frame: DaemonMessage) => void
  watch?: typeof watchCheckout
}): void {
  deps.watches.register('checkout.changed', (id) => {
    const address = parseCheckoutTopicId(id)
    if (address?.machineId !== deps.machineId) return () => {}
    return (deps.watch ?? watchCheckout)(address.path, () =>
      deps.send({ type: 'topicPublish', key: topicKey('checkout.changed', id), payload: null }),
    )
  })
}
