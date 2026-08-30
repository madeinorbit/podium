import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('r18 continuity selector contract', () => {
  test('tracks the registered-project cold and live workspace surfaces', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const sidebar = read('apps/web/src/features/worklist/SidebarUnified.tsx')
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
    expect(sidebar).toContain('data-testid="project-group"')
    expect(sidebar).toContain('<StartFirstTaskRow repoPath={repo.path} />')
    expect(worktree).toContain('testId="unified-worktree-row"')

    expect(composer).toContain('data-testid="cold-start-launch"')
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
