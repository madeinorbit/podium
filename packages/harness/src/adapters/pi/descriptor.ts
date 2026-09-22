/**
 * Pi's wire-descriptor statement (POD-4475): presentation DATA for clients,
 * beside the manifest that owns the behaviour. Browser-safe by construction
 * — literals plus a type-only import — so `@podium/harness/browser` (the
 * bundled fallback) and the served builder read the SAME row and web and
 * mobile never keep a second copy. `capabilities` mirrors the manifest's
 * client subset and is held to it by the identity test, not by convention.
 *
 * Pi has no published brand mark: the π glyph (the desktop's PiIcon path,
 * verbatim) in the surrounding tone.
 */

import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const piDescriptor: HarnessDescriptorData = {
  kind: 'pi',
  label: 'Pi',
  shortLabel: 'Pi',
  icon: {
    id: 'pi',
    viewBox: '0 0 24 24',
    d: 'M3.5 5.5h17V8h-2.75v10.5h-2.5V8h-6.5v10.5h-2.5V8H3.5z',
  },
  brand: null,
  login: {
    command: 'pi',
    installHint:
      'Install Pi on this machine, then run “pi” and sign in with its /login command. Podium will detect it automatically.',
    signedOutHint: null,
  },
  defaults: { model: null, effort: null },
  capabilities: { argvPrompt: true, effort: true, systemPrompt: true },
}
