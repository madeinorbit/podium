import { type TunnelHealth, type TunnelHealthReport, TUNNEL_REPORT_MAX_AGE_MS } from '@podium/runtime/tunnel-health'

/** Owned by one server instance. The tunnel sends a heartbeat every thirty seconds. */
export class TunnelHealthStore {
  private latest: TunnelHealth | null = null
  constructor(private readonly now: () => number = Date.now) {}
  report(report: TunnelHealthReport): void {
    this.latest = { ...report, reportedAt: this.now() }
  }
  read(publicUrl?: string): TunnelHealth | null {
    const latest = this.latest
    if (!latest) return null
    if (this.now() - latest.reportedAt > TUNNEL_REPORT_MAX_AGE_MS) {
      return { ...latest, state: 'unhealthy', failedSince: latest.failedSince ?? latest.reportedAt, lastError: 'The tunnel stopped reporting.' }
    }
    if (latest.state === 'working' && latest.url !== publicUrl) {
      return { ...latest, state: 'starting', lastError: 'Waiting for the current address.' }
    }
    return latest
  }
}
