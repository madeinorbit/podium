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

export const USAGE =
  'usage: verify-headless-signature.ts <tarball> <signature-file-or-base64> [--pubkey <b64>]'

export type SignatureArgs =
  | { ok: true; tarball: string; signature: string; pubkey?: string }
  | { ok: false; usage: string }

/**
 * Split argv into the tarball, the signature and an optional publisher key.
 *
 * EXTRACTED AND TESTED because the inline version shipped broken and nothing caught
 * it. It filtered out `pubkeyIndex` and `pubkeyIndex + 1` unconditionally — and with
 * `--pubkey` absent `indexOf` returns -1, so `pubkeyIndex + 1` is 0 and the filter ate
 * the TARBALL. The two-argument form then exited with a usage error having verified
 * nothing, and that form is the only one the published smoke uses: the release-key
 * check behind both Mac bundles could never have run.
 *
 * Pure, so the cases are a table rather than something only a release can exercise.
 */
export function parseSignatureArgs(argv: readonly string[]): SignatureArgs {
  const rest: string[] = []
  let pubkey: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pubkey') {
      pubkey = argv[i + 1]
      if (!pubkey) return { ok: false, usage: 'usage: --pubkey needs a base64 SPKI/DER public key' }
      i++ // consume the value, and ONLY when the flag was actually present
      continue
    }
    rest.push(argv[i] as string)
  }
  const [tarball, signature] = rest
  if (!tarball || !signature) return { ok: false, usage: USAGE }
  return { ok: true, tarball, signature, ...(pubkey ? { pubkey } : {}) }
}

function main(): void {
  const parsed = parseSignatureArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.usage)
    process.exit(2)
  }
  const { tarball, signature: signatureArg, pubkey } = parsed
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

// Guarded like every other script here: without it, importing this module to TEST the
// parser executed main() against vitest's own argv and exited the worker. A script that
// cannot be imported is a script whose parsing can only be exercised by a release.
if (import.meta.main) main()
