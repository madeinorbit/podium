import { randomUUID } from './id'
import type { UiStore } from './ui/ui-store'

export interface NoticeSink {
  error(message: string): void
  info(message: string, description?: string): void
}

/** Notices last only on this device, in the UiStore's unsaved toast queue. */
export function createNotices(ui: () => UiStore, consumer?: NoticeSink): NoticeSink {
  const add = (kind: 'error' | 'info', message: string, description?: string): void => {
    const owner = ui()
    const id = randomUUID()
    owner.addNotice({
      id,
      kind,
      message,
      ...(description !== undefined ? { description } : {}),
    })
    if (consumer) {
      if (kind === 'error') consumer.error(message)
      else consumer.info(message, description)
      owner.dismissNotice(id)
    }
  }
  return {
    error: (message) => add('error', message),
    info: (message, description) => add('info', message, description),
  }
}
