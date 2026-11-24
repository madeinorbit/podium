import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core'
import { findNodeHandle, Platform } from 'react-native'
import type { AttachmentReadSource } from './composer-media-limits'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK } from './composer-media-limits'

export type ImagePasteEvent = { target: number; pasteId: string } & (
  | { phase: 'preparing' }
  | { phase: 'ready'; files: AttachmentReadSource[] }
)

interface ComposerImagePasteModule {
  addListener: (
    event: 'onImagePaste',
    listener: (event: ImagePasteEvent) => void,
  ) => EventSubscription
  bindInput: (target: number, maxBytes: number, maxItems: number) => Promise<void>
  unbindInput: (target: number) => Promise<void>
}

const nativePaste =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<ComposerImagePasteModule>('PodiumComposerPaste')
    : null

// React can tear down and rebind the same input before native registration
// resolves. Preserve request order so an old unbind cannot clear a new binding.
let inputOperations = Promise.resolve()
function inputOperation(operation: () => Promise<void>): Promise<void> {
  const next = inputOperations.then(operation)
  inputOperations = next.catch(() => {})
  return next
}

/** Bind only this composer's RN input. Clipboard contents are read by the
 * native responder during the user's Paste command, never on clipboard change. */
export function onImagePaste(
  node: Parameters<typeof findNodeHandle>[0],
  handler: (source: () => Promise<AttachmentReadSource[]>) => void,
): () => void {
  if (!nativePaste || !node) return () => {}
  const target = findNodeHandle(node)
  if (target === null) return () => {}

  let listening = true
  const pending = new Map<string, (files: AttachmentReadSource[]) => void>()
  const subscription = nativePaste.addListener('onImagePaste', (event) => {
    if (!listening || event.target !== target) return
    if (event.phase === 'preparing') {
      if (pending.has(event.pasteId)) return
      const result = new Promise<AttachmentReadSource[]>((resolve) => {
        pending.set(event.pasteId, resolve)
      })
      handler(() => result)
    } else {
      const resolve = pending.get(event.pasteId)
      pending.delete(event.pasteId)
      resolve?.(event.files)
    }
  })
  // Keep teardown after registration even when React unmounts immediately.
  const bound = inputOperation(() =>
    nativePaste.bindInput(target, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK),
  )
  void bound.catch((error: unknown) => console.warn('Could not enable image paste', error))
  return () => {
    listening = false
    subscription.remove()
    for (const resolve of pending.values()) resolve([])
    pending.clear()
    void inputOperation(() => nativePaste.unbindInput(target)).catch((error: unknown) =>
      console.warn('Could not disable image paste', error),
    )
  }
}
