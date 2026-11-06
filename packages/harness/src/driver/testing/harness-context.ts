/**
 * A hand-built {@link HarnessContext} for tests (POD-6533).
 *
 * The context is plain data by design, so a test that only needs a session to
 * carry one builds it here instead of standing up an inventory. The folders
 * come from the adapter's own `roots` rule over `home`, so a test that does
 * read them reads what production would for that home.
 */

import type { BuiltinHarnessKind } from '@podium/protocol'
import { type HarnessContext, harnessRoots } from '../../harness-context.js'

export function testHarnessContext(input: {
  kind: BuiltinHarnessKind
  home?: string
  executable?: string
  version?: string
  generation?: number
  env?: Readonly<Record<string, string>>
}): HarnessContext {
  const kind = input.kind
  const home = input.home ?? '/home/podium-test'
  const env = Object.freeze({ HOME: home, ...input.env })
  return Object.freeze({
    installation: Object.freeze({
      kind,
      executable: input.executable ?? `/opt/podium-test/bin/${kind}`,
      version: input.version ?? '',
      generation: input.generation ?? 0,
    }),
    home,
    env,
    roots: Object.freeze(harnessRoots(kind, home, env)),
  })
}
