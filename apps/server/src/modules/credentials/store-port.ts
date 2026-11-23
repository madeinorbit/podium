/**
 * What the credential family reads of a workspace's store, named. Its own module so
 * a reader of credential refs (the issue service) does not import the command family,
 * and with it the composed application (`scripts/server-test-shards.ts`).
 */
import type { SessionStore } from '../../store'

export type CredentialsStore = Pick<
  SessionStore,
  'credentials' | 'vault' | 'grants' | 'users' | 'machines' | 'settingsAudit' | 'secrets'
>
