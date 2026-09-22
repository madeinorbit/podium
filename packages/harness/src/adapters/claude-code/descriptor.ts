/**
 * Claude Code's wire-descriptor statement (POD-4475): presentation DATA for
 * clients, beside the manifest that owns the behaviour. Browser-safe by
 * construction — literals plus a type-only import — so `@podium/harness/browser`
 * (the bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. Client capability flags are derived
 * from the manifest at generation time (scripts/harness-descriptors.ts),
 * never stated here.
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const claudeCodeDescriptor: HarnessDescriptorData = {
  kind: 'claude-code',
  provider: 'anthropic',
  label: 'Claude Code',
  shortLabel: 'Claude',
  icon: {
    id: 'claude-code',
    viewBox: '0 0 24 24',
    d: 'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z',
  },
  brand: { bg: '#d97757', fg: '#ffffff' },
  login: { command: null, installHint: null, signedOutHint: null },
  defaults: { model: null, effort: null },
}
