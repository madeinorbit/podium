"""Render raw run observations; missing cells never become zero or a win."""
import argparse
import collections
import html
import json
import math
import pathlib
import statistics

parser=argparse.ArgumentParser()
parser.add_argument('--raw',default='docs/measurements/POD-4286-old-vs-new/raw')
args=parser.parse_args()
root=pathlib.Path(args.raw)
def load_run(file):
    run=json.loads(file.read_text())
    supplement=file.parent/'cpu-boundaries.json'
    if supplement.exists():
        boundary=json.loads(supplement.read_text())['actions']
        for row in run['actions']:
            if row.get('mainThreadCpuMs') is None and row.get('trace') in boundary:row.update(boundary[row['trace']])
    return run
runs=[load_run(file) for file in sorted(root.rglob('run.json'))]
measured=[run for run in runs if run.get('purpose')=='measurement' and run['mode'] in ['timing','memory'] and not run.get('controlOnly')]
completed=[run for run in measured if run['status']=='complete']
valid=[run for run in measured if run['status']=='complete' or run.get('actionPhaseComplete')]
valid_keys={(run['arm'],run['surface'],run['scale'],run['round'],run['sha']) for run in valid}
q=lambda values,p: sorted(values)[max(0,math.ceil(len(values)*p)-1)]
fmt=lambda value: '—' if value is None else f'{value:,.1f}'
percent=lambda value:'—' if value is None else fmt(value)+'%'
percent_change=lambda old,new: (new/old-1)*100 if old is not None and new is not None and old else None
cells=collections.defaultdict(list)
for run in valid:
    if run['mode']!='timing':continue
    for row in run['actions']:
        if row.get('profiled') or 'inputToPaintMs' not in row:continue
        cells[(run['surface'],run['scale'],row['action'],run['arm'],run.get('comparisonArm','new' if run['arm']=='old' else run['arm']))].append(row)
metrics=[]
arm_labels={'new-current':'Current operator build','new-deleted':'After old-store deletion','new':'Before old-store deletion'}
new_arms=sorted({run['arm'] for run in valid if run['arm']!='old'},key=lambda arm:({'new-current':0,'new-deleted':1,'new':2}.get(arm,3),arm)) or ['new']
for new in new_arms:
    keys={(surface,scale,action) for surface,scale,action,arm,pair in cells if arm in ['old',new] and pair==new}
    for run in measured:
        if run.get('comparisonArm')!=new:continue
        for gap in run.get('unavailable',[]):
            if gap['action'] in ['session-composer-typing','phone-inbox']:
                keys.add((run['surface'],run['scale'],gap['action']))
    keys=sorted(keys)
    for surface,scale,action in keys:
        old=cells[(surface,scale,action,'old',new)];candidate=cells[(surface,scale,action,new,new)]
        def stat(rows):
            if not rows:return None
            values=[row['inputToPaintMs'] for row in rows]
            cpu=[row['mainThreadCpuMs'] for row in rows if row.get('mainThreadCpuMs') is not None]
            layout=[row['layoutCpuMs'] for row in rows if row.get('layoutCpuMs') is not None]
            return {'n':len(rows),'median':statistics.median(values),'p95':q(values,.95),'max':max(values),'cpuN':len(cpu),'cpuMedian':statistics.median(cpu) if cpu else None,'cpuP95':q(cpu,.95) if cpu else None,'cpuMax':max(cpu) if cpu else None,'layoutCpuMedian':statistics.median(layout) if layout else None,'boundary':sorted({row.get('boundary','Paint') for row in rows}),'taskWindowMedian':statistics.median(row['taskWindowMs'] for row in rows)}
        a,b=stat(old),stat(candidate)
        change=(b['median']/a['median']-1)*100 if a and b and a['median'] else None
        tail=(b['p95']/a['p95']-1)*100 if a and b and a['p95'] else None
        verdict='not measured' if not a and not b else 'not comparable' if change is None else ('faster' if change < -10 else 'slower' if change > 10 else 'no clear improvement')
        if tail is not None and tail>10:
            if verdict=='faster':verdict='faster median, worse tail'
            elif verdict=='no clear improvement':verdict='similar median, worse tail'
        metrics.append({'newArm':new,'surface':surface,'scale':scale,'action':action,'old':a,'new':b,'changePercent':change,'p95ChangePercent':tail,'verdict':verdict})
