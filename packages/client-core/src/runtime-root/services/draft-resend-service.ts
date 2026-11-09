import type { DraftStore } from '../../conversation/draft-store'
import type { ConnectionService } from '../connection/connection-service'
import { ServiceLifetime } from './lifetime'

/** Re-offer unsent composer documents when the connection recovers. */
export class DraftResendService {
  private readonly lifetime = new ServiceLifetime()
  constructor(
    private readonly drafts: DraftStore,
    private readonly connection: Pick<ConnectionService, 'onReconnected'>,
  ) {}
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      this.connection.onReconnected(() => {
        if (this.lifetime.active) this.drafts.flushDirty()
      }),
    )
  }
  stop(): void {
    this.lifetime.stop()
  }
  dispose(): void {
    this.lifetime.dispose()
  }
}
