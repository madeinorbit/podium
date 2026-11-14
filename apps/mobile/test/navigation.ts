import { vi } from 'vitest'

// Expo Router's CJS navigation barrel eagerly loads native/NavigationContainer,
// whose require('react-native') bypasses Vite's web alias and parses Flow in Node.
// Keep the real leaf helpers and contexts. Screen tests have no navigator to
// register removal guards with; MissionScreen.navigation.test.tsx supplies that
// boundary explicitly and checks the guard's callbacks.
vi.mock('expo-router/react-navigation', async () => ({
  ...(await import('expo-router/build/react-navigation/core/getFocusedRouteNameFromRoute')),
  ...(await import('expo-router/build/react-navigation/elements/Header/HeaderHeightContext')),
  ...(await import('expo-router/build/react-navigation/core/useIsFocused')),
  usePreventRemove: vi.fn(),
}))
