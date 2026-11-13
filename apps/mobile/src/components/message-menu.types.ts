import type { ReactNode } from 'react'

/** What a message's long-press menu can do. `undefined` asks the host to open
 *  its own menu (the JS sheet path). */
export type MessageAction = 'copy' | 'quote' | 'select'

export interface MessageMenuProps {
  text: string
  /** Exact local instant, already formatted by the transcript for its menu. */
  timeLabel?: string
  /** The host can put a quote in the composer. */
  canQuote: boolean
  onAction: (text: string, action?: MessageAction) => void
  children: ReactNode
}
