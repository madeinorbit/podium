import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Stable repo identity (#74). A repo's `repo_id` is derived from its normalized
 *  origin URL when one is known — so the same repository cloned at different paths
 *  (or on different machines) shares one id — and falls back to a deterministic
 *  (machineId, path) hash when no origin is available. Additive: nothing keys reads
 *  on repo_id yet; path-keyed reads stay as-is. */

/** Default ports per scheme — a port is only identity-bearing when non-default. */
const DEFAULT_PORTS: Record<string, string> = { ssh: '22', http: '80', https: '443', git: '9418' }

/**
 * Canonicalize a git origin URL to a `host[/owner]/repo`-style string so that
 * ssh scp-style (`git@host:o/r.git`), `ssh://`, and `http(s)://` spellings of the
 * same repository normalize identically. Credentials are stripped, the host is
 * lowercased, default ports and trailing `.git`/slashes are dropped.
 * Returns null for empty or unparseable input.
 */
export function normalizeOriginUrl(url: string | null | undefined): string | null {
  const raw = url?.trim()
  if (!raw) return null

  let scheme: string
  let host: string
  let port: string | undefined
  let path: string

  const full = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:?#]+)(?::(\d+))?(\/[^?#]*)?/)
  // scp-style: [user@]host:path — only when there's no scheme and the part after
  // ':' doesn't look like a port-only or //-authority form.
  const scp = full ? null : raw.match(/^(?:[^@/]+@)?([^:/@]+):([^/].*)$/)
  if (full) {
    scheme = full[1]!.toLowerCase()
    host = full[2]!
    port = full[3]
    path = full[4] ?? ''
  } else if (scp) {
    scheme = 'ssh'
    host = scp[1]!
    port = undefined
    path = `/${scp[2]!}`
  } else {
    return null
  }

  host = host.toLowerCase()
  const cleanPath = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '')
  if (!host || !cleanPath) return null
  const portSuffix = port && port !== DEFAULT_PORTS[scheme] ? `:${port}` : ''
  return `${host}${portSuffix}/${cleanPath}`
}

function sha1_16(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}

/** Deterministic repo id: origin-derived when the originUrl normalizes, else a
 *  (machineId, path) fallback that a later `updateRepoOrigin` may upgrade. */
export function deriveRepoId(input: {
  originUrl?: string | null
  machineId: string
  path: string
}): string {
  const normalized = normalizeOriginUrl(input.originUrl)
  if (normalized) return `repo_${sha1_16(normalized)}`
  return `repo_${sha1_16(`path:${input.machineId}:${input.path}`)}`
}

/** True iff `repoId` is the path-fallback id for (machineId, path) — i.e. it was
 *  NOT derived from an origin URL and may be upgraded when an origin is learned. */
export function isPathFallbackRepoId(
  repoId: string | null | undefined,
  machineId: string,
  path: string,
): boolean {
  return repoId == null || repoId === deriveRepoId({ machineId, path })
}

/**
 * Best-effort synchronous read of `<repoPath>/.git` → config → [remote "origin"] url.
 * Handles worktree/submodule `.git` files (`gitdir: …` indirection) and the
 * `commondir` hop back to the primary git dir. Returns null on any failure —
 * remote-machine paths simply don't exist locally and fall through here.
 */
export function readLocalOriginUrl(repoPath: string): string | null {
  try {
    let gitDir = join(repoPath, '.git')
    const st = statSync(gitDir)
    if (st.isFile()) {
      const m = readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)
      if (!m) return null
      gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(repoPath, m[1]!)
    }
    // Worktree git dirs keep the shared config next to `commondir`'s target.
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
      if (common) gitDir = isAbsolute(common) ? common : resolve(gitDir, common)
    } catch {
      // no commondir — gitDir is already the primary git dir
    }
    return parseOriginUrlFromConfig(readFileSync(join(gitDir, 'config'), 'utf8'))
  } catch {
    return null
  }
}

/** Minimal INI walk of a git config: url under `[remote "origin"]`. */
function parseOriginUrlFromConfig(config: string): string | null {
  let inOrigin = false
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      inOrigin = section[1]?.trim() === 'remote "origin"'
      continue
    }
    if (!inOrigin) continue
    const url = line.match(/^url\s*=\s*(.*)$/)
    if (url) return url[1]?.trim() || null
  }
  return null
}
