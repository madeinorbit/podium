export type FileKind = 'html' | 'markdown' | 'source'

export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path)
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

export function fileKindForPath(path: string): FileKind {
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  return 'source'
}