summary={'runs':len(runs),'completeRuns':len(completed),'partialActionRuns':sum(run['status']!='complete' for run in valid),'failedRuns':sum(run['status']=='failed' for run in measured),'calibrationOrDiagnosticRuns':len(runs)-len(measured),'comparisons':metrics}
paired=collections.defaultdict(list)
for run in valid:
    paired[(run['surface'],run['scale'],run['arm'],run.get('comparisonArm','new' if run['arm']=='old' else run['arm']))].append(run)
idle_comparisons=[];heap_comparisons=[]
for new in new_arms:
    for surface,scale in sorted({(r['surface'],r['scale']) for r in valid}):
        a=paired[(surface,scale,'old',new)];b=paired[(surface,scale,new,new)]
        for profile in ['observed','busy']:
            idle_values=lambda rows:[window['taskMs']/window['seconds']/10 for row in rows if not row.get('backgroundSuperseded') and (window:=row.get('idleProfiles',{}).get(profile,row.get('idle') if profile=='busy' else None))]
            old_values,new_values=idle_values(a),idle_values(b)
            old_idle=statistics.median(old_values) if old_values else None
            new_idle=statistics.median(new_values) if new_values else None
            if old_idle is not None or new_idle is not None:
                idle_comparisons.append({'newArm':new,'surface':surface,'scale':scale,'profile':profile,'oldN':len(old_values),'newN':len(new_values),'oldPercentOneCore':old_idle,'newPercentOneCore':new_idle,'changePercent':percent_change(old_idle,new_idle)})
        heap_stat=lambda rows,key: statistics.median(row[key]['usedSize']/1048576 for row in rows if row.get(key)) if any(row.get(key) for row in rows) else None
        old_start,new_start=heap_stat(a,'heapStartup'),heap_stat(b,'heapStartup')
        old_end,new_end=heap_stat(a,'heapFiveMinutes'),heap_stat(b,'heapFiveMinutes')
        if old_start is not None or new_start is not None:
            heap_comparisons.append({'newArm':new,'surface':surface,'scale':scale,'oldStartupMiB':old_start,'newStartupMiB':new_start,'startupChangePercent':percent_change(old_start,new_start),'oldFiveMinuteMiB':old_end,'newFiveMinuteMiB':new_end,'fiveMinuteChangePercent':percent_change(old_end,new_end)})
background_comparisons=[]
for new in new_arms:
    for surface,scale in sorted({(r['surface'],r['scale']) for r in valid}):
        a=paired[(surface,scale,'old',new)];b=paired[(surface,scale,new,new)]
        for kind in ['quiet','heartbeat','session-output','issue-change']:
            values=lambda rows:[window['taskMs'] for row in rows if not row.get('backgroundSuperseded') for window in row.get('background',[]) if window['kind']==kind]
            av,bv=values(a),values(b)
            old_median=statistics.median(av) if av else None
            new_median=statistics.median(bv) if bv else None
            if av or bv:
                background_comparisons.append({'newArm':new,'surface':surface,'scale':scale,'kind':kind,'oldN':len(av),'newN':len(bv),'oldMedianMs':old_median,'newMedianMs':new_median,'changePercent':percent_change(old_median,new_median),'oldP95Ms':q(av,.95) if av else None,'newP95Ms':q(bv,.95) if bv else None,'oldWindowMedianMs':statistics.median(window['actualWindowMs'] for row in a if not row.get('backgroundSuperseded') for window in row.get('background',[]) if window['kind']==kind) if av else None,'newWindowMedianMs':statistics.median(window['actualWindowMs'] for row in b if not row.get('backgroundSuperseded') for window in row.get('background',[]) if window['kind']==kind) if bv else None})
summary.update(idleComparisons=idle_comparisons,heapComparisons=heap_comparisons,backgroundComparisons=background_comparisons)
pathlib.Path('docs/measurements/POD-4286-old-vs-new/results.json').write_text(json.dumps(summary,indent=2)+'\n')
lines=['# OLD versus NEW whole-app measurements','','SUMMARY_PENDING','','## Compared applications','']
for arm in sorted({run['arm'] for run in measured}):
    shas=sorted({run['sha'] for run in measured if run['arm']==arm})
    lines.append(f'- **{arm.upper()}**: '+', '.join(f'`{sha}`' for sha in shas))
