import type { JSX } from 'react'
import { MediaLightbox } from '@/components/MediaLightbox'

/** Transcript images share the artifact preview's modal and Escape handling. */
export function ImageLightbox({
  src,
  onClose,
}: {
  src: string | null
  onClose: () => void
}): JSX.Element | null {
  if (!src) return null
  return (
    <MediaLightbox items={[{ kind: 'image', src, label: 'Preview' }]} index={0} onClose={onClose} />
  )
}
