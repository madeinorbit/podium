import type { ClientRuntime } from '@podium/client-core/engine'

/** Inject root-owned readers into sources that deliberately take narrow ports. */
export function replicaSourcePorts(runtime: Pick<ClientRuntime, 'root'>) {
  return { replica: runtime.root.replica }
}

export function noticeSourcePorts(runtime: Pick<ClientRuntime, 'root'>) {
  return { replica: runtime.root.replica, outbox: runtime.root.services.outbox.queue }
}

export function chatSourcePorts(runtime: Pick<ClientRuntime, 'root' | 'ui' | 'drafts'>) {
  return { ...noticeSourcePorts(runtime), ui: runtime.ui, drafts: runtime.drafts }
}

export function superagentSourcePorts(runtime: Pick<ClientRuntime, 'root' | 'ui' | 'readPosition'>) {
  return { ...replicaSourcePorts(runtime), ui: runtime.ui, readPosition: runtime.readPosition }
}
