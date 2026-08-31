import { MAX_ATTACHMENTS_PER_PICK } from './composer-media-limits'

/** Options that keep the selected iOS asset's current bytes instead of asking
 * Photos to recompress or transcode it before the upload size check. */
export const ORIGINAL_PHOTO_PICKER_POLICY = {
  allowsEditing: false,
  allowsMultipleSelection: true,
  selectionLimit: MAX_ATTACHMENTS_PER_PICK,
  quality: 1,
  preferredAssetRepresentationMode: 'current',
} as const

const PHOTO_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
}

export function photoFallbackName(index: number, mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  // Never give unknown bytes a plausible-but-false image extension. A neutral
  // name preserves the declared MIME while avoiding downstream type confusion.
  const extension = PHOTO_EXTENSIONS[normalized] ?? 'bin'
  return `photo-${index + 1}.${extension}`
}

export function photoUploadMetadata(
  index: number,
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
): { name: string; mimeType: string } {
  // Missing metadata must stay unknown. Calling original HEIC bytes JPEG is
  // worse than a neutral name because consumers may trust both declarations.
  const resolvedMimeType = mimeType || 'application/octet-stream'
  return {
    name: fileName || photoFallbackName(index, resolvedMimeType),
    mimeType: resolvedMimeType,
  }
}
