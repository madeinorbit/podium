import type { FileScope } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { AssetFilePanel } from './AssetFilePanel'
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
}): JSX.Element {
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
