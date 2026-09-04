/**
 * WHERE MEDIA COMES FROM, ON THE WEB — the platform the phone app actually
 * ships on today (`/mobile`, PWA).
 *
 * Three routes into one prompt, matching what the desktop composer has had
 * since POD-405: the clipboard `paste` event, a drop on the field, and the file
 * dialog. All three land in the same place, so a screenshot from the iOS share
 * sheet, a photo dragged from Files, and a PDF picked from Drive are the same
 * kind of object by the time the composer sees them.
 *
 * IMAGES ARE NOT THE POINT, only the first case (POD-1203, same reasoning as
 * the desktop's): the harness reads an attachment by absolute path, and a path
 * to a PDF is as readable as a path to a screenshot. The only mime test here
 * decides whether a chip can show a THUMBNAIL.
 *
 * See `./composer-media.ts` for the native half.
 */
import type { PickedFile } from './composer-media-types'

export type { PickedFile } from './composer-media-types'

async function readFile(file: File): Promise<PickedFile> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('could not read the file'))
    reader.readAsDataURL(file)
  })
  const dataBase64 = dataUrl.includes(',') ? (dataUrl.split(',')[1] ?? '') : dataUrl
  return {
    name: file.name || 'pasted-file',
    mimeType: file.type || 'application/octet-stream',
    dataBase64,
    previewUri: file.type.startsWith('image/') ? dataUrl : '',
    size: file.size,
  }
}

async function readAll(files: readonly File[]): Promise<PickedFile[]> {
  const read = await Promise.allSettled(files.map(readFile))
  return read.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
}

export const canPickFiles = true

export function pickFiles(): Promise<PickedFile[]> {
  if (typeof document === 'undefined') return Promise.resolve([])
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    // `change` never fires on cancel in any browser, so the promise would hang
    // on a dismissed dialog; `cancel` is the modern signal and the focus
    // fallback catches the rest.
    const finish = (files: FileList | null) => {
      input.remove()
      void readAll(files ? Array.from(files) : []).then(resolve)
    }
    input.addEventListener('change', () => finish(input.files), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/** True when this transfer carries FILES rather than only text. Copied prose
 *  arrives as `'string'` items and must fall through to the field untouched —
 *  a paste of words is still a paste of words. */
function hasFiles(items: DataTransferItemList | undefined | null): boolean {
  if (!items) return false
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind === 'file') return true
  }
  return false
}

function filesOf(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const items = transfer.items
  if (!items) return Array.from(transfer.files ?? [])
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item?.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

/**
 * Wire the composer's own text node for paste and drop.
 *
 * The node is react-native-web's `<textarea>`: its RN ref IS the host element,
 * with RN's imperative methods hung off it (the same fact `composer-measure.web`
 * relies on). Attaching here rather than at the document keeps a paste into the
 * PROMPT distinct from a paste anywhere else on the page.
 */
export function onMediaPaste(node: unknown, handler: (files: PickedFile[]) => void): () => void {
  const el = node as HTMLElement | null
  if (!el || typeof el.addEventListener !== 'function') return () => {}

  const onPaste = (event: Event) => {
    const clipboard = (event as ClipboardEvent).clipboardData
    if (!hasFiles(clipboard?.items)) return
    event.preventDefault()
    void readAll(filesOf(clipboard)).then((files) => {
      if (files.length > 0) handler(files)
    })
  }
  const onDragOver = (event: Event) => {
    if (hasFiles((event as DragEvent).dataTransfer?.items)) event.preventDefault()
  }
  const onDrop = (event: Event) => {
    const transfer = (event as DragEvent).dataTransfer
    if (!hasFiles(transfer?.items)) return
    event.preventDefault()
    void readAll(filesOf(transfer)).then((files) => {
      if (files.length > 0) handler(files)
    })
  }

  el.addEventListener('paste', onPaste)
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('drop', onDrop)
  return () => {
    el.removeEventListener('paste', onPaste)
    el.removeEventListener('dragover', onDragOver)
    el.removeEventListener('drop', onDrop)
  }
}

/** The browser's paste event already covers this; a second "paste" control
 *  beside it would be two names for one gesture. */
export const canPasteMedia = false

export async function pasteMedia(): Promise<PickedFile[]> {
  return []
}
