import {
  FeedChange,
  MetadataChange,
  type MetadataEntityKind,
  type SyncKindTokens,
  schemaDigest,
} from '@podium/protocol'
import type { SyncRepository } from '@podium/sync'
import { DATABASE_ONLY_BUILDERS } from './record-builders'

// Change the salt when a kind's published meaning changes without a schema
// change. A data migration that rewrites a kind instead increments its
// generation in the same migration:
// INSERT INTO sync_kind (tenant_id, kind, generation) VALUES ('local', 'example', 1)
// ON CONFLICT (tenant_id, kind) DO UPDATE SET generation = sync_kind.generation + 1;
const salts: Partial<Record<MetadataEntityKind, string>> = {}

// The scoped feed has its own schema for some kinds. Other kinds use the
// opaque arm of the feed envelope and publish the value from MetadataChange.
const schemas = new Map(
  [...MetadataChange.options, ...FeedChange.options].map(
    (arm) => [arm.shape.entity.value, arm.shape.value] as const,
  ),
)
const kinds = DATABASE_ONLY_BUILDERS.map(({ kind }) => kind)
const digests = kinds.map((kind) => {
  const schema = schemas.get(kind)
  if (!schema) throw new Error(`No wire schema for sync kind ${kind}`)
  return schemaDigest(schema, salts[kind] ?? '')
})

export async function readKindTokens(sync: SyncRepository): Promise<SyncKindTokens> {
  const generations = new Map(
    (await sync.readKindGenerations()).map(({ kind, generation }) => [kind, generation]),
  )
  return Object.fromEntries(
    kinds.map((kind, index) => [kind, `${digests[index]}:${generations.get(kind) ?? 0}`]),
  )
}
