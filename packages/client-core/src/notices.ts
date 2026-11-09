import { randomUUID } from './id'
import type { UiStore } from './ui/ui-store'

export interface NoticeSink {
  error(message: string): void
  info(message: string, description?: string): void
}

/** Notices last only on this device, in the UiStore's unsaved toast queue. */
export function createNotices(ui: () => UiStore): NoticeSink {
  return {
    error: (message) => ui().addNotice({ id: randomUUID(), kind: 'error', message }),
    info: (message, description) =>
      ui().addNotice({
        id: randomUUID(),
        kind: 'info',
        message,
        ...(description !== undefined ? { description } : {}),
      }),
  }
}
