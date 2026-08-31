import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as ImagePicker from 'expo-image-picker'
import { ActionSheetIOS, Platform } from 'react-native'

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

/** Native intake is a two-step system choice rather than a web-shaped file
 * dialog. The paperclip first asks for Photos or Files, then hands control to
 * the corresponding iOS picker. */
export const canPickFiles = true

async function readUri(
  uri: string,
  name: string,
  mimeType: string | null | undefined,
  size?: number,
): Promise<PickedFile> {
  const type = mimeType || 'application/octet-stream'
  return {
    name,
    mimeType: type,
    dataBase64: await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    }),
    previewUri: type.startsWith('image/') ? uri : '',
    ...(size === undefined ? {} : { size }),
  }
}

async function pickPhotos(): Promise<PickedFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 0.85,
  })
  if (result.canceled) return []
  return Promise.all(
    result.assets.map(async (asset, index) => {
      const mimeType = asset.mimeType || 'image/jpeg'
      const dataBase64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      })
      return {
        name: asset.fileName || `photo-${index + 1}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
        mimeType,
        dataBase64,
        previewUri: asset.uri,
        ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
      }
    }),
  )
}

async function pickDocuments(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  })
  if (result.canceled) return []
  return Promise.all(
    result.assets.map((asset) =>
      readUri(asset.uri, asset.name, asset.mimeType, asset.size),
    ),
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
