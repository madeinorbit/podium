/**
 * Principal namespaces for client-side replica storage.
 *
 * A cursor is a claim about one principal's slice. Sharing that key with a
 * different principal can make a cold, empty slice appear caught up forever, so
 * every localStorage/AsyncStorage key is rooted below a principal prefix.
 *
 * Retention policy (the security/default decision for POD-401):
 * - sign-out erases the acting principal's namespace;
 * - at most three principal namespaces are retained on a device;
 * - an inactive namespace expires after 30 days;
 * - the active namespace is never selected for retention eviction.
 *
 * The theme is intentionally outside this module. It is the sole raw pre-auth
 * storage read because it is cosmetic and carries no identity, cursor, entity or
 * authored-work data; ThemeProvider must paint before authentication settles.
 */

import type { StorageApi } from './contract'

export interface PrincipalNamespacePolicy {
  readonly signOut: 'erase'
  readonly maxRetainedPrincipals: number
  readonly maxInactiveMs: number
}

export const DEFAULT_PRINCIPAL_NAMESPACE_POLICY: PrincipalNamespacePolicy = {
  signOut: 'erase',
  maxRetainedPrincipals: 3,
  maxInactiveMs: 30 * 24 * 60 * 60 * 1_000,
}

interface NamespaceMarker {
  readonly principal: string
  readonly lastUsedAt: number
}

export interface PrincipalNamespaceInit {
  readonly storage: StorageApi
  readonly enumerateKeys: () => string[]
  readonly basePrefix: string
  readonly principal: string
  readonly now?: () => number
  readonly policy?: PrincipalNamespacePolicy
}

export interface PrincipalNamespace {
  readonly keyPrefix: string
  readonly durable: boolean
  readonly knownPrincipals: readonly string[]
  readonly evictedPrincipals: readonly string[]
  /** Fail-closed sign-out policy: erase every key below this principal root. */
  erase(): void
}

const MARKER_SUFFIX = '.namespace.v1'

export function principalKeyPrefix(basePrefix: string, principal: string): string {
  if (principal.length === 0) throw new Error('replica principal must not be empty')
  return `${basePrefix}.principal.${encodeURIComponent(principal)}`
}

/**
 * Record an authenticated principal, apply bounded retention, and return the
 * only prefix that composition roots may hand to persistence adapters.
 *
 * Marker persistence failure is loud but nonfatal: the replica's persistence
 * probe then degrades the principal slice to memory, so no retained data exists
 * to cross a sign-in boundary. Existing durable namespaces are still bounded.
 */
export function preparePrincipalNamespace(init: PrincipalNamespaceInit): PrincipalNamespace {
  const policy = init.policy ?? DEFAULT_PRINCIPAL_NAMESPACE_POLICY
  if (policy.signOut !== 'erase') throw new Error('unsupported principal sign-out policy')
  if (policy.maxRetainedPrincipals < 1) {
    throw new Error('principal retention must keep at least the active namespace')
  }

  const now = (init.now ?? Date.now)()
  const keyPrefix = principalKeyPrefix(init.basePrefix, init.principal)
  const markerKey = `${keyPrefix}${MARKER_SUFFIX}`
  let durable = true
  try {
    init.storage.setItem(
      markerKey,
      JSON.stringify({ principal: init.principal, lastUsedAt: now } satisfies NamespaceMarker),
    )
  } catch (error) {
    durable = false
    console.warn(
      '[podium] principal namespace marker is not durable; using storage fallback',
      error,
    )
  }

  const markers = readMarkers(init)
  if (!durable && markers.get(keyPrefix)?.principal === init.principal) durable = true
  // A successfully written active marker is authoritative even if an unusual
  // storage enumerator has not reflected it yet. A failed first write confers no
  // durable identity evidence and cannot authorize persistent adapters.
  if (durable) {
    markers.set(keyPrefix, {
      keyPrefix,
      principal: init.principal,
      lastUsedAt: now,
    })
  }

  const stale = [...markers.values()]
    .filter(
      (entry) =>
        entry.principal !== init.principal && now - entry.lastUsedAt > policy.maxInactiveMs,
    )
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)

  const staleRoots = new Set(stale.map((entry) => entry.keyPrefix))
  const retained = [...markers.values()]
    .filter((entry) => !staleRoots.has(entry.keyPrefix))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  for (const entry of retained.slice(policy.maxRetainedPrincipals)) {
    if (entry.principal !== init.principal) staleRoots.add(entry.keyPrefix)
  }

  const evictedPrincipals: string[] = []
  for (const root of staleRoots) {
    const marker = markers.get(root)
    if (marker !== undefined) evictedPrincipals.push(marker.principal)
    eraseRoot(init.storage, safeKeys(init.enumerateKeys), root)
  }

  const survivors = [...markers.values()]
    .filter((entry) => !staleRoots.has(entry.keyPrefix))
    .map((entry) => entry.principal)

  return {
    keyPrefix,
    durable,
    knownPrincipals: [...new Set(survivors)],
    evictedPrincipals: [...new Set(evictedPrincipals)],
    erase: () => eraseRoot(init.storage, safeKeys(init.enumerateKeys), keyPrefix),
  }
}

/** Read-only evidence for the attribution gate. It never creates a global ledger. */
export function inspectPrincipalNamespaces(init: {
  readonly storage: StorageApi
  readonly enumerateKeys: () => string[]
  readonly basePrefix: string
}): readonly string[] {
  return [...new Set([...readMarkers(init).values()].map((entry) => entry.principal))]
}

function readMarkers(init: {
  readonly storage: StorageApi
  readonly enumerateKeys: () => string[]
  readonly basePrefix: string
}): Map<string, NamespaceMarker & { keyPrefix: string }> {
  const result = new Map<string, NamespaceMarker & { keyPrefix: string }>()
  const root = `${init.basePrefix}.principal.`
  for (const key of safeKeys(init.enumerateKeys)) {
    if (!key.startsWith(root) || !key.endsWith(MARKER_SUFFIX)) continue
    try {
      const parsed = JSON.parse(init.storage.getItem(key) ?? 'null') as Partial<NamespaceMarker>
      if (typeof parsed.principal !== 'string' || typeof parsed.lastUsedAt !== 'number') continue
      const keyPrefix = key.slice(0, -MARKER_SUFFIX.length)
      result.set(keyPrefix, {
        keyPrefix,
        principal: parsed.principal,
        lastUsedAt: parsed.lastUsedAt,
      })
    } catch {
      // A malformed marker confers no identity evidence and is never adopted.
    }
  }
  return result
}

function safeKeys(enumerate: () => string[]): string[] {
  try {
    return enumerate()
  } catch {
    return []
  }
}

function eraseRoot(storage: StorageApi, keys: readonly string[], root: string): void {
  for (const key of keys) {
    if (key !== root && !key.startsWith(`${root}.`)) continue
    storage.removeItem(key)
  }
}
