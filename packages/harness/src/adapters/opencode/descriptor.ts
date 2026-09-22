/**
 * OpenCode's wire-descriptor statement (POD-4475): presentation DATA for
 * clients, beside the manifest that owns the behaviour. Browser-safe by
 * construction — literals plus a type-only import — so `@podium/harness/browser`
 * (the bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. Client capability flags are derived
 * from the manifest at generation time (scripts/harness-descriptors.ts),
 * never stated here.
 *
 * `defaults.panelMode: 'native'` (POD-4541) states the headed-create panel
 * intent the web "+" menu used to key on the harness name: a headed OpenCode
 * session opens on the native terminal surface. Absent for every other
 * harness (no override — today's rendering).
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const opencodeDescriptor: HarnessDescriptorData = {
  kind: 'opencode',
  provider: 'opencode',
  label: 'OpenCode',
  shortLabel: 'OpenCode',
  icon: {
    id: 'opencode',
    viewBox: '0 0 24 24',
    d: 'M16 6H8v12h8V6zm4 16H4V2h16v20z',
  },
  brand: null,
  login: {
    command: 'opencode auth login',
    installHint:
      'Install OpenCode on this machine, then run “opencode auth login”. Podium will detect it automatically.',
    signedOutHint:
      'Installed but not signed in. You can continue now and sign in before you run it.',
  },
  defaults: { model: null, effort: null, panelMode: 'native' },
}
