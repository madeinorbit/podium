import type { FileScope } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { fileKindForPath } from './file-kind'
import { HtmlFilePanel } from './HtmlFilePanel'
import { MarkdownFilePanel } from './MarkdownFilePanel'

export function FilePanel({
  scope,
  path,
  onClose,
}: {
  scope: FileScope
  path: string
  onClose: () => void
}): JSX.Element {
  if (fileKindForPath(path) === 'html') {
    return <HtmlFilePanel scope={scope} path={path} onClose={onClose} />
  }
  return <MarkdownFilePanel scope={scope} path={path} onClose={onClose} />
}
