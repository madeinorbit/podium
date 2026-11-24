/**
 * Desktop acceptance evidence for on-demand issue bodies (POD-7550).
 * Run on an agent VM, through remote-lane and validation-admission:
 *   PODIUM_BROWSER_VM=1 bun --conditions=@podium/source tests/e2e/empty-device-bodies.mjs
 * No sync responses are replaced. Each step gets a new browser context, backed
 * by the real IndexedDB replica and a real, separately seeded server database.
 * Evidence belongs in issue artifacts, never in git.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, firefox } from '@playwright/test'

if (process.env.PODIUM_BROWSER_VM !== '1') throw Error('Use the assigned agent VM lane')
const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const out = resolve(option('out', '.artifacts/empty-device-bodies'))
const backendPort = Number(option('backend-port', '19650'))
const webPort = Number(option('web-port', '19651'))
const bodyKinds =
  /^(issueDescription|issueBrief|issuePanelTodo|issuePanelArtifact|issuePanelDeferred|issuePanelState)\./
const ids = {
  source: 'iss_browser_source',
  target: 'iss_browser_target',
  offline: 'iss_browser_offline',
}
const text = {
  description:
    'The complete description survives a cold device. Its final sentence must also reach the editor.',
  brief: 'The complete agent brief arrives through its own on-demand record.',
  state: 'All six body fields are present on the isolated server.',
  todo: 'Verify the synthetic todo is visible',
  artifact: 'Browser evidence fixture',
  deferred: 'A synthetic deferred decision for later review',
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
mkdirSync(out, { recursive: true })

async function serveFixture() {
  const { startServer } = await import('../../apps/server/src/test-support/enrolled-server.ts')
  const { seedRows } = await import('../../apps/server/src/test-support/seed-rows.ts')
  const { issueRowFixture } = await import('../../apps/server/src/test-support/issue-row.ts')
  const { firstAdminMemberId } = await import('@podium/model')
  const { fixtureWriteScope } = await import('@podium/sync/testing')
  const server = await startServer({
    port: backendPort,
    host: '127.0.0.1',
    redirectPhoneRootToMobile: false,
  })
  const store = server.registry.sessionStore
  const owner = await firstAdminMemberId(store)
  const machine = store.hostMachine.id
  const repo = join(process.env.PODIUM_STATE_DIR, 'fixture-project')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  const now = new Date().toISOString()
  const old = '2024-01-01T00:00:00.000Z'
  const scope = fixtureWriteScope()
  await seedRows(store, async () => {
    await store.repos.addRepo(repo, machine, undefined, 'TEST')
    await store.layout.setMany(
      scope,
      owner,
      {
        superOpen: false,
        dockTab: 'issue',
        'tips.enabled': false,
        'issues.display': JSON.stringify({ layout: 'kanban', ordering: 'priority' }),
      },
      now,
    )
    for (let start = 0; start < 8687; start += 250) {
      for (let n = start; n < Math.min(start + 250, 8687); n++) {
        const id =
          n === 0 ? ids.source : n === 1 ? ids.target : n === 2 ? ids.offline : `iss_browser_${n}`
        const active = n < 600
        const row = issueRowFixture({
          id,
          seq: n + 1,
          ownerUserId: owner,
          createdByActor: owner,
          createdByOnBehalfOf: owner,
          repoPath: repo,
          repoId: undefined,
          machineId: machine,
          title:
            n === 0
              ? 'Reference source task'
              : n === 1
                ? 'Cold device target'
                : n === 2
                  ? 'Never opened offline task'
                  : `Synthetic task ${String(n + 1).padStart(5, '0')}`,
          description:
            n === 0
              ? 'Source issue description for setup only.'
              : n < 3
                ? text.description
                : `Synthetic description ${n + 1}`,
          brief: n < 3 ? text.brief : null,
          stage: active ? 'in_progress' : 'done',
          parentId: n >= 601 && n < 1570 ? 'iss_browser_600' : null,
          worktreePath: null,
          branch: null,
          parentBranch: 'main',
          linearId: null,
          linearIdentifier: null,
          linearUrl: null,
          activityNotes: null,
          notesUpdatedAt: null,
          suggestedStage: null,
          suggestedReason: null,
          blockedBy: [],
          dependencyNote: null,
          prUrl: null,
          createdAt: active ? now : old,
          updatedAt: n < 3 ? new Date(Date.now() + 10_000).toISOString() : active ? now : old,
          archived: false,
          revision: undefined,
          deletedAt: null,
          assignee: null,
          acceptance: null,
          dueAt: null,
          deferUntil: null,
          closedReason: active ? null : 'done',
          closedAt: active ? null : old,
          pinned: false,
          color: null,
          estimateMin: null,
          needsHuman: false,
          humanQuestion: null,
          humanQuestionOptions: null,
          humanQuestionAskedBy: null,
          humanQuestionAskedAt: null,
          panel: undefined,
          readAt: null,
          origin: 'human',
          audience: 'human',
        })
        await store.issues.upsertIssue(scope, row)
      }
    }
    for (const issueId of Object.values(ids)) {
      await store.issues.panel.save(scope, 'issuePanelTodo', {
        id: `todo_${issueId}`,
        issueId,
        position: 0,
        text: text.todo,
        done: false,
      })
      await store.issues.panel.save(scope, 'issuePanelArtifact', {
        id: `artifact_${issueId}`,
        issueId,
        position: 0,
        path: 'fixture.txt',
        title: text.artifact,
        addedAt: now,
      })
      await store.issues.panel.save(scope, 'issuePanelDeferred', {
        id: `deferred_${issueId}`,
        issueId,
        position: 0,
        text: text.deferred,
        addedAt: now,
      })
      await store.issues.panel.save(scope, 'issuePanelState', {
        id: issueId,
        text: issueId === ids.source ? 'Source task state for setup only.' : text.state,
        updatedAt: now,
      })
    }
    await store.issues.addIssueDep(ids.source, ids.target, 'related')
    for (let start = 0; start < 6941; start += 250) {
      const sessions = Array.from({ length: Math.min(250, 6941 - start) }, (_, offset) => ({
        id: `browser-session-${start + offset}`,
        ownerUserId: owner,
        agentKind: 'shell',
        cwd: repo,
        title: `Synthetic historical session ${start + offset}`,
        name: null,
        originKind: 'spawn',
        conversationId: null,
        resumeKind: null,
        resumeValue: null,
        status: 'exited',
        exitCode: 0,
        durableLabel: `podium-browser-acceptance-${start + offset}`,
        createdAt: old,
        lastActiveAt: old,
        archived: true,
        workState: null,
        machineId: machine,
        headless: false,
        issueId: null,
        stoppedAt: old,
      }))
      await store.sessions.upsertSessions(scope, sessions)
    }
  })
  writeFileSync(
    join(out, 'fixture.json'),
    JSON.stringify(
      {
        issues: 8687,
        sessions: 6941,
        activeIssues: 600,
        missionIssues: 970,
        ids,
        text,
        owner: 'browser-user',
        ready: true,
      },
      null,
      2,
    ),
  )
  const stop = async () => {
    const target = await store.issues.getIssue(ids.target)
    writeFileSync(
      join(out, 'server-after.json'),
      JSON.stringify({ description: target.description, brief: target.brief }, null, 2),
    )
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  console.log('FIXTURE_READY')
}

if (process.argv.includes('--fixture-web')) {
  const { createServer } = await import('../../apps/web/node_modules/vite/dist/node/index.js')
  // Scope dependency discovery to the real app entry. Other HTML files under
  // apps/web are independent layout fixtures, including mobile-only sources.
  const vite = await createServer({
    root: resolve('apps/web'),
    optimizeDeps: { entries: ['index.html'] },
  })
  await vite.listen()
  process.on('SIGTERM', async () => {
    await vite.close()
    process.exit(0)
  })
} else if (process.argv.includes('--fixture-server')) {
  await serveFixture()
} else {
  const root = mkdtempSync(join(tmpdir(), 'podium-empty-browser-'))
  const state = join(root, 'state')
  const home = join(root, 'home')
  mkdirSync(state, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(state, 'config.json'),
    JSON.stringify({ mode: 'all-in-one', loopProfile: 'off' }),
  )
  // An allowlist keeps inherited session relays, instance endpoints, provider
  // credentials and operator state out of both fixture processes.
  const env = {
    PATH: process.env.PATH,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    HOME: home,
    USER: 'browser-user',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    PODIUM_BROWSER_VM: '1',
    PODIUM_INSTANCE: 'browser-acceptance',
    PODIUM_STATE_DIR: state,
    PODIUM_AGENT_HOME: join(root, 'agent-home'),
    PODIUM_NO_RELAY: '1',
    // This newly created root contains only our own config.json.
    PODIUM_ADOPT_STATE: '1',
    PODIUM_PORT: String(backendPort),
    PODIUM_HOOK_PORT: String(backendPort + 2),
    PODIUM_AGENT_RELAY_PORT: String(backendPort + 3),
    PODIUM_WEB_PORT: String(webPort),
    PODIUM_LOOP_PROFILE: 'off',
  }
  let serverLog = '',
    webLog = ''
  const server = spawn(
    process.execPath,
    [
      '--conditions=@podium/source',
      import.meta.filename,
      '--fixture-server',
      `--out=${out}`,
      `--backend-port=${backendPort}`,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (x) => {
      serverLog = (serverLog + x).slice(-50000)
    })
  let web, browser
  const run = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    engines: [],
    steps: [],
    startedAt: new Date().toISOString(),
  }
  const save = () => writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  try {
    for (let n = 0; !serverLog.includes('FIXTURE_READY'); n++) {
      if (server.exitCode !== null || n > 240)
        throw Error(`Fixture startup failed: ${serverLog.slice(-5000)}`)
      await pause(500)
    }
    web = spawn(process.execPath, [import.meta.filename, '--fixture-web'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [web.stdout, web.stderr])
      stream.on('data', (x) => {
        webLog = (webLog + x).slice(-30000)
      })
    const base = `http://127.0.0.1:${webPort}`
    for (let n = 0; ; n++) {
      if (web.exitCode !== null || n > 120)
        throw Error(`Web startup failed: ${webLog.slice(-3000)}`)
      try {
        if ((await fetch(`${base}/`)).ok) break
      } catch {}
      await pause(500)
    }
    for (const [engine, launcher] of [
      ['chromium', chromium],
      ['firefox', firefox],
    ]) {
      browser = await launcher.launch({ headless: true })
      run.engines.push({ engine, version: browser.version() })
      const selectedSteps = option('steps', 'abcdef')
      for (const step of selectedSteps) {
        const selectedCases = option('cases', '').split(',').filter(Boolean)
        if (selectedCases.length && !selectedCases.includes(`${engine}:${step}`)) continue
        const context = await browser.newContext({
          viewport: { width: 1600, height: 1100 },
          serviceWorkers: 'block',
        })
        const page = await context.newPage()
        page.setDefaultTimeout(12000)
        const row = {
          engine,
          step,
          pass: false,
          requests: [],
          console: [],
          errors: [],
          observations: {},
          screenshots: [],
        }
        run.steps.push(row)
        let phase = 'startup',
          delayBodies = 0
        const consoleMessages = new Map()
        page.on('console', (message) => {
          if (!['warning', 'error'].includes(message.type())) return
          const text = message.text().replace(/@\d+/g, '@<id>')
          const prior = consoleMessages.get(text)
          if (prior) prior.count++
          else {
            const entry = { type: message.type(), text, count: 1 }
            consoleMessages.set(text, entry)
            row.console.push(entry)
          }
        })
        page.on('pageerror', (error) => row.errors.push(error.message))
        page.on('request', (request) => {
          if (!new URL(request.url()).pathname.startsWith('/sync/')) return
          let body
          try {
            body = request.postDataJSON()
          } catch {}
          const entry = {
            phase,
            path: new URL(request.url()).pathname,
            instances: body?.instances ?? [],
            startedAt: Date.now(),
            status: 'pending',
          }
          row.requests.push(entry)
          request.__entry = entry
        })
        page.on('response', (response) => {
          const entry = response.request().__entry
          if (entry) {
            entry.status = response.status()
            entry.finishedAt = Date.now()
          }
        })
        page.on('requestfailed', (request) => {
          const entry = request.__entry
          if (entry) entry.status = request.failure()?.errorText ?? 'failed'
        })
        await context.route('**/sync/collections', async (route) => {
          const instances = route.request().postDataJSON()?.instances ?? []
          if (delayBodies && instances.some((x) => bodyKinds.test(x.collection)))
            await pause(delayBodies)
          // Delay only: the real server supplies the entire answer unchanged.
          await route.continue()
        })
        const shot = async (suffix = '') => {
          const name = `${engine}-${step}${suffix}.png`
          await page.screenshot({
            path: join(out, name),
            fullPage: false,
            mask: [page.locator('[data-testid="account-menu"], [data-testid="member-menu"]')],
          })
          row.screenshots.push(name)
        }
        const navigate = async (path) =>
          page.evaluate((path) => {
            history.pushState(null, '', path)
            dispatchEvent(new PopStateEvent('popstate'))
          }, path)
        const waitText = async (value, selector = 'body') =>
          page.waitForFunction(
            ({ value, selector }) => document.querySelector(selector)?.textContent.includes(value),
            { value, selector },
            { timeout: 20000 },
          )
        const check = (condition, message) => {
          if (!condition) throw Error(message)
        }
        try {
          await page.addInitScript(() => {
            // Runs before the app's first script, at its real origin. Health
            // responses are API downloads rather than browser documents.
            const localKeys = localStorage.length
            window.__emptyDevice = Promise.all([indexedDB.databases(), caches.keys()]).then(
              ([databases, cacheKeys]) => ({
                localStorage: localKeys,
                databases: databases.length,
                caches: cacheKeys.length,
              }),
            )
          })
          if (step === 'c' || step === 'd') {
            if (step === 'd') delayBodies = 2500
            phase = 'action'
            await page.goto(`${base}/issues/${ids.target}`, { waitUntil: 'domcontentloaded' })
          } else {
            await page.goto(`${base}/issues/${ids.source}`)
            await waitText('Reference source task', '[data-testid="issue-page"]')
            await page.waitForFunction(
              () => !document.querySelector('[data-body-pending="loading"]'),
            )
            await pause(1000)
            phase = 'action'
          }
          row.emptyDevice = await page.evaluate(() => window.__emptyDevice)
          check(
            Object.values(row.emptyDevice).every((x) => x === 0),
            'Device storage was not empty',
          )
          if (step === 'a') {
            // Select only the source mission. The acceptance action is the
            // target's actual related-task row in its dock, and never opens
            // the target's flight deck, page or miniview beforehand.
            phase = 'startup'
            const filter = page.getByPlaceholder('Filter tasks', { exact: true })
            await filter.fill('Reference source task')
            await page
              .getByTestId('unified-issue-row')
              .filter({ hasText: 'Reference source task' })
              .getByText('Reference source task', { exact: true })
              .click()
            await page.waitForURL('**/workspace*')
            await filter.fill('')
            await page.evaluate(() =>
              window.dispatchEvent(new CustomEvent('podium:open-right-panel', { detail: 'issue' })),
            )
            await page.getByTestId('dock-relations').waitFor({ state: 'visible' })
            check(
              !row.requests.some((x) =>
                x.instances.some(
                  (i) => bodyKinds.test(i.collection) && JSON.stringify(i).includes(ids.target),
                ),
              ),
              'Target body was requested before the dock action',
            )
            phase = 'action'
            await page
              .getByTestId('dock-link-row')
              .filter({ hasText: 'Cold device target' })
              .click()
            await waitText('Cold device target', '[data-testid="dock-title"]')
            await waitText(text.description, '[data-testid="dock-description"]')
            await waitText(text.state, '[data-testid="dock-current-update-body"]')
            row.observations.targetOpenedThroughDockRelation = true
            await shot()
          } else if (step === 'b') {
            delayBodies = 900
            const reference = page
              .getByTestId('issue-aside')
              .getByRole('button', { name: /TEST-2.*Cold device target/ })
            await reference.hover()
            await pause(1500)
            const card = page.getByRole('dialog', { name: 'Reference TEST-2' })
            row.observations.hoverOpened = await card.isVisible()
            await shot('-hover')
            // Also exercise the miniview's real activation entry point as a
            // separately counted control, without converting hover to a pass.
            if (!row.observations.hoverOpened) {
              phase = 'activation-control'
              // The module lives at the browser's Vite origin. Pass its URL
              // into the browser rather than declaring a Node module import.
              await page.evaluate(
                async (activationUrl) =>
                  (await import(activationUrl)).activateRef('TEST-2', {
                    clientX: 900,
                    clientY: 250,
                  }),
                `${base}/src/lib/ref-activation.ts`,
              )
            }
            await card.waitFor({ state: 'visible' })
            row.observations.loadingShown =
              (await card.locator('[data-body-pending="loading"]').count()) > 0
            await shot('-loading')
            await waitText(text.description, '[role="dialog"]')
            row.observations.descriptionAfterLoading = true
            await shot()
            check(row.observations.hoverOpened, 'Hover does not open the reference miniview')
          } else if (step === 'c') {
            await waitText(text.description, '[data-testid="issue-page"]')
            await page.getByTestId('issue-brief').locator('summary').click()
            await waitText(text.brief, '[data-testid="issue-brief"]')
            await waitText(text.artifact, '[data-testid="issue-artifacts"]')
            await waitText(text.deferred, '[data-testid="issue-deferred"]')
            row.observations = {
              description: true,
              brief: true,
              artifacts: true,
              deferred: true,
              todos: (await page.getByTestId('issue-page').innerText()).includes(text.todo),
            }
            // Coordinator clarification: the full page intentionally hides
            // agent todos (POD-1163). Their presentation is not applicable;
            // it must not leave a false empty state or a loading placeholder.
            row.observations.todoPresentation = 'not applicable: intentionally hidden'
            await page.waitForFunction(
              () => !document.querySelector('[data-body-pending="loading"]'),
            )
            row.observations.loadingLeftovers = await page
              .locator('[data-body-pending="loading"]')
              .count()
            row.observations.falseTodoEmptyState = /no todos|no to-dos/i.test(
              await page.getByTestId('issue-page').innerText(),
            )
            await shot()
            check(!row.observations.falseTodoEmptyState, 'Full page reports an empty todo list')
          } else if (step === 'd') {
            const pending = page.getByTestId('issue-description-pending')
            await pending.waitFor({ state: 'visible' })
            await pending.click()
            row.observations.editorBeforeLoad = await page
              .getByLabel('Task description', { exact: true })
              .count()
            await shot('-pending')
            check(
              row.observations.editorBeforeLoad === 0,
              'An editor opened before description loaded',
            )
            await page.getByTitle('Click to edit description').click({ timeout: 20000 })
            const editor = page.getByLabel('Task description', { exact: true })
            row.observations.editorValue = await editor.inputValue()
            check(
              row.observations.editorValue === text.description,
              'Editor text differs from full server description',
            )
            await shot()
            await editor.press('Escape')
          } else if (step === 'e') {
            // Preload the issue page module, but never read the target's bodies.
            check(
              !row.requests.some((x) =>
                x.instances.some((i) => JSON.stringify(i).includes(ids.offline)),
              ),
              'Offline target was requested during startup',
            )
            await context.setOffline(true)
            await page.evaluate(() => dispatchEvent(new Event('offline')))
            await pause(700)
            phase = 'offline-action'
            await navigate(`/issues/${ids.offline}`)
            await page.waitForFunction(
              () => document.querySelectorAll('[data-body-pending="offline"]').length >= 3,
              undefined,
              { timeout: 15000 },
            )
            await pause(2500)
            row.observations.offlineSections = await page
              .locator('[data-body-pending="offline"]')
              .evaluateAll((nodes) =>
                nodes.map((x) => ({
                  label: x.getAttribute('aria-label'),
                  text: x.textContent,
                  busy: x.getAttribute('aria-busy'),
                })),
              )
            row.observations.stillLoading = await page
              .locator('[data-body-pending="loading"]')
              .count()
            await shot()
            check(
              row.observations.stillLoading === 0,
              'A never-opened body remains loading while offline',
            )
          } else if (step === 'f') {
            await navigate('/issues')
            await page.waitForFunction(
              () =>
                document.querySelectorAll('[data-testid="issues-board"] [data-issue-id]').length >
                25,
            )
            row.observations.scrolls = []
            for (const selector of [
              '[data-testid="column-scroll"]',
              '[data-testid="work-scroll"]',
            ]) {
              const candidates = page.locator(selector)
              const dimensions = await candidates.evaluateAll((nodes) =>
                nodes.map((node) => ({
                  height: node.clientHeight,
                  scrollHeight: node.scrollHeight,
                })),
              )
              row.observations.scrolls.push({ selector, dimensions })
              for (const n of dimensions.flatMap((d, i) =>
                d.scrollHeight > d.height ? [i] : [],
              )) {
                const list = candidates.nth(n)
                await list.hover()
                const before = await list.evaluate((node) => node.scrollTop)
                for (let i = 0; i < 7; i++) {
                  await page.mouse.wheel(0, 700)
                  await pause(180)
                }
                const after = await list.evaluate((node) => node.scrollTop)
                row.observations.scrolls.at(-1).moved = { before, after }
                check(after > before, 'Mouse wheel did not scroll the tested list')
              }
            }
            await pause(1200)
            await shot()
            row.observations.bodyWarnings = row.console.filter((x) =>
              x.text.includes('Body read misuse'),
            )
            const bodyRequests = row.requests.filter(
              (x) => x.phase === 'action' && x.instances.some((i) => bodyKinds.test(i.collection)),
            )
            row.observations.bodyRequests = bodyRequests.length
            check(
              row.observations.bodyWarnings.length === 0,
              'Body-hold development warning fired while scrolling',
            )
            check(bodyRequests.length === 0, 'Board or sidebar requested per-row body records')
            check(
              row.observations.scrolls.every((x) =>
                x.dimensions.some((d) => d.scrollHeight > d.height),
              ),
              'A tested list did not exceed its viewport',
            )
          }
          row.pass = true
        } catch (error) {
          row.failure = error.message
          await shot('-failure').catch(() => {})
        } finally {
          await pause(400)
          row.batchRequests = row.requests.filter(
            (x) => x.path === '/sync/collections' && x.phase !== 'startup',
          ).length
          row.startupBatchRequests = row.requests.filter(
            (x) => x.path === '/sync/collections' && x.phase === 'startup',
          ).length
          row.bodyInstances = row.requests
            .filter((x) => x.phase !== 'startup')
            .flatMap((x) => x.instances)
            .filter((x) => bodyKinds.test(x.collection))
          row.shown = (
            await page
              .locator('body')
              .innerText()
              .catch(() => '')
          ).slice(0, 16000)
          save()
          console.log(
            `${engine} ${step}: ${row.pass ? 'PASS' : 'FAIL'}; ${row.batchRequests} action batch requests; ${row.bodyInstances.length} body instances${row.failure ? `; ${row.failure.split('\n')[0]}` : ''}`,
          )
          await context.close()
        }
      }
      await browser.close()
      browser = undefined
    }
  } finally {
    await browser?.close()
    web?.kill('SIGTERM')
    server.kill('SIGTERM')
    for (let i = 0; server.exitCode === null && i < 30; i++) await pause(200)
    if (server.exitCode === null) server.kill('SIGKILL')
    writeFileSync(join(out, 'server.log'), serverLog)
    writeFileSync(join(out, 'web.log'), webLog)
    save()
    rmSync(root, { recursive: true, force: true })
  }
  if (run.steps.length === 0 || run.steps.some((x) => !x.pass)) process.exitCode = 1
}
