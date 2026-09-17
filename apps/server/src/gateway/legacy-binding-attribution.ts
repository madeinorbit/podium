import { asAgentIdentityId, asUserId, type UserId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'

/**
 * Single-member compatibility only: session owner equals delegating member.
 * Remove this ingress shim in the release that raises MIN_SUPPORTED_VERSION
 * above 2 (packages/protocol/src/version.ts). Track B server-authored delegation
 * supersedes this equivalence before multi-member operation.
 * Build metadata is irrelevant: only typed retired identity fields are mapped.
 */
export async function mapLegacyBindingAttribution(
  msg: DaemonMessage,
  readMapping: () => Promise<UserId | null>,
): Promise<DaemonMessage> {
  if (msg.type !== 'handoffExportResult') return msg
  const manifest = msg.manifest?.format === 2 ? msg.manifest : undefined
  const delegation = msg.binding?.delegation
  const by = manifest?.exported.by
  if (
    manifest?.owner !== 'user:sole' &&
    by?.onBehalfOf !== 'user:sole' &&
    !(by?.actor.kind === 'user' && by.actor.id === 'user:sole') &&
    delegation?.onBehalfOf !== 'user:sole' &&
    delegation?.actor !== 'user:sole'
  )
    return msg
  const member = await readMapping()
  if (!member || member === 'user:sole') throw new Error('retired member mapping unavailable')
  return {
    ...msg,
    ...(manifest
      ? {
          manifest: {
            ...manifest,
            owner: manifest.owner === 'user:sole' ? member : manifest.owner,
            exported: {
              ...manifest.exported,
              by: {
                ...manifest.exported.by,
                onBehalfOf:
                  by?.onBehalfOf === 'user:sole' ? member : manifest.exported.by.onBehalfOf,
                actor:
                  by?.actor.kind === 'user' && by.actor.id === 'user:sole'
                    ? { kind: 'user', id: asUserId(member) }
                    : manifest.exported.by.actor,
              },
            },
          },
        }
      : {}),
    ...(msg.binding && delegation
      ? {
          binding: {
            ...msg.binding,
            delegation: {
              ...delegation,
              onBehalfOf: delegation.onBehalfOf === 'user:sole' ? member : delegation.onBehalfOf,
              actor:
                delegation.actor === 'user:sole' ? asAgentIdentityId(member) : delegation.actor,
            },
          },
        }
      : {}),
  }
}