lines.extend(['','OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. OLD controls are matched to their contemporary NEW build using comparisonArm; later OLD controls are not pooled into the earlier NEW comparison. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.','',f'Performance evidence: {len(completed)} completed measurement runs and {sum(run["status"]=="failed" for run in measured)} failed measurement runs. {summary["partialActionRuns"]} failed run(s) retain a separately completed action phase; their failed background preparation contributes no CPU windows. {len(runs)-len(measured)} calibration, superseded or diagnostic runs are retained separately and excluded from comparisons.','', 'This is a comparison of shipped application revisions, including their other changes and different data representations. It does not isolate MobX as the sole cause. The operator requested NEW be repinned from 22b676a741 to 1aa0ec71f6 during collection, and later requested the current dev/mw operator build dcceaacb1d be compared first. The deletion revision e22a8b6bd9 remains a separate named snapshot. The earlier 22b676 captures are retained as superseded evidence and do not enter the verdict.','', '## Latency, milliseconds','','Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Cached phone Work can return using only composited pixels: its boundary is DrawFrame when no new raster Paint occurs, and its CPU boundary is the last completed main-thread trace event before that frame, a conservative lower bound if work overlaps the frame; wider CDP task CPU also remains raw. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. With 8 or 16 observations, nearest-rank p95 equals the maximum; it is a limited tail estimate, not an independent tail measurement.','','| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | NEW boundary | Verdict |','|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|'])
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['action'],item['newArm'],a.get('n',0),b.get('n',0),fmt(a.get('median')),fmt(b.get('median')),fmt(a.get('p95')),fmt(b.get('p95')),percent(item['changePercent']),percent(item['p95ChangePercent']),fmt(a.get('max')),fmt(b.get('max')),', '.join(b.get('boundary',[])),item['verdict']]))+' |')
lines.extend(['','## Main-thread work per action','','Main-thread CPU uses Chromium trace thread timestamps (tts/tdur), from the trusted input handler to the qualifying Paint end. It excludes OS descheduling; click latency includes the event queue and waiting. Startup CPU starts at the initialization script, slightly after navigation begins. Layout CPU is the union of Layout and UpdateLayoutTree thread durations in that interval and overlaps total CPU. Task busy wall time and wider CDP polling-window deltas remain in raw data. Source-map profiles separately estimate store/derive and React work; never add overlapping categories. [Chromium performance-agent implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).','','| Surface | Scale | Action | NEW arm | OLD CPU median | NEW CPU median | Median change | OLD CPU p95 | NEW CPU p95 | OLD CPU max | NEW CPU max | OLD layout CPU | NEW layout CPU |','|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'])
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['action'],item['newArm'],fmt(a.get('cpuMedian')),fmt(b.get('cpuMedian')),percent(percent_change(a.get('cpuMedian'),b.get('cpuMedian'))),fmt(a.get('cpuP95')),fmt(b.get('cpuP95')),fmt(a.get('cpuMax')),fmt(b.get('cpuMax')),fmt(a.get('layoutCpuMedian')),fmt(b.get('layoutCpuMedian'))]))+' |')
profile_cells=collections.defaultdict(list)
for path in root.rglob('cpu-attribution.json'):
    run=json.loads((path.parent/'run.json').read_text())
    if (run['arm'],run['surface'],run['scale'],run['round'],run['sha']) not in valid_keys:continue
    attribution=json.loads(path.read_text())
    for row in attribution['summaries']:
        if row.get('unavailable'):continue
        profile_cells[(run['arm']+' → '+run.get('comparisonArm','new') if run['arm']=='old' else run['arm'],run['surface'],run['scale'],row['action'])].append(row)
