import { fetch as expoFetch } from 'expo/fetch'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { Linking } from 'react-native'
import { createHostedSignIn } from './hosted-sign-in'
const key = 'podium.mobile.hosted-sign-in.v1'
export const hostedSignIn = createHostedSignIn({
  fetch: expoFetch,
  read: () => SecureStore.getItemAsync(key),
  write: (value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  remove: () => SecureStore.deleteItemAsync(key),
  digest: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  open: (url) => Linking.openURL(url),
  now: Date.now,
})
