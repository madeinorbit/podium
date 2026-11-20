/**
 * THE WORKSPACE SCOPE CHECKER, ON PLANTED SQL [POD-6959 design 2.5, POD-7014].
 *
 * Each rule is shown passing on SQL written the way the scoped definitions write it, and failing
 * on the same SQL with the workspace term missing, under OR, or pointed at the wrong placeholder.
 * Every SQLite case is repeated in Postgres form: `$n` placeholders, `::type` casts, JSON
 * operators and `jsonb_array_elements_text` in FROM.
 */

import { describe, expect, it } from 'vitest'
import {
  type CheckedScope,
  checkWorkspaceScope,
  type ScopeCheckOptions,
  type ScopeFinding,
  type ScopeRule,
  tableReferencesOf,
} from './workspace-scope-check'

const WORKSPACE = new Set(['issues', 'labels', 'issue_labels', 'locks', 'sync_feed', 'sessions'])
const SHARED = new Set(['meta', 'server_secrets', 'conversations_fts'])
const options: ScopeCheckOptions = {
  tableKind: (table) =>
    WORKSPACE.has(table) ? 'workspace' : SHARED.has(table) ? 'shared' : undefined,
}

/**
 * Check `sql`, naming its placeholders in order. A name `ws` stands for the workspace
 * placeholder; `-` for a literal value.
 */
function check(
  sql: string,
  names: readonly string[] = [],
  scope: CheckedScope = 'workspace',
  extra: Partial<ScopeCheckOptions> = {},
): ScopeFinding[] {
  const placeholders = names.map((name) =>
    name === 'ws' ? 'workspaceId' : name === '-' ? undefined : name,
  )
  return checkWorkspaceScope({ sql, placeholders }, scope, { ...options, ...extra })
}

const rules = (findings: readonly ScopeFinding[]): ScopeRule[] =>
  findings.map((finding) => finding.rule)