lines.extend(['','## Sampled store and React attribution','','Requested V8 sampling interval: 100 microseconds. Values below estimate CPU as measured renderer thread CPU multiplied by each category’s share of non-idle sampled stack wall time, during separately profiled handler-to-Paint windows. Stack slices start at the mark’s callTime (actual recorder execution), matching the thread-clock start; latency still begins at the backdated trusted-event timestamp and includes queueing. Any absent-callTime fallback is labelled in raw attribution. Sampling and OS descheduling can bias these allocations; they are not exclusive hardware counters. Profiled samples are excluded from latency statistics. Sampled wall durations also remain in raw attribution files. React render includes app derivations it calls; store/derive is an inclusive stack match and overlaps React. Commit includes layout effects and called native work; layout hardware CPU appears in the preceding table. Idle, unmapped and other samples are retained in cpu-attribution.json. No exact exclusive store or React hardware-CPU counters are claimed.','','| Arm | Surface | Scale | Action | Profiles | Store/derive CPU estimate | React render CPU estimate | React commit CPU estimate | Unmapped wall ms |','|---|---|---:|---|---:|---:|---:|---:|---:|'])
for key,rows in sorted(profile_cells.items()):
    cpu_rows=[row for row in rows if row.get('storeDeriveCpuEstimateMs') is not None]
    middle=lambda values:statistics.median(values) if values else None
    lines.append('| '+' | '.join(map(str,[*key,len(rows),fmt(middle([row['storeDeriveCpuEstimateMs'] for row in cpu_rows])),fmt(middle([sum(value for name,value in row['cpuEstimates'].items() if 'React render' in name) for row in cpu_rows])),fmt(middle([sum(value for name,value in row['cpuEstimates'].items() if 'React commit' in name) for row in cpu_rows])),fmt(statistics.median(row['unmappedMs'] for row in rows))]))+' |')
lines.extend(['','## Incoming updates and connected idle','','Update CPU is the CDP main-thread TaskDuration delta with Performance.enable(timeDomain=threadTicks), measured after one injected update through a 200 ms minimum window and two animation frames. Actual windows can be longer under load; their medians appear below and each duration remains raw. Heartbeats change lastActiveAt; issue updates change title (both legacy issue and projection in OLD, projection in NEW); terminal output is a short text line per frame. These are payload-specific observations, not costs for arbitrary issue edits or output byte volumes. Quiet windows measure the same instrumentation with no injection. These are observed total CPU costs in a window containing one update, not exclusive causal CPU per update; pending UI tasks, paints and real upstream traffic can overlap. The 60 s connected-idle replay delivers 30 heartbeat changes/minute, 10 issue changes/minute, and 120 terminal output frames/minute (two frames/second). These busy-profile rates are explicit synthetic assumptions, distinct from the historical-rate replay below. This is an idle UI with live data, not a silent disconnected app. Delivery to the visible terminal is verified before replay. Percent CPU means one renderer thread’s fraction of one core, not whole-machine or Mac desktop CPU.','','| Arm | Surface | Scale | Update | n | Task CPU ms/window median | p95 |','|---|---|---:|---|---:|---:|---:|'])
bg=collections.defaultdict(list)
for run in valid:
    if run.get('backgroundSuperseded'):continue
    for sample in run.get('background',[]):bg[(run['arm']+' → '+run.get('comparisonArm','new') if run['arm']=='old' else run['arm'],run['surface'],run['scale'],sample['kind'])].append(sample['taskMs'])
for key,values in sorted(bg.items()):lines.append('| '+' | '.join(map(str,[*key,len(values),fmt(statistics.median(values)),fmt(q(values,.95))]))+' |')
lines.extend(['','Matched update-window comparisons, without subtracting quiet-window CPU:','','| Surface | Scale | NEW arm | Update | n OLD/NEW | OLD CPU median ms | NEW CPU median ms | Change | OLD p95 | NEW p95 | OLD window ms | NEW window ms |','|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|'])
for item in background_comparisons:
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['newArm'],item['kind'],f'{item["oldN"]}/{item["newN"]}',fmt(item['oldMedianMs']),fmt(item['newMedianMs']),percent(item['changePercent']),fmt(item['oldP95Ms']),fmt(item['newP95Ms']),fmt(item['oldWindowMedianMs']),fmt(item['newWindowMedianMs'])]))+' |')
lines.extend(['','The **observed** profile approximates the [September 18 operator publication census](POD-4286-baseline-summary.json): 12 session, 6 issue, 16 machine, 28 conversation, 36 host-metric and 2 draft changes per minute. The minute clock advances normally. These are historical publication rates replayed with validated synthetic payloads, not a capture of historical network frames or today’s traffic. OLD issue/projection rows are sent together as one logical issue update. The **busy** profile adds the stated 30 heartbeat/10 issue/120 output cadence. Both windows use the same visible terminal and selected control mission.','', '| Arm | Surface | Scale | Profile | Seconds | Updates delivered | Main-thread task ms | One-core CPU % |','|---|---|---:|---|---:|---|---:|---:|'])
for run in valid:
    if run.get('backgroundSuperseded'):continue
    for profile,idle in run.get('idleProfiles',{'busy':run['idle']} if run.get('idle') else {}).items():
        lines.append('| '+' | '.join(map(str,[run['arm'],run['surface'],run['scale'],profile,fmt(idle['seconds']),json.dumps(idle['delivered']),fmt(idle['taskMs']),fmt(idle['taskMs']/idle['seconds']/10)]))+' |')
