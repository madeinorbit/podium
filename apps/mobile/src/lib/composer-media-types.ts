export interface PickedFileBase {
  name: string
  mimeType: string
  /** Something `<Image source>` can render while the upload is in flight, or ''
   * for a file with no preview. */
  previewUri: string
  size?: number
}

export type PickedFile = PickedFileBase &
  (
    | {
        /** Base64 WITHOUT the `data:` prefix. */
        dataBase64: string
        error?: never
      }
    | {
        /** A picker/read refusal that stays visible as a removable chip. */
        error: string
        dataBase64?: never
      }
  )

export function pickedFileReady(file: PickedFile): file is PickedFile & { dataBase64: string } {
  return file.error === undefined && typeof file.dataBase64 === 'string'
}
