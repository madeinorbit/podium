import { Dialog } from '@base-ui/react/dialog'
import {
  ChevronLeft,
  ChevronRight,
  Film,
  ImageOff,
  Maximize,
  RotateCw,
  X,
  ZoomIn,
} from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import './media-lightbox.css'

export interface MediaLightboxItem {
  kind: 'image' | 'video'
  src: string
  label: string
}

/** A failed filmstrip preview keeps its named button and a quiet glyph. */
function MediaThumbnail({ item }: { item: MediaLightboxItem }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (item.kind === 'video') return <Film size={20} aria-hidden="true" />
  if (failed) return <ImageOff size={18} aria-hidden="true" />
  return <img src={item.src} alt="" loading="lazy" onError={() => setFailed(true)} />
}

/** One accessible viewer for artifact galleries and transcript images. */
export function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
  navigationLabel = 'artifact',
}: {
  items: readonly MediaLightboxItem[]
  index: number
  onIndexChange?: (index: number) => void
  onClose: () => void
  navigationLabel?: 'image' | 'artifact'
}): JSX.Element | null {
  const item = items[index]
  const gallery = items.length > 1 && !!onIndexChange
  const closeRef = useRef<HTMLButtonElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const filmstripRef = useRef<HTMLElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState<{ src: string; width: number } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState<{
    src: string
    width: number
    height: number
  } | null>(null)
  const zoomed = item?.src === zoom?.src
  const failed = item?.src === failedSrc
  const navigate = (offset: number): void => {
    setZoom(null)
    onIndexChange?.((index + offset + items.length) % items.length)
  }

  useEffect(() => {
    if (!item) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Cancel before WebKit forwards Escape to AppKit's fullscreen handler.
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
        if (event.target instanceof Element && event.target.closest('video')) return
        event.preventDefault()
        event.stopPropagation()
        setZoom(null)
        onIndexChange?.(
          (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length,
        )
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [item, gallery, index, items.length, onClose, onIndexChange])

  useEffect(() => {
    filmstripRef.current?.children
      .item(index)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [index])

  if (!item) return null
  const size = dimensions?.src === item.src ? dimensions : null
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="media-lightbox-backdrop" />
        <Dialog.Popup
          className="media-lightbox"
          initialFocus={closeRef}
          onClick={(event) => {
            // Portals still bubble through React's tree, including offer cards.
            event.stopPropagation()
            if (event.target === event.currentTarget) onClose()
          }}
        >
          <header className="media-lightbox-header">
            <div className="media-lightbox-heading">
              <Dialog.Title className="media-lightbox-title" title={item.label}>
                {item.label}
              </Dialog.Title>
              <Dialog.Description className="media-lightbox-description">
                {item.kind === 'video'
                  ? 'Video'
                  : size
                    ? `${size.width} × ${size.height} · Image`
                    : 'Image preview'}
              </Dialog.Description>
            </div>
            <div className="media-lightbox-actions">
              {gallery && (
                <span className="media-lightbox-count" aria-live="polite" aria-atomic="true">
                  {index + 1} / {items.length}
                </span>
              )}
              {item.kind === 'image' && !failed && (
                <button
                  data-pressable
                  type="button"
                  className="media-lightbox-zoom"
                  aria-label={zoomed ? 'Fit image to viewer' : 'Zoom image'}
                  aria-pressed={zoomed}
                  onClick={() => {
                    const viewport = viewportRef.current
                    const fitWidth =
                      size && viewport
                        ? Math.min(
                            viewport.clientWidth,
                            (size.width * viewport.clientHeight) / size.height,
                          )
                        : (viewport?.clientWidth ?? 800)
                    setZoom(zoomed ? null : { src: item.src, width: fitWidth * 2 })
                    viewportRef.current?.scrollTo({ top: 0, left: 0 })
                  }}
                >
                  {zoomed ? (
                    <Maximize size={15} aria-hidden="true" />
                  ) : (
                    <ZoomIn size={15} aria-hidden="true" />
                  )}
                  <span>{zoomed ? 'Fit' : 'Zoom'}</span>
                </button>
              )}
              <button
                data-pressable
                ref={closeRef}
                type="button"
                className="media-lightbox-button"
                aria-label="Close preview"
                onClick={onClose}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div
            className="media-lightbox-stage"
            onTouchStart={(event) => {
              if (zoomed || item.kind === 'video' || event.touches.length !== 1) {
                touch.current = null
                return
              }
              const point = event.touches[0]
              if (point) touch.current = { x: point.clientX, y: point.clientY }
            }}
            onTouchCancel={() => {
              touch.current = null
            }}
            onTouchEnd={(event) => {
              const start = touch.current
              touch.current = null
              const point = event.changedTouches[0]
              if (!gallery || zoomed || !point || !start) return
              const dx = point.clientX - start.x,
                dy = point.clientY - start.y
              if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(dx < 0 ? 1 : -1)
            }}
          >
            {gallery && (
              <button
                data-pressable
                type="button"
                aria-label={`Previous ${navigationLabel}`}
                aria-keyshortcuts="ArrowLeft"
                className="media-lightbox-button media-lightbox-nav media-lightbox-prev"
                onClick={() => navigate(-1)}
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
            )}
            <div
              className="media-lightbox-viewport"
              ref={viewportRef}
              data-zoomed={zoomed}
              aria-busy={item.kind === 'image' && !failed && !size}
            >
              {item.kind === 'image' && !failed && !size && (
                <span className="media-lightbox-loading" role="status">
                  Loading image…
                </span>
              )}
              {failed ? (
                <div className="media-lightbox-unavailable" role="status">
                  <ImageOff size={30} aria-hidden="true" />
                  <p>This preview couldn’t load.</p>
                  <span>{item.label}</span>
                  <button
                    data-pressable
                    type="button"
                    className="media-lightbox-retry"
                    onClick={() => setFailedSrc(null)}
                  >
                    <RotateCw size={14} aria-hidden="true" />
                    Try again
                  </button>
                </div>
              ) : item.kind === 'image' ? (
                <img
                  key={item.src}
                  src={item.src}
                  alt={item.label}
                  className="media-lightbox-image"
                  style={zoomed ? { width: zoom?.width, height: 'auto' } : undefined}
                  draggable={false}
                  onLoad={(event) =>
                    setDimensions({
                      src: item.src,
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    })
                  }
                  onError={() => setFailedSrc(item.src)}
                />
              ) : (
                // biome-ignore lint/a11y/useMediaCaption: agent-published videos have no captions
                <video
                  key={item.src}
                  src={item.src}
                  aria-label={item.label}
                  controls
                  autoPlay
                  className="media-lightbox-video"
                  onError={() => setFailedSrc(item.src)}
                />
              )}
            </div>
            {gallery && (
              <button
                data-pressable
                type="button"
                aria-label={`Next ${navigationLabel}`}
                aria-keyshortcuts="ArrowRight"
                className="media-lightbox-button media-lightbox-nav media-lightbox-next"
                onClick={() => navigate(1)}
              >
                <ChevronRight size={22} aria-hidden="true" />
              </button>
            )}
          </div>
          <footer className="media-lightbox-footer">
            {gallery && (
              <nav
                className="media-lightbox-filmstrip"
                ref={filmstripRef}
                aria-label="Gallery images"
              >
                {items.map((entry, i) => (
                  <button
                    data-pressable
                    // biome-ignore lint/suspicious/noArrayIndexKey: a viewer album has fixed order and may contain the same file twice.
                    key={`${entry.src}:${i}`}
                    type="button"
                    aria-label={`Show ${entry.label}, ${i + 1} of ${items.length}`}
                    aria-current={i === index ? 'true' : undefined}
                    title={entry.label}
                    onClick={() => {
                      setZoom(null)
                      onIndexChange?.(i)
                    }}
                  >
                    <MediaThumbnail item={entry} />
                  </button>
                ))}
              </nav>
            )}
            <div className="media-lightbox-hint">
              {gallery && (
                <span>
                  <kbd>←</kbd>
                  <kbd>→</kbd> Browse {navigationLabel === 'image' ? 'images' : 'media'}
                </span>
              )}
              <span>
                <kbd>Esc</kbd>{' '}
                {navigationLabel === 'image' ? 'Back to conversation' : 'Close preview'}
              </span>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
