import { realpath as realpathFs, stat } from 'node:fs/promises'
import { sep } from 'node:path'
import type { ConversationDiscoveryCache } from './cache.js'
import { canonicalPath, expandHome, isDirectory } from './paths.js'
import { createClaudeCodeConversationProvider } from './providers/claude-code.js'
import { createCodexConversationProvider } from './providers/codex.js'
import { createCursorConversationProvider } from './providers/cursor.js'
import { createGrokConversationProvider } from './providers/grok.js'
import { createOpencodeConversationProvider } from './providers/opencode.js'
import {
  type AgentConversation,
  type AgentConversationDiagnostic,
  AgentConversationLoadError,
  type AgentConversationSummary,
  type AgentKind,
  type ConversationFileStat,
  type ConversationProvider,
  type ScanAgentConversationsCachedResult,
  type ScanAgentConversationsOptions,
  type ScanAgentConversationsResult,
} from './types.js'

const builtInProviders: readonly ConversationProvider[] = [
  createCodexConversationProvider(),
  createClaudeCodeConversationProvider(),
  createGrokConversationProvider(),
  createOpencodeConversationProvider(),
  createCursorConversationProvider(),
]

const providersById = new Map(builtInProviders.map((provider) => [provider.id, provider]))

/**
 * Every built-in provider's default discovery roots for `homeDir` (deduped, not
 * existence-checked). The daemon's transcript-mirror path guard uses this as its
 * allowlist: a mirror read may only touch files under a discovery root, so the
 * mirror can never be used as an arbitrary file reader (transcript-mirror spec §2.3).
 */
export function discoveryRoots(homeDir: string): string[] {
  const roots = new Set<string>()
  for (const provider of builtInProviders) {
    for (const root of provider.defaultRoots({ homeDir })) roots.add(root)
  }
  return [...roots]
}

export type ScanAgentConversationsCachedOptions = ScanAgentConversationsOptions & {
  cache: ConversationDiscoveryCache
  providers?: readonly ConversationProvider[]
}

/**
 * Internal knobs shared by the full cached scan and the targeted {@link summarizePaths}
 * refresh. Both walk providers/roots and (re-)summarize on cache miss; they differ only
 * in which files they consider and whether they prune the cache:
 * - `onlyPaths` restricts work to the given file paths (a Set for O(1) membership).
 * - `skipPrune` leaves the cache untouched for absent paths — a targeted refresh must
 *   not prune (it never sees the whole filesystem, so "missing" is meaningless to it).
 */
type CachedScanInternalOptions = {
  onlyPaths?: ReadonlySet<string>
  skipPrune?: boolean
}

export async function scanAgentConversations(
  options: ScanAgentConversationsOptions = {},
): Promise<ScanAgentConversationsResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const includeDefaults = options.includeDefaults ?? true
  const selectedProviders = selectProviders(options.agents)
  const diagnostics: AgentConversationDiagnostic[] = []
  const conversations: AgentConversationSummary[] = []

  await Promise.all(
    selectedProviders.map(async (provider) => {
      const roots = await resolveProviderRoots(provider, {
        homeDir,
        includeDefaults,
        extraRoots: options.extraRoots?.[provider.agentKind],
        diagnostics,
      })

      await Promise.all(
        roots.map(async (root) => {
          try {
            const result = await provider.scanRoot(root)
            conversations.push(...result.conversations)
            diagnostics.push(...result.diagnostics)
          } catch (cause) {
            diagnostics.push({
              severity: 'error',
              providerId: provider.id,
              root,
              message: `Could not scan ${provider.agentKind} conversation root`,
              cause,
            })
          }
        }),
      )
    }),
  )

  return {
    conversations: dedupeConversations(conversations).sort(compareConversationSummaries),
    diagnostics,
  }
}

export async function scanAgentConversationsCached(
  options: ScanAgentConversationsCachedOptions,
): Promise<ScanAgentConversationsCachedResult> {
  return scanAgentConversationsCachedInternal(options, {})
}

