import type { Stats } from 'node:fs'

export type AgentKind = 'codex' | 'claude-code' | 'grok' | 'opencode'

export type AgentConversationRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown'

export type AgentConversationTitleSource = 'native' | 'filename' | 'path' | 'heuristic'

export type AgentConversationStatusHint =
  | 'unknown'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'archived'

export type ScanAgentConversationsOptions = {
  agents?: readonly AgentKind[]
  includeDefaults?: boolean
  extraRoots?: Partial<Record<AgentKind, readonly string[]>>
  homeDir?: string
}

export type AgentConversationSource = {
  providerId: string
  root: string
  path: string
  relatedPaths?: string[]
}

export type AgentConversationGitMetadata = {
  branch?: string
  sha?: string
  originUrl?: string
}

export type AgentConversationResumeRef = {
  kind: string
  value: string
}

export type AgentConversationSummary = {
  id: string
  agentKind: AgentKind
  title?: string
  titleSource?: AgentConversationTitleSource
  projectPath?: string
  parentConversationId?: string
  statusHint?: AgentConversationStatusHint
  createdAt?: Date
  updatedAt?: Date
  messageCount?: number
  git?: AgentConversationGitMetadata
  resume?: AgentConversationResumeRef
  source: AgentConversationSource
}

export type AgentConversationMessage = {
  role: AgentConversationRole
  content: string
  createdAt?: Date
  raw?: unknown
}

export type AgentConversation = AgentConversationSummary & {
  messages: AgentConversationMessage[]
  raw?: unknown
}

export type AgentConversationDiagnostic = {
  severity: 'warning' | 'error'
  providerId?: string
  root?: string
  path?: string
  message: string
  cause?: unknown
}

export type ScanAgentConversationsResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}

export type ConversationProviderContext = {
  homeDir: string
}

export type ProviderScanResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}

export type ConversationFileStat = Pick<
  Stats,
  'size' | 'mtime' | 'mtimeMs' | 'birthtime' | 'birthtimeMs' | 'ctime' | 'ctimeMs'
>

export type ConversationProviderFile = {
  path: string
  parentConversationId?: string
}

export type ProviderRootListing = {
  files: ConversationProviderFile[]
  diagnostics: AgentConversationDiagnostic[]
  state?: unknown
}

export type ProviderSummaryContext = {
  canonicalPath?: (path: string) => Promise<string>
  stats?: ConversationFileStat
  rootState?: unknown
  headBytes?: number
  headLines?: number
}

export type ProviderSummaryResult = {
  summary?: AgentConversationSummary
  diagnostics: AgentConversationDiagnostic[]
}

export interface ConversationProvider {
  id: string
  agentKind: AgentKind
  defaultRoots(context: ConversationProviderContext): readonly string[]
  listRoot(root: string): Promise<ProviderRootListing>
  summarizeFile(
    root: string,
    file: ConversationProviderFile,
    context?: ProviderSummaryContext,
  ): Promise<ProviderSummaryResult>
  scanRoot(root: string): Promise<ProviderScanResult>
  loadConversation(summary: AgentConversationSummary): Promise<AgentConversation>
}

export class AgentConversationLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentConversationLoadError'
  }
}
