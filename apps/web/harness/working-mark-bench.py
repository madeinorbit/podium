#!/usr/bin/env python3
"""Native-key working-mark comparisons through Safari/Chrome WebDriver.

Run FOREGROUND on the owned benchmark host under its Podium bench lease.
Use an already created driver session and explicitly recorded WebContent or
renderer PIDs; this collector never starts or kills browsers or processes.
All captures are gzip-compressed at creation, including failure evidence.
This synthetic 32-mark fixture isolates animation cost; it is not full-app
acceptance. Safari numbers must come from Safari, never Playwright WebKit.
"""
import argparse
import atexit
import base64
import ctypes
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def request(base, method, path, body=None, timeout=120):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=encoded, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value = result.get('value')
    if isinstance(value, dict) and value.get('error'):
        raise RuntimeError(value)
    return value


def park_on_exit(base, out):
    """Stop the owned fixture drawing before a finished collector yields control.

    Browser/preview termination remains the explicit recorded-PID handoff. This
    single final platform hide prevents active marks burning CPU in that gap.
    """
    def park():
        record = {'startedAt': time.time()}
        try:
            record['parked'] = request(base, 'POST', '/execute/sync', {
                'script': "if(window.__workingMarkFixture?.bench!==true)throw Error('Expected owned mark fixture');document.body.style.display='none';return true",
                'args': []}, timeout=10)
        except Exception as error:
            record['error'] = str(error)
        record['endedAt'] = time.time()
        with gzip.open(out / 'fixture-park.json.gz', 'wt') as file:
            json.dump(record, file, separators=(',', ':'))
    atexit.register(park)


def summary(values):
    values = sorted(values)
    return {'count': len(values), 'median': values[len(values) // 2],
            'p95': values[math.ceil(len(values) * .95) - 1], 'max': values[-1]} if values else None


def cpu_seconds(pids):
    result = {}
    if platform.system() == 'Darwin':
        class Timebase(ctypes.Structure):
            _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
        timebase = Timebase()
        ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(timebase))
        for pid in pids:
            usage = ctypes.create_string_buffer(512)
            if libproc.proc_pid_rusage(pid, 2, usage) != 0:
                raise RuntimeError(f'Recorded WebContent PID {pid} exited; CPU attribution is invalid')
            # rusage_info_v2's user/system CPU time includes exited threads.
            result[pid] = sum(ctypes.c_uint64.from_buffer(usage, offset).value for offset in (16, 24)) * timebase.numer / timebase.denom / 1e9
    elif platform.system() == 'Linux':
        hz = os.sysconf('SC_CLK_TCK')
        for pid in pids:
            # comm may contain spaces/parentheses. Fields after its last ')'
            # start at field 3; utime/stime are fields 14/15.
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            result[pid] = (int(fields[11]) + int(fields[12])) / hz
    else:
        raise RuntimeError('No high-resolution process CPU sampler for this platform')
    return result


def ps_cpu_seconds(pid):
    """Cumulative CPU of any process, including other users' (WindowServer), at ps's 10 ms resolution."""
    text = subprocess.check_output(['ps', '-o', 'time=', '-p', str(pid)], text=True, timeout=10).strip()
    days, _, clock = text.rpartition('-')
    seconds = 0.0
    for part in clock.split(':'):
        seconds = seconds * 60 + float(part)
    return seconds + (int(days) * 86400 if days else 0)


class ThreadInfo(ctypes.Structure):
    # struct proc_threadinfo (sys/proc_info.h); times are nanoseconds.
    _fields_ = [('user', ctypes.c_uint64), ('system', ctypes.c_uint64), ('cpu_usage', ctypes.c_int32),
                ('policy', ctypes.c_int32), ('run_state', ctypes.c_int32), ('flags', ctypes.c_int32),
                ('sleep_time', ctypes.c_int32), ('curpri', ctypes.c_int32), ('priority', ctypes.c_int32),
                ('maxpriority', ctypes.c_int32), ('name', ctypes.c_char * 64)]


