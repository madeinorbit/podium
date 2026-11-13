import type { ReactNode, Ref } from 'react'

export type PagerPage = 0 | 1

export interface ChatDeckPagerHandle {
  /** Animates to a page as a flick would; `animated: false` jumps. */
  setPage(page: PagerPage, animated?: boolean): void
}

export interface ChatDeckPagerProps {
  ref?: Ref<ChatDeckPagerHandle>
  /** Page 0 is the chat, page 1 the flight deck. Both stay mounted. */
  chat: ReactNode
  deck: ReactNode
  /** The page nearest the offset; changes as a drag crosses the midpoint. */
  onPageChange?: (page: PagerPage) => void
  /** The page the pager came to rest on. */
  onPageSettle?: (page: PagerPage) => void
}
