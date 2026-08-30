import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Window } from 'happy-dom'

const root = resolve(import.meta.dir, '../../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('r18 continuity selector contract', () => {
  test('tracks the registered-project cold and live workspace surfaces', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const sidebar = read('apps/web/src/features/worklist/SidebarUnified.tsx')
    const folds = read('apps/web/src/features/worklist/work-folds.tsx')
    const worktree = read('apps/web/src/features/worklist/UnifiedWorktreeRow.tsx')
    const composer = read('apps/web/src/features/setup/ColdStartComposer.tsx')

    expect(rig).not.toContain("page.locator('.shell-work-row-title'")
    for (const contract of [
      'project-group-label',
      'start-first-task',
      'unified-worktree-row',
      'cold-start-deck',
      'cold-start-launch',
    ]) {
      expect(rig).toContain(contract)
    }
    expect(rig).toContain('project-group-label"] > span:not([data-testid="project-group-count"])')
    expect(folds).toContain('countTestId="project-group-count"')
    expect(sidebar).toContain('data-testid="project-group"')
    expect(sidebar).toContain('<StartFirstTaskRow repoPath={repo.path} />')
    expect(worktree).toContain('testId="unified-worktree-row"')
    expect(rig).toContain('value.slice(-512)')
    expect(rig).toContain('redactedNormalizedTail:redactedNativeTail(normalized)')
    expect(rig).toContain("'[REDACTED_TOKEN]'")
    expect(rig).toContain("'[REDACTED_HEX]'")
    expect(rig).not.toContain('redactedNormalizedTail:normalized')

    expect(composer).toContain('data-testid="cold-start-launch"')
  })
  test('selects only the exact populated issue-backed restored session', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const window = new Window()
    window.document.body.innerHTML = `
      <section data-testid="project-group" data-repository="DUM-1-A">
        <button data-testid="project-group-label" aria-expanded="true"><span>DUM-1-A</span></button>
        <div data-testid="unified-issue-row"><div class="shell-work-row" data-issue-row="issue-dum"><button>DUM task</button></div></div>
      </section>
      <section data-testid="project-group" data-repository="FOREIGN">
        <button data-testid="project-group-label" aria-expanded="true"><span>FOREIGN</span></button>
        <div data-testid="unified-issue-row"><div class="shell-work-row" data-issue-row="issue-foreign"><button>Foreign task</button></div></div>
      </section>
    `
    const sessions = [
      { sessionId: 'restored-dum', cwd: '/tmp/pod-3112-dum/DUM-1-A', issueId: 'issue-dum' },
      { sessionId: 'foreign', cwd: '/tmp/pod-3112-dum/FOREIGN', issueId: 'issue-foreign' },
    ]
    const restoredIssueRow = (sessionId: string, cwd: string, repository: string) => {
      const restored = sessions.filter((row) => row.sessionId === sessionId && row.cwd === cwd)
      if (restored.length !== 1 || !restored[0]?.issueId) return null
      const group = window.document.querySelector(
        `[data-testid="project-group"][data-repository="${repository}"]`,
      )
      const rows = group?.querySelectorAll(
        `[data-testid="unified-issue-row"]:has([data-issue-row="${restored[0].issueId}"])`,
      )
      return rows?.length === 1 ? rows[0] : null
    }

    expect(restoredIssueRow('restored-dum', '/tmp/pod-3112-dum/DUM-1-A', 'DUM-1-A')).not.toBeNull()
    expect(restoredIssueRow('absent', '/tmp/pod-3112-dum/DUM-1-A', 'DUM-1-A')).toBeNull()
    expect(restoredIssueRow('foreign', '/tmp/pod-3112-dum/FOREIGN', 'DUM-1-A')).toBeNull()

    expect(rig).toContain("row.sessionId===sid&&row.cwd===C")
    expect(rig).toContain("restored.length!==1")
    expect(rig).toContain('restored[0].issueId')
    expect(rig).toContain('[data-testid="unified-issue-row"]:has([data-issue-row="${issueId}"])')
    expect(rig).toContain('issueCount!==1')
  })
  test('enables and selects the headless driver through visible product controls', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')

    expect(rig).toContain("getByRole('button',{name:'Settings',exact:true})")
    expect(rig).toContain("getByRole('button',{name:'Experimental',exact:true})")
    expect(rig).toContain("getByText('Headless session drivers',{exact:true})")
    expect(rig).toContain("getByRole('button',{name:'Driver',exact:true})")
    expect(rig).toContain("getByRole('menuitem',{name:exact('opencode-server')})")
    expect(rig).toContain("exact('opencode-server').test((await driver.innerText()).trim())")
    expect(rig).not.toContain('PODIUM_RUNTIME_DRIVER=')
    expect(rig).not.toContain("m('sessions.create'")
    expect(rig).toContain("writeFileSync(base+'/a7a-ready'")
    expect(rig).toContain("getAttribute('aria-checked')!=='true'")
    expect(rig).not.toContain("getAttribute('data-state')")
    expect(rig).toContain("existsSync(base+'/a7a-continue')")
  })

  test("compiles without executing the runtime proof", async () => {
    const result = await Bun.build({
      entrypoints: [resolve(root, "docs/evidence/pod-3112/r18-continuity.ts")],
      target: "bun",
      external: ["playwright"],
      write: false,
    })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
  })
})
