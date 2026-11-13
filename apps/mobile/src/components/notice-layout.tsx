import { createContext, type ReactElement, use } from 'react'

/** A native list supplies its row wrapper after a notice decides to render. */
export const NoticeLayoutContext = createContext<(notice: ReactElement) => ReactElement>(
  (notice) => notice,
)

export function NoticeLayout({ children }: { children: ReactElement }) {
  return use(NoticeLayoutContext)(children)
}
