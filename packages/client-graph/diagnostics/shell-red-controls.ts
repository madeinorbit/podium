/** Plant production-reader faults in the isolated flatblock checkout, one at
 * a time. Restore the original bytes even when an assertion or lane fails. */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { resolve } from 'node:path'

if (hostname() !== 'flatblock' || process.cwd() !== resolve(homedir(), 'podium-test-5162')) throw new Error('Use the isolated flatblock checkout')
const views = 'packages/client-graph/src/shell-views.ts'
const controls = [
  ['window', 'packages/client-graph/src/shell-source.ts', 'selectedWorktree, reposLoaded, superOpen, paletteOpen, autoContinuePromptSessionId, coarseNow })', 'selectedWorktree, reposLoaded, superOpen, paletteOpen: !paletteOpen, autoContinuePromptSessionId, coarseNow })'],
  ['approvals', views, "records('shellApproval', keys.approvals)", "records('shellApproval', [...keys.approvals].reverse())"],
  ['files', views, 'if (value) values.push(value)', "if (value) values.push(entity === 'shellFile' ? { ...value, path: 'planted-file' } : value)"],
  ['close', views, 'workspaceKey: key, layout, fileTabs', "workspaceKey: 'planted-workspace', layout, fileTabs"],
  ['chrome', views, 'repoCount: repos.length', 'repoCount: repos.length + 1'],
  ['dock', views, 'mailIssueId: crew?.find', "mailIssueId: 'planted-mail' || crew?.find"],
  ['shipping', views, "decisionCount: scoped.filter(order => order.humanState === 'needs_you').length", "decisionCount: 1 + scoped.filter(order => order.humanState === 'needs_you').length"],
  ['orders', views, 'issues: tasks ?? [], shipOrders, shipLanes:', 'issues: tasks ?? [], shipOrders: [...shipOrders].reverse(), shipLanes:'],
  ['lanes', views, 'if (value) values.push(value)', "if (value) values.push(entity === 'shellShipLane' ? { ...value, destination: 'planted-destination' } : value)"],
  ['machines', views, 'return value ? [value] : []\n    }))\n  }\n  function worktrees', "return value ? [{ ...value, name: 'planted-machine' }] : []\n    }))\n  }\n  function worktrees"],
  ['sessions', views, "return values\n    })\n  }\n  function issues", "return values.map(value => ({ ...value, name: 'planted-session' }))\n    })\n  }\n  function issues"],
  ['issues', views, 'const prefix = repo?.prefix', "const prefix = 'PLANTED'"],
] as const
let rejected = 0
for (const [name, path, before, after] of controls) {
  const original = readFileSync(path, 'utf8')
  if (original.split(before).length !== 2) throw new Error(`Control ${name} no longer has one insertion point`)
  try {
    writeFileSync(path, original.replace(before, after))
    const result = spawnSync(process.execPath, ['run', 'test:file', '--', 'packages/client-graph/src/shell.test.ts', '-t', 'matches window, approval'], { encoding: 'utf8', timeout: 300000 })
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 1 || !output.includes('differences') || !output.includes('AssertionError')) throw new Error(`Control ${name} did not fail the parity assertion`)
    rejected++
    console.log(JSON.stringify({ control: name, rejected: 1 }))
  } finally { writeFileSync(path, original) }
}
console.log(JSON.stringify({ controls: controls.length, rejected }))
