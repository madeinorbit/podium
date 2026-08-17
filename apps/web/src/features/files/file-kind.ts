export type FileKind = 'html' | 'markdown' | 'json' | 'source'

export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path)
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** Strict JSON only. `.jsonc` and `.json5` are deliberately absent: their whole
 *  point is the comments and trailing commas that the JSON panel would have to
 *  report as faults. */
export function isJsonPath(path: string): boolean {
  return /\.json$/i.test(path)
}

export function fileKindForPath(path: string): FileKind {
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  if (isJsonPath(path)) return 'json'
  return 'source'
}
