/** Write the standalone installer adapter produced by the release origin module. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installerOriginPolicy } from '../packages/runtime/src/release-origins'

if (import.meta.main) {
  const path = fileURLToPath(new URL('../install.sh', import.meta.url))
  const text = readFileSync(path, 'utf8')
  writeFileSync(
    path,
    text.replace(/# BEGIN GENERATED RELEASE ORIGINS[\s\S]*?# END GENERATED RELEASE ORIGINS/, () =>
      installerOriginPolicy(),
    ),
  )
}
