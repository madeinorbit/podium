import type { SessionId, TranscriptItem } from '@podium/model/browser'
import type { JSX } from 'react'
import { ItemAttachments } from './ChatUploadThumb'
import type { OpenChatImage } from './ImageLightbox'

/** Agent-shared files use the same gallery and file chips as operator messages. */
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
  sessionId: SessionId
  cwd: string
  httpOrigin: string
  openFile: (sessionId: SessionId, path: string) => void
  onOpenImage: OpenChatImage
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
        <ItemAttachments
          sessionId={sessionId}
          paths={paths}
          attachments={[]}
          tags={[]}
          cwd={cwd}
          httpOrigin={httpOrigin}
          onOpenImage={onOpenImage}
          openFile={openFile}
        />
      </div>
    </div>
  )
}
