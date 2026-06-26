import type {
  AgentConversationDiagnostic,
  AgentConversationSummary,
} from '@podium/agent-bridge'
import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/protocol'

export function summaryToWire(s: AgentConversationSummary): ConversationSummaryWire {
  return {
    id: s.id,
    agentKind: s.agentKind,
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.projectPath !== undefined ? { projectPath: s.projectPath } : {}),
    ...(s.parentConversationId !== undefined
      ? { parentConversationId: s.parentConversationId }
      : {}),
    ...(s.statusHint !== undefined ? { statusHint: s.statusHint } : {}),
    ...(s.createdAt ? { createdAt: s.createdAt.toISOString() } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt.toISOString() } : {}),
    ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
    ...(s.git ? { git: s.git } : {}),
    ...(s.resume ? { resume: s.resume } : {}),
    providerId: s.source.providerId,
  }
}

export function diagnosticToWire(d: AgentConversationDiagnostic): ConversationDiagnosticWire {
  return {
    severity: d.severity,
    ...(d.providerId !== undefined ? { providerId: d.providerId } : {}),
    ...(d.root !== undefined ? { root: d.root } : {}),
    ...(d.path !== undefined ? { path: d.path } : {}),
    message: d.message,
  }
}
