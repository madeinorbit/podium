import * as Clipboard from 'expo-clipboard'

/**
 * WHERE MEDIA COMES FROM, PER PLATFORM.
 *
 * The composer itself is platform-blind: it holds chips, uploads bytes and
 * prefixes paths onto the prompt. What differs is how a phone hands it a file at
 * all — a browser has a clipboard `paste` event, a drop target and a file
 * dialog; a native runtime has none of those on a text field, but it does have
 * a readable image clipboard.
 *
 * This is the NATIVE half. See `./composer-media.web.ts` for the browser half,
 * which is what the shipped `/mobile` PWA runs.
 *
 * Everything returns base64 because that is what `sessions.uploadImage` takes:
 * the bytes go to the machine that runs the session and come back as an
 * absolute path the agent can read.
 */

export interface PickedFile {
  name: string
  mimeType: string
  /** Base64 WITHOUT the `data:` prefix — the upload mutation's own shape. */
  dataBase64: string
  /** Something `<Image source>` can render while the upload is in flight, or ''
   *  when the file has no preview (a PDF, a spec, a log). */
  previewUri: string
  size?: number
}

/** A browser can open a file dialog. A native runtime, without a picker module
 *  linked in, cannot — and offering a paperclip that does nothing is worse than
 *  not offering one. */
export const canPickFiles = false

export async function pickFiles(): Promise<PickedFile[]> {
  return []
}

/**
 * No-op on native: `TextInput` reports no paste event, so there is nothing to
 * intercept. The clipboard route below is the native answer to the same need.
 */
export function onMediaPaste(_node: unknown, _handler: (files: PickedFile[]) => void): () => void {
  return () => {}
}

/** Native's one real media route: the OS image clipboard, read on an explicit
 *  press. This is what "paste a screenshot" means on a phone. */
export const canPasteMedia = true

export async function pasteMedia(): Promise<PickedFile[]> {
  if (!(await Clipboard.hasImageAsync())) return []
  const image = await Clipboard.getImageAsync({ format: 'png' })
  if (!image?.data) return []
  // `getImageAsync` answers a data URI; the upload wants the payload alone.
  const dataBase64 = image.data.includes(',') ? (image.data.split(',')[1] ?? '') : image.data
  if (!dataBase64) return []
  return [
    {
      name: 'pasted-image.png',
      mimeType: 'image/png',
      dataBase64,
      previewUri: image.data.startsWith('data:')
        ? image.data
        : `data:image/png;base64,${dataBase64}`,
    },
  ]
}
