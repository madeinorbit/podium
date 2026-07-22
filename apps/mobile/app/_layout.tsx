import {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
} from '@expo-google-fonts/geist'
import {
  GeistMono_400Regular,
  GeistMono_500Medium,
  GeistMono_600SemiBold,
  GeistMono_700Bold,
} from '@expo-google-fonts/geist-mono'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { AuthGate } from '../src/client/AuthGate'
import { MobileClientProvider } from '../src/client/MobileClientProvider'
import { BootSplash } from '../src/components/BootSplash'
import { color } from '../src/theme/theme'

export default function RootLayout() {
  const [fontsLoaded, fontsError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    GeistMono_400Regular,
    GeistMono_500Medium,
    GeistMono_600SemiBold,
    GeistMono_700Bold,
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
