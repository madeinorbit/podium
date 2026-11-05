import { PORTABLE_CREDENTIAL_HARNESS_KINDS } from '@podium/model'
import { z } from 'zod'

/** The peer enforces the expected native login identity at export AND install,
 * including preservation of different expired/unknown logins. Old peers may
 * ignore additive fields, so they must not receive an identity-bound transfer. */
export const CAP_CREDENTIAL_IDENTITY_GUARD = 'credential.identity-guard.v1'

/**
 * Native single-user CLI logins Podium can explicitly copy to another owned machine.
 *
 * Derived from {@link PORTABLE_CREDENTIAL_HARNESS_KINDS}: the harness members
 * come from the closed set, and `'claude-code-state'` — a bundle name, not a
 * harness — stays local here. Same members, same order, same wire.
 */
export const PortableCredentialKind = z.enum([
  PORTABLE_CREDENTIAL_HARNESS_KINDS[0],
  'claude-code-state',
  PORTABLE_CREDENTIAL_HARNESS_KINDS[1],
  PORTABLE_CREDENTIAL_HARNESS_KINDS[2],
] as const)
export type PortableCredentialKind = z.infer<typeof PortableCredentialKind>

// A native auth file is tiny in practice. The hard cap bounds both websocket
// memory and disk writes if a compromised daemon sends hostile input.
export const PortableCredentialBundle = z.object({
  kind: PortableCredentialKind,
  contentBase64: z.string().max(1_500_000),
})
export type PortableCredentialBundle = z.infer<typeof PortableCredentialBundle>

export const CredentialExportRequestMessage = z.object({
  type: z.literal('credentialExportRequest'),
  requestId: z.string(),
  kinds: z.array(PortableCredentialKind).max(4),
  /** Server-only native login propagation; absent keeps legacy pairing behavior. */
  propagation: z.boolean().optional(),
  /**
   * The identity fingerprint of the login the server means to copy (POD-6301).
   * A daemon whose login has a different (or unknown) identity exports nothing:
   * the D11 choice belongs to that one account, not to whatever is there now.
   */
  expectedFingerprint: z.string().min(1).max(256).optional(),
})
export const CredentialExportResultMessage = z.object({
  type: z.literal('credentialExportResult'),
  requestId: z.string(),
  bundles: z.array(PortableCredentialBundle).max(4),
  unavailable: z.array(PortableCredentialKind).max(4),
})
export type CredentialExportResultMessage = z.infer<typeof CredentialExportResultMessage>

export const CredentialInstallRequestMessage = z.object({
  type: z.literal('credentialInstallRequest'),
  requestId: z.string(),
  bundles: z.array(PortableCredentialBundle).max(4),
  /** Server-only native login propagation; absent keeps legacy pairing behavior. */
  propagation: z.boolean().optional(),
  /**
   * The identity fingerprint of the login being installed (POD-6301). A
   * destination already holding a login of a different or unknown identity
   * keeps it and reports the kind under `preserved`.
   */
  expectedFingerprint: z.string().min(1).max(256).optional(),
})
export const CredentialInstallResultMessage = z.object({
  type: z.literal('credentialInstallResult'),
  requestId: z.string(),
  installed: z.array(PortableCredentialKind).max(4),
  failed: z.array(PortableCredentialKind).max(4),
  /** Not installed because the destination holds a different login, which
   *  stays in place (POD-6301). Also listed under `failed` for older servers. */
  preserved: z.array(PortableCredentialKind).max(4).optional(),
})
export type CredentialInstallResultMessage = z.infer<typeof CredentialInstallResultMessage>
