import { Dialog } from '@base-ui/react/dialog'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { type JSX, useEffect } from 'react'

export interface MediaLightboxItem {
  kind: 'image' | 'video'
  src: string
  label: string
}

/** Shared modal preview for artifact galleries and transcript images. */
export function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: readonly MediaLightboxItem[]
  index: number
  onIndexChange?: (index: number) => void
  onClose: () => void
}): JSX.Element | null {
  const item = items[index]
  const gallery = items.length > 1 && !!onIndexChange
  const navigate = (offset: number): void => {
    onIndexChange?.((index + offset + items.length) % items.length)
  }

  useEffect(() => {
    if (!item) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // WebKit forwards unhandled Escape to AppKit, which exits the window's
        // fullscreen Space. Stopping propagation alone does not cancel that.
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (
        gallery &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        // Native video controls own their arrow keys for seeking and volume.
        if (event.target instanceof Element && event.target.closest('video')) return
        event.preventDefault()
        event.stopPropagation()
        onIndexChange?.(
          (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length,
        )
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [item, gallery, index, items.length, onClose, onIndexChange])

  if (!item) return null

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/85" />
        <Dialog.Popup
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-2 overflow-hidden overscroll-contain px-14 py-16 text-white sm:px-20"
          onClick={(event) => {
            // Portals still bubble through React's tree, including offer cards.
            event.stopPropagation()
            if (event.target === event.currentTarget) onClose()
          }}
        >
          <Dialog.Title className="sr-only">Media preview</Dialog.Title>
          <button
            data-pressable
            type="button"
            aria-label="Close preview"
            className="absolute top-3 right-3 flex size-10 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
            onClick={onClose}
          >
            <X size={22} aria-hidden="true" />
          </button>
          {gallery && (
            <>
              <button
                data-pressable
                type="button"
                aria-label="Previous artifact"
                aria-keyshortcuts="ArrowLeft"
                className="absolute top-1/2 left-2 flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white sm:left-4"
                onClick={() => navigate(-1)}
              >
                <ChevronLeft size={26} aria-hidden="true" />
              </button>
              <button
                data-pressable
                type="button"
                aria-label="Next artifact"
                aria-keyshortcuts="ArrowRight"
                className="absolute top-1/2 right-2 flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white sm:right-4"
                onClick={() => navigate(1)}
              >
                <ChevronRight size={26} aria-hidden="true" />
              </button>
            </>
          )}
          {item.kind === 'image' ? (
            <img
              key={item.src}
              src={item.src}
              alt={item.label}
              className="min-h-0 max-w-full rounded-md object-contain shadow-2xl"
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: agent-published artifact videos have no captions
            <video
              key={item.src}
              src={item.src}
              aria-label={item.label}
              controls
              autoPlay
              className="min-h-0 max-w-full rounded-md shadow-2xl"
            />
          )}
          <Dialog.Description
            aria-live="polite"
            aria-atomic="true"
            className="flex max-w-full flex-none items-baseline gap-3 text-[12px] text-white/70"
          >
            <span className="truncate">{item.label}</span>
            {gallery && (
              <span className="flex-none tabular-nums">
                {index + 1} / {items.length}
              </span>
            )}
          </Dialog.Description>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
