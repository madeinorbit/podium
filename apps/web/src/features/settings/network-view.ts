import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { Trpc } from '@/app/trpc'

export type NetworkInfo = Awaited<ReturnType<Trpc['setup']['info']['query']>>
export class NetworkSettingsView extends RequestAnswer<NetworkInfo> {
  constructor(private readonly trpc: Pick<Trpc, 'setup'>) {
    super()
  }
  refresh = (showLoading = false): Promise<void> =>
    this.load(() => this.trpc.setup.info.query(), showLoading)
}
