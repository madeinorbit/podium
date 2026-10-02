import type { AccountCredentials } from '@podium/client-core/accounts'
import { Platform } from 'react-native'
import {
  getProfileCredential,
  setProfileCredential,
  deleteProfileCredential,
} from './profile-credentials'

export const mobileAccountCredentials: AccountCredentials = {
  get delivery() {
    return Platform.OS === 'web' ? 'browser' : 'native'
  },
  get: getProfileCredential,
  set: setProfileCredential,
  remove: deleteProfileCredential,
}