/**
 * Targeted refresh: re-summarize ONLY the given transcript file paths against the
 * caller-owned cache, returning their summaries as `changed`. Used by the daemon's
 * event-driven active refresh — when a LOADED session's transcript tail fires, the
 * file's mtime has moved, so it misses the cache and is re-summarized here without
 * waiting for the next periodic scan.
 *
 * Unlike {@link scanAgentConversationsCached} this NEVER prunes the cache (`removed`
 * is always empty): a targeted refresh sees only a handful of dirty paths, never the
 * whole filesystem, so it has no basis to decide anything is "missing". It still walks
 * each provider's `listRoot` (filtered to the dirty paths) so per-provider listing
 * state — e.g. codex's sibling-derived title/parent metadata — is preserved, rather
 * than summarizing a bare file path out of context.
 */
export async function summarizePaths(
  paths: readonly string[],
  options: Omit<ScanAgentConversationsCachedOptions, 'agents'> & {
    agents?: readonly AgentKind[]
  },
): Promise<ScanAgentConversationsCachedResult> {
  const onlyPaths = new Set(paths)
  if (onlyPaths.size === 0) {
    return { conversations: [], diagnostics: [], changed: [], removed: [] }
  }
  return scanAgentConversationsCachedInternal(options, { onlyPaths, skipPrune: true })
}

async function scanAgentConversationsCachedInternal(
  options: ScanAgentConversationsCachedOptions,
  internal: CachedScanInternalOptions,
): Promise<ScanAgentConversationsCachedResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const includeDefaults = options.includeDefaults ?? true
  const selectedProviders = selectProviders(options.agents, options.providers)
  const selectedAgentKinds = selectedProviders.map((provider) => provider.agentKind)
  const diagnostics: AgentConversationDiagnostic[] = []
  const conversations: AgentConversationSummary[] = []
  const cacheWrites: {
    path: string
    stats: ConversationFileStat
    summary: AgentConversationSummary
    agentKind: AgentKind
  }[] = []
  const seenPaths = new Set<string>()
  const memoCanonicalPath = memoizeCanonicalPath()

  await Promise.all(
    selectedProviders.map(async (provider) => {
      const roots = await resolveProviderRoots(provider, {
        homeDir,
        includeDefaults,
        extraRoots: options.extraRoots?.[provider.agentKind],
        diagnostics,
      })

      await Promise.all(
        roots.map(async (root) => {
          let listing: Awaited<ReturnType<ConversationProvider['listRoot']>>
          try {
            listing = await provider.listRoot(root)
          } catch (cause) {
            diagnostics.push({
              severity: 'error',
              providerId: provider.id,
              root,
              message: `Could not scan ${provider.agentKind} conversation root`,
              cause,
            })
            return
          }

          diagnostics.push(...listing.diagnostics)

          const candidateFiles = internal.onlyPaths
            ? listing.files.filter((file) => internal.onlyPaths?.has(file.path))
            : listing.files

          await Promise.all(
            candidateFiles.map(async (file) => {
              let stats: Awaited<ReturnType<typeof stat>>
              try {
                stats = await stat(file.path)
              } catch (cause) {
                diagnostics.push({
                  severity: 'warning',
                  providerId: provider.id,
                  root,
                  path: file.path,
                  message: `Could not stat ${provider.agentKind} conversation file`,
                  cause,
                })
                return
              }

              seenPaths.add(file.path)
              const cached = options.cache.getFresh(file.path, stats, provider.agentKind)
              if (cached) {
                conversations.push(cached)
                return
              }

              const extracted = await provider.summarizeFile(root, file, {
                canonicalPath: memoCanonicalPath,
                stats,
                rootState: listing.state,
              })
              diagnostics.push(...extracted.diagnostics)
              if (!extracted.summary) return

              cacheWrites.push({
                path: file.path,
                stats,
                summary: extracted.summary,
                agentKind: provider.agentKind,
              })
              conversations.push(extracted.summary)
            }),
          )
        }),
      )
    }),
  )

  options.cache.upsertMany(cacheWrites)
  // A targeted refresh (`skipPrune`) never prunes: it only ever saw the dirty paths,
  // so it cannot tell what is genuinely missing — `removed` stays empty.
  const pruned = internal.skipPrune
    ? { removedIds: [] as string[] }
    : options.cache.deleteMissing(seenPaths, selectedAgentKinds)

  return {
    conversations: dedupeConversations(conversations).sort(compareConversationSummaries),
    diagnostics,
    changed: cacheWrites.map((write) => write.summary),
    removed: pruned.removedIds,
  }
}

