import { randomUUID } from './id'
import type { UiStore } from './ui/ui-store'

export interface NoticeSink {
  /** `id` names the operation, so its retry can resolve this error alone. */
  error(message: string, id?: string): void
  info(message: string, description?: string): void
  /** Resolve only the error belonging to a retried operation. */
  dismissError?(id: string): void
}

/** Notices last only on this device, in the UiStore's unsaved toast queue. */
export function createNotices(ui: () => UiStore, consumer?: NoticeSink): NoticeSink {
  const add = (
    kind: 'error' | 'info',
    message: string,
    description?: string,
    noticeId?: string,
  ): void => {
    const owner = ui()
    const id = noticeId ?? randomUUID()
    owner.addNotice({
      id,
      kind,
      message,
      ...(description !== undefined ? { description } : {}),
    })
    if (consumer) {
      if (kind === 'error') consumer.error(message, noticeId)
      else consumer.info(message, description)
      owner.dismissNotice(id)
    }
  }
  return {
    error: (message, id) => add('error', message, undefined, id),
    info: (message, description) => add('info', message, description),
    dismissError: (id) => {
      ui().dismissNotice(id)
      consumer?.dismissError?.(id)
    },
  }
}

export const NOOP_NOTICES: NoticeSink = { error: () => {}, info: () => {} }
