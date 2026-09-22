/**
 * Fixture's wire-descriptor statement (POD-4538): presentation DATA for the
 * test-double CLI, beside the manifest that owns its behaviour. Browser-safe
 * by construction — literals plus a type-only import — like every shipped
 * harness row. The fixture is never in AGENT_MANIFESTS, so this row never
 * reaches the served or bundled descriptors; it exists so the fixture
 * manifest satisfies the same totality the registry enforces.
 */

import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const fixtureDescriptor: HarnessDescriptorData = {
  kind: 'fixture' as BuiltinHarnessKind,
  provider: 'fixture',
  label: 'Fixture',
  shortLabel: 'Fixture',
  icon: {
    id: 'fixture',
    viewBox: '0 0 24 24',
    d: 'M4 4h16v16H4z',
  },
  brand: null,
  login: {
    command: 'fixture-agent login',
    installHint: 'Point PATH at the fixture double; there is no installer.',
    signedOutHint: null,
  },
  defaults: { model: null, effort: null },
}
