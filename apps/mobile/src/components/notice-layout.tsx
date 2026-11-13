import { createContext, type ReactElement, use } from 'react'
import { View } from 'react-native'

/** A native list supplies its row wrapper after a notice decides to render. */
export const NoticeLayoutContext = createContext<
  (notice: ReactElement, horizontalInset?: number) => ReactElement
>((notice, horizontalInset) =>
  horizontalInset ? <View style={{ paddingHorizontal: horizontalInset }}>{notice}</View> : notice,
)

export function NoticeLayout({
  children,
  horizontalInset,
}: {
  children: ReactElement
  /** Standalone spacing; a native list already supplies its section margins. */
  horizontalInset?: number
}) {
  return use(NoticeLayoutContext)(children, horizontalInset)
}
