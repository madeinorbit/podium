import type { PickedFile, PickedFileBase } from './composer-media-types'

/** Exact encoded ceiling from sessions.uploadImage. */
export const MAX_ATTACHMENT_BASE64_CHARS = 10 * 1024 * 1024
/** Largest byte count whose padded base64 representation fits that ceiling. */
export const MAX_ATTACHMENT_BYTES = Math.floor(MAX_ATTACHMENT_BASE64_CHARS / 4) * 3
/** A small, fixed phone batch keeps base64 memory bounded even at the byte ceiling. */
export const MAX_ATTACHMENTS_PER_PICK = 4

export interface AttachmentReadSource extends PickedFileBase {
  uri: string
}

function tooLarge(name: string): string {
  return `${name} is larger than 7.5 MB.`
}

/**
 * Read a native picker result in series. Known sizes are rejected before any
 * bytes are read; unknown sizes get a filesystem preflight; encoded length is
 * checked again because provider metadata is not authoritative.
 */
export async function readAttachmentsSequentially(
  sources: readonly AttachmentReadSource[],
  io: {
    sizeOf: (source: AttachmentReadSource) => Promise<number | undefined>
    base64Of: (source: AttachmentReadSource) => Promise<string>
  },
): Promise<PickedFile[]> {
  const results: PickedFile[] = []
  for (const source of sources.slice(0, MAX_ATTACHMENTS_PER_PICK)) {
    try {
      const size = source.size ?? (await io.sizeOf(source))
      const base = {
        name: source.name,
        mimeType: source.mimeType,
        previewUri: source.previewUri,
        ...(size === undefined ? {} : { size }),
      }
      if (size !== undefined && size > MAX_ATTACHMENT_BYTES) {
        results.push({ ...base, error: tooLarge(source.name) })
        continue
      }
      const dataBase64 = await io.base64Of(source)
      if (dataBase64.length > MAX_ATTACHMENT_BASE64_CHARS) {
        results.push({ ...base, error: tooLarge(source.name) })
        continue
      }
      results.push({ ...base, dataBase64 })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      results.push({
        name: source.name,
        mimeType: source.mimeType,
        previewUri: source.previewUri,
        ...(source.size === undefined ? {} : { size: source.size }),
        error: `Could not read ${source.name}: ${reason || 'unknown error'}`,
      })
    }
  }
  if (sources.length > MAX_ATTACHMENTS_PER_PICK) {
    const remaining = sources.length - MAX_ATTACHMENTS_PER_PICK
    results.push({
      name: `${remaining} more file${remaining === 1 ? '' : 's'}`,
      mimeType: 'application/octet-stream',
      previewUri: '',
      error: `Attach up to ${MAX_ATTACHMENTS_PER_PICK} files at a time.`,
    })
  }
  return results
}

export function checkedClipboardImage(dataBase64: string): PickedFile {
  const base = {
    name: 'pasted-image.png',
    mimeType: 'image/png',
    previewUri: `data:image/png;base64,${dataBase64}`,
  }
  return dataBase64.length <= MAX_ATTACHMENT_BASE64_CHARS
    ? { ...base, dataBase64 }
    : { ...base, error: tooLarge(base.name) }
}
