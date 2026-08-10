/**
 * Opt-in, peer-attributed feed lifecycle trace.
 *
 * Aggregate performance counters answer "how often" but deliberately discard
 * identity. Bootstrap cadence investigations need the inverse view: one bounded
 * line per accepted peer event, carrying the server-minted peer id so attach,
 * hello, world serving, reclaim, and detach can be read as one sequence.
 *
 * Disabled by default. Set `PODIUM_TRACE_FEED_PEERS=1` for a diagnostic run.
 * No cookie, user id, request URL, payload, or row data is recorded.
 */
export type FeedPeerTraceEvent =
  | {
      readonly event: 'attach'
      readonly peerId: string
      readonly wireVersion: number
    }
  | {
      readonly event: 'hello'
      readonly peerId: string
      readonly claimedPeerId?: string
      readonly wireVersion: number
      readonly acceptsDelta: boolean
      readonly ageMs: number
    }
  | {
      readonly event: 'bootstrap'
      readonly peerId: string
      readonly cause: 'attach' | 'hello' | 'version-change'
      readonly wireVersion: number
      readonly reused: boolean
      readonly throughSeq: number
      readonly rows: number
      readonly durationMs: number
    }
  | {
      readonly event: 'reclaim'
      readonly peerId: string
      readonly priorPeerId: string
      readonly priorAgeMs: number | null
    }
  | {
      readonly event: 'detach'
      readonly peerId: string
      readonly cause: 'socket-close' | 'reclaim'
      readonly ageMs: number | null
    }

export function traceFeedPeer(event: FeedPeerTraceEvent): void {
  if (process.env.PODIUM_TRACE_FEED_PEERS !== '1') return
  console.info('[podium:feed-peer]', JSON.stringify({ at: new Date().toISOString(), ...event }))
}
