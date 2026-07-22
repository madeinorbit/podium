import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular'
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { AuthGate } from '../src/client/AuthGate'
import { MobileClientProvider } from '../src/client/MobileClientProvider'
import { BootSplash } from '../src/components/BootSplash'
import { color } from '../src/theme/theme'

export default function RootLayout() {
  // Four retained faces (POD-143): regular + semibold per family, imported by
  // direct subpath so the export bundles only these TTFs, not the barrels.
  const [fontsLoaded, fontsError] = useFonts({
    Geist_400Regular,
    Geist_600SemiBold,
    GeistMono_400Regular,
    GeistMono_600SemiBold,
  })
  // A load error falls back to system fonts; only block while still loading.
  if (!fontsLoaded && !fontsError) return <BootSplash />
  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <AuthGate>
        <MobileClientProvider>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: color.bg },
            }}
          />
        </MobileClientProvider>
      </AuthGate>
      <StatusBar style="light" />
    </View>
  )
}
