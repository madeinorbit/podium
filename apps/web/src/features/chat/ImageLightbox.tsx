import { X } from 'lucide-react'
import type { JSX } from 'react'

/** Full-screen preview for an image surfaced in the transcript (SendUserFile
 *  blocks and image tags). Closed by the backdrop, the ✕, or Escape via the
 *  button's native semantics. */
export function ImageLightbox({
  src,
  onClose,
}: {
  src: string | null
  onClose: () => void
}): JSX.Element | null {
  if (!src) return null
  return (
    <button
      data-pressable-exempt
      type="button"
      aria-label="Close image preview"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <X
        size={22}
        aria-hidden="true"
        className="absolute top-4 right-4 text-white/80 hover:text-white"
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop close */}
      <img
        src={src}
        alt="Preview"
        className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </button>
  )
}
