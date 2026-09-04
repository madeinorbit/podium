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
  test('finishes first-run onboarding only through exact visible controls', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const activation = read('apps/web/src/features/setup/FirstTaskActivation.tsx')
    const helperStart = rig.indexOf('const finishOnboarding=async()=>')
    const helperEnd = rig.indexOf('const settingsControl=async()=>', helperStart)
    const helper = rig.slice(helperStart, helperEnd)
    const finishCall = rig.indexOf('out.onboarding=await finishOnboarding()')
    const settingsCall = rig.indexOf('await enableRuntimeDrivers()', finishCall)

    expect(helperStart).toBeGreaterThan(-1)
    expect(helperEnd).toBeGreaterThan(helperStart)
    expect(helper).toContain("getByRole('heading',{name:'Set up your agents.',exact:true})")
    expect(helper).toContain("getByRole('button',{name:'Continue',exact:true})")
    expect(helper).toContain('REFUSED agent Continue control count')
    expect(helper).toContain("getByRole('heading',{name:'Podium is good to go.',exact:true})")
    expect(helper).toContain("getByRole('button',{name:'Finish setup',exact:true})")
    expect(helper).toContain('REFUSED Finish setup control count')
    expect(helper).toContain("setup.waitFor({state:'hidden'")
    expect(helper).not.toContain('localStorage')
    expect(helper).not.toContain('sessionStorage')
    expect(helper).not.toContain("m('")
    expect(helper).not.toContain("q('")
    expect(helper).not.toContain('page.evaluate')
    expect(finishCall).toBeGreaterThan(helperEnd)
    expect(settingsCall).toBeGreaterThan(finishCall)
    expect(activation).toContain('<span>Finish setup</span>')
    expect(activation).toContain("onRouteChange('first-task')")
  })
  test('enables and selects the headless driver through visible product controls', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const topBar = read('apps/web/src/app/TopBar.tsx')
    const window = new Window()
    const settingsControl = (markup: string): Element | null => {
      window.document.body.innerHTML = markup
      const topbars = window.document.querySelectorAll('[data-testid="desktop-topbar"]')
      const settings = window.document.querySelectorAll('button[aria-label="Settings"]')
      if (
        topbars.length !== 1 ||
        topbars[0]?.tagName !== 'HEADER' ||
        topbars[0]?.hasAttribute('data-chromeless') ||
        settings.length !== 1 ||
        !topbars[0]?.contains(settings[0] ?? null)
      ) {
        return null
      }
      return settings[0] ?? null
    }

    expect(topBar).toContain('data-testid="desktop-topbar"')
    expect(topBar).toContain('<UtilityNavItem')
    expect(rig).toContain("topbars.first().waitFor({state:'visible',timeout:30000})")
    expect(rig).toContain("settings.first().waitFor({state:'visible',timeout:30000})")
    expect(topBar).toContain('label="Settings"')
    expect(rig).toContain("page.getByTestId('desktop-topbar')")
    expect(rig).toContain("getAttribute('data-chromeless')!==null")
    expect(rig).toContain("page.getByRole('button',{name:'Settings',exact:true})")
    expect(rig).toContain('REFUSED Settings control count')
    expect(rig).toContain("getByRole('button',{name:'Experimental',exact:true})")
    expect(rig).toContain("getByText('Headless session drivers',{exact:true})")
    expect(rig).toContain("getByRole('button',{name:'Driver',exact:true})")
    expect(rig).toContain("getByRole('menuitem',{name:exact('opencode-server')})")
    expect(rig).toContain("exact('opencode-server').test((await driver.innerText()).trim())")
    expect(
      settingsControl(`
        <header data-testid="desktop-topbar">
          <button aria-label="Settings"></button>
        </header>
      `),
    ).not.toBeNull()
    expect(settingsControl('<header data-testid="desktop-topbar"></header>')).toBeNull()
    expect(
      settingsControl(
        '<header data-testid="desktop-topbar" data-chromeless="true"><button aria-label="Settings"></button></header>',
      ),
    ).toBeNull()
    expect(
      settingsControl('<header data-testid="desktop-topbar"><button aria-label="Settings"></button></header><button aria-label="Settings"></button>'),
    ).toBeNull()
    expect(
      settingsControl('<button data-testid="desktop-topbar" aria-label="Settings"></button>'),
    ).toBeNull()
    expect(rig).not.toContain('PODIUM_RUNTIME_DRIVER=')
    expect(rig).not.toContain("m('sessions.create'")
    expect(rig).toContain("writeFileSync(base+'/a7a-ready'")
    expect(rig).toContain("getAttribute('aria-checked')!=='true'")
    expect(rig).not.toContain("getAttribute('data-state')")
    expect(rig).toContain("existsSync(base+'/a7a-continue')")
  })

  test('keeps the runner detached across the A7a commit checkpoint', () => {
    const orchestration = read('docs/evidence/pod-3112/r18-orchestrate.sh')
    const launch = orchestration.indexOf('nohup setsid env')
    const absoluteBun = orchestration.indexOf('/home/mgw/.bun/bin/bun', launch)
    const pidWrite = orchestration.indexOf('> "$PIDFILE"', absoluteBun)
    const checkpoint = orchestration.indexOf('[ -f "$BASE/a7a-ready" ]', pidWrite)
    const continuation = orchestration.indexOf('if [ "$MODE" = continue-a7b ]')
    const livenessFence = orchestration.indexOf('runner_alive ||', continuation)
    const release = orchestration.indexOf('touch "$BASE/a7a-continue"', livenessFence)
    const completion = orchestration.indexOf('runner_alive || { verify_a7b; exit $?; }', release)
    const verifierStart = orchestration.indexOf('verify_a7b() {')
    const verifierEnd = orchestration.indexOf('\n}', verifierStart)
    const verifier = orchestration.slice(verifierStart, verifierEnd)
    const passSentinel = verifier.indexOf('A7B_PASS_CONTROLLED')

    expect(launch).toBeGreaterThan(-1)
    expect(absoluteBun).toBeGreaterThan(launch)
    expect(orchestration.slice(launch, pidWrite)).toContain('> "$BASE/r18-run.log" 2>&1 < /dev/null &')
    expect(pidWrite).toBeGreaterThan(absoluteBun)
    expect(checkpoint).toBeGreaterThan(pidWrite)
    expect(continuation).toBeGreaterThan(-1)
    expect(livenessFence).toBeGreaterThan(continuation)
    expect(release).toBeGreaterThan(livenessFence)
    expect(completion).toBeGreaterThan(release)
    expect(verifierStart).toBeGreaterThan(-1)
    expect(verifierEnd).toBeGreaterThan(verifierStart)
    expect(passSentinel).toBeGreaterThan(-1)
    expect(orchestration).toContain('refusing: detached r18 runner absent')
    expect(verifier).toContain('refusing: A7b reading absent after runner exit')
    expect(verifier).toContain('x.get("verdict")=="PASS"')
    expect(verifier).toContain('a.get("verdict")=="PASS"')
    expect(verifier).toContain('views.get("native") is True')
    expect(verifier).toContain('recall.get("remembered") is True')
    expect(orchestration).not.toContain('runner_alive || { cat "$BASE/r18-run.log"; exit 0; }')
  })

  test('releases the Native viewer before hibernation and resurrection', () => {
    const rig = read('docs/evidence/pod-3112/r18-continuity.ts')
    const leaveNative = rig.indexOf("const chatBeforeHibernate=page.locator('[data-testid=\"mode-chat\"]')")
    const releaseViewer = rig.indexOf("await page.goto('about:blank')", leaveNative)
    const releaseProof = rig.indexOf('waitViewerReleased(sid,viewerReleaseBaseline)', releaseViewer)
    const hibernate = rig.indexOf("m('sessions.hibernate'", releaseProof)
    const providerGone = rig.indexOf('waitProviderGone(preParkJournal.process.pid', hibernate)
    const resurrect = rig.indexOf("m('sessions.resurrect'", providerGone)

    expect(leaveNative).toBeGreaterThan(-1)
    expect(releaseViewer).toBeGreaterThan(leaveNative)
    expect(releaseProof).toBeGreaterThan(releaseViewer)
    expect(hibernate).toBeGreaterThan(releaseProof)
    expect(providerGone).toBeGreaterThan(hibernate)
    expect(resurrect).toBeGreaterThan(providerGone)
    expect(rig).toContain("waitRow(sid,x=>x.status==='hibernated'")
    expect(rig).toContain('Promise.all([waitRow')
    expect(rig).toContain('journalB.opencodeSessionId===journal0.opencodeSessionId')
    expect(rig).toContain('journalB.process.key===journal0.process.key')
    expect(rig).toContain('journalB.process.pid!==preParkJournal.process.pid')
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
