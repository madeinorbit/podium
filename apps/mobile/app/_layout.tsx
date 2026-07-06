import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { MobileClientProvider } from '../src/client/MobileClientProvider'

export default function RootLayout() {
  return (
    <MobileClientProvider>
      <View style={{ flex: 1, backgroundColor: '#101114' }}>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="light" />
      </View>
    </MobileClientProvider>
  )
}
