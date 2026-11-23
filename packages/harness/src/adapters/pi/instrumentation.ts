import { join } from 'node:path'
import type { HarnessInstrumentation, InstrumentationDestination } from '../../manifest.js'
import { piContextExtensionSource } from './context-extension.js'
import { object, PI_CONTEXT_SCHEMA, piContextVersion, text } from './context-native.js'

/** The print owner must pass false when its tool policy prohibits extensions.
 * --no-extensions alone does NOT prohibit explicit -e in Pi 1.5.0. */
export async function installPiContext(destination: InstrumentationDestination) {
  if (destination.extensionsAllowed === false) return { args: [] }
  const version = destination.harnessContext.installation.version
  if (!piContextVersion(version))
    return {
      args: [],
      degradedReason: 'Pi context extension is verified only on Pi 1.5.0',
      degradedKind: 'unsupported-version' as const,
    }
  const path = join(destination.settingsDir, `${destination.sessionId}.pi-context.mjs`)
  return {
    args: ['-e', path],
    file: { path, contents: piContextExtensionSource(destination.endpointUrl, version) },
  }
}

export const piInstrumentation: HarnessInstrumentation = {
  driverIds: ['generic-pty', 'headless'],
  scope: { kind: 'session' },
  hookTransport: 'loopback-http',
  install: installPiContext,
  payloadCodec: {
    eventName: (raw) => (object(raw)?.schema === PI_CONTEXT_SCHEMA ? 'PodiumPiContext' : undefined),
    sessionId: (raw) => text(object(raw)?.sessionId),
    transcriptPath: () => undefined,
    // Poll remains the single Pi lifecycle state source. Context is forwarded
    // opaquely before this codec; it does not manufacture agent state events.
    decode: async () => [],
  },
}
