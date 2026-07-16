import { join } from 'node:path'

/**
 * Derive the absolute filesystem path for an uploaded image file.
 * Pure / side-effect-free — the caller creates the directory and writes the file.
 *
 * @param root     - The selected Podium instance state root
 * @param sessionId - Podium session the upload belongs to
 * @param id       - Unique identifier for this upload (UUID)
 * @param mime     - MIME type used to pick the file extension
 */
export function uploadFilePath(root: string, sessionId: string, id: string, mime: string): string {
  const ext = mimeToExt(mime)
  return join(root, 'uploads', sessionId, `${id}${ext}`)
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    default:
      return '.bin'
  }
}