lines.extend(['','Median of the separate 60-second windows:','','| Surface | Scale | NEW arm | Profile | n OLD/NEW | OLD one-core CPU % | NEW one-core CPU % | Change |','|---|---:|---|---|---|---:|---:|---:|'])
for item in idle_comparisons:
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['newArm'],item['profile'],f'{item["oldN"]}/{item["newN"]}',fmt(item['oldPercentOneCore']),fmt(item['newPercentOneCore']),percent(item['changePercent'])]))+' |')
lines.extend(['','## Retained JavaScript heap','','Post-GC Runtime.getHeapUsage usedSize. One startup/5-minute pair per arm/surface/scale is an observation, not leak evidence. Memory runs use meter:flatblock and do not contribute timings.','','| Arm | Surface | Scale | Startup MiB | Five minutes MiB | Duration s | Action groups |','|---|---|---:|---:|---:|---:|---:|'])
for run in valid:
    if 'heapFiveMinutes' in run:lines.append('| '+' | '.join(map(str,[run['arm'],run['surface'],run['scale'],fmt(run['heapStartup']['usedSize']/1048576),fmt(run['heapFiveMinutes']['usedSize']/1048576),fmt(run['heapUse']['durationSeconds']),run['heapUse']['actions']]))+' |')
lines.extend(['','| Surface | Scale | NEW arm | OLD startup MiB | NEW startup MiB | Change | OLD five-minute MiB | NEW five-minute MiB | Change |','|---|---:|---|---:|---:|---:|---:|---:|---:|'])
for item in heap_comparisons:
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['newArm'],fmt(item['oldStartupMiB']),fmt(item['newStartupMiB']),percent(item['startupChangePercent']),fmt(item['oldFiveMinuteMiB']),fmt(item['newFiveMinuteMiB']),percent(item['fiveMinuteChangePercent'])]))+' |')
lines.extend(['','## Action gaps and defects','','OLD phone fails during startup at both 1x and 4x with React error 185, before a usable Work screen. The control-only fixture with two issues can boot, so this is a failure of OLD with this shared corpus, not evidence that every historical phone installation failed. The recorded failure is POD-5505. [React error 185](https://react.dev/errors/185) identifies excessive nested updates.','', 'Consequently OLD has **no phone latency, action CPU, incoming-update CPU, connected-idle CPU, startup heap or five-minute heap comparison** at either requested scale. The unavailable OLD phone actions are cold start, warm start, Work, Tasks/issue screen, mission open, mission details, issue open, parent-picker search, Work search, rename, composer typing and long-press. NEW phone numbers are standalone measurements, never relative wins.','', 'Inbox has no production route/tab in the measured revisions. Its detached component is excluded. The desktop session Chat composer is not available in the isolated agent fixture, despite advertising transcript capability; its typing latency is unavailable in both arms. The desktop global Superagent composer and phone mission composer are measured. This leaves session Chat typing and Inbox performance unresolved.',''])
gaps=collections.defaultdict(set)
for run in measured:
    for gap in run.get('unavailable',[]):gaps[(run['arm'],run['surface'],run['scale'],gap['action'])].add(gap['reason'].splitlines()[0])
for (arm,surface,scale,action),reasons in sorted(gaps.items()):
    lines.append(f'- {arm.upper()} {surface} {scale}x: **{action}** — '+ '; '.join(sorted(reasons)))
