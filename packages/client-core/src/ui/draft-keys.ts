/** Device-authored documents, separate from the preferences saved beside them. */
export const DEVICE_AUTHORED_DRAFT_KEYS = new Set([
  'podium.drafts.v1',
  'podium.githubProjectIntake.draft',
  'podium.localProjectIntake.draft',
  'podium.existingPodium.clientDraft',
  'podium.existingPodium.machineDraft',
  'podium.onboarding.vpsServerDraft',
  'podium.firstTaskActivation.draft',
])

export const DEVICE_DRAFT_KEYS = new Set([
  ...DEVICE_AUTHORED_DRAFT_KEYS,
  'podium.newWork.model',
  'podium.newWork.effort',
  'podium.newWork.machine',
  'podium.newWork.repo',
  'podium.onboarding.active',
])
