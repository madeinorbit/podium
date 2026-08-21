/**
 * Verify a headless tarball's Ed25519 update signature against Podium's release key.
 *
 * This exists for the platforms CI cannot EXECUTE. The linux-x86_64 leg of the
 * published smoke proves its signature the strongest way there is — by running the
 * shipped updater against the real artifact — but a Linux runner cannot run a Darwin
 * binary, so the Darwin bundles would otherwise ship with nothing checking that their
 * signatures are the ones `podium update` will demand on a Mac.
 *
 * It calls `verifyTarball` from packages/runtime rather than re-implementing the check:
 * a verifier that agrees with itself but not with the shipped updater is worse than no
 * verifier, because it reads as a pass.
 *
 *   bun scripts/verify-headless-signature.ts <tarball> <signature-file-or-base64>
 *
 * Exit 0 = verified, 1 = REJECTED. Nothing else prints a green line.
 */
import { existsSync, readFileSync } from 'node:fs'
import { verifyTarball } from '../packages/runtime/src/update-delivery'

function main(): void {
  const [tarball, signatureArg] = process.argv.slice(2)
  if (!tarball || !signatureArg) {
    console.error('usage: verify-headless-signature.ts <tarball> <signature-file-or-base64>')
    process.exit(2)
  }
  if (!existsSync(tarball)) {
    console.error(`FAIL: no such tarball ${tarball}`)
    process.exit(1)
  }
  // A path is read; anything else is taken as the base64 signature itself, which is the
  // form a manifest carries it in.
  const signature = (
    existsSync(signatureArg) ? readFileSync(signatureArg, 'utf8') : signatureArg
  ).trim()
  if (!signature) {
    console.error(`FAIL: empty signature for ${tarball}`)
    process.exit(1)
  }
  if (!verifyTarball(new Uint8Array(readFileSync(tarball)), signature)) {
    console.error(
      `FAIL: ${tarball} does NOT verify under Podium's release key — ` +
        'the shipped updater would reject this artifact',
    )
    process.exit(1)
  }
  console.log(`PASS: ${tarball} verifies under Podium's release key`)
}

main()