lines.extend(['','Individual failed attempts, diagnostics, exclusions and exact errors remain in the run ledger and raw files. Long-press includes the product’s 500 ms gesture threshold. Rename starts at submit, after title entry; drag drop starts at pointer release, with drag initiation reported separately. Search starts with the input event that replaces the query and ends only after matching results replace the previous results. Sidebar selection includes issue switching; small mission switching additionally waits for the target mission’s session deck. Mutation and session actions use two small real control missions. The separate large-mission action selects the two largest corpus root trees by assigned descendant sessions; target IDs and actual rendered issue/session counts are recorded. Project folding targets a populated group from the largest root’s corpus repository, not an empty discovered repository.',''])
lines.extend(['The first current OLD and NEW 1x large-mission attempts loaded the same incorrect collector witness: the mission root is a header, while the tested row attribute belongs to its children. Those attempts have no large-mission latency and remain collector failures, not application defects. Corrected second rounds supply eight samples for each arm in that cell. Other actions from the first runs remain valid.','', 'The first 1x background windows are excluded from background comparisons because OLD issue updates omitted the legacy issue row and the action workflow could leave different resident panes. Four dedicated background-only captures repeat OLD/NEW/OLD/NEW with complete logical issue updates and fresh matched UI contexts. All later background windows use that corrected recipe. Original observations remain raw; these are collector corrections, not product changes.',''])
lines.extend(['The first OLD 4x run also lost sidebar-selection samples when its unmeasured preparation exceeded the initial 10-second allowance. Its first large-root selector chose i4089, whose deferUntil is in November; the Work sidebar correctly hides that mission. Later collectors allow 60 seconds for preparation and choose the two largest roots that are not deferred or tucked. The project-fold corpus repository stays unchanged. The table reports available counts for those two cells. These missing attempts do not enter latency statistics.',''])
lines.extend(['The first OLD 4x run finished its action phase but failed background preparation because readiness expected the original title after optimistic rename. Its 220 completed action observations remain valid; its failed background preparation contributes no CPU windows. The contemporary NEW background window is excluded with it. A separate OLD/NEW background pair replaces that first 4x pair, alongside the normal second pair. Later readiness uses the stable issue ID and resets the title after the complete action phase.',''])
lines.extend(['','Rendered DOM counts describe the work selected by each revision; they are not viewport-visible counts. The group anchor is chosen from the largest root’s corpus repository. Small differences in row counts and display labels are part of this release comparison, not a claim of identical DOM work.','','| Arm | Scale | Round | Group anchor | Group rows | Group label | Large root | Large issue rows | Large session rows |','|---|---:|---:|---|---:|---|---|---:|---:|'])
for run in valid:
    if run['surface']!='web' or run.get('backgroundOnly') or run['mode']!='timing':continue
    group=run.get('sidebarGroupTarget',{})
    targets={row.get('targetIssueId'):(row.get('deckIssueRows'),row.get('deckSessionRows')) for row in run['actions'] if row['action']=='large-mission-switch'} or {'—':('—','—')}
    for target,(issues,sessions) in targets.items():
        lines.append('| '+' | '.join(map(str,[run['arm'],run['scale'],run['round'],group.get('anchorIssueId','—'),group.get('initialRows','—'),group.get('label','—'),target,issues,sessions]))+' |')
lines.extend(['','## Run order, provenance, host load','','Runs execute sequentially on flatblock, one implementation per process. Leases are taken on ludovico after server/browser preparation, released as soon as capture ends. A fresh browser context means cold start; reload of that profile means warm start. Pixel 7 Chromium emulation is phone web evidence, not physical Android/native performance. No CPU or network throttle is applied. No product source is changed. No full test suite runs.','','| Started UTC | Mode | Arm | Surface | Scale | Round | Status | Purpose / exclusions | Load start (1/5/15m) | Load end | Browser |','|---|---|---|---|---:|---:|---|---|---|---|---|'])
for run in sorted(runs,key=lambda r:r['startedAt']):lines.append('| '+' | '.join(map(str,[run.get('captureStartedAt',run['startedAt']),run['mode'],run['arm'],run['surface'],run['scale'],run['round'],run['status'],run.get('purpose','legacy diagnostic')+('; background excluded' if run.get('backgroundSuperseded') else '')+('; background only' if run.get('backgroundOnly') else '')+('; action phase retained' if run['status']!='complete' and run.get('actionPhaseComplete') else ''),', '.join(fmt(n) for n in run.get('captureLoadStart',run['loadStart'])),', '.join(fmt(n) for n in run.get('loadEnd',[])),run.get('browser','—')]))+' |')
lines.extend(['','Host CPU utilization below is the /proc/stat delta across capture, all logical cores; it includes other processes. It is separate from measured renderer CPU.','','| Arm | Surface | Scale | Round | CPU model | Logical cores | Host CPU busy % | Harness digest |','|---|---|---:|---:|---|---:|---:|---|'])
for run in measured:
    start,end=run.get('hostCpuStart'),run.get('hostCpuEnd')
    busy=None
    if start and end:
        delta=[b-a for a,b in zip(start[:8],end[:8])];total=sum(delta)
        if total>0:busy=100*(total-delta[3]-delta[4])/total
    lines.append('| '+' | '.join(map(str,[run['arm'],run['surface'],run['scale'],run['round'],run['cpu'],run['cores'],fmt(busy),run['harnessSha256'][:16]]))+' |')
