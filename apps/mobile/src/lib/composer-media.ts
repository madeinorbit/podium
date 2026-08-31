import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as ImagePicker from 'expo-image-picker'
import { ActionSheetIOS, Platform } from 'react-native'
import {
  checkedClipboardImage,
  readAttachmentsSequentially,
  type AttachmentReadSource,
} from './composer-media-limits'
import { openNativePicker } from './composer-picker-errors'
import type { PickedFile } from './composer-media-types'
import { ORIGINAL_PHOTO_PICKER_POLICY, photoUploadMetadata } from './composer-photo-policy'

export type { PickedFile } from './composer-media-types'

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

/** Native intake is a two-step system choice rather than a web-shaped file
 * dialog. The paperclip first asks for Photos or Files, then hands control to
 * the corresponding iOS picker. */
export const canPickFiles = true

async function readPicked(sources: readonly AttachmentReadSource[]): Promise<PickedFile[]> {
  return readAttachmentsSequentially(sources, {
    sizeOf: async (source) => {
      try {
        const info = await FileSystem.getInfoAsync(source.uri)
        return info.exists ? info.size : undefined
      } catch {
        // Some document providers expose readable content without metadata.
        // Treat that as unknown and enforce the encoded ceiling after reading.
        return undefined
      }
    },
    base64Of: (source) =>
      FileSystem.readAsStringAsync(source.uri, {
        encoding: FileSystem.EncodingType.Base64,
      }),
  })
}

async function pickPhotos(): Promise<PickedFile[]> {
  const assets = await openNativePicker('Photos', async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      ...ORIGINAL_PHOTO_PICKER_POLICY,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    })
    return { cancelled: result.canceled, value: result.assets }
  })
  if (!assets) return []
  return readPicked(
    assets.map((asset, index) => {
      const metadata = photoUploadMetadata(index, asset.fileName, asset.mimeType)
      return {
        uri: asset.uri,
        ...metadata,
        previewUri: asset.uri,
        ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
      }
    }),
  )
}

async function pickDocuments(): Promise<PickedFile[]> {
  const assets = await openNativePicker('Files', async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    })
    return { cancelled: result.canceled, value: result.assets }
  })
  if (!assets) return []
  return readPicked(
    assets.map((asset) => {
      const mimeType = asset.mimeType || 'application/octet-stream'
      return {
        uri: asset.uri,
        name: asset.name,
        mimeType,
        previewUri: mimeType.startsWith('image/') ? asset.uri : '',
        ...(asset.size === undefined ? {} : { size: asset.size }),
      }
    }),
  )
}

function chooseIosSource(): Promise<'photos' | 'files' | null> {
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Attach',
        options: ['Photos', 'Files', 'Cancel'],
        cancelButtonIndex: 2,
      },
      (index) => resolve(index === 0 ? 'photos' : index === 1 ? 'files' : null),
    )
  })
}

export async function pickFiles(): Promise<PickedFile[]> {
  // The first supported native release is iPhone-only. Files remains a useful
  // fallback if this module is exercised by another native runtime.
  const source = Platform.OS === 'ios' ? await chooseIosSource() : 'files'
  if (source === 'photos') return pickPhotos()
  if (source === 'files') return pickDocuments()
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
  return [checkedClipboardImage(dataBase64)]
}
