import type { ReactElement } from 'react'
import type { ListRenderItem, ScrollViewProps } from 'react-native'

export interface TranscriptViewportHandle {
  pinToNewest(): void
  scrollToIndex(options: { index: number; animated: boolean; viewPosition?: number }): void
}

export interface TranscriptViewportProps<Item> extends ScrollViewProps {
  identity: string
  data: readonly Item[]
  keyExtractor(item: Item, index: number): string
  anchorKeys?: (item: Item) => readonly string[]
  renderItem: ListRenderItem<Item>
  ListEmptyComponent?: ReactElement
  ListFooterComponent?: ReactElement
  moreAbove?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
  onFollowChange?: (following: boolean) => void
}
