import { supported, unsupported } from '../../../manifest.js'
import { contextCapabilityFor } from '../../../registry.js'
import type { DriverCapabilities } from '../../capabilities.js'

export function grokAcpCapabilities(): DriverCapabilities {
  return {
    context: contextCapabilityFor('grok', 'grok-acp'),
    send: {
      readiness: { kind: 'driver-managed' },
      // ACP has no steer method. A send made while a prompt is open is held in
      // the driver's durable in-memory queue and reports that downgrade.
      native: ['at-boundary', 'when-ready', 'queue', 'interrupt'],
      // Grok naming the prompt's promptId (POD-4837); and, for a message this
      // session's history already holds under that id, the entry itself.
      proof: ['protocol-ack', 'transcript-echo'],
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
    /**
     * EVERY ATTACHMENT AS ITS PATH (POD-6093). Grok ACP reports
     * `promptCapabilities.image=false` and takes no file input, so there is no
     * typed part to use; the path rides in the prompt text, which is the form
     * POD-5923 measured Grok recording as typed, and the agent opens the file
     * with its own tools.
     */
    staging: supported({ kinds: ['image', 'file'], promptForm: 'path-text' }),
    // The driver can broker a client endpoint when a host supplies one. The
    // stdio production host currently declines it, like the Codex host.
    attach: supported({ kinds: ['client'] }),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({}),
    archive: supported({ formatVersion: 1, byteFaithful: true }),
    resumeRefTiming: 'spawn',
    placement: 'dedicated',
    instrumentation: 'none',

    /** Model and effort are journalled and sent through session/set_model
     *  before each prompt. Permission mode uses session/set_mode. */
    configure: supported({ fields: ['model', 'effort', 'permissionMode'], effective: 'next-turn' }),
    usage: supported({ perTurn: true }),
    openUrl: unsupported('Grok ACP publishes no core browser-open notification'),
    title: supported({ source: 'transcript' }),
    accentColor: unsupported('Grok ACP exposes no per-session accent'),
  }
}
