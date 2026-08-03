/**
 * Agent kind -> icon, shared by the worklist's fleet summary and the "+" menu's
 * agent list (POD-407).
 *
 * It has its own module for one reason: it is the single helper the extracted
 * `UnifiedIssueRow` and the spawn row BOTH need. Leaving it in either would have
 * made one row module import the other for an icon lookup.
 */
import type { AgentKind } from '@podium/model'
import { NEW_AGENTS } from '@/app/NewPanelMenu'

export function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}
