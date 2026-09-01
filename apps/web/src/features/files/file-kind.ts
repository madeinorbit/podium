export type FileKind =
  | 'html'
  | 'markdown'
  | 'json'
  | 'table'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'source'

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

export function isTablePath(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path)
}

/** Raster images only. `.svg` is deliberately absent: it is markup people edit,
 *  and the asset viewer has no source mode, so routing it here would take away
 *  the editor it has always had. It keeps the text editor until the viewer grows
 *  a Preview/Source toggle. */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path)
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path)
}

export function isVideoPath(path: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv)$/i.test(path)
}

export function isAudioPath(path: string): boolean {
  return /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(path)
}

export function fileKindForPath(path: string): FileKind {
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  if (isJsonPath(path)) return 'json'
  if (isTablePath(path)) return 'table'
  if (isImagePath(path)) return 'image'
  if (isPdfPath(path)) return 'pdf'
  if (isVideoPath(path)) return 'video'
  if (isAudioPath(path)) return 'audio'
  return 'source'
}