export async function loadAgentConversation(
  summary: AgentConversationSummary,
): Promise<AgentConversation> {
  const provider = providersById.get(summary.source.providerId)
  if (!provider) {
    throw new AgentConversationLoadError(
      `No conversation provider is registered for ${summary.source.providerId}`,
    )
  }

  return await provider.loadConversation(summary)
}

function selectProviders(
  agents: readonly AgentKind[] | undefined,
  providers: readonly ConversationProvider[] = builtInProviders,
): readonly ConversationProvider[] {
  if (!agents) return providers
  const selected = new Set<AgentKind>(agents)
  return providers.filter((provider) => selected.has(provider.agentKind))
}

async function resolveProviderRoots(
  provider: ConversationProvider,
  options: {
    homeDir: string
    includeDefaults: boolean
    extraRoots: readonly string[] | undefined
    diagnostics: AgentConversationDiagnostic[]
  },
): Promise<string[]> {
  const requestedRoots = [
    ...(options.includeDefaults ? provider.defaultRoots({ homeDir: options.homeDir }) : []),
    ...(options.extraRoots ?? []),
  ]
  const canonicalRoots: string[] = []
  const seen = new Set<string>()

  for (const root of requestedRoots) {
    const expanded = expandHome(root, options.homeDir)

    let canonical: string
    try {
      if (!(await isDirectory(expanded))) continue
      canonical = await canonicalPath(expanded)
    } catch (cause) {
      options.diagnostics.push({
        severity: 'error',
        providerId: provider.id,
        root: expanded,
        message: `Could not read ${provider.agentKind} conversation root`,
        cause,
      })
      continue
    }

    if (seen.has(canonical)) continue
    seen.add(canonical)
    canonicalRoots.push(canonical)
  }

  return canonicalRoots
}

export function dedupeConversations(
  conversations: readonly AgentConversationSummary[],
): AgentConversationSummary[] {
  const bySource = new Map<string, AgentConversationSummary>()

  for (const conversation of conversations) {
    const key = `${conversation.source.providerId}\0${conversation.source.path}`
    if (!bySource.has(key)) bySource.set(key, conversation)
  }

  return [...bySource.values()]
}

export function compareConversationSummaries(
  left: AgentConversationSummary,
  right: AgentConversationSummary,
): number {
  const updated = compareDatesDescending(left.updatedAt, right.updatedAt)
  if (updated !== 0) return updated

  const created = compareDatesDescending(left.createdAt, right.createdAt)
  if (created !== 0) return created

  return compareStrings(conversationTieBreaker(left), conversationTieBreaker(right))
}

function compareDatesDescending(left: Date | undefined, right: Date | undefined): number {
  const leftTime = left?.getTime() ?? Number.NEGATIVE_INFINITY
  const rightTime = right?.getTime() ?? Number.NEGATIVE_INFINITY
  return rightTime - leftTime
}

function conversationTieBreaker(conversation: AgentConversationSummary): string {
  return [conversation.source.providerId, conversation.source.path, conversation.id].join('\0')
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function memoizeCanonicalPath(): (path: string) => Promise<string> {
  const paths = new Map<string, Promise<string>>()
  return (path: string) => {
    let cached = paths.get(path)
    if (!cached) {
      cached = canonicalPath(path)
      paths.set(path, cached)
    }
    return cached
  }
}

/**
 * Mirror-read path guard (docs/spec/transcript-mirror.md §2.3): resolve `path`
 * and admit it only when its REAL location sits inside one of the given roots
 * (realpathed, trailing-separator prefix — `<root>-evil` and symlinks escaping a
 * root are refused). Returns the realpath to read, or null when refused/missing.
 */
export async function resolveWithinRoots(path: string, roots: string[]): Promise<string | null> {
  let real: string
  try {
    real = await realpathFs(path)
  } catch {
    return null // vanished between discovery and this read
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpathFs(root)
    } catch {
      continue // a provider dir absent on this host can't allow anything
    }
    if (real.startsWith(realRoot + sep)) return real
  }
  return null
}