describe('POD-7014 — the workspace scope checker', () => {
  describe('a single table', () => {
    it('passes a read held to the workspace placeholder (Drizzle form, nested parens)', () => {
      const sql =
        'select "repo_id", "name" from "locks" where (("locks"."workspace_id" = ?) and ("locks"."repo_id" = ?) and ("locks"."name" = ?))'
      expect(check(sql, ['ws', 'repoId', 'name'])).toEqual([])
    })

    it('fails a read with no workspace term', () => {
      const sql =
        'select "repo_id" from "locks" where ("locks"."repo_id" = ? and "locks"."name" = ?)'
      expect(rules(check(sql, ['repoId', 'name']))).toEqual(['unconstrained'])
    })

    it('fails a workspace term on a placeholder of another name, or on a literal', () => {
      const sql = 'select 1 from "locks" where "locks"."workspace_id" = ?'
      expect(rules(check(sql, ['repoId']))).toEqual(['unconstrained'])
      expect(rules(check(sql, ['-']))).toEqual(['unconstrained'])
      expect(rules(check(`select 1 from locks where workspace_id = 'local'`))).toEqual([
        'unconstrained',
      ])
    })

    it('passes an unqualified column when the scope has one table, and a placeholder on the left', () => {
      expect(check('select 1 from locks where ? = workspace_id', ['ws'])).toEqual([])
    })

    it('does not count a term under OR, under NOT, or other than an equality', () => {
      expect(
        rules(
          check('select 1 from locks where locks.workspace_id = ? or locks.name = ?', ['ws', 'n']),
        ),
      ).toEqual(['unconstrained'])
      expect(
        rules(
          check(
            'select 1 from locks where (locks.workspace_id = ? or locks.name = ?) and locks.repo_id = ?',
            ['ws', 'n', 'r'],
          ),
        ),
      ).toEqual(['unconstrained'])
      expect(
        rules(check('select 1 from locks where not (locks.workspace_id = ?)', ['ws'])),
      ).toEqual(['unconstrained'])
      expect(rules(check('select 1 from locks where locks.workspace_id >= ?', ['ws']))).toEqual([
        'unconstrained',
      ])
    })

    it('reads an AND that BETWEEN holds as part of its term', () => {
      expect(
        check(
          'select 1 from locks where locks.expires_at between ? and ? and locks.workspace_id = ?',
          ['a', 'b', 'ws'],
        ),
      ).toEqual([])
    })

    it('passes a table outside any workspace with no term, and names an unclassified table', () => {
      expect(check('select value from meta where key = ?', ['key'])).toEqual([])
      expect(rules(check('select 1 from mystery where id = ?', ['id']))).toEqual(['unknown-table'])
    })
  })

  describe('a join', () => {
    const join = (on: string, where: string) =>
      `select i.id from issues i inner join issue_labels l on ${on} where ${where}`

    it('passes when the join term links to a constrained reference', () => {
      expect(
        check(join('l.workspace_id = i.workspace_id and l.issue_id = i.id', 'i.workspace_id = ?'), [
          'ws',
        ]),
      ).toEqual([])
      // The link holds in either order, and through a chain of joins.
      expect(
        check(
          'select 1 from issues i join issue_labels il on i.workspace_id = il.workspace_id join labels l on l.workspace_id = il.workspace_id where il.workspace_id = ?',
          ['ws'],
        ),
      ).toEqual([])
    })

    it('fails the joined table when only the driving table is constrained', () => {
      const found = check(join('l.issue_id = i.id', 'i.workspace_id = ?'), ['ws'])
      expect(found.map((finding) => [finding.rule, finding.table])).toEqual([
        ['unconstrained', 'issue_labels'],
      ])
    })

    it('fails two tables linked to each other but to no placeholder', () => {
      expect(rules(check(join('l.workspace_id = i.workspace_id', 'i.id = ?'), ['id']))).toEqual([
        'unconstrained',
        'unconstrained',
      ])
    })

    it("reads a LEFT JOIN's ON as restricting only the joined side", () => {
      // The workspace term on the left table inside a LEFT JOIN's ON filters nothing of it.
      expect(
        rules(
          check(
            'select 1 from issues i left join labels l on i.workspace_id = ? and l.workspace_id = i.workspace_id',
            ['ws'],
          ),
        ),
      ).toEqual(['unconstrained', 'unconstrained'])
      expect(
        check(
          'select 1 from issues i left join labels l on l.workspace_id = i.workspace_id and l.id = i.label_id where i.workspace_id = ?',
          ['ws'],
        ),
      ).toEqual([])
    })

    it('reads comma joins and a parenthesised join', () => {
      expect(
        check(
          'select 1 from issues i, labels l where l.workspace_id = i.workspace_id and i.workspace_id = ?',
          ['ws'],
        ),
      ).toEqual([])
      expect(
        rules(
          check(
            'select 1 from (issues i join labels l on l.id = i.label_id) where i.workspace_id = ?',
            ['ws'],
          ),
        ),
      ).toEqual(['unconstrained'])
    })
  })

  describe('a correlated subquery', () => {
    it('passes an inner table linked to a constrained outer one', () => {
      expect(
        check(
          'select i.id from issues i where i.workspace_id = ? and exists (select 1 from issue_labels l where l.workspace_id = i.workspace_id and l.issue_id = i.id)',
          ['ws'],
        ),
      ).toEqual([])
    })

    it('fails an inner table with no term of its own', () => {
      const found = check(
        'select i.id, (select count(*) from issue_labels l where l.issue_id = i.id) from issues i where i.workspace_id = ?',
        ['ws'],
      )
      expect(found.map((finding) => finding.table)).toEqual(['issue_labels'])
    })

    it('fails an inner table linked to an outer one that is itself unconstrained', () => {
      expect(
        rules(
          check(
            'select 1 from issues i where i.id in (select l.issue_id from issue_labels l where l.workspace_id = i.workspace_id)',
          ),
        ),
      ).toEqual(['unconstrained', 'unconstrained'])
    })

    it('reads a subquery in a function call and a CASE', () => {
      expect(
        rules(
          check(
            'select coalesce((select max(seq) from issues where repo_id = ?), 0), case when exists (select 1 from labels) then 1 end from locks where locks.workspace_id = ?',
            ['r', 'ws'],
          ),
        ),
      ).toEqual(['unconstrained', 'unconstrained'])
    })
  })

  describe('a CTE', () => {
    it('checks the CTE body as its own scope; a CTE reference is no table', () => {
      expect(
        check(
          'with open as (select id from issues where workspace_id = ? and state = ?) select o.id from open o',
          ['ws', 'state'],
        ),
      ).toEqual([])
      expect(
        rules(
          check('with open as (select id from issues where state = ?) select id from open', [
            'state',
          ]),
        ),
      ).toEqual(['unconstrained'])
    })

    it('checks both arms of a recursive CTE', () => {
      const tree = (inner: string) =>
        `with recursive tree(id) as (select id from issues where workspace_id = ? and id = ? union all select c.id from issues c join tree on c.parent_id = tree.id${inner}) select id from tree`
      expect(check(tree(' where c.workspace_id = ?'), ['ws', 'id', 'ws'])).toEqual([])
      expect(rules(check(tree(''), ['ws', 'id']))).toEqual(['unconstrained'])
    })

    it('checks every arm of a UNION at the top', () => {
      expect(
        rules(
          check('select id from issues where workspace_id = ? union select id from labels', ['ws']),
        ),
      ).toEqual(['unconstrained'])
    })
  })

  describe('UPDATE and DELETE', () => {
    it('passes an update and a delete held to the workspace', () => {
      expect(
        check(
          'update "issues" set "title" = ? where ("issues"."workspace_id" = ? and "issues"."id" = ?)',
          ['title', 'ws', 'id'],
        ),
      ).toEqual([])
      expect(
        check('delete from "locks" where "locks"."workspace_id" = ? and "locks"."name" = ?', [
          'ws',
          'n',
        ]),
      ).toEqual([])
    })

    it('fails an update and a delete without the term', () => {
      expect(rules(check('update issues set title = ? where id = ?', ['t', 'id']))).toEqual([
        'unconstrained',
      ])
      expect(rules(check('delete from locks where name = ?', ['n']))).toEqual(['unconstrained'])
    })

    it('checks UPDATE … FROM: the target and every FROM table', () => {
      const sql = (link: string) =>
        `update issues set label_id = l.id from labels l where issues.workspace_id = ? and ${link} l.name = ?`
      expect(check(sql('l.workspace_id = issues.workspace_id and'), ['ws', 'name'])).toEqual([])
      expect(check(sql(''), ['ws', 'name']).map((finding) => finding.table)).toEqual(['labels'])
    })

    it('checks a subquery in SET', () => {
      expect(
        rules(
          check(
            'update issues set seq = (select max(seq) + 1 from issues) where workspace_id = ? and id = ?',
            ['ws', 'id'],
          ),
        ),
      ).toEqual(['unconstrained'])
    })

    it('fails an assignment to workspace_id', () => {
      expect(
        rules(
          check('update issues set workspace_id = ? where workspace_id = ? and id = ?', [
            'to',
            'ws',
            'id',
          ]),
        ),
      ).toEqual(['sets-workspace'])
    })
  })

  describe('INSERT', () => {
    it('passes VALUES rows that take workspace_id from the placeholder', () => {
      expect(
        check(
          'insert into "locks" ("workspace_id", "repo_id", "name") values (?, ?, ?), (?, ?, ?)',
          ['ws', 'r1', 'n1', 'ws', 'r2', 'n2'],
        ),
      ).toEqual([])
    })

    it('fails an insert that names no workspace_id, or takes it from elsewhere', () => {
      expect(rules(check('insert into locks (repo_id, name) values (?, ?)', ['r', 'n']))).toEqual([
        'insert-workspace',
      ])
      expect(
        rules(check(`insert into locks (workspace_id, name) values ('local', ?)`, ['n'])),
      ).toEqual(['insert-workspace'])
      expect(
        rules(
          check('insert into locks (workspace_id, name) values (?, ?), (?, ?)', [
            'ws',
            'n',
            'x',
            'n',
          ]),
        ),
      ).toEqual(['insert-workspace'])
      expect(rules(check('insert into locks default values'))).toEqual(['insert-workspace'])
      expect(
        rules(check('insert into locks select * from locks where workspace_id = ?', ['ws'])),
      ).toEqual(['insert-workspace'])
    })

    it('passes INSERT … SELECT that takes workspace_id from a constrained reference or the placeholder', () => {
      expect(
        check(
          'insert into issue_labels (workspace_id, issue_id, label_id) select l.workspace_id, ?, l.id from labels l where l.workspace_id = ? and l.name = ?',
          ['issue', 'ws', 'name'],
        ),
      ).toEqual([])
      expect(
        check(
          'insert into issue_labels (workspace_id, issue_id, label_id) select ?, ?, l.id from labels l where l.workspace_id = ? and l.name = ?',
          ['ws', 'issue', 'ws', 'name'],
        ),
      ).toEqual([])
    })

    it.each([
      '?',
      '$1',
    ])('checks aliased INSERT SELECT values without trusting their alias (%s)', (placeholder) => {
      const insert = (value: string) =>
        `insert into locks (workspace_id, name) select distinct ${value} as "workspace_id", 'name' from meta`
      expect(check(insert(placeholder), ['ws'])).toEqual([])
      expect(check(insert(`cast(${placeholder} as text)`), ['ws'])).toEqual([])
      expect(rules(check(insert("'foreign'")))).toEqual(['insert-workspace'])
      expect(rules(check(insert(placeholder), ['foreign']))).toEqual(['insert-workspace'])
      expect(rules(check(insert(`${placeholder} || ''`), ['ws']))).toEqual(['insert-workspace'])
      expect(rules(check(insert(`cast((${placeholder} || 'foreign') as text)`), ['ws']))).toEqual([
        'insert-workspace',
      ])
      expect(
        rules(
          check(
            'insert into locks (workspace_id, name) select l.workspace_id as "workspace_id", l.name from labels l',
          ),
        ),
      ).toEqual(['unconstrained', 'insert-workspace'])
    })

    it('fails INSERT … SELECT from an unconstrained reference', () => {
      expect(
        rules(
          check(
            'insert into issue_labels (workspace_id, issue_id, label_id) select l.workspace_id, ?, l.id from labels l where l.name = ?',
            ['issue', 'name'],
          ),
        ),
      ).toEqual(['unconstrained', 'insert-workspace'])
    })

    it('fails an upsert that moves the row to another workspace, and checks a subquery in VALUES', () => {
      expect(
        rules(
          check(
            'insert into locks (workspace_id, name) values (?, ?) on conflict (workspace_id, name) do update set workspace_id = excluded.workspace_id',
            ['ws', 'n'],
          ),
        ),
      ).toEqual(['sets-workspace'])
      expect(
        rules(
          check(
            'insert into locks (workspace_id, name) values (?, (select name from labels where id = ?))',
            ['ws', 'id'],
          ),
        ),
      ).toEqual(['unconstrained'])
    })
  })

  describe('ON CONFLICT targets', () => {
    const upsert = (target: string) =>
      `insert into "locks" ("workspace_id", "repo_id", "name") values (?, ?, ?) on conflict (${target}) do update set "holder" = excluded."holder"`

    it('requires the target of a workspace table to lead with workspace_id', () => {
      expect(
        check(upsert('"locks"."workspace_id", "locks"."repo_id", "locks"."name"'), [
          'ws',
          'r',
          'n',
        ]),
      ).toEqual([])
      expect(rules(check(upsert('"locks"."repo_id", "locks"."name"'), ['ws', 'r', 'n']))).toEqual([
        'conflict-target',
      ])
      // Naming the workspace somewhere is not enough: the key leads with it, so must the target.
      expect(
        rules(
          check(upsert('"locks"."repo_id", "locks"."workspace_id", "locks"."name"'), [
            'ws',
            'r',
            'n',
          ]),
        ),
      ).toEqual(['conflict-target'])
      expect(
        rules(
          check(
            'insert into sync_feed (workspace_id) values ($1) on conflict on constraint sync_feed_pkey do nothing',
            ['ws'],
          ),
        ),
      ).toEqual(['conflict-target'])
    })

    it('leaves a bare ON CONFLICT DO NOTHING alone: it names no target', () => {
      expect(
        check(
          'insert into "locks" ("workspace_id", "repo_id", "name") values (?, ?, ?) on conflict do nothing',
          ['ws', 'r', 'n'],
        ),
      ).toEqual([])
    })
  })

  describe('global and cross-workspace definitions', () => {
    it('passes a global definition on install tables only', () => {
      expect(
        check(
          'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
          ['k', 'v'],
          'global',
        ),
      ).toEqual([])
    })

    it('fails a global definition that names a workspace table anywhere, held or not', () => {
      expect(rules(check('select 1 from issues where workspace_id = ?', ['ws'], 'global'))).toEqual(
        ['global-workspace-table'],
      )
      expect(
        rules(
          check('select value from meta where key = (select id from issues limit 1)', [], 'global'),
        ),
      ).toEqual(['global-workspace-table'])
    })

    it('passes a cross-workspace SELECT, and fails one that writes', () => {
      expect(
        check('select workspace_id, count(*) from sessions group by workspace_id', [], 'across'),
      ).toEqual([])
      expect(rules(check('delete from sessions where id = ?', ['id'], 'across'))).toEqual([
        'across-write',
      ])
      // A data-modifying CTE writes too (Postgres).
      expect(
        rules(
          check(
            'with gone as (delete from sessions where id = $1 returning id) select id from gone',
            ['id'],
            'across',
          ),
        ),
      ).toEqual(['across-write'])
    })
  })

  describe('unparseable SQL fails, never passes', () => {
    it.each([
      ['unbalanced parens', 'select 1 from locks where (workspace_id = ?'],
      ['an unterminated string', "select 1 from locks where name = 'x"],
      ['not a query', 'pragma table_info(locks)'],
      ['a clause out of place', 'select 1 from locks where workspace_id = ? from issues'],
      ['an empty statement', '  ;  '],
    ])('%s', (_name, sql) => {
      expect(rules(check(sql, ['ws']))).toEqual(['unparseable'])
    })
  })

  describe('tokens the checker must not misread', () => {
    it('reads quoted names, strings and comments as such', () => {
      expect(
        check(
          `select "where", 'from issues' as label -- from issues\n from locks /* join issues */ where locks.workspace_id = ? and locks.name = 'a''b'`,
          ['ws'],
        ),
      ).toEqual([])
    })

    it('reads SQLite named placeholders by their names', () => {
      expect(
        check('select 1 from locks where workspace_id = :workspaceId and name = :name'),
      ).toEqual([])
      expect(check('select 1 from locks where workspace_id = $workspaceId')).toEqual([])
      expect(rules(check('select 1 from locks where workspace_id = :other'))).toEqual([
        'unconstrained',
      ])
    })

    it('reads json_each in FROM as a function, not a table', () => {
      expect(
        check(
          'select i.id from issues i, json_each(i.labels) j where i.workspace_id = ? and j.value = ?',
          ['ws', 'label'],
        ),
      ).toEqual([])
      expect(
        tableReferencesOf({ sql: 'select 1 from json_each(?) j', placeholders: ['ids'] }),
      ).toEqual([])
    })

    it('reads ->> and #>> as operators, not as part of a column', () => {
      expect(
        check(`select 1 from sessions s where s.workspace_id = ? and s.meta ->> 'kind' = ?`, [
          'ws',
          'k',
        ]),
      ).toEqual([])
    })
  })

  describe('the same cases in Postgres form', () => {
    it('maps $n placeholders to their names, in any order and repeated', () => {
      expect(
        check(
          'select "name" from "locks" where ("locks"."workspace_id" = $2 and "locks"."repo_id" = $1)',
          ['repoId', 'ws'],
        ),
      ).toEqual([])
      expect(
        rules(check('select 1 from locks where workspace_id = $1 and name = $2', ['name', 'ws'])),
      ).toEqual(['unconstrained'])
    })

    it('reads a ::type cast around a placeholder and CAST(… AS …)', () => {
      expect(
        check('select 1 from locks where workspace_id = $1::text and name = $2', ['ws', 'n']),
      ).toEqual([])
      expect(check('select 1 from locks where workspace_id = cast($1 as text)', ['ws'])).toEqual([])
    })

    it('a join', () => {
      const sql = (link: string) =>
        `select i.id from issues i join issue_labels l on ${link}l.issue_id = i.id where i.workspace_id = $1`
      expect(check(sql('l.workspace_id = i.workspace_id and '), ['ws'])).toEqual([])
      expect(rules(check(sql(''), ['ws']))).toEqual(['unconstrained'])
    })

    it('jsonb_array_elements_text in FROM, with a ::jsonb cast and a JSON operator', () => {
      const sql = (term: string) =>
        `select i.id from issues i, jsonb_array_elements_text($2::jsonb -> 'ids') as ids(value) where ${term}i.id = ids.value and i.payload #>> '{a,b}' = $3`
      expect(check(sql('i.workspace_id = $1 and '), ['ws', 'ids', 'v'])).toEqual([])
      expect(rules(check(sql(''), ['ws', 'ids', 'v']))).toEqual(['unconstrained'])
      expect(
        tableReferencesOf({
          sql: 'select 1 from unnest($1::text[]) as u(id), jsonb_each($2::jsonb) e',
          placeholders: ['a', 'b'],
        }),
      ).toEqual([])
    })

    it('a correlated subquery', () => {
      expect(
        check(
          'select i.id from issues i where i.workspace_id = $1 and exists (select 1 from issue_labels l where l.workspace_id = i.workspace_id and l.issue_id = i.id)',
          ['ws'],
        ),
      ).toEqual([])
      expect(
        rules(
          check(
            'select i.id from issues i where i.workspace_id = $1 and exists (select 1 from issue_labels l where l.issue_id = i.id)',
            ['ws'],
          ),
        ),
      ).toEqual(['unconstrained'])
    })

    it('a CTE', () => {
      expect(
        check(
          'with o as (select id from issues where workspace_id = $1) select id from o for update',
          ['ws'],
        ),
      ).toEqual([])
      expect(rules(check('with o as (select id from issues) select id from o', []))).toEqual([
        'unconstrained',
      ])
    })

    it('an OR', () => {
      expect(
        rules(check('select 1 from locks where workspace_id = $1 or name = $2', ['ws', 'n'])),
      ).toEqual(['unconstrained'])
    })

    it('UPDATE … FROM and DELETE … USING', () => {
      expect(
        check(
          'update issues set label_id = l.id from labels l where issues.workspace_id = $1 and l.workspace_id = issues.workspace_id and l.name = $2',
          ['ws', 'name'],
        ),
      ).toEqual([])
      expect(
        check(
          'update issues set label_id = l.id from labels l where issues.workspace_id = $1 and l.name = $2',
          ['ws', 'name'],
        ).map((finding) => finding.table),
      ).toEqual(['labels'])
      expect(
        check(
          'delete from issue_labels il using labels l where il.workspace_id = $1 and l.workspace_id = il.workspace_id and l.id = il.label_id',
          ['ws'],
        ),
      ).toEqual([])
    })

    it('INSERT … SELECT and the provisioning insert', () => {
      expect(
        check(
          'insert into issue_labels (workspace_id, issue_id, label_id) select l.workspace_id, $2, l.id from labels l where l.workspace_id = $1 returning label_id',
          ['ws', 'issue'],
        ),
      ).toEqual([])
      expect(
        check(
          'insert into sync_feed (workspace_id, feed_id) values ($1::text, $2) on conflict (workspace_id) do nothing',
          ['ws', 'feed'],
        ),
      ).toEqual([])
    })

    it('reads $$-quoted strings and the ? JSON operator', () => {
      expect(
        check(
          `select 1 from sessions where workspace_id = $1 and meta ? 'kind' and note = $$it's$$`,
          ['ws'],
        ),
      ).toEqual([])
    })
  })
})
