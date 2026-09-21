/**
 * `packages/harness/src/adapter.ts` — THE ADAPTER TYPE (POD-4469, spec §4.5).
 *
 * One package, one authoritative definition: everything Podium knows about a
 * harness is read through this type's sections, and every mechanism receives a
 * narrow typed SUBSET of sections, never the whole adapter (spec §5 rules).
 *
 * In this issue the adapter shape IS the manifest: `AgentManifest` carries
 * launch, exec, headless, state, discovery and transcript knowledge per CLI,
 * and the registry (`AGENT_MANIFESTS`) is the one enumeration with the
 * totality check. Later phases split per-harness sections out of
 * `adapters/<harness>/` (transcript, discovery, inventory, credentials, usage,
 * install, descriptor, catalog, composer) and narrow each mechanism's reader to
 * its subset — this module is where that type lands, so import the adapter
 * from here, not from `./manifest.js` directly.
 */

export type { AgentManifest } from './manifest.js'
