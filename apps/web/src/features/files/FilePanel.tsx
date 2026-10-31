import type { FileScope } from '@podium/client-core/values'
import type { JSX } from 'react'
import { AssetFilePanel } from './AssetFilePanel'
import { isArtifactsTabScope } from './artifacts-tab-id'
import { fileKindForPath } from './file-kind'
import { HtmlFilePanel } from './HtmlFilePanel'
import { JsonFilePanel } from './JsonFilePanel'
import { MarkdownFilePanel } from './MarkdownFilePanel'
import { TableFilePanel } from './TableFilePanel'

export function FilePanel({
  scope,
  path,
  onClose,
}: {
  scope: FileScope
  path: string
  onClose: () => void
}): JSX.Element | null {
  // The Artifacts index's sentinel scope has no bytes behind it (POD-2078):
  // never mount a reader for it, whichever route handed it here.
  if (isArtifactsTabScope(scope)) return null
  const kind = fileKindForPath(path)
  if (kind === 'html') {
    return <HtmlFilePanel scope={scope} path={path} onClose={onClose} />
  }
  if (kind === 'json') {
    return <JsonFilePanel scope={scope} path={path} onClose={onClose} />
  }
  if (kind === 'table') {
    return <TableFilePanel scope={scope} path={path} onClose={onClose} />
  }
  if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
    return <AssetFilePanel scope={scope} path={path} kind={kind} onClose={onClose} />
  }
  return <MarkdownFilePanel scope={scope} path={path} onClose={onClose} />
}
