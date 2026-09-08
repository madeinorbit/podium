import type { UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { updateFingerprint } from './machine-update'

// Checked by the runtime package typecheck; never executed.
export function fingerprintInputs(target: UpdateTarget, grant: UpdateGrantMessage,
  pending: Promise<UpdateTarget | undefined>): void {
  updateFingerprint('wss://coordinator.example')
  updateFingerprint(target)
  updateFingerprint(grant)
  updateFingerprint({ target, repair: true })
  // @ts-expect-error Resolve and narrow asynchronous lookups before fingerprinting.
  updateFingerprint(pending)
  // @ts-expect-error Nested target lookups must also be resolved.
  updateFingerprint({ target: pending, repair: false })
  // @ts-expect-error Arbitrary objects are not update identities.
  updateFingerprint({})
}
