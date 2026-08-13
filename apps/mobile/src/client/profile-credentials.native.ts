import * as SecureStore from 'expo-secure-store'
import { mobileMetadataStorage } from './mobile-metadata-storage'

const CREDENTIAL_PROFILE_IDS_KEY = 'podium.mobile.credential-profile-ids.v1'

function key(profileId: string): string {
  // SecureStore keys accept only alphanumerics plus '.', '-' and '_'. Runtime
  // URL overrides deliberately never reach this function.
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(profileId)) {
    throw new Error('invalid secure profile id')
  }
  return `podium.mobile.profile.${profileId}.bearer.v1`
}

async function registeredIds(): Promise<string[]> {
  const raw = await mobileMetadataStorage().getItem(CREDENTIAL_PROFILE_IDS_KEY)
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id))
      : []
  } catch {
    return []
  }
}

async function saveRegisteredIds(ids: string[]): Promise<void> {
  await mobileMetadataStorage().setItem(
    CREDENTIAL_PROFILE_IDS_KEY,
    JSON.stringify([...new Set(ids)]),
  )
}

export function getProfileCredential(profileId: string): Promise<string | null> {
  return SecureStore.getItemAsync(key(profileId))
}

export async function setProfileCredential(profileId: string, bearer: string): Promise<void> {
  const secureKey = key(profileId)
  const previous = await SecureStore.getItemAsync(secureKey)
  const idsBefore = await registeredIds()
  const wasRegistered = idsBefore.includes(profileId)
  if (!wasRegistered) {
    // Write-ahead journal: an extra id with no secret is harmless and purgeable;
    // a secret whose id was never recorded is not recoverable.
    await saveRegisteredIds([...idsBefore, profileId])
  }
  try {
    await SecureStore.setItemAsync(secureKey, bearer, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  } catch (cause) {
    let secureRollbackSucceeded = false
    try {
      if (previous !== null) {
        await SecureStore.setItemAsync(secureKey, previous, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        })
      } else {
        await SecureStore.deleteItemAsync(secureKey)
      }
      secureRollbackSucceeded = true
    } catch {
      // Keep the write-ahead id. The SecureStore write may have partially
      // landed, so removing its only enumerable pointer would create an orphan.
    }
    if (secureRollbackSucceeded && previous === null && !wasRegistered) {
      // Registry compensation is best-effort. Failure leaves only a harmless,
      // purgeable id, never an unenumerable credential.
      await saveRegisteredIds(idsBefore).catch(() => {})
    }
    throw cause
  }
}

export async function deleteProfileCredential(profileId: string): Promise<void> {
  await SecureStore.deleteItemAsync(key(profileId))
  const ids = await registeredIds()
  await saveRegisteredIds(ids.filter((id) => id !== profileId))
}

/** Purge credentials whose profile metadata is missing or failed validation. */
export async function purgeOrphanedProfileCredentials(validProfileIds: string[]): Promise<void> {
  const valid = new Set(validProfileIds)
  const ids = await registeredIds()
  const orphaned = ids.filter((id) => !valid.has(id))
  await Promise.all(orphaned.map((id) => SecureStore.deleteItemAsync(key(id))))
  await saveRegisteredIds(ids.filter((id) => valid.has(id)))
}
