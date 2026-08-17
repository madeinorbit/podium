import { join } from 'node:path'
import type { SessionId } from '@podium/model'

/**
 * Derive the absolute filesystem path for an uploaded file.
 * Pure / side-effect-free — the caller creates the directory and writes the file.
 *
 * @param root     - The selected Podium instance state root
 * @param sessionId - Podium session the upload belongs to
 * @param id       - Unique identifier for this upload (UUID)
 * @param mime     - MIME type, the fallback source of the file extension
 * @param filename - The name the file had on the operator's machine. Its
 *   extension WINS over the mime map when it has one, because the mime table
 *   only ever knew the four screenshot formats and answered `.bin` for
 *   everything else — which is how an attached `notes.pdf` reached the agent as
 *   a file no harness would open (POD-1203). Only the extension is taken; the
 *   rest of the name is untrusted input and never touches the path.
 */
export function uploadFilePath(
  root: string,
  sessionId: SessionId,
  id: string,
  mime: string,
  filename?: string,
): string {
  const ext = extFromName(filename) ?? mimeToExt(mime)
  return join(root, 'uploads', sessionId, `${id}${ext}`)
}

/** The trailing `.ext` of a filename, when it is one — lowercase, alphanumeric,
 *  1–8 characters. Anything else (no dot, a dotfile, a path separator smuggled
 *  in, an absurd tail) is not an extension and falls through to the mime map. */
function extFromName(filename: string | undefined): string | null {
  if (!filename) return null
  const base = filename.split(/[/\\]/).pop() ?? ''
  // `.gitignore` is a whole name whose only dot leads it, not an extension.
  if (base.lastIndexOf('.') <= 0) return null
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base)
  return match?.[1] ? `.${match[1].toLowerCase()}` : null
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
