import type { PodiumClientApi } from '../api'
import type { Commands } from '../commands'
import type { ChatCommands } from '../conversation/sends'
import { useClientRuntime } from './provider'

/** Commands are acquired as families; the Store façade has no commands. */
export function useCommands<TApi extends PodiumClientApi = PodiumClientApi>(): Commands<TApi> {
  return useClientRuntime<TApi>().root.commands
}

/** A conversation's unchanged durable send path. */
export function useChatSends(): ChatCommands {
  return useClientRuntime().root.chatSends
}

export function useRequestClient<TApi extends PodiumClientApi = PodiumClientApi>(): TApi {
  return useClientRuntime<TApi>().root.api
}

export function useHttpOrigin(): string {
  return useClientRuntime().root.httpOrigin
}

/** Transport boundary for terminal and stream hooks. */
export function useSocketHub(): import('../socket-transport').SocketHub {
  return useClientRuntime().root.services.connection.hub
}

export function useReplica(): import('../replica').Replica {
  return useClientRuntime().root.replica
}

export function useDrafts(): import('../conversation/draft-store').DraftStore {
  return useClientRuntime().drafts
}