lines.extend(['','## Evidence and reproduction','','Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are preserved in the isolated flatblock checkouts; their issue-attachment manifest is published with the final report.','','Preparation uses each arm’s own .toolchain/bun and checkout-local dependencies: bun run setup:worktree, then bun scripts/browser-lane.ts --build-only. old-vs-new-corpus.mjs serializes the OLD seed once and adapts that same JSON to NEW’s schema; old-vs-new.mjs validates the augmented stream through the production decoder before capture. Run old-vs-new-remote.py from ludovico with --arm, --surface, --scale, --mode and --round; it runs one foreground SSH process, acquires bench:flatblock for timing or meter:flatblock for heap/diagnostic captures, delivers the lease grant to the arm, and releases at CAPTURE_FINISHED. Timing rounds alternate OLD/NEW. All browser contexts and the recorded server PID are torn down before the next arm. Four cold/warm pairs per round are unprofiled; one additional pair and the last two repetitions of each action are profiled separately. Cold means fresh browser storage/cache against an already-running isolated server; warm means reload of that profile. Neither measures desktop sidecar spawn, a physical phone, network conditions or real agent startup. No test suite or product-code edits are part of these captures.',''])
lines.extend(['Startup ends at the first qualifying Paint after an unobscured task row appears inside the viewport and the boot splash is absent. It measures first task content, not completion of every asynchronous child or agent startup. The final action context additionally proves the complete requested corpus reached durable client storage. Warm reload retains storage and HTTP cache but still receives the same augmented bootstrap replay; it does not model a production cursor-resume optimization. Preparation waits may be longer than measured paint times: ordinary actionability permits 60 seconds after the first 4x OLD preparation exceeded the initial 10-second allowance, while semantic capture waits are 20 seconds after dispatch returns. Every failed attempt is retained.',''])
findings=pathlib.Path('docs/measurements/POD-4286-old-vs-new/findings.json')
operator_summary=json.loads(findings.read_text())['summary'] if findings.exists() else 'Measurement runs are in progress. No final verdict yet.'
lines=[line.replace('SUMMARY_PENDING',operator_summary) for line in lines]
pathlib.Path('docs/measurements/POD-4286-old-vs-new.md').write_text('\n'.join(lines))
rows=[]
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    fields=[item['surface'],f'{item["scale"]}x',item['action'],item['newArm'],f'{a.get("n",0)} / {b.get("n",0)}',fmt(a.get('median')),fmt(b.get('median')),fmt(a.get('p95')),fmt(b.get('p95')),fmt(a.get('max')),fmt(b.get('max')),percent(item['changePercent']),percent(item['p95ChangePercent']),item['verdict']]
    rows.append(f'<tr data-surface="{item["surface"]}" data-scale="{item["scale"]}" data-arm="{item["newArm"]}" data-verdict="{item["verdict"]}">'+''.join('<td>'+html.escape(str(value))+'</td>' for value in fields)+'</tr>')
headers=['Surface','Scale','Action','NEW arm','n OLD / NEW','OLD median','NEW median','OLD p95','NEW p95','OLD max','NEW max','Median change','p95 change','Verdict']
def detail_html(source):
    """Keep the numeric evidence readable in the standalone issue artifact."""
    blocks=[];index=0
    while index<len(source):
        line=source[index]
        if line.startswith('| '):
            table=[]
            while index<len(source) and source[index].startswith('|'):
                row=source[index]
                if not set(row)<=set('|-: '):
                    table.append([cell.strip() for cell in row.strip('|').split('|')])
                index+=1
            if table:
                blocks.append('<div class="evidence-table"><table><thead><tr>'+''.join('<th>'+html.escape(cell)+'</th>' for cell in table[0])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+html.escape(cell)+'</td>' for cell in row)+'</tr>' for row in table[1:])+'</tbody></table></div>')
            continue
        if line.startswith('## '):blocks.append('<h2>'+html.escape(line[3:])+'</h2>')
        elif line:blocks.append('<p>'+html.escape(line)+'</p>')
        index+=1
    return ''.join(blocks)
