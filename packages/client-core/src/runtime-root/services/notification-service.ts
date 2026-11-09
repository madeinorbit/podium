import type { SocketHub } from '../../socket-transport'
import type { VisibilitySource } from '../connection/visibility'
import { ServiceLifetime } from './lifetime'

/** Attention is a web notification only while this client is off screen. */
export class NotificationService {
  private readonly lifetime = new ServiceLifetime()
  constructor(
    private readonly hub: Pick<SocketHub, 'on'>,
    private readonly visibility: VisibilitySource,
  ) {}
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      this.hub.on('attention', (event) => {
        if (!this.lifetime.active || this.visibility.isVisible()) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        try {
          new Notification(event.title, { body: event.body, tag: event.sessionId })
        } catch {
          /* Some webviews cannot construct notifications. */
        }
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
