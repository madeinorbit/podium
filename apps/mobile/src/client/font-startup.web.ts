import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular'
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold'
import { useFonts } from 'expo-font'

/** Web still registers local font faces at runtime and keeps them in the launch gate. */
export function useLaunchFontsReady() {
  const [fontsLoaded, fontsError] = useFonts({
    Geist_400Regular,
    Geist_600SemiBold,
    GeistMono_400Regular,
    GeistMono_600SemiBold,
  })
  return fontsLoaded || fontsError != null
}
