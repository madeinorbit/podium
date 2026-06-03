import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Default state file: $PODIUM_STATE_DIR/repos.json, else ~/.podium/repos.json. */
export function defaultRegistryPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium')
  return join(base, 'repos.json')
}

/** Persisted list of absolute repo-root paths. Shared by all clients so the
 *  repo list survives and shows on every device (desktop + phone). */
export class RepoRegistry {
  private roots: string[] = []
  constructor(private readonly file: string = defaultRegistryPath()) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.roots = Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === 'string')
        : []
    } catch {
      this.roots = [] // missing/corrupt file -> empty registry
    }
  }

  list(): string[] {
    return [...this.roots]
  }

  async add(path: string): Promise<void> {
    const p = path.trim()
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    if (!this.roots.includes(p)) {
      this.roots.push(p)
      await this.persist()
    }
  }

  async remove(path: string): Promise<void> {
    const p = path.trim()
    const before = this.roots.length
    this.roots = this.roots.filter((r) => r !== p)
    if (this.roots.length !== before) await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.roots, null, 2))
  }
}
