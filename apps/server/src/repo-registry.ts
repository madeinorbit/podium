import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { SessionStore } from './store'

export type DirectoryBrowserEntry = {
  name: string
  path: string
}

export type DirectoryBrowserListing = {
  path: string
  homePath: string
  parentPath: string | null
  entries: DirectoryBrowserEntry[]
}

/** Server-side directory browser used by the web picker. */
export async function browseDirectories(
  path?: string,
  options: { includeHidden?: boolean } = {},
): Promise<DirectoryBrowserListing> {
  const homePath = currentHomeDir()
  const requested = expandHome(path?.trim() || homePath, homePath)
  if (!isAbsolute(requested)) throw new Error(`directory path must be absolute: ${requested}`)

  let current = requested
  try {
    const s = await stat(current)
    if (!s.isDirectory()) throw new Error('path is not a directory')
    current = await realpath(current)
  } catch (err) {
    throw new Error(
      `Could not open directory ${requested}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let entries: DirectoryBrowserEntry[]
  try {
    entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => options.includeHidden || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    throw new Error(
      `Could not read directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parent = dirname(current)
  return {
    path: current,
    homePath,
    parentPath: parent === current ? null : parent,
    entries,
  }
}

/** Persisted list of absolute repo-root paths, backed by SessionStore. Shared by all
 *  clients so the repo list survives and shows on every device (desktop + phone). */
export class RepoRegistry {
  constructor(private readonly store: SessionStore) {}

  list(): string[] {
    return this.store.listRepoPaths()
  }

  async add(path: string): Promise<void> {
    const p = path.trim()
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    this.store.addRepo(p)
  }

  async remove(path: string): Promise<void> {
    this.store.removeRepo(path.trim())
  }
}

function currentHomeDir(): string {
  return process.env.HOME || homedir()
}

function expandHome(path: string, homePath: string): string {
  if (path === '~') return homePath
  if (path.startsWith('~/')) return join(homePath, path.slice(2))
  return path
}
