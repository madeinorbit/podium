import { describe, expect, it } from 'vitest'
import {
  ORIGINAL_PHOTO_PICKER_POLICY,
  photoFallbackName,
  photoUploadMetadata,
} from './composer-photo-policy'

describe('native Photos payload policy', () => {
  it('requests current original bytes without editing or recompression', () => {
    expect(ORIGINAL_PHOTO_PICKER_POLICY).toMatchObject({
      allowsEditing: false,
      quality: 1,
      preferredAssetRepresentationMode: 'current',
    })
  })

  it('keeps a missing filename consistent with the returned MIME', () => {
    expect(photoFallbackName(0, 'image/jpeg')).toBe('photo-1.jpg')
    expect(photoFallbackName(1, 'image/heic')).toBe('photo-2.heic')
    expect(photoFallbackName(2, 'image/webp')).toBe('photo-3.webp')
    expect(photoFallbackName(3, 'image/vnd.vendor+binary')).toBe('photo-4.bin')
    expect(photoFallbackName(4, 'application/octet-stream')).toBe('photo-5.bin')
  })

  it('keeps missing picker MIME metadata neutral instead of inventing JPEG', () => {
    expect(photoUploadMetadata(0, null, null)).toEqual({
      name: 'photo-1.bin',
      mimeType: 'application/octet-stream',
    })
    expect(photoUploadMetadata(1, 'original.heic', 'image/heic')).toEqual({
      name: 'original.heic',
      mimeType: 'image/heic',
    })
  })
})
