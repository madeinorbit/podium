import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

describe('shipping train proof-authority migration', () => {
  const migrationIndex = DRIZZLE_MIGRATIONS.findIndex((migration) =>
    migration.name.endsWith('_shipping-train-proof-authority'),
  )

  it('rebuilds the manifest table without weakening dependent trigger invariants', () => {
    const db = openDatabase(':memory:')
    expect(migrationIndex).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, migrationIndex), {
      skipSchemaRepair: true,
    })

    expect(() =>
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, migrationIndex + 1), {
        skipSchemaRepair: true,
      }),
    ).not.toThrow()

    const dependentTriggers = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN (
              'ship_train_members_final_leader',
              'ship_train_active_claims_insert_guard',
              'ship_train_active_claims_release_guard'
            )
          ORDER BY name`,
      )
      .all() as { name: string }[]
    expect(dependentTriggers.map(({ name }) => name)).toEqual([
      'ship_train_active_claims_insert_guard',
      'ship_train_active_claims_release_guard',
      'ship_train_members_final_leader',
    ])

    db.prepare(
      `INSERT INTO issues
        (id, repo_path, seq, title, description, stage, parent_branch, default_agent,
         created_at, updated_at)
       VALUES ('issue-1', '/repo', 1, 'Train member', '', 'backlog', 'main',
         'claude-code', 't0', 't0')`,
    ).run()
    db.prepare(
      `INSERT INTO ship_orders
        (id, issue_id, repo_id, repo_path, machine_id, target_branch, destination,
         approved_base_sha, approved_head_sha, descendant_manifest, delivery_depends_on,
         requested_by_actor_kind, requested_by_actor_id, requested_by_on_behalf_of,
         requested_at, policy_id, validation_profile, validation_profile_digest,
         close_mode, state, state_changed_at)
       VALUES ('order-1', 'issue-1', 'repo-1', '/repo', 'machine-1', 'main', 'origin/main',
         'base', 'head', '[]', '[]', 'user', 'user:sole', 'user:sole', 't0', 'policy-1',
         '{}', 'profile-digest', 'after-destination', 'preflight', 't0')`,
    ).run()
    db.prepare(
      `INSERT INTO ship_attempts
        (id, order_id, expected_source_base_sha, approved_head_sha, expected_target_sha,
         machine_id, lease_generation, started_at, submitted_head_sha)
       VALUES ('attempt-1', 'order-1', 'base', 'head', 'target', 'machine-1', 1, 't0', 'head')`,
    ).run()
    db.prepare(
      `INSERT INTO ship_train_manifests
        (id, version, subset_id, repair_round, canonical_digest, canonical_json, repo_id,
         repo_path, machine_id, lane_key, lane_revision, target_branch, expected_target_sha,
         destination, policy_id, validation_profile, validation_profile_digest, member_count,
         leader_order_id, leader_attempt_id, leader_generation, created_at)
       VALUES ('train-1', 1, 'subset-1', 0, 'manifest-digest', '{}', 'repo-1', '/repo',
         'machine-1', 'lane-1', 1, 'main', 'target', 'origin/main', 'policy-1', '{}',
         'profile-digest', 1, 'order-1', 'attempt-1', 1, 't0')`,
    ).run()

    expect(() =>
      db
        .prepare(
          `INSERT INTO ship_train_members
            (train_id, ordinal, issue_id, order_id, attempt_id, generation, machine_id,
             source_branch, approved_base_sha, approved_head_sha, delivery_depends_on)
           VALUES ('train-1', 0, 'issue-1', 'order-1', 'attempt-1', 2, 'machine-1',
             'feature', 'base', 'head', '[]')`,
        )
        .run(),
    ).toThrow(/final member must be its leader/)

    db.close()
  })
})
