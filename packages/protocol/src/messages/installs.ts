/** Managed harness controls. The machine owns every decision and reports the result. */
import { HarnessAgent } from '@podium/model'
import { z } from 'zod'

export const CAP_HARNESS_INSTALLS = 'harness.installs.v1'
export const InstallHarness = HarnessAgent
export const HarnessInstallAction = z.enum([
  'install',
  'check',
  'back',
  'pause',
  'resume',
  'take-settings',
  'remove-changes',
  'changes',
  'remove',
  'home-info',
  'remove-home',
])
export type HarnessInstallAction = z.infer<typeof HarnessInstallAction>

/** A posture edit in the person's folder, with its original value and ownership test. */
export const HarnessHomeChange = z.object({
  id: z.number().int(),
  harness: InstallHarness,
  file: z.string(),
  edit: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('json-key'), path: z.array(z.string()), value: z.unknown() }),
    z.object({ kind: z.literal('toml-array-entry'), path: z.array(z.string()), value: z.string() }),
    z.object({ kind: z.literal('owned-file'), sha256: z.string() }),
    z.object({
      kind: z.literal('hook-handlers'),
      marker: z.string(),
      events: z.array(z.string()),
    }),
  ]),
  prior: z.union([
    z.object({ absent: z.literal(true) }),
    z.object({ value: z.unknown() }),
    z.object({ contents: z.string() }),
  ]),
  serves: z.string(),
  appliedAt: z.string(),
  status: z.enum(['restored', 'changed', 'failed']).optional(),
  reason: z.string().optional(),
})
export type HarnessHomeChange = z.infer<typeof HarnessHomeChange>

const request = { requestId: z.string(), harness: InstallHarness }
const result = {
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  outcome: z.string().optional(),
  version: z.string().optional(),
  /** Releases remain pinned until the last running process exits. Homes are kept. */
  pendingSessions: z.number().int().nonnegative().optional(),
  changes: z.array(HarnessHomeChange).optional(),
  conversations: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  homeExists: z.boolean().optional(),
}

export const HarnessInstallRequestMessage = z.object({
  type: z.literal('harnessInstallRequest'),
  ...request,
})
export type HarnessInstallRequestMessage = z.infer<typeof HarnessInstallRequestMessage>
export const HarnessInstallResultMessage = z.object({
  type: z.literal('harnessInstallResult'),
  ...result,
})
export type HarnessInstallResultMessage = z.infer<typeof HarnessInstallResultMessage>
export const HarnessCheckRequestMessage = z.object({
  type: z.literal('harnessCheckRequest'),
  ...request,
})
export type HarnessCheckRequestMessage = z.infer<typeof HarnessCheckRequestMessage>
export const HarnessCheckResultMessage = z.object({
  type: z.literal('harnessCheckResult'),
  ...result,
})
export type HarnessCheckResultMessage = z.infer<typeof HarnessCheckResultMessage>
export const HarnessBackRequestMessage = z.object({
  type: z.literal('harnessBackRequest'),
  ...request,
})
export type HarnessBackRequestMessage = z.infer<typeof HarnessBackRequestMessage>
export const HarnessBackResultMessage = z.object({
  type: z.literal('harnessBackResult'),
  ...result,
})
export type HarnessBackResultMessage = z.infer<typeof HarnessBackResultMessage>
export const HarnessPauseRequestMessage = z.object({
  type: z.literal('harnessPauseRequest'),
  ...request,
})
export type HarnessPauseRequestMessage = z.infer<typeof HarnessPauseRequestMessage>
export const HarnessPauseResultMessage = z.object({
  type: z.literal('harnessPauseResult'),
  ...result,
})
export type HarnessPauseResultMessage = z.infer<typeof HarnessPauseResultMessage>
export const HarnessResumeRequestMessage = z.object({
  type: z.literal('harnessResumeRequest'),
  ...request,
})
export type HarnessResumeRequestMessage = z.infer<typeof HarnessResumeRequestMessage>
export const HarnessResumeResultMessage = z.object({
  type: z.literal('harnessResumeResult'),
  ...result,
})
export type HarnessResumeResultMessage = z.infer<typeof HarnessResumeResultMessage>
export const HarnessTakeSettingsRequestMessage = z.object({
  type: z.literal('harnessTakeSettingsRequest'),
  ...request,
})
export type HarnessTakeSettingsRequestMessage = z.infer<typeof HarnessTakeSettingsRequestMessage>
export const HarnessTakeSettingsResultMessage = z.object({
  type: z.literal('harnessTakeSettingsResult'),
  ...result,
})
export type HarnessTakeSettingsResultMessage = z.infer<typeof HarnessTakeSettingsResultMessage>
export const HarnessRemoveChangesRequestMessage = z.object({
  type: z.literal('harnessRemoveChangesRequest'),
  ...request,
})
export type HarnessRemoveChangesRequestMessage = z.infer<typeof HarnessRemoveChangesRequestMessage>
export const HarnessRemoveChangesResultMessage = z.object({
  type: z.literal('harnessRemoveChangesResult'),
  ...result,
})
export type HarnessRemoveChangesResultMessage = z.infer<typeof HarnessRemoveChangesResultMessage>
export const HarnessChangesRequestMessage = z.object({
  type: z.literal('harnessChangesRequest'),
  ...request,
})
export type HarnessChangesRequestMessage = z.infer<typeof HarnessChangesRequestMessage>
export const HarnessChangesResultMessage = z.object({
  type: z.literal('harnessChangesResult'),
  ...result,
})
export type HarnessChangesResultMessage = z.infer<typeof HarnessChangesResultMessage>
export const HarnessRemoveRequestMessage = z.object({
  type: z.literal('harnessRemoveRequest'),
  ...request,
})
export type HarnessRemoveRequestMessage = z.infer<typeof HarnessRemoveRequestMessage>
export const HarnessRemoveResultMessage = z.object({
  type: z.literal('harnessRemoveResult'),
  ...result,
})
export type HarnessRemoveResultMessage = z.infer<typeof HarnessRemoveResultMessage>

/** Shared HTTP/CLI answer; each wire action still has its own result message. */
export const HarnessActionResult = z.object(result).omit({ requestId: true })
export type HarnessActionResult = z.infer<typeof HarnessActionResult>

/** A separate destructive action: the confirmation names the conversations inspected first. */
export const HarnessHomeInfoRequestMessage = z.object({
  type: z.literal('harnessHomeInfoRequest'),
  ...request,
})
export type HarnessHomeInfoRequestMessage = z.infer<typeof HarnessHomeInfoRequestMessage>
export const HarnessHomeInfoResultMessage = z.object({
  type: z.literal('harnessHomeInfoResult'),
  ...result,
})
export type HarnessHomeInfoResultMessage = z.infer<typeof HarnessHomeInfoResultMessage>
export const HarnessHomeRemoveRequestMessage = z.object({
  type: z.literal('harnessHomeRemoveRequest'),
  ...request,
  confirmedConversations: z.array(z.string()),
})
export type HarnessHomeRemoveRequestMessage = z.infer<typeof HarnessHomeRemoveRequestMessage>
export const HarnessHomeRemoveResultMessage = z.object({
  type: z.literal('harnessHomeRemoveResult'),
  ...result,
})
export type HarnessHomeRemoveResultMessage = z.infer<typeof HarnessHomeRemoveResultMessage>
