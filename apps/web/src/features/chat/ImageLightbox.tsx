import { type JSX, useState } from 'react'
import { MediaLightbox, type MediaLightboxItem } from '@/components/MediaLightbox'

export interface ChatImagePreview {
  items: readonly MediaLightboxItem[]
  index: number
}

export type OpenChatImage = (
  src: string,
  items?: readonly MediaLightboxItem[],
  index?: number,
) => void

function OpenImageLightbox({
  preview,
  onClose,
}: {
  preview: ChatImagePreview
  onClose: () => void
}): JSX.Element {
  const [index, setIndex] = useState(preview.index)
  return (
    <MediaLightbox
      items={preview.items}
      index={index}
      onIndexChange={setIndex}
      onClose={onClose}
      navigationLabel="image"
    />
  )
}

/** Transcript images share the artifact preview's modal and Escape handling. */
export function ImageLightbox({
  src,
  onClose,
}: {
  src: string | ChatImagePreview | null
  onClose: () => void
}): JSX.Element | null {
  if (!src) return null
  const preview: ChatImagePreview =
    typeof src === 'string' ? { items: [{ kind: 'image', src, label: 'Preview' }], index: 0 } : src
  return (
    <OpenImageLightbox
      key={preview.items[preview.index]?.src}
      preview={preview}
      onClose={onClose}
    />
  )
}
