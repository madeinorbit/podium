import { Platform, type ImageSourcePropType } from 'react-native'

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
  return fetch(url, {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: authenticatedAssetHeaders(bearer),
  })
}
