import type { IssueViewModel } from '@podium/client-core/replica'
/**
 * POD-4546 (L1a) — the runtime bridge from a field citation in `schema.ts` to
 * the real definition in `@podium/model`.
 *
 * `@podium/model` declares every entity as a zod object [ADR 4], so a field
 * citation can be CHECKED rather than trusted: `Object.keys(schema.shape)` is
 * the authoritative field list at runtime. `schema.test.ts` resolves every
 * declared field through this map, which is why an invented field fails a test
 * instead of surviving as a comment.
 *
 * Kept out of `index.ts` on purpose: `schema.ts` is plain data with no
 * dependencies, and the arms must not pull zod into their bundles to read it.
 * The validator, and anyone who wants to parse a row, imports this module
 * directly.
 */

import {
  AgentRuntimeState,
  GitRepositoryWire,
  GitWorktreeWire,
  IssueDepWire,
  IssueDepProjection,
  IssueGitState,
  IssueProjection,
  IssueUserStateWire,
  IssueGitStateProjection,
  IssueDerived,
  RepoProjection,
  ResumeRef,
  SessionMeta,
  SessionOffer,
  SessionUserStateWire,
} from '@podium/model'
import type { ReplicaKind } from '@podium/client-core/replica'
import { SCHEMA, type ModelSchema, type ModelSchemaName, type RowArrival } from '@podium/client-graph/shared/schema'

/** The minimum a zod object exposes that the validator needs. */
export interface ShapeCarrier {
  readonly shape: Readonly<Record<string, unknown>>
}

/**
 * Total by construction: a `ModelSchemaName` with no entry here fails
 * typecheck, so the citation vocabulary cannot drift from the model.
 */
export const MODEL_SCHEMAS: Readonly<Record<ModelSchemaName, ShapeCarrier>> = {
  IssueUserStateWire,
  IssueGitStateProjection,
  IssueDerived,
  IssueProjection,
  IssueDepWire,
  IssueDepProjection,
  SessionMeta,
  AgentRuntimeState,
  SessionOffer,
  SessionUserStateWire,
  ResumeRef,
  RepoProjection,
  GitRepositoryWire,
  GitWorktreeWire,
  IssueGitState,
}

/** The property names a model schema actually declares. */
export function fieldsOf(name: ModelSchemaName): readonly string[] {
  return Object.keys(MODEL_SCHEMAS[name].shape)
}

// --- `replica:<kind>` arrivals name real ReplicaRows collections ------------
// Proved at typecheck time rather than in the test: `ReplicaRows` is an
// interface, so its keys exist only in the type system.

type ReplicaArrival = Extract<RowArrival, `replica:${string}`>
type KindOf<A> = A extends `replica:${infer K}` ? K : never

/** `never` unless every `replica:<kind>` arrival is a real `ReplicaKind`. */
type ArrivalsAreReplicaKinds = KindOf<ReplicaArrival> extends ReplicaKind ? true : never

export const ARRIVALS_ARE_REPLICA_KINDS: ArrivalsAreReplicaKinds = true

// ---------------------------------------------------------------------------
// Source validation
// ---------------------------------------------------------------------------

/**
 * Resolve every field citation in the schema against the real zod shape.
 *
 * Returns a finding per field that names a property `@podium/model` does not
 * declare. `schema.test.ts` asserts the list is empty and, as a negative
 * control, that a fabricated citation produces a finding.
 */
export function validateSources(schema: ModelSchema = SCHEMA): string[] {
  const problems: string[] = []
  const has = (name: ModelSchemaName, property: string) => fieldsOf(name).includes(property)

  for (const entityName of Object.keys(schema) as (keyof ModelSchema)[]) {
    const entity = schema[entityName]

    /** Every property the instance carries, once its components are composed. */
    const composed = new Map<string, string>()

    for (const [componentName, component] of Object.entries(entity.components)) {
      if (!has(component.schema, component.joinKey)) {
        problems.push(
          `${String(entityName)}.components.${componentName}: joinKey "${component.joinKey}" is not a property of ${component.schema}`,
        )
      }
      for (const excluded of Object.keys(component.notComposed ?? {})) {
        if (!has(component.schema, excluded)) {
          problems.push(
            `${String(entityName)}.components.${componentName}.notComposed: "${excluded}" is not a property of ${component.schema}`,
          )
        }
      }
      for (const property of fieldsOf(component.schema)) {
        if (property in (component.notComposed ?? {})) continue
        if (!composed.has(property)) composed.set(property, component.schema)
      }
    }

    // A relation name must not shadow a property the composed row carries,
    // even one this schema does not declare as a field: the pool holds the
    // whole row. `IssueViewModel.origin` is why the R4 relation is named
    // `discoveredFrom`.
    for (const relationName of Object.keys(entity.relations)) {
      const carrier = composed.get(relationName)
      if (carrier !== undefined) {
        problems.push(
          `${String(entityName)}.${relationName}: relation name shadows ${carrier}.${relationName}, a property of the composed row`,
        )
      }
    }

    for (const [fieldName, field] of Object.entries(entity.fields)) {
      const property = field.source.property ?? fieldName
      if (!has(field.source.schema, property)) {
        problems.push(
          `${String(entityName)}.${fieldName}: "${property}" is not a property of ${field.source.schema}`,
        )
      }
      for (const [partName, part] of Object.entries(field.parts ?? {})) {
        const partProperty = part.source.property ?? partName
        if (!has(part.source.schema, partProperty)) {
          problems.push(
            `${String(entityName)}.${fieldName}.${partName}: "${partProperty}" is not a property of ${part.source.schema}`,
          )
        }
      }
    }
  }

  return problems
}
