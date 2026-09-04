import { Platform } from 'react-native'

const aliasedFaces = {
  sansRegular: 'Geist_400Regular',
  sansSemiBold: 'Geist_600SemiBold',
  monoRegular: 'GeistMono_400Regular',
  monoSemiBold: 'GeistMono_600SemiBold',
} as const

const iosFaces = {
  sansRegular: 'Geist-Regular',
  sansSemiBold: 'Geist-SemiBold',
  monoRegular: 'GeistMono-Regular',
  monoSemiBold: 'GeistMono-SemiBold',
} as const

export function fontFacesForPlatform(platform: string) {
  return platform === 'ios' ? iosFaces : aliasedFaces
}

export const fontFaces = fontFacesForPlatform(Platform.OS)
