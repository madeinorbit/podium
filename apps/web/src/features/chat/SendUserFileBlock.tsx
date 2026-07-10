import { isImagePath } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import { FileText } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { resolveAgainstCwd } from '@/lib/file-path'

/**
 * The agent sharing files with the user (SendUserFile). Images render as
 * clickable thumbnails (→ lightbox); other files as openable chips. The optional
 * caption rides in on `toolTitle` (set by the transcript parser).
 */
export function SendUserFileBlock({
  item,
  cls,
  index,
  sessionId,
  cwd,
  httpOrigin,
  openFile,
  onOpenImage,
}: {
  item: TranscriptItem
  cls: string
  index: number
  sessionId: string
  cwd: string
  httpOrigin: string
  openFile: (sessionId: string, path: string) => void
  onOpenImage: (src: string) => void
}): JSX.Element {
  const paths = item.toolPaths ?? []
  return (
    <div className={cls} data-block={index}>
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div className="transcript-header">
          <span className="transcript-role">Shared {paths.length === 1 ? 'a file' : 'files'}</span>
        </div>
        {item.toolTitle && (
          <div className="mt-0.5 text-xs text-muted-foreground">{item.toolTitle}</div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2">
          {paths.map((p) => {
            const abs = resolveAgainstCwd(cwd, p)
            const name = p.split('/').pop() ?? p
            // Defined once: the openable file chip — used for non-image files and
            // as the fallback when an image fails to load (moved/deleted/denied).
            const chip = (
              <button
                key={p}
                type="button"
                onClick={() => openFile(sessionId, abs)}
                className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title={`Open ${p}`}
              >
                <FileText size={12} aria-hidden="true" />
                {name}
              </button>
            )
            if (isImagePath(p)) {
              const url = assetUrl({ httpOrigin, sessionId, fileDir: cwd, src: abs })
              if (url)
                return (
                  <SentImageThumb
                    key={p}
                    url={url}
                    name={name}
                    onOpen={() => onOpenImage(url)}
                    fallback={chip}
                  />
                )
            }
            return chip
          })}
        </div>
      </div>
    </div>
  )
}

/** One SendUserFile image thumbnail. Falls back to the file chip if the image
 *  fails to load (file moved/deleted, or read denied) — no broken-image glyph. */
function SentImageThumb({
  url,
  name,
  onOpen,
  fallback,
}: {
  url: string
  name: string
  onOpen: () => void
  fallback: JSX.Element
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) return fallback
  return (
    <button
      type="button"
      onClick={onOpen}
      className="overflow-hidden rounded-md border border-border hover:border-primary"
      title={`Open ${name}`}
    >
      <img
        src={url}
        alt={name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-48 max-w-[260px] object-cover"
      />
    </button>
  )
}
