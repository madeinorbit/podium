/**
 * THE NAMED PORT RULE — ADR 7 D2, restated by ADR 5 D7 and independently
 * re-derived in [spec:SP-b85a], [spec:SP-fccf] and [spec:SP-a43e].
 *
 * Host↔server traffic stays SEPARATE from the agent command relay. This is a
 * rule with a name, not a convention: the relay bakes session identity into its
 * URL path (`/agent/<sessionId>`), so a host callback routed through it
 * re-homes identity, confuses authz, and breaks `PODIUM_NO_RELAY` hermetic
 * tests.
 *
 * On the peer wire the agent relay is EXACTLY two frames. Everything else the
 * host or daemon says — hooks, browser-open, resume-ref, PTY/agent-frame
 * streams, inventory probes, host-initiated bulk — is a host-edge channel with
 * its own typed frames and its own plane classification in the inventory.
 */

export const PORT_RULE_HOST_EDGE_SEPARATION = {
  name: 'host-edge-separation',
  adr: 'ADR 7 D2 (restated by ADR 5 D7)',
  specs: ['SP-b85a', 'SP-fccf', 'SP-a43e'] as const,
  statement:
    'Never route a new host callback through PODIUM_AGENT_RELAY for convenience. ' +
    'New host features get typed frames (or a dedicated host HTTP path under instance ' +
    'isolation) and a plane classification in the ADR 7 inventory.',
} as const

/** Which edge a frame belongs to. Disjoint by construction — see the assert below. */
export type WireEdge = 'agent-relay' | 'host'

/**
 * The complete agent-relay surface on the peer wire. Both are control · command.
 * Adding a third member is an ADR 7 amendment, not a refactor.
 */
export const AGENT_RELAY_FRAMES = ['agentRelayRequest', 'agentRelayResult'] as const
export type AgentRelayFrame = (typeof AGENT_RELAY_FRAMES)[number]

/**
 * Host-edge frames: daemon- or host-owned side channels that MUST NOT share the
 * agent-relay HTTP surface or its session-identity inheritance. The list is the
 * inventory's, not a judgement call at a send site.
 */
export const HOST_EDGE_FRAMES = [
  // Native harness hooks ([spec:SP-15aa] instance-scoped /hooks or hook socket).
  'title',
  'agentState',
  'agentColor',
  'agentModel',
  'agentObservation',
  'agentObservationAck',
  'agentObservationRebind',
  'agentObservationRebindAck',
  'agentObserverLiveConfirmation',
  'nativeDraft',
  'draftTarget',
  // Resume-ref receipts ([spec:SP-fccf]) — explicitly "separate from the agent
  // command relay" in that spec's own words.
  'sessionResumeRef',
  'sessionResumeRefAck',
  'sessionCwd',
  'sessionGitActivity',
  // Browser-open family ([spec:SP-a43e]): daemon→server→client, not an RPC.
  'sessionOpenUrl',
  'sessionOpenUrlResult',
  'sessionOpenUrlCallback',
  'sessionOpenUrlDismiss',
  // Inventory probes and host metrics.
  'inventoryRequest',
  'inventoryReport',
  'hostMetrics',
  'memoryBreakdownRequest',
  'memoryBreakdownResult',
  // PTY / agent-frame streams.
  'agentFrame',
  'agentFrameBatch',
  'agentExit',
  'bind',
  'transcriptDelta',
  // Host-initiated file / transcript bulk.
  'transcriptRead',
  'transcriptReadResult',
  'transcriptMirrorRead',
  'transcriptMirrorResult',
] as const
export type HostEdgeFrame = (typeof HOST_EDGE_FRAMES)[number]

/**
 * The rule as a check. Returns the violations; an empty array is compliance.
 * A frame in both sets is the exact failure the rule exists to prevent.
 */
export const hostEdgeSeparationViolations = (): string[] => {
  const relay = new Set<string>(AGENT_RELAY_FRAMES)
  return HOST_EDGE_FRAMES.filter((f) => relay.has(f))
}

/** May this frame type ride the agent relay? Only the two relay frames may. */
export const routableOverAgentRelay = (type: string): type is AgentRelayFrame =>
  (AGENT_RELAY_FRAMES as readonly string[]).includes(type)

export const edgeOf = (type: string): WireEdge | null => {
  if (routableOverAgentRelay(type)) return 'agent-relay'
  return (HOST_EDGE_FRAMES as readonly string[]).includes(type) ? 'host' : null
}
