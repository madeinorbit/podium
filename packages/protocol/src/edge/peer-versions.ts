/**
 * MINIMUM-CONNECTED-VERSION TELEMETRY — permanent (POD-308).
 *
 * The rollout question this answers is not "how many clients are old" but "may I
 * raise the floor yet", and those are different questions: the first is a
 * histogram, the second is a MINIMUM over currently connected peers. Raising
 * `MIN_SUPPORTED_VERSION` while one peer is still below it is the outage this
 * exists to prevent, and it is not observable from request counts — an old peer
 * that sits idle sends nothing and is invisible to traffic metrics while still
 * being very much connected.
 *
 * Deliberately NOT a counter of hellos. A hello is an event; what decides the
 * rollout is the set of LIVE connections, so this tracks connect/disconnect and
 * reports over what is currently attached. A peer that connected an hour ago and
 * has been silent since is exactly the peer that would be broken by a premature
 * floor raise, and the only structure that still knows about it is this one.
 */

export interface PeerVersionSnapshot {
  /** Lowest wire version among connected peers, or null when none are. */
  readonly minimum: number | null
  /** Live connection count per version, ascending by version. */
  readonly byVersion: readonly { readonly version: number; readonly peers: number }[]
  readonly totalPeers: number
  /** True when every connected peer is at or above `floor` — the question a
   *  rollout actually asks. `null` minimum (no peers) answers TRUE: there is
   *  nobody to break. */
  readonly canRaiseFloorTo: (floor: number) => boolean
}

export class PeerVersionTelemetry {
  /** connectionId → wire version. Keyed by connection, not by peer identity: one
   *  user with a stale PWA tab and a fresh one has two versions live at once,
   *  and the stale tab is the one that decides. */
  private readonly connections = new Map<string, number>()

  connected(connectionId: string, wireVersion: number): void {
    this.connections.set(connectionId, wireVersion)
  }

  disconnected(connectionId: string): void {
    this.connections.delete(connectionId)
  }

  snapshot(): PeerVersionSnapshot {
    const counts = new Map<number, number>()
    for (const version of this.connections.values()) {
      counts.set(version, (counts.get(version) ?? 0) + 1)
    }
    const byVersion = [...counts.entries()]
      .map(([version, peers]) => ({ version, peers }))
      .sort((a, b) => a.version - b.version)
    const minimum = byVersion[0]?.version ?? null
    return {
      minimum,
      byVersion,
      totalPeers: this.connections.size,
      canRaiseFloorTo: (floor: number) => minimum === null || minimum >= floor,
    }
  }
}
