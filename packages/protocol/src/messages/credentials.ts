import { z } from 'zod'

/** Native single-user CLI logins Podium can explicitly copy to another owned machine. */
export const PortableCredentialKind = z.enum(['claude-code', 'claude-code-state', 'codex', 'grok'])
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
})
export const CredentialInstallResultMessage = z.object({
  type: z.literal('credentialInstallResult'),
  requestId: z.string(),
  installed: z.array(PortableCredentialKind).max(4),
  failed: z.array(PortableCredentialKind).max(4),
})
export type CredentialInstallResultMessage = z.infer<typeof CredentialInstallResultMessage>
