import { lazy } from '@podium/mobx-helpers'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { Trpc } from '@/app/trpc'

export type NetworkInfo = Awaited<ReturnType<Trpc['setup']['info']['query']>>
export class NetworkSettingsView extends RequestAnswer<NetworkInfo> {
  constructor(private readonly trpc: Pick<Trpc, 'setup'>) {
    super()
  }
  private timer: ReturnType<typeof setTimeout> | undefined
  private opened = false

  /** Poll only while this settings view and document are visible. */
  open(): void {
    this.opened = true
    document.addEventListener('visibilitychange', this.visibilityChanged)
    void this.refresh(true).then(() => this.schedule())
  }
  private visibilityChanged = (): void => {
    clearTimeout(this.timer)
    this.cancel()
    if (document.visibilityState !== 'hidden') void this.refresh().then(() => this.schedule())
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.opened || document.visibilityState === 'hidden') return
    this.timer = setTimeout(() => void this.refresh().then(() => this.schedule()), 15_000)
  }
  override close(): void {
    this.opened = false
    clearTimeout(this.timer)
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    super.close()
  }

  @lazy get tunnelHealthLabel(): string {
    const health = this.answer?.tunnelHealth
    if (!health) return 'Waiting for a tunnel report.'
    if (health.state === 'working') return 'Working'
    if (health.state === 'starting' || health.state === 'restarting') return 'Restarting'
    return `Not answering since ${new Date(health.failedSince ?? health.reportedAt).toLocaleString()}`
  }

  refresh = (showLoading = false): Promise<void> =>
    this.load(() => this.trpc.setup.info.query(), showLoading)
}