def thread_cpu(pid):
    """Per-thread CPU seconds and names of one of our own processes (Darwin): main thread vs compositor."""
    if platform.system() != 'Darwin':
        return {}
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    handles = (ctypes.c_uint64 * 4096)()
    got = libproc.proc_pidinfo(pid, 6, 0, handles, ctypes.sizeof(handles))  # PROC_PIDLISTTHREADS
    result = {}
    for handle in handles[:max(0, got) // 8]:
        info = ThreadInfo()
        if libproc.proc_pidinfo(pid, 5, handle, ctypes.byref(info), ctypes.sizeof(info)) == ctypes.sizeof(info):  # PROC_PIDTHREADINFO
            result[handle] = {'name': info.name.decode(errors='replace'), 'seconds': (info.user + info.system) / 1e9}
    return result


def resource_usage(pid):
    """Memory footprint, wakeups and energy of one of our own processes (Darwin rusage_info_v4)."""
    if platform.system() != 'Darwin':
        return None
    usage = ctypes.create_string_buffer(512)
    if ctypes.CDLL('/usr/lib/libproc.dylib').proc_pid_rusage(pid, 4, usage) != 0:
        return None
    field = lambda offset: ctypes.c_uint64.from_buffer(usage, offset).value
    return {'idleWakeups': field(32), 'interruptWakeups': field(40), 'footprintBytes': field(72),
            'instructions': field(248), 'cycles': field(256), 'billedEnergyNj': field(264)}


def usage_rates(before, after, wall):
    """Footprint at the end of the window; wakeups, energy and instructions per second over it."""
    if not before or not after:
        return None
    rate = lambda key: (after[key] - before[key]) / wall
    return {'footprintMiB': after['footprintBytes'] / 2**20, 'idleWakeupsPerSecond': rate('idleWakeups'),
            'interruptWakeupsPerSecond': rate('interruptWakeups'), 'billedEnergyMilliwatts': rate('billedEnergyNj') / 1e6,
            'instructionsPerSecond': rate('instructions')}


def thread_split(before, after, wall):
    """Percent of one core per thread over the window, busiest first; names repeat, so keep handles apart."""
    rows = [{'name': info['name'] or '(unnamed)', 'percent': (info['seconds'] - before[handle]['seconds']) / wall * 100}
            for handle, info in after.items() if handle in before]
    return sorted((row for row in rows if row['percent'] > .005), key=lambda row: -row['percent'])[:8]


def helper_processes(safari_owner_pid=None, chrome_profile=None):
    """The other processes that draw this page: the browser application, its GPU process and WindowServer."""
    lines = subprocess.check_output(['ps', '-axww', '-o', 'pid=,ppid=,command='], text=True, timeout=10).splitlines()
    processes = {int(pid): {'parent': int(parent), 'command': command} for pid, parent, command in
                 (line.strip().split(None, 2) for line in lines if line.strip())}
    roles = {}
    servers = [pid for pid, info in processes.items() if info['command'].split()[0].endswith('/WindowServer')]
    if len(servers) == 1:
        roles['windowserver'] = servers[0]
    if safari_owner_pid is not None:
        roles['browser'] = safari_owner_pid
        responsible = ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
        responsible.argtypes = [ctypes.c_int]
        responsible.restype = ctypes.c_int
        gpu = [pid for pid, info in processes.items()
               if info['command'].split()[0].endswith('/com.apple.WebKit.GPU') and responsible(pid) == safari_owner_pid]
        if len(gpu) == 1:
            roles['gpu'] = gpu[0]
    if chrome_profile is not None:
        marker = '--user-data-dir=' + str(chrome_profile.resolve())
        owned = {pid for pid, info in processes.items() if marker in info['command'].split()}
        while True:
            children = {pid for pid, info in processes.items() if info['parent'] in owned}
            if children <= owned:
                break
            owned |= children
        browsers = [pid for pid in owned if not any(part.startswith('--type=') for part in processes[pid]['command'].split())]
        gpus = [pid for pid in owned if '--type=gpu-process' in processes[pid]['command'].split()]
        if len(browsers) == 1:
            roles['browser'] = browsers[0]
        if len(gpus) == 1:
            roles['gpu'] = gpus[0]
    return roles


def helper_cpu(roles):
    result = {}
    for role, pid in roles.items():
        try:
            # WindowServer belongs to another user, so proc_pid_rusage cannot read it; ps can.
            result[role] = ps_cpu_seconds(pid) if role == 'windowserver' else cpu_seconds([pid])[pid]
        except Exception:
            result[role] = None
    return result


def safari_webcontent(owner_pid):
    """Use macOS responsibility, not launchd parentage, to identify our Safari group."""
    if platform.system() != 'Darwin':
        raise RuntimeError('Safari responsibility attribution requires macOS')
    lines = subprocess.check_output(['ps', '-axww', '-o', 'pid=,command='], text=True, timeout=10).splitlines()
    processes = {int(pid): command for pid, command in
                 (line.strip().split(None, 1) for line in lines if line.strip())}
    owner = processes.get(owner_pid, '')
    if not owner.split(None, 1)[0:1] or not owner.split(None, 1)[0].endswith('/Safari.app/Contents/MacOS/Safari'):
        raise RuntimeError('Recorded Safari application is no longer present')
    responsible = ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
    responsible.argtypes = [ctypes.c_int]
    responsible.restype = ctypes.c_int
    cohort = {pid: {'command': command, 'responsiblePid': owner_pid}
              for pid, command in processes.items()
              if command.split(None, 1)[0].endswith('/com.apple.WebKit.WebContent') and responsible(pid) == owner_pid}
    if not cohort:
        raise RuntimeError('No WebContent process belongs to the recorded Safari automation application')
    return {'owner': {'pid': owner_pid, 'command': owner}, 'processes': cohort}


def chrome_renderers(profile):
    """Refresh only the renderer descendants of this run's private Chrome profile."""
    lines = subprocess.check_output(['ps', '-axww', '-o', 'pid=,ppid=,command='], text=True, timeout=10).splitlines()
    processes = {int(pid): {'parent': int(parent), 'command': command} for pid, parent, command in
                 (line.strip().split(None, 2) for line in lines if line.strip())}
    marker = '--user-data-dir=' + str(profile.resolve())
    owned = {pid for pid, info in processes.items() if marker in info['command'].split()}
    while True:
        children = {pid for pid, info in processes.items() if info['parent'] in owned}
        if children <= owned:
            break
        owned |= children
    cohort = {pid: processes[pid] for pid in owned if '--type=renderer' in processes[pid]['command'].split()}
    if not cohort:
        raise RuntimeError('No renderer belongs to the recorded private Chrome profile')
    return {'profile': str(profile.resolve()), 'processes': cohort}


def fixture_process(execute, owned_cohort):
    """Identify this exact page with a controlled CPU burst before warm-up/timing."""
    cohort = owned_cohort()
    before = cpu_seconds(sorted(cohort['processes']))
    probe = execute("""
if(window.__workingMarkFixture?.bench!==true)throw Error('Expected owned mark fixture');
const started=performance.now();let iterations=0;
while(performance.now()-started<500)iterations++;
return {elapsedMs:performance.now()-started,iterations,href:location.href};
""")
    after = {}
    for pid in cohort['processes']:
        try:
            after[pid] = cpu_seconds([pid])[pid]
        except (RuntimeError, FileNotFoundError):
            # A spare may exit; it cannot have executed this completed page probe.
            continue
    delta = {pid: after[pid] - before[pid] for pid in after}
    # The page busy-loops for 0.5 s, and on a loaded machine it gets less CPU than that; it must still stand out.
    ranked = sorted(delta.items(), key=lambda item: -item[1])
    if not ranked or ranked[0][1] < .2 or (len(ranked) > 1 and ranked[1][1] * 4 > ranked[0][1]):
        raise RuntimeError(f'Controlled page CPU attribution is ambiguous: {delta}')
    selected = [ranked[0][0]]
    current = owned_cohort()
    pid = selected[0]
    if pid not in current['processes']:
        raise RuntimeError('Identified fixture process no longer belongs to the recorded browser')
    return {**current, 'processes': {pid: current['processes'][pid]},
            'probe': probe, 'probeCpuSeconds': delta, 'outsideTimedPhase': True}


ENVIRONMENT = r"""
const fixture = window.__workingMarkFixture;
if (!fixture?.bench) throw Error('Expected isolated working-mark benchmark fixture');
const ta = document.querySelector('#composer'); ta.focus();
const viewport = [innerWidth, innerHeight];
const cells = [...document.querySelectorAll('#roster .mark')];
// Snapshot only, BEFORE warming and CPU collection. No recurring observation.
const visible = fixture.mode === 'visible' ? cells.filter(cell => {
  const r = cell.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
}).length : 0;
return {fixture, userAgent: navigator.userAgent, viewport, devicePixelRatio,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  visibility: document.visibilityState, focused: document.hasFocus(),
  marks: cells.length, visibleMarks: visible, domNodes: document.querySelectorAll('*').length,
  // checkVisibility tests skipped ANCESTORS. The row itself still has a box;
  // ask its child mark, not the content-visibility container.
  checkVisibilitySupported: typeof cells[0]?.checkVisibility === 'function',
  marksSkippedOrHidden: typeof cells[0]?.checkVisibility === 'function' ? cells.filter(cell=>!cell.checkVisibility({contentVisibilityAuto:true})).length : null,
  contentVisibilitySupported: CSS.supports('content-visibility', 'auto'),
  failedImages: [...document.querySelectorAll('img')].filter(i=>!i.complete || !i.naturalWidth).length,
  // On screen, a video that can't show a frame, or that the browser left paused (not the page's idle pause), counts as
  // failed. Off screen and hidden, browsers may leave muted autoplay video paused: that is the platform skipping it.
  failedVideos: fixture.mode !== 'visible' ? 0 : [...document.querySelectorAll('video')].filter(v=>v.error || v.readyState < 2 || (v.paused && !fixture.idleLog?.at(-1)?.on)).length};
"""

VIDEOS_WAITING = r"""
const f = window.__workingMarkFixture;
return [...document.querySelectorAll('video')].filter(v=>!v.error && (v.readyState < 2 || (v.paused && !f.idleLog?.at(-1)?.on))).length;
"""

PROBE = r"""
const ta = document.querySelector('#composer');
const p = window.__markTyping = {samples: [], drift: [], active: true, start: performance.now()};
const listen = event => {
  if (event.target !== ta || !event.isTrusted) return;
  const sample = {index: p.samples.length, timestamp: event.timeStamp, dispatch: performance.now(), length: ta.value.length, data: event.data};
  p.samples.push(sample);
  requestAnimationFrame(frame => {
    sample.frame = performance.now(); sample.frameTimestamp = frame;
    setTimeout(()=>{ sample.postPaint=performance.now(); sample.latency=sample.postPaint-sample.timestamp; }, 0);
  });
};
document.addEventListener('input', listen, true);
let previous = performance.now();
const drift = () => {
  if (!p.active) return;
  const now=performance.now(); p.drift.push({at:now, delay:Math.max(0,now-previous-4)});
  previous=now; p.timer=setTimeout(drift,4);
};
p.timer=setTimeout(drift,4);
p.stop=()=>{p.active=false;clearTimeout(p.timer);document.removeEventListener('input',listen,true)};
return true;
"""


def bring_forward(args):
    """Put the measured browser in front again before an arm; a system alert can take the front meanwhile."""
    if platform.system() != 'Darwin':
        return
    if args.safari_owner_pid is not None:
        subprocess.run(['open', '-a', 'Safari'], check=True, timeout=20)
    elif args.chrome_app is not None:
        subprocess.run(['open', '-a', str(args.chrome_app)], check=True, timeout=20)
    time.sleep(.5)


def focused(execute, allow_unfocused=False):
    state = execute('return {visible:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.id}')
    if state != {'visible': 'visible', 'focused': True, 'active': 'composer'}:
        # A system alert on the runner's screen can hold keyboard focus. Keys are still injected into the
        # visible page; record the state so every arm's conditions are on file, and keep them equal.
        if not allow_unfocused or state.get('visible') != 'visible' or state.get('active') != 'composer':
            raise RuntimeError(f'Foreground focused composer required: {state}')
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--pid', type=int, action='append', required=True, help='Recorded owned renderer/WebContent PID; repeat for its cohort')
    parser.add_argument('--safari-owner-pid', type=int, help='Newly created, recorded Safari --automation application; refresh its owned WebContent group for each arm')
    parser.add_argument('--chrome-profile', type=Path, help='Recorded private Chrome profile; refresh its owned renderer group for each arm')
    parser.add_argument('--chrome-app', type=Path, help='The private Chrome application bundle, brought to the front before each arm')
    parser.add_argument('--allow-unfocused', action='store_true', help='Run with a visible but unfocused window (a system alert holds focus); the state is recorded per arm')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--candidates', default='static,breathe,static,signal,static,apng,static,webp,static')
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--mode', choices=['visible', 'offscreen', 'hidden'], default='visible')
    parser.add_argument('--count', type=int, default=32)
    parser.add_argument('--idle-seconds', type=float, default=30)
    parser.add_argument('--viewport', default='800x600')
    parser.add_argument('--reduced', action='store_true')
    parser.add_argument('--expect-motion', choices=['reduce', 'no-preference'], help='Assert the media query, independently of the manual preview override')
    parser.add_argument('--light', action='store_true')
    parser.add_argument('--skip-typing', action='store_true', help='Idle/visibility arm only')
    parser.add_argument('--capture', action='store_true', help='Capture a compressed PNG per option outside timed phases')
    parser.add_argument('--asset-manifest', type=Path)
    parser.add_argument('--source-file', type=Path, help='Exact served self-contained HTML for byte provenance')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    base = args.driver.rstrip('/') + '/session/' + args.session
    park_on_exit(base, args.out)
    execute = lambda script, *values: request(base, 'POST', '/execute/sync', {'script': script, 'args': values})
    text = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefgh'
    candidates = args.candidates.split(',')
    if any(not re.fullmatch(r'static|breathe|signal|apng|webp|[a-z0-9-]+\.(dots|flip|img|best|steps|sprite|canvas|image|worker|apng|webp|avif|svg|gif|mp4|webm|mov)(@\d+)?(\+css)?(\+waapi)?(\+noio)?(\+nocv)?(\+sentinel)?(\+fps(\d+|auto))?(\+loop\d+)?(\+mirror)?(\+layer)?(\+idle\d+)?', key) for key in candidates):
        raise RuntimeError('Unknown candidate')
    machine = {'system': platform.platform(), 'host': platform.node(), 'pids': args.pid,
               'processes': subprocess.check_output(['ps', '-p', ','.join(map(str, args.pid)), '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], text=True)}
    manifest = json.loads(args.asset_manifest.read_text()) if args.asset_manifest else None
    source_hash = hashlib.sha256(args.source_file.read_bytes()).hexdigest() if args.source_file else None
    all_results = []
    failed = 0
    for repeat in range(args.repeat):
        # Alternate order to expose drift rather than hiding it in one baseline.
        order = candidates if repeat % 2 == 0 else list(reversed(candidates))
        for index, candidate in enumerate(order):
            label = f'{args.mode}-{args.count}-{candidate}-{repeat + 1}-{index + 1}' + ('-reduce' if args.reduced else '') + ('-media-reduce' if args.expect_motion == 'reduce' else '')
            result = {'sha': args.sha, 'candidate': candidate, 'repeat': repeat + 1, 'order': index + 1,
                      'mode': args.mode, 'startedAt': time.time(), 'machine': machine, 'assets': manifest, 'htmlSha256': source_hash,
                      'loadAtStart': os.getloadavg(),
                      'cpuUnits': 'percent of one CPU core, cumulative process CPU / monotonic wall time',
                      'latencyUnits': 'trusted input event timestamp to rAF then zero-delay timer; paint proxy, milliseconds'}
            try:
                params = {'bench': '1', 'candidate': candidate, 'visibility': args.mode, 'count': args.count}
                if args.reduced:
                    params['reduce'] = '1'
                if args.light:
                    params['light'] = '1'
                url = args.url + ('&' if '?' in args.url else '?') + urllib.parse.urlencode(params)
                request(base, 'POST', '/url', {'url': url})
                width, height = map(int, args.viewport.split('x'))
                result['windowResize'] = []
                for attempt in range(3):
                    viewport = execute('return [innerWidth,innerHeight]')
                    if viewport == [width, height]:
                        break
                    rect = request(base, 'GET', '/window/rect')
                    resized = request(base, 'POST', '/window/rect', {'x': 0, 'y': 0, 'width': rect['width'] + width - viewport[0], 'height': rect['height'] + height - viewport[1]})
                    result['windowResize'].append({'beforeViewport': viewport, 'beforeRect': rect, 'returnedRect': resized})
                    time.sleep(.35)
                # Navigation/load and resize need not include a rendering update.
                # Let the platform determine content-visibility proximity first.
                bring_forward(args)
                execute("document.querySelector('#composer').focus(); return null")
                time.sleep(1)
                # Video marks: wait (outside the timed phases) until every on-screen video shows frames.
                for _ in range(40):
                    if args.mode != 'visible' or not execute(VIDEOS_WAITING):
                        break
                    time.sleep(.25)
                result['environment'] = execute(ENVIRONMENT)
                env = result['environment']
                if args.expect_motion is not None and env['reducedMotion'] != (args.expect_motion == 'reduce'):
                    raise RuntimeError(f'Requested media preference was not obtained: {env}')
                if env['fixture']['candidate'] != candidate or env['marks'] != args.count or env['failedImages'] or env.get('failedVideos'):
                    raise RuntimeError(f'Fixture is incomplete: {env}')
                if args.mode == 'visible' and env['visibleMarks'] < 24:
                    raise RuntimeError(f'Need at least 24 fully visible marks: {env}')
                if env['viewport'] != [width, height]:
                    raise RuntimeError('Requested content viewport was not obtained')
                if args.mode != 'visible' and env['marksSkippedOrHidden'] != args.count:
                    raise RuntimeError(f'Platform skipping is not established for every mark: {env}')
                result.setdefault('focusStates', []).append(focused(execute, args.allow_unfocused))
                if args.safari_owner_pid is not None:
                    result['idleProcessCohort'] = fixture_process(execute, lambda: safari_webcontent(args.safari_owner_pid))
                elif args.chrome_profile is not None:
                    result['idleProcessCohort'] = fixture_process(execute, lambda: chrome_renderers(args.chrome_profile))
                # No rAF probes, drift timers, visibility/style queries or driver
                # commands during idle. Process TIME resolution is retained.
                time.sleep(3)
                idle_pids = args.pid
                if args.safari_owner_pid is not None or args.chrome_profile is not None:
                    idle_pids = sorted(result['idleProcessCohort']['processes'])
                roles = helper_processes(args.safari_owner_pid, args.chrome_profile)
                result['helperPids'] = roles
                # WindowServer belongs to another user; its footprint and wakeups are not readable.
                usage_pids = {**{f'page:{pid}': pid for pid in idle_pids}, **{role: pid for role, pid in roles.items() if role != 'windowserver'}}
                usage_before = {key: resource_usage(pid) for key, pid in usage_pids.items()}
                helpers_before = helper_cpu(roles)
                threads_before = {pid: thread_cpu(pid) for pid in idle_pids}
                result['cpuBefore'] = cpu_seconds(idle_pids)
                result['idleStartedAt'] = time.time()
                start = time.monotonic()
                time.sleep(args.idle_seconds)
                result['cpuAfter'] = cpu_seconds(idle_pids)
                threads_after = {pid: thread_cpu(pid) for pid in idle_pids}
                helpers_after = helper_cpu(roles)
                usage_after = {key: resource_usage(pid) for key, pid in usage_pids.items()}
                result['idleEndedAt'] = time.time()
                result['idleWallSeconds'] = time.monotonic() - start
                result['resourceUsage'] = {key: usage_rates(usage_before[key], usage_after[key], result['idleWallSeconds']) for key in usage_pids}
                result['idleCpuPercent'] = sum(result['cpuAfter'][pid] - result['cpuBefore'][pid] for pid in idle_pids) / result['idleWallSeconds'] * 100
                result['helperCpuPercent'] = {role: (helpers_after[role] - helpers_before[role]) / result['idleWallSeconds'] * 100
                                              for role in roles if helpers_before.get(role) is not None and helpers_after.get(role) is not None}
                result['threadCpuPercent'] = {pid: thread_split(threads_before[pid], threads_after[pid], result['idleWallSeconds']) for pid in idle_pids}
                result['totalCpuPercent'] = result['idleCpuPercent'] + sum(result['helperCpuPercent'].values())
                if args.safari_owner_pid is not None or args.chrome_profile is not None:
                    result['idleProcessCohortAfter'] = (safari_webcontent(args.safari_owner_pid) if args.safari_owner_pid is not None
                                                       else chrome_renderers(args.chrome_profile))
                    after_pids = set(result['idleProcessCohortAfter']['processes'])
                    if not set(idle_pids) <= after_pids:
                        raise RuntimeError('Owned rendering process group changed during idle; CPU attribution is invalid')
                result['loadAfterIdle'] = os.getloadavg()
                result.setdefault('focusStates', []).append(focused(execute, args.allow_unfocused))
                if not args.skip_typing:
                    result['typingStartedAt'] = time.time()
                    execute(PROBE)
                    element = request(base, 'POST', '/element', {'using': 'css selector', 'value': '#composer'})
                    element_id = element['element-6066-11e4-a52e-4f735466cecf']
                    next_key = time.monotonic()
                    for char in text:
                        request(base, 'POST', '/element/' + element_id + '/value', {'text': char, 'value': [char]})
                        next_key = max(next_key + .1, time.monotonic())
                        time.sleep(max(0, next_key - time.monotonic()))
                    time.sleep(.3)
                    result['raw'] = execute("const p=window.__markTyping;p.stop();return {samples:p.samples,drift:p.drift,value:document.querySelector('#composer').value,idleLog:window.__workingMarkFixture.idleLog||null}")
                    samples = result['raw']['samples']
                    if len(samples) != 60 or result['raw']['value'] != text or any('latency' not in s for s in samples):
                        raise RuntimeError('Expected 60 trusted input events, intact final text and all post-frame samples')
                    result['inputToPostPaintMs'] = summary([s['latency'] for s in samples])
                    result['timerDriftMs'] = summary([s['delay'] for s in result['raw']['drift']])
                    result['inputIntervalsMs'] = summary([b['timestamp'] - a['timestamp'] for a, b in zip(samples, samples[1:])])
                    result['typingEndedAt'] = time.time()
                    result.setdefault('focusStates', []).append(focused(execute, args.allow_unfocused))
                if args.capture and repeat == 0:
                    pixels = base64.b64decode(request(base, 'GET', '/screenshot'))
                    (args.out / f'{label}.png').write_bytes(pixels)
                    result['screenshotSha256'] = hashlib.sha256(pixels).hexdigest()
            except Exception as error:
                # Record the failed arm and go on with the next one; the summary leaves it out.
                result['error'] = str(error)
                failed += 1
            finally:
                result['endedAt'] = time.time()
                with gzip.open(args.out / f'{label}.json.gz', 'wt', encoding='utf-8') as file:
                    json.dump(result, file, separators=(',', ':'))
                compact = {key: result[key] for key in ('candidate', 'repeat', 'mode', 'idleCpuPercent', 'helperCpuPercent', 'totalCpuPercent', 'threadCpuPercent', 'resourceUsage', 'inputToPostPaintMs', 'error') if key in result}
                all_results.append(compact)
                print(json.dumps(compact), flush=True)
                with gzip.open(args.out / 'summary.json.gz', 'wt', encoding='utf-8') as file:
                    json.dump(all_results, file, separators=(',', ':'))
    return failed


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
