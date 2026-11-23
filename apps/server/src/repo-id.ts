import { createHash } from 'node:crypto'
import { asRepoId, type MachineId, machinePathKey, type RepoId } from '@podium/model'

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
 *
 * NAMED FOR REPO_ID, not for URLs (POD-335). This was `normalizeOriginUrl`, which
 * is also the name of a `@podium/model` predicate — and the two are NOT the same
 * function: the model's returns `''` for unparseable input and this one returns
 * `null`, because repo_id identity must be able to say "no identity" rather than
 * collapse every unparseable origin onto one empty key. `feature-single-home`
 * refuses the shared name; the distinct behaviour is the reason the fix is a
 * rename and not a merge.
 */
export function canonicalizeRepoOrigin(url: string | null | undefined): string | null {
  const raw = url?.trim()
  if (!raw) return null

  let scheme: string
  let host: string
  let port: string | undefined
  let path: string

  const full = raw.match(
    /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:?#]+)(?::(\d+))?(\/[^?#]*)?/,
  )
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
  machineId: MachineId
  path: string
}): RepoId {
  // MINT SITE for a RepoId — derived here from an origin URL or a (machine, path)
  // fallback, so this is where the brand is applied (POD-362).
  const normalized = canonicalizeRepoOrigin(input.originUrl)
  if (normalized) return asRepoId(`repo_${sha1_16(normalized)}`)
  return asRepoId(`repo_${sha1_16(`path:${input.machineId}:${machinePathKey(input.path)}`)}`)
}

/** True iff `repoId` is the path-fallback id for (machineId, path) — i.e. it was
 *  NOT derived from an origin URL and may be upgraded when an origin is learned. */
export function isPathFallbackRepoId(
  repoId: RepoId | null | undefined,
  machineId: MachineId,
  path: string,
): boolean {
  return (
    repoId == null ||
    repoId === deriveRepoId({ machineId, path }) ||
    repoId === asRepoId(`repo_${sha1_16(`path:${machineId}:${path}`)}`)
  )
}
