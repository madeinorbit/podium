import type { SocketHub } from '../socket-transport/socket-hub'
import type { ConversationConnection } from './controller'

/** The link to the server, from the socket hub: when it comes back up, the
 *  conversation catches up on its own messages by id (POD-4811). */
export function hubConnection(
  hub: Pick<SocketHub, 'connectionHealth' | 'on'>,
): ConversationConnection {
  return {
    connected: () => hub.connectionHealth().status !== 'down',
    subscribe: (listener) =>
      hub.on('connectionHealth', (health) => listener(health.status !== 'down')),
  }
}
