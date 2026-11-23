/** Native metadata adapter; all profile policy lives in the shared accounts layer. */
import { createServerProfiles } from '@podium/client-core/accounts'
import { mobileMetadataStorage } from './mobile-metadata-storage'

export * from '@podium/client-core/accounts/server-profiles'
export const SERVER_PROFILES_KEY = 'podium.mobile.server-profiles.v1'
export const PENDING_PROFILE_CLEANUPS_KEY = 'podium.mobile.pending-profile-cleanups.v1'

const profiles = createServerProfiles({
  storage: {
    getItem: (key) => mobileMetadataStorage().getItem(key),
    setItem: (key, value) => mobileMetadataStorage().setItem(key, value),
  },
  profilesKey: SERVER_PROFILES_KEY,
  cleanupsKey: PENDING_PROFILE_CLEANUPS_KEY,
})
export const {
  loadServerProfiles,
  saveServerProfiles,
  loadPendingProfileCleanups,
  enqueuePendingProfileCleanup,
  completePendingProfileCleanup,
} = profiles
export { profiles as mobileServerProfiles }

/** Onboarding belongs to the paired server profile, across accounts and app restarts. */
const agentSetupKey = (profileId: string) =>
  `podium.mobile.agent-setup.v1:${encodeURIComponent(profileId)}`

export async function profileAgentSetupFinished(profileId: string): Promise<boolean> {
  const value = await mobileMetadataStorage().getItem(agentSetupKey(profileId))
  return value === 'completed' || value === 'skipped'
}

export async function finishProfileAgentSetup(
  profileId: string,
  outcome: 'completed' | 'skipped',
): Promise<void> {
  await mobileMetadataStorage().setItem(agentSetupKey(profileId), outcome)
}
