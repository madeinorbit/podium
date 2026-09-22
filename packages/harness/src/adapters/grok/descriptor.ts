/**
 * Grok's wire-descriptor statement (POD-4475): presentation DATA for
 * clients, beside the manifest that owns the behaviour. Browser-safe by
 * construction — literals plus a type-only import — so `@podium/harness/browser`
 * (the bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. Client capability flags are derived
 * from the manifest at generation time (scripts/harness-descriptors.ts),
 * never stated here.
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const grokDescriptor: HarnessDescriptorData = {
  kind: 'grok',
  provider: 'xai',
  label: 'Grok',
  shortLabel: 'Grok',
  icon: {
    id: 'grok',
    viewBox: '0 0 24 24',
    d: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815',
  },
  brand: { bg: '#ffffff', fg: '#09090b' },
  login: { command: null, installHint: null, signedOutHint: null },
  defaults: { model: null, effort: null },
}
