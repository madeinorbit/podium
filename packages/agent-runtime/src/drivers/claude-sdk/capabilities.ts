import { supported, unsupported } from '@podium/harness'
import type { DriverCapabilities } from '../../capabilities.js'

/** Capabilities of Claude's process-per-turn Agent SDK embedding. */
export function claudeSdkCapabilities(): DriverCapabilities {
  return {
    send: {
      native: ['when-ready', 'queue'],
      proof: ['sdk-callback'],
      mayReturnUnverified: false,
    },
    interrupt: { fenceOnProviderConfirmation: true },
    interactions: supported({
      kinds: ['permission'],
      source: 'sdk-callback',
      answerable: 'structured',
      atLeastOnce: false,
    }),
    observation: { watchLevels: ['coarse', 'fine'], cursorMaterial: 'sdk-event-seq' },
    transcript: supported({ history: true }),
    staging: unsupported('the Claude SDK adapter has no typed attachment channel'),
    attach: unsupported('the embedded SDK has no terminal or native client to attach'),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({ includesDraft: false }),
    archive: supported({ formatVersion: 1, byteFaithful: true }),
    resumeRefTiming: 'spawn',
    placement: 'dedicated',
    draft: unsupported('the embedded SDK has no harness-owned composer'),
    /**
     * MODEL AND EFFORT, STICKY, FROM THE NEXT TURN (POD-3081). Each turn opens
     * its own `query()` built from `spec.model`, so a write to the session's
     * policy is read by every turn after it. `permissionMode` is deliberately
     * NOT here — see `runtime.configure()` for why a permission field must not
     * be reachable through a settings verb.
     */
    configure: supported({ fields: ['model', 'effort'], effective: 'next-turn' }),
    usage: unsupported('the current SDK result mapping does not retain normalized usage'),
    openUrl: unsupported('the SDK host does not publish browser-open intents'),
    title: unsupported('the SDK host does not publish a session title'),
    accentColor: unsupported('Claude exposes no per-session accent through the SDK'),
  }
}