report_details='<details><summary>CPU, updates, heap, coverage and provenance</summary>'+detail_html(lines[lines.index('## Main-thread work per action'):])+'</details>'
page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLD versus NEW app comparison</title><style>body{font:15px/1.5 system-ui;margin:24px;color:#16202c;background:#f7f8fa}h1{font-size:25px}table{border-collapse:collapse;background:white;width:100%}th,td{padding:9px 12px;border-bottom:1px solid #dee4e9;text-align:right;white-space:nowrap}td:first-child,td:nth-child(3),td:last-child{text-align:left}th{position:sticky;top:0;background:#e9eef3;cursor:pointer}tr[data-verdict="slower"] td:last-child{color:#b42318}tr[data-verdict="faster"] td:last-child{color:#067647}button,select,input{font:inherit;padding:7px;margin-right:10px}#table{overflow:auto;max-height:75vh}p{max-width:1000px}pre{white-space:pre-wrap;font:12px/1.6 ui-monospace;background:white;padding:16px}details{margin-top:24px}.evidence-table{overflow:auto;margin:18px 0}.evidence-table td{text-align:left}h2{font-size:20px}</style><h1>Was the MobX rewrite worth it?</h1><p id="summary">SUMMARY_PENDING</p><p>Unprofiled production Chromium input to qualifying Paint (or separately labelled compositor frame for cached Work), in milliseconds. Lower is better. A negative change is an improvement. Pixel 7 means phone web emulation. Missing evidence is never scored as a win.</p><label>Surface <select id="surface"><option value="">All</option><option selected>web</option><option>phone</option></select></label><label>Scale <select id="scale"><option value="">Both</option><option value="1" selected>1x</option><option value="4">4x</option></select></label><label>NEW build <select id="arm">ARM_OPTIONS</select></label><input id="search" placeholder="Find an action"><div id="table"><table><thead><tr>'''+''.join('<th>'+x+'</th>' for x in headers)+'''</tr></thead><tbody>'''+''.join(rows)+'''</tbody></table></div><p>±10% is a descriptive band, not a confidence interval. See the Markdown report for CPU, heap, SHAs, load, failures and coverage limits. Raw observations are retained.</p>'''+report_details+'''<script>const body=document.querySelector('tbody'),surface=document.getElementById('surface'),scale=document.getElementById('scale'),search=document.getElementById('search'),arm=document.getElementById('arm');function filter(){for(const row of body.rows)row.hidden=(surface.value&&row.dataset.surface!==surface.value)||(scale.value&&row.dataset.scale!==scale.value)||(arm.value&&row.dataset.arm!==arm.value)||!row.textContent.toLowerCase().includes(search.value.toLowerCase())}for(const id of ['surface','scale','search','arm'])document.getElementById(id).addEventListener('input',filter);document.querySelectorAll('#table th').forEach((head,index)=>head.addEventListener('click',()=>{const ascending=head.dataset.order!=='up';head.dataset.order=ascending?'up':'down';const rows=[...body.rows].sort((a,b)=>{const x=a.cells[index].textContent,y=b.cells[index].textContent;const nx=parseFloat(x.replaceAll(',','')),ny=parseFloat(y.replaceAll(',',''));return(ascending?1:-1)*(Number.isFinite(nx)&&Number.isFinite(ny)?nx-ny:x.localeCompare(y))});body.append(...rows)}));filter();</script></html>'''
page=page.replace('SUMMARY_PENDING',html.escape(operator_summary)).replace('ARM_OPTIONS',''.join('<option value="'+html.escape(arm)+'"'+(' selected' if index==0 else '')+'>'+arm_labels.get(arm,arm)+'</option>' for index,arm in enumerate(new_arms)))
pathlib.Path('docs/measurements/POD-4286-old-vs-new.html').write_text(page)
print(json.dumps({'runs':len(runs),'complete':len(completed),'partialActions':summary['partialActionRuns'],'comparisonCells':len(metrics)}))
