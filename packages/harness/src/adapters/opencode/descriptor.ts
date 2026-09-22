/**
 * OpenCode's wire-descriptor statement (POD-4475): presentation DATA for
 * clients, beside the manifest that owns the behaviour. Browser-safe by
 * construction — literals plus a type-only import — so `@podium/harness/browser`
 * (the bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. `capabilities` mirrors the manifest's
 * client subset and is held to it by the identity test, not by convention.
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const opencodeDescriptor: HarnessDescriptorData = {
  kind: 'opencode',
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
  defaults: { model: null, effort: null },
  capabilities: { argvPrompt: true, effort: true, systemPrompt: false },
}
