/**
 * Cursor's wire-descriptor statement (POD-4475): presentation DATA for
 * clients, beside the manifest that owns the behaviour. Browser-safe by
 * construction — literals plus a type-only import — so `@podium/harness/browser`
 * (the bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. Client capability flags are derived
 * from the manifest at generation time (scripts/harness-descriptors.ts),
 * never stated here.
 *
 * Cursor has no effort flag and no argv prompt: effort rides the model
 * string and the first prompt travels the durable outbox.
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const cursorDescriptor: HarnessDescriptorData = {
  kind: 'cursor',
  label: 'Cursor',
  shortLabel: 'Cursor',
  icon: {
    id: 'cursor',
    viewBox: '0 0 24 24',
    d: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
  },
  brand: null,
  login: {
    command: 'cursor-agent login',
    installHint:
      'Install the Cursor CLI on this machine, then run “cursor-agent login”. Podium will detect it automatically.',
    signedOutHint: null,
  },
  defaults: { model: null, effort: null },
}
