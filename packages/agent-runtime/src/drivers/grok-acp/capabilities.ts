import { supported, unsupported } from '@podium/harness'
import type { DriverCapabilities } from '../../capabilities.js'

export function grokAcpCapabilities(): DriverCapabilities {
  return {
    send: {
      // ACP has no steer method. A send made while a prompt is open is held in
      // the driver's durable in-memory queue and reports that downgrade.
      native: ['when-ready', 'queue', 'interrupt'],
      proof: ['protocol-ack'],
      mayReturnUnverified: false,
    },
    interrupt: { fenceOnProviderConfirmation: true },
    interactions: supported({
      kinds: ['permission'],
      source: 'protocol',
      answerable: 'structured',
      atLeastOnce: false,
    }),
    observation: {
      watchLevels: ['coarse', 'fine'],
      cursorMaterial: 'ACP _meta.eventId',
    },
    transcript: supported({ history: true }),
    // The driver can broker a client endpoint when a host supplies one. The
    // stdio production host currently declines it, like the Codex host.
    attach: supported({ kinds: ['client'] }),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({ includesDraft: true }),
    archive: supported({ formatVersion: 1, byteFaithful: true }),
    resumeRefTiming: 'spawn',
    placement: 'dedicated',

    draft: supported({ read: true, write: true }),
    configure: supported({ fields: ['permissionMode'] }),
    usage: supported({ perTurn: true }),
    openUrl: unsupported('Grok ACP publishes no core browser-open notification'),
    title: supported({ source: 'transcript' }),
    accentColor: unsupported('Grok ACP exposes no per-session accent'),
  }
}
