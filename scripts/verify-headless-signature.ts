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
 *   bun scripts/verify-headless-signature.ts <tarball> <sig> --pubkey <base64-spki-der>
 *
 * `--pubkey` exists because there is more than one legitimate publisher: production
 * releases are signed with Podium's release key, and the development host signs its own
 * dev bundles with the dev key. It is an explicit argument rather than an environment
 * variable so that nothing can weaken the published smoke by accident — that path never
 * passes it, and therefore always checks against the release key.
 *
 * Exit 0 = verified, 1 = REJECTED. Nothing else prints a green line.
 */
import { existsSync, readFileSync } from 'node:fs'
import { verifyTarball } from '../packages/runtime/src/update-delivery'

function main(): void {
  const argv = process.argv.slice(2)
  const pubkeyIndex = argv.indexOf('--pubkey')
  const pubkey = pubkeyIndex >= 0 ? argv[pubkeyIndex + 1] : undefined
  if (pubkeyIndex >= 0 && !pubkey) {
    console.error('usage: --pubkey needs a base64 SPKI/DER public key')
    process.exit(2)
  }
  const [tarball, signatureArg] = argv.filter((_, i) => i !== pubkeyIndex && i !== pubkeyIndex + 1)
  if (!tarball || !signatureArg) {
    console.error(
      'usage: verify-headless-signature.ts <tarball> <signature-file-or-base64> [--pubkey <b64>]',
    )
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
  const keyName = pubkey ? 'the supplied publisher key' : "Podium's release key"
  const bytes = new Uint8Array(readFileSync(tarball))
  if (pubkey ? !verifyTarball(bytes, signature, pubkey) : !verifyTarball(bytes, signature)) {
    console.error(
      `FAIL: ${tarball} does NOT verify under ${keyName} — ` +
        'the shipped updater would reject this artifact',
    )
    process.exit(1)
  }
  console.log(`PASS: ${tarball} verifies under ${keyName}`)
}

main()
