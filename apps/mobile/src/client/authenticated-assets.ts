import { fetch as expoFetch } from 'expo/fetch'
import { Platform, type ImageSourcePropType } from 'react-native'

export const AUTHENTICATED_TEXT_PREVIEW_CAP = 512 * 1024

const UNSAFE_PREVIEW_SIZE = 'This file is too large to preview safely on this device.'

type ByteStreamReader = {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>
  cancel(reason?: unknown): Promise<void>
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function responseReader(response: Response): ByteStreamReader | undefined {
  const body = response.body
  if (!body || typeof body.getReader !== 'function') return undefined
  return body.getReader() as ByteStreamReader
}

/**
 * Read at most `cap` bytes from a protected text response.
 *
 * Native fetch implementations do not all expose a response stream. The
 * one-shot fallback is only safe when Content-Length proves the entire body
 * fits inside the preview budget.
 */
export async function readAuthenticatedTextPreview(
  response: Response,
  cap = AUTHENTICATED_TEXT_PREVIEW_CAP,
): Promise<string> {
  const reader = responseReader(response)
  if (!reader) {
    const declaredBytes = contentLength(response)
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    if (
      declaredBytes === undefined ||
      declaredBytes > cap ||
      (contentEncoding !== undefined && contentEncoding !== 'identity')
    ) {
      throw new Error(UNSAFE_PREVIEW_SIZE)
    }
    const buffer = await response.arrayBuffer()
    return new TextDecoder().decode(buffer.slice(0, cap))
  }

  const chunks: Uint8Array[] = []
  let received = 0
  while (received < cap) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    const accepted = Math.min(value.byteLength, cap - received)
    const ownsBuffer = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    chunks.push(accepted === value.byteLength && ownsBuffer ? value : value.slice(0, accepted))
    received += accepted
  }
  if (received === cap) await reader.cancel().catch(() => undefined)
  if (chunks.length === 0) return ''
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0])

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Protected bulk routes use cookies on web and a bearer only in native. Keep
 * this split in one place so an image, thumbnail, or text fetch cannot
 * accidentally leak a native credential into the browser transport.
 */
export function authenticatedAssetHeaders(
  bearer: string | null,
): Record<string, string> | undefined {
  return Platform.OS !== 'web' && bearer ? { Authorization: `Bearer ${bearer}` } : undefined
}

export function authenticatedImageSource(url: string, bearer: string | null): ImageSourcePropType {
  const headers = authenticatedAssetHeaders(bearer)
  return headers ? { uri: url, headers } : { uri: url }
}

export function fetchAuthenticatedAsset(url: string, bearer: string | null): Promise<Response> {
  // Expo SDK 57's native response exposes a lazy stream. Importing it directly
  // keeps headerless and compressed previews bounded even if the global fetch
  // configuration changes.
  const fetchAsset = Platform.OS === 'web' ? globalThis.fetch : expoFetch
  return fetchAsset(url, {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: authenticatedAssetHeaders(bearer),
  })
}
