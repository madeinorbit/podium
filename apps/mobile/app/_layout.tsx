import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { AuthGate } from '../src/client/AuthGate'
import { MobileClientProvider } from '../src/client/MobileClientProvider'
import { color } from '../src/theme/theme'

export default function RootLayout() {
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
