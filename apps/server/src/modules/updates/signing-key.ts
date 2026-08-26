import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'

export {
  readOrCreateUpdateSigningKey,
  rotateUpdateSigningKey,
  type UpdateSigningKey,
} from '@podium/runtime/update-signing-key'

const DEV_ARTIFACT_TOKEN_FILE_NAME = 'dev-artifact-token'

function readDevArtifactToken(path: string): string {
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error(`invalid persisted development artifact token at ${path}`)
  }
  return token
}

/**
 * Read the credential embedded in development-feed artifact URLs, or mint it
 * once in the instance state directory.
 *
 * The manifest outlives the process that wrote it, so its query credential has
 * exactly the same lifetime requirement. A malformed existing file refuses
 * startup rather than rotating every persisted artifact URL into a 401.
 */
export function readOrCreateDevArtifactToken(dir: string = stateDir()): string {
  const path = join(dir, DEV_ARTIFACT_TOKEN_FILE_NAME)
  try {
    return readDevArtifactToken(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const token = randomUUID()
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, token + '\n', { mode: 0o600, flag: 'wx' })
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readDevArtifactToken(path)
  }
}
