import type { ClientRuntime } from '@podium/client-core/runtime-root'

/** Inject root-owned readers into sources that deliberately take narrow ports. */
export function replicaSourcePorts(runtime: Pick<ClientRuntime, 'replica'>) {
  return { replica: runtime.replica }
}

export function noticeSourcePorts(runtime: Pick<ClientRuntime, 'replica' | 'services'>) {
  return { replica: runtime.replica, outbox: runtime.services.outbox.queue }
}

export function chatSourcePorts(
  runtime: Pick<ClientRuntime, 'replica' | 'services' | 'ui' | 'drafts'>,
) {
  return { ...noticeSourcePorts(runtime), ui: runtime.ui, drafts: runtime.drafts }
}

export function superagentSourcePorts(
  runtime: Pick<ClientRuntime, 'replica' | 'ui' | 'readPosition'>,
) {
  return { ...replicaSourcePorts(runtime), ui: runtime.ui, readPosition: runtime.readPosition }
}
