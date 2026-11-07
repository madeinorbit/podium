import { ChevronRight, Expand, ImageOff, Images } from 'lucide-react'
import { type JSX, useState } from 'react'
import type { MediaLightboxItem } from '@/components/MediaLightbox'
import type { OpenChatImage } from './ImageLightbox'
import './chat-image-gallery.css'

export interface ChatGalleryImage extends MediaLightboxItem {
  kind: 'image'
  path?: string
}

function ImageTile({
  item,
  index,
  count,
  onOpen,
  onOpenFile,
}: {
  item: ChatGalleryImage
  index: number
  count: number
  onOpen: () => void
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = failedSrc === item.src
  const wideExtra = index === 2 ? count - 3 : 0
  const narrowExtra = index === 1 ? count - 2 : 0
  return (
    <button
      data-pressable
      type="button"
      className="chat-image-tile"
      aria-label={`Open ${item.label}, image ${index + 1} of ${count}`}
      aria-haspopup={failed && item.path && onOpenFile ? undefined : 'dialog'}
      title={`Open ${item.label}`}
      onClick={(event) => {
        event.stopPropagation()
        if (failed && item.path && onOpenFile) onOpenFile(item.path)
        else onOpen()
      }}
    >
      <span className="chat-image-frame">
        {failed ? (
          <span className="chat-image-unavailable">
            <ImageOff size={22} aria-hidden="true" />
            <span>Preview unavailable</span>
          </span>
        ) : (
          <img
            key={item.src}
            src={item.src}
            alt={item.label}
            loading="lazy"
            onError={() => setFailedSrc(item.src)}
          />
        )}
        {wideExtra > 0 && (
          <span className="chat-image-more chat-image-more--wide" aria-hidden="true">
            <strong>+{wideExtra}</strong>
            <span>more {wideExtra === 1 ? 'image' : 'images'}</span>
          </span>
        )}
        {narrowExtra > 0 && (
          <span className="chat-image-more chat-image-more--narrow" aria-hidden="true">
            <strong>+{narrowExtra}</strong>
            <span>more {narrowExtra === 1 ? 'image' : 'images'}</span>
          </span>
        )}
      </span>
      <span className="chat-image-caption">
        <span>{item.label}</span>
        <Expand size={12} aria-hidden="true" />
      </span>
    </button>
  )
}

/** Container queries follow pane width, including split desktop panes, without
 * adding resize state to every message. All images remain in the viewer. */
export function ChatImageGallery({
  items,
  onOpenImage,
  onOpenFile,
}: {
  items: readonly ChatGalleryImage[]
  onOpenImage: OpenChatImage
  onOpenFile?: (path: string) => void
}): JSX.Element | null {
  if (!items.length) return null
  const open = (index: number): void => {
    const item = items[index]
    if (item) onOpenImage(item.src, items, index)
  }
  return (
    <section
      className="chat-image-gallery"
      data-count={items.length}
      aria-label={`Message attachments, ${items.length} ${items.length === 1 ? 'image' : 'images'}`}
    >
      <div className="chat-image-gallery-heading">
        <span>
          <Images size={14} aria-hidden="true" />
          {items.length} {items.length === 1 ? 'image' : 'images'}
        </span>
        <button
          data-pressable
          type="button"
          className="chat-image-view-all"
          aria-haspopup="dialog"
          onClick={(event) => {
            event.stopPropagation()
            open(0)
          }}
        >
          {items.length === 1 ? 'Open image' : 'View all'}
          <ChevronRight size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-image-grid">
        {items.slice(0, 3).map((item, index) => (
          <ImageTile
            // biome-ignore lint/suspicious/noArrayIndexKey: upload order is fixed; preserve the focused button when its stored-copy URL arrives.
            key={`${item.path ?? item.label}:${index}`}
            item={item}
            index={index}
            count={items.length}
            onOpen={() => open(index)}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </section>
  )
}
