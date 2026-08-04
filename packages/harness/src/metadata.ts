/**
 * `@podium/harness/metadata` — THE OPEN ENTRYPOINT (POD-335, retiring legacy
 * rule 2 `agent-host-consumers`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Importing `@podium/harness` means taking a HOST CAPABILITY: the manifests it
 * exports launch processes, drive PTYs, probe binaries and observe native state.
 * The architecture manifest restricts that package's consumers to the machine
 * host (`apps/daemon`) and the build tier, and `manifest-consumers` enforces it.
 *
 * But four `apps/server` files never wanted the capability. They wanted STATIC
 * SOFTWARE METADATA — a display name, a capability descriptor, a pure transcript
 * mapper, two prompt-pointer constants, a protocol-level causal state machine,
 * and the answer to "is this CLI logged in". A whole-package ban could not tell
 * those from a call to `launch()`, so all four sat in
 * `scripts/boundary-allowlist.ts` as debt no one could pay without moving
 * modules between packages. This module is the alternative the allowlist note
 * asked for: make the boundary PRECISE rather than merely strict.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY EXPORT IS NAMED, AND WHY THAT IS THE ENFORCED PROPERTY
 * ---------------------------------------------------------------------------
 *
 * There is no `export *` here and there may never be one:
 * `manifest-open-entrypoint` (scripts/check-boundaries.ts) fails the build on a
 * star re-export from a declared open entrypoint, and on any export whose name
 * matches the process-driving vocabulary (launch/spawn/exec/probe/attach/kill/…).
 *
 * That is the load-bearing choice. A closure check — the shape rules 8b and 12b
 * use — cannot help here: these functions read `AGENT_MANIFESTS`, and the
 * manifests' own closure legitimately reaches `node:child_process`, so a
 * transitive walk would refuse the whole surface and prove nothing about it.
 * What CAN be proved is that the surface is ENUMERABLE: an explicit named list
 * cannot widen without someone editing this file, which is precisely the review
 * checkpoint the exception exists to force. Stated rather than implied, because
 * a limitation nobody wrote down is a limitation somebody will later mistake for
 * a guarantee.
 *
 * ADDING AN EXPORT HERE IS A DECISION with the same bar as the ones below: it
 * must be a FACT ABOUT SOFTWARE ("what is this CLI, what can it do, what did it
 * write"), never an ACTION ON A HOST. If a call site seems to need an action,
 * it belongs on `apps/daemon`, which is what the machine host is.
 */

// The observation-ledger causal state machine (cursor succession, binding
// version, terminal fence). Harness-AGNOSTIC — its only imports are types from
// `@podium/protocol` — and merely FILED in this package; the boundary-allowlist
// entry it replaces said exactly that.
export { acceptAgentObservation } from './agent-state/causal.js'

// Two prompt-pointer string constants. Data the server renders into agent
// prompts; they name no process and reach no host.
export { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from './issue-system-pointer.js'
// Types only. Erased at build, so they carry nothing at all; listed rather than
// starred for the same reason as everything above.
export type {
  HarnessCapabilities,
  HarnessLogin,
  LoginIdentity,
  PortableCredential,
} from './manifest.js'
// Static per-CLI facts. Each resolves through `manifestFor`, which returns
// `undefined` for a harness this build has never heard of rather than
// substituting another CLI's row.
export {
  harnessCapabilitiesFor,
  harnessDetectLogin,
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
} from './registry.js'
