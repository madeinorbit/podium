import { createClaudeCodeConversationProvider } from './providers/claude-code.js'
import { createCodexConversationProvider } from './providers/codex.js'
import { canonicalPath, expandHome, isDirectory } from './paths.js'
import {
  AgentConversationLoadError,
  type AgentConversation,
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentKind,
  type ConversationProvider,
  type ScanAgentConversationsOptions,
  type ScanAgentConversationsResult,
} from './types.js'

const builtInProviders: readonly ConversationProvider[] = [
  createCodexConversationProvider(),
  createClaudeCodeConversationProvider(),
]

const providersById = new Map(builtInProviders.map((provider) => [provider.id, provider]))

export async function scanAgentConversations(
  options: ScanAgentConversationsOptions = {},
): Promise<ScanAgentConversationsResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const includeDefaults = options.includeDefaults ?? true
  const selectedProviders = selectProviders(options.agents)
  const diagnostics: AgentConversationDiagnostic[] = []
  const conversations: AgentConversationSummary[] = []

  for (const provider of selectedProviders) {
    const roots = await resolveProviderRoots(provider, {
      homeDir,
      includeDefaults,
      extraRoots: options.extraRoots?.[provider.agentKind],
      diagnostics,
    })

    for (const root of roots) {
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
    }
  }

  return {
    conversations: dedupeConversations(conversations).sort(compareConversationSummaries),
    diagnostics,
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
): readonly ConversationProvider[] {
  if (!agents) return builtInProviders
  const selected = new Set<AgentKind>(agents)
  return builtInProviders.filter((provider) => selected.has(provider.agentKind))
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

function dedupeConversations(
  conversations: readonly AgentConversationSummary[],
): AgentConversationSummary[] {
  const bySource = new Map<string, AgentConversationSummary>()

  for (const conversation of conversations) {
    const key = `${conversation.source.providerId}\0${conversation.source.path}`
    if (!bySource.has(key)) bySource.set(key, conversation)
  }

  return [...bySource.values()]
}

function compareConversationSummaries(
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
