/**
 * SUBSTITUTE THE TRUST ROOT INSIDE A REAL PUBLISHED BINARY, AND PROVE IT IS THE
 * ONLY THING THAT MOVED.
 *
 * The real-release row upgrades an actual published 0.1.0 install. That install
 * verifies every artifact against `PODIUM_UPDATE_PUBKEY`, which v0.1.0 bakes as a
 * module constant with NO environment override — so the only artifacts it will
 * ever install are ones signed by the production release key, which no test has
 * and none should. The row therefore has to re-anchor the published binary onto
 * a run-local key.
 *
 * Every other way of getting there rebuilds something, and rebuilding is exactly
 * what the row exists to stop doing: the whole point is that the OLD code, as it
 * was actually shipped, performs the first hop. So this does the smallest
 * possible thing instead — an in-place substitution of one base64 constant.
 *
 * WHY THAT IS SAFE TO DO IN PLACE: an Ed25519 SPKI DER is 44 bytes, so its base64
 * is always 60 characters. Old and new are the same length, the file size does not
 * change, and no offset inside the binary moves.
 *
 * WHY IT IS HONEST: the substitution is refused unless the constant appears EXACTLY
 * once, and the report names how many bytes actually differ. The caller asserts on
 * that number. A change to anything but the trust root shows up as a byte count
 * nobody expected, which is the difference between a stated deviation and an
 * unstated one.
 *
 * The deviation this leaves in the row is one constant: which key the install
 * trusts. It is not a statement about migration, topology, schema, or the shape of
 * the units — the four things the row is actually asserting on.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [target, oldKey, newKey] = process.argv.slice(2)
if (!target || !oldKey || !newKey) {
  throw new Error('usage: patch-trust-root.ts <binary> <old-pubkey-b64> <new-pubkey-b64>')
}
if (oldKey.length !== newKey.length) {
  throw new Error(
    `trust roots differ in length (${oldKey.length} vs ${newKey.length}); an in-place ` +
      'substitution would move every offset after it',
  )
}

const before = readFileSync(target)
const oldBytes = Buffer.from(oldKey, 'binary')
const newBytes = Buffer.from(newKey, 'binary')

let occurrences = 0
let at = before.indexOf(oldBytes)
let first = -1
while (at !== -1) {
  if (first === -1) first = at
  occurrences++
  at = before.indexOf(oldBytes, at + 1)
}
if (occurrences !== 1) {
  throw new Error(
    `expected the trust root exactly once in ${target}, found ${occurrences}. Refusing: a ` +
      'substitution that cannot name its one site cannot claim to have changed only that site.',
  )
}

const after = Buffer.from(before)
newBytes.copy(after, first)

let changed = 0
for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++

writeFileSync(target, after)
console.log(
  JSON.stringify({
    bytes: after.length,
    sizeUnchanged: after.length === before.length,
    occurrences,
    offset: first,
    changedBytes: changed,
    // Every differing byte must sit inside the constant itself.
    changedInsideConstant: changed <= oldKey.length,
  }),
)
