import { X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Full-screen media overlay: an image or video at comfortable size over a
 * dimmed backdrop. Click outside the media or press Escape to close. Portaled
 * to <body> so it escapes the dock/panel overflow contexts.
 */
export function MediaLightbox({
  kind,
  src,
  label,
  onClose,
}: {
  kind: 'image' | 'video'
  src: string
  label: string
  onClose: () => void
}): JSX.Element {
  // Capture-phase Escape so panel-level key handlers underneath never see it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    // Backdrop click closes; the media stops propagation so interacting with
    // it (video controls included) never closes. Keyboard close is the Escape
    // listener above plus the explicit X button — the backdrop itself is
    // presentational, NOT a <button>: a <video controls> may not nest inside
    // interactive content.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape + X button cover keyboard
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-2 bg-black/85 p-6"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close preview"
        className="absolute top-4 right-4 rounded-md p-1 text-white/80 hover:text-white"
        onClick={onClose}
      >
        <X size={22} aria-hidden="true" />
      </button>
      {kind === 'image' ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop close only
        <img
          src={src}
          alt={label}
          className="max-h-[88vh] max-w-full rounded-md object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: agent-published artifact videos have no captions
        <video
          src={src}
          controls
          autoPlay
          className="max-h-[88vh] max-w-full rounded-md shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className="max-w-[80vw] truncate text-[12px] text-white/70">{label}</span>
    </div>,
    document.body,
  )
}
