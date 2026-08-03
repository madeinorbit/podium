/**
 * Static, principal-free harness manifest projection for the node app.
 *
 * Keep this surface deliberately narrow: the server may resolve software
 * metadata and pure transcript mappers, but it must not gain access to launch,
 * PTY, probe, or observer APIs owned by the machine host. POD-740 owns moving
 * this projection to its final browser-safe package so the temporary package
 * boundary exception can disappear.
 */
export {
  harnessCapabilitiesFor,
  harnessDisplayName,
  harnessNeedsSubmitVerification,
  harnessObservationProvider,
  harnessPremintsHeadlessResumeId,
  harnessRequiresExclusiveInteractiveResume,
  harnessResumeKind,
  harnessSupportsCloud,
  harnessSupportsEffort,
  harnessSupportsHandoff,
  harnessSupportsInitialPrompt,
  harnessSupportsMcp,
  harnessUsesPromptTitleFallback,
  transcriptRecordMapperFor,
} from '@podium/harness/metadata'

/** Makes the temporary adapter explicit rather than disguising it as a legacy
 * app-level re-export shim in the deletion audit. */
export const SERVER_HARNESS_MANIFEST_PROJECTION = 'static-manifest-metadata' as const
