/**
 * Agent kind -> icon.
 *
 * The table itself moved to `@/lib/agent-tone` (POD-591), which already owned
 * kind→tint and kind→tone: the board card and the sidebar row now render their
 * agent stack from one component under both features, and that component cannot
 * import out of a feature folder. This module stays as the worklist's spelling
 * of the same lookup so its two call sites keep reading locally.
 */
export { type AgentIconComponent, agentIconFor } from '@/lib/agent-tone'
