import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core'
import { findNodeHandle, Platform } from 'react-native'
import type { AttachmentReadSource } from './composer-media-limits'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK } from './composer-media-limits'

interface ImagePasteEvent {
  target: number
  files: AttachmentReadSource[]
}

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

/** Bind only this composer's RN input. Clipboard contents are read by the
 * native responder during the user's Paste command, never on clipboard change. */
export function onImagePaste(
  node: Parameters<typeof findNodeHandle>[0],
  handler: (files: AttachmentReadSource[]) => void,
): () => void {
  if (!nativePaste || !node) return () => {}
  const target = findNodeHandle(node)
  if (target === null) return () => {}

  const subscription = nativePaste.addListener('onImagePaste', (event) => {
    if (event.target === target) handler(event.files)
  })
  // Keep teardown after registration even when React unmounts immediately.
  const bound = nativePaste.bindInput(target, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK)
  void bound.catch((error: unknown) => console.warn('Could not enable image paste', error))
  return () => {
    subscription.remove()
    void bound
      .then(() => nativePaste.unbindInput(target))
      .catch((error: unknown) => console.warn('Could not disable image paste', error))
  }
}
