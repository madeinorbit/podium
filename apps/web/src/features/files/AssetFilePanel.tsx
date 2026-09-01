import type { FileScope } from '@podium/client-core/viewmodels'
import { Maximize2, Minus, Plus, X } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import type { FileKind } from './file-kind'
import { OpenInBrowserButton } from './OpenInBrowserButton'
import { rawFileUrl } from './open-in-browser'

type AssetKind = Extract<FileKind, 'image' | 'pdf' | 'video' | 'audio'>

const MIN_ZOOM = 25
const MAX_ZOOM = 400
const ZOOM_STEP = 25

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/** Browser-native viewers for repository files whose bytes should never pass
 * through the text editor. The raw-file route keeps remote and artifact scopes
 * working while preserving the server's path and document sandboxes. */
export function AssetFilePanel({
  scope,
  path,
  kind,
  onClose,
}: {
  scope: FileScope
  path: string
  kind: AssetKind
  onClose: () => void
}): JSX.Element {
  const httpOrigin = useStoreSelector((s) => s.httpOrigin)
  const origin = httpOrigin || (typeof window === 'undefined' ? '' : window.location.origin)
  const url = rawFileUrl({ httpOrigin: origin, scope, path })
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(100)
  // A deleted, unreadable or rejected asset otherwise leaves a broken-image glyph
  // with no explanation — every other panel surfaces the failure through
  // useFileDocument, and these elements load their bytes themselves.
  const [failed, setFailed] = useState(false)

  const setActualSize = (): void => {
    setFit(false)
    setZoom(100)
  }
  const changeZoom = (delta: number): void => {
    setFit(false)
    setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value + delta)))
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      <div className="flex-none border-b border-border">
        <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </span>
          <OpenInBrowserButton scope={scope} path={path} dirty={false} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        {kind === 'image' && (
          <div className="flex min-h-8 items-center justify-center gap-0.5 border-t border-border px-2 py-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!url || (!fit && zoom <= MIN_ZOOM)}
              onClick={() => changeZoom(-ZOOM_STEP)}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <Minus size={13} aria-hidden="true" />
            </Button>
            <button
              type="button"
              className="h-6 min-w-11 rounded px-1 text-[10px] tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={setActualSize}
              aria-label="Show image at actual size"
              title="Actual size"
            >
              {fit ? 'Fit' : `${zoom}%`}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!url || (!fit && zoom >= MAX_ZOOM)}
              onClick={() => changeZoom(ZOOM_STEP)}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <Plus size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!url || fit}
              onClick={() => setFit(true)}
              aria-label="Fit image to window"
              title="Fit to window"
            >
              <Maximize2 size={13} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      {!url || failed ? (
        <div className="p-4 text-sm text-muted-foreground">This file cannot be previewed.</div>
      ) : kind === 'image' ? (
        <div
          className={`relative min-h-0 flex-1 overflow-auto p-5 ${fit ? 'flex items-center justify-center' : ''}`}
          style={{
            backgroundImage:
              'linear-gradient(45deg, color-mix(in oklab, currentColor 5%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in oklab, currentColor 5%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in oklab, currentColor 5%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in oklab, currentColor 5%, transparent) 75%)',
            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
            backgroundSize: '16px 16px',
          }}
        >
          {dimensions && (
            <span className="pointer-events-none absolute top-2 right-2 z-10 rounded bg-background/85 px-1.5 py-1 font-mono text-[10px] tabular-nums text-muted-foreground shadow-sm backdrop-blur-sm">
              {dimensions.width} × {dimensions.height}
            </span>
          )}
          <img
            src={url}
            alt={fileName(path)}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              // An SVG carrying only a viewBox reports 0 in some browsers. Treating
              // that as a real size makes "Actual size" compute a 0px width and the
              // image vanish, so fall back to intrinsic layout instead.
              setDimensions(
                image.naturalWidth > 0 && image.naturalHeight > 0
                  ? { width: image.naturalWidth, height: image.naturalHeight }
                  : null,
              )
            }}
            onError={() => setFailed(true)}
            className={`block bg-transparent outline outline-1 outline-black/10 select-none dark:outline-white/10 ${
              fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'
            }`}
            style={
              fit || !dimensions
                ? undefined
                : { width: `${Math.round((dimensions.width * zoom) / 100)}px`, height: 'auto' }
            }
          />
        </div>
      ) : kind === 'pdf' ? (
        <iframe
          src={url}
          title={`PDF preview: ${fileName(path)}`}
          className="min-h-0 flex-1 border-0"
        />
      ) : kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/90 p-4">
          {/* biome-ignore lint/a11y/useMediaCaption: Repository media has no guaranteed caption sidecar. */}
          <video
            controls
            preload="metadata"
            className="max-h-full max-w-full"
            aria-label={fileName(path)}
            onError={() => setFailed(true)}
          >
            <source src={url} />
            Your browser cannot play this video. Open it in the browser to try another player.
          </video>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
          <div className="max-w-full truncate font-mono text-xs text-muted-foreground">
            {fileName(path)}
          </div>
          {/* biome-ignore lint/a11y/useMediaCaption: Repository media has no guaranteed transcript sidecar. */}
          <audio
            controls
            preload="metadata"
            className="w-full max-w-xl"
            aria-label={fileName(path)}
            onError={() => setFailed(true)}
          >
            <source src={url} />
            Your browser cannot play this audio file. Open it in the browser to try another player.
          </audio>
        </div>
      )}
    </div>
  )
}
