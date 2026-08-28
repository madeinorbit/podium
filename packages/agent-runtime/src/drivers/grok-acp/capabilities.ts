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
    staging: unsupported('Grok ACP reports promptCapabilities.image=false and no file input'),
    // The driver can broker a client endpoint when a host supplies one. The
    // stdio production host currently declines it, like the Codex host.
    attach: supported({ kinds: ['client'] }),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({ includesDraft: true }),
    archive: supported({ formatVersion: 1, byteFaithful: true }),
    resumeRefTiming: 'spawn',
    placement: 'dedicated',

    draft: supported({ read: true, write: true }),
    /**
     * PERMISSION MODE ONLY, AND IMMEDIATELY (POD-3081).
     *
     * `session/set_mode` is a real RPC: it returns and the mode is different, so
     * this axis is `immediate` rather than the `next-turn` its headless
     * siblings declare.
     *
     * MODEL AND EFFORT ARE ABSENT ON PURPOSE, and the reason is stronger than
     * "no RPC for it": this driver never sends a model AT ALL. `session/new`
     * carries `cwd` and `mcpServers` and nothing else, and `session/prompt`
     * carries the prompt. There is no launch-time value for a configure to
     * replace and no per-turn field for it to ride, so accepting either field
     * could only write a number into driver state that never reaches Grok.
     * `unsupported` is the true answer and the conformance property holds us to
     * it.
     */
    configure: supported({ fields: ['permissionMode'], effective: 'immediate' }),
    usage: supported({ perTurn: true }),
    openUrl: unsupported('Grok ACP publishes no core browser-open notification'),
    title: supported({ source: 'transcript' }),
    accentColor: unsupported('Grok ACP exposes no per-session accent'),
  }
}
