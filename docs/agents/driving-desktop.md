# Driving the desktop app headlessly (for agents)

How to run and drive the **Tauri desktop shell** on a Linux box with no display and no
root, so you can verify things only the real webview can answer. Written from actually
doing it on `flatblock` (POD-1996); every step below cost a real failed run.

## When this is worth it

Almost never for UI work — see [driving-podium.md](driving-podium.md) for the Playwright
harness, which is faster and reads the DOM. Reach for this **only** when the property
under test belongs to the desktop shell itself and no browser can stand in for it:

| Property | Why a browser can't answer it |
|---|---|
| Cross-origin behaviour of the bundled UI | All-in-one loads `tauri://localhost` and talks to a loopback backend. Nothing else produces that origin pair. |
| Cookie / credential behaviour in the webview | The page origin is not the server origin, so SameSite and third-party rules bite differently. |
| Sidecar spawn, supervision, respawn | `local_host_sidecar_command` and the respawn monitor only exist in the shell. |
| Which log sink the sidecar picks | It depends on how the shell spawns it (`PODIUM_DESKTOP_SUPERVISED`). |

**The two window shapes are different tests.** All-in-one loads the *bundled* UI
(`WebviewUrl::default()` → `tauri://localhost`) and injects `__PODIUM_SERVER__` pointing at
loopback; client/daemon modes load the relay's URL directly (`WebviewUrl::External`) and are
plain same-origin pages. A cross-origin bug reproduces in the first and is invisible in the
second — check `launch action:` in `desktop-native.ndjson` to know which one you ran.

## Isolation — read this before you start

The dev box runs a **live daemon paired to a real server**. The desktop shell spawns its
sidecar with `--takeover`, which is explicitly allowed to displace a live same-role
instance. Four variables, all of them, or you risk the user's daemon:

```bash
export PODIUM_STATE_DIR=$HOME/podium-desktop-test/state  # config.json, run registry, logs, sidecar cache
export PODIUM_INSTANCE=desktoptest                       # PORTS DERIVE FROM THIS — see below
export PODIUM_NO_RELAY=1                                 # your session belongs to instance 'default'
export PODIUM_ADOPT_STATE=1                              # see "guard rails" below
unset NOTIFY_SOCKET                                      # see "the logs went missing" below
```

`PODIUM_STATE_DIR` alone is **not enough**. Ports come from the *instance id*, not the state
dir: `default` derives `{server: 18787, hook: 45777, agentRelay: 45778}`, and 45777/45778 are
exactly what the live daemon holds. Without `PODIUM_INSTANCE` the test instance fights it and
logs `Failed to start server. Is port 45777 in use?`. Check your derivation before running:

```bash
bun -e "import('./packages/runtime/src/instance.ts').then(m =>
  console.log(m.defaultInstancePorts('desktoptest')))"
```

Both the Rust shell and the sidecar honour `PODIUM_STATE_DIR` (`bootstrap.rs::state_dir`
resolves it identically to the TS side), and the shell passes its whole environment through
to the sidecar, so exporting these once covers both processes.

### Guard rails you will hit, and what they mean

| Message | Cause | Answer |
|---|---|---|
| `this agent session belongs to instance 'default', not 'desktoptest'` | Your own Podium session's relay | `PODIUM_NO_RELAY=1` |
| `refusing to adopt non-empty state directory … for instance 'x'` | The sidecar materialises `bin/abduco` *before* the instance-identity check, so even a freshly-created dir is non-empty by the time it is checked | `PODIUM_ADOPT_STATE=1` |

## Getting a display without root

`apt install xvfb` needs sudo. If you have it, use it and skip this section. Without it,
extract the packages into a user prefix — but Xvfb needs one patch to work there.

```bash
mkdir -p ~/.local/opt/xvfb-dl && cd ~/.local/opt/xvfb-dl
apt-get download xvfb xserver-common xkb-data x11-xkb-utils libxfont2 libfontenc1 libxkbfile1 xdotool libxdo3 x11-apps
for d in *.deb; do dpkg -x "$d" ~/.local/opt/xvfb; done
export LD_LIBRARY_PATH=$HOME/.local/opt/xvfb/usr/lib/x86_64-linux-gnu
ldd ~/.local/opt/xvfb/usr/bin/Xvfb | grep 'not found'   # loop until empty
```

**The xkbcomp problem.** The X server execs `xkbcomp` from a path baked in at compile time
(`/usr/bin`), which you cannot write and which `x11-xkb-utils` did not populate system-wide.
It is fatal, not a warning: `Failed to activate virtual core keyboard`. There is no server
flag to disable XKB. The obvious fix — bind-mount over `/usr/bin` in a user namespace —
is unavailable on Ubuntu 24.04+, where `kernel.apparmor_restrict_unprivileged_userns=1`
makes `unshare --map-root-user` fail. So patch a private copy of the binary instead; the
replacement path must be **the same length or shorter** so nothing shifts:

```bash
mkdir -p /tmp/xkb && cp ~/.local/opt/xvfb/usr/bin/xkbcomp /tmp/xkb/
cp ~/.local/opt/xvfb/usr/bin/Xvfb ~/.local/opt/xvfb/usr/bin/Xvfb-patched
python3 - <<'EOF'
import re
p = '/home/YOU/.local/opt/xvfb/usr/bin/Xvfb-patched'
d = bytearray(open(p, 'rb').read())
off = [m.start() for m in re.finditer(rb'(?<![!-~])/usr/bin\x00', d)]
assert len(off) == 1, off          # exactly one standalone occurrence: XkbBinDirectory
d[off[0]:off[0] + 9] = b'/tmp/xkb\x00'   # 8 chars, same as /usr/bin
open(p, 'wb').write(bytes(d))
EOF

Xvfb-patched :99 -screen 0 1400x1000x24 -xkbdir ~/.local/opt/xvfb/usr/share/X11/xkb &
export DISPLAY=:99
```

`_XSERVTransmkdir: Owner of /tmp/.X11-unix should be set to root` is a warning; the socket
still appears and `xdotool getdisplaygeometry` will answer.

### Screenshots with no ImageMagick

`xwd` ships in `x11-apps`; convert its output yourself rather than pulling ImageMagick's
dependency tree. A ~40-line `xwd`-to-PNG script (parse the big-endian header, use the RGB
masks, emit one zlib-compressed IDAT) is enough, and the resulting PNG can be read back
with the `Read` tool to find button coordinates for `xdotool`.

Capture with `xwd -root -silent > shot.xwd` and **not** `2>&1` — merging stderr into the
same file corrupts the header, and the converter then fails on a 5 MB file with a message
about needing 68 bytes.

## Building it

`bun run --cwd apps/desktop stage` is the documented path and it runs `package:headless`,
which currently **fails on the web bundle-size budget** before staging anything. That gate
runs *after* Vite emits, so `apps/web/dist` is already on disk when it fails — build the
pieces directly instead:

```bash
bun run --filter @podium/web build   # ignore the budget failure; dist/ is written
bun scripts/build-bun.ts             # -> dist-bun/podium  (~1 min; the tarball step after it is not needed)
cp dist-bun/podium apps/desktop/src-tauri/resources/podium && chmod 755 $_
cp -r apps/web/dist apps/desktop/src-tauri/resources/web
cd apps/desktop/src-tauri && cargo build     # 30-60+ min cold on a loaded box
```

**Resources resolve to the exe directory.** `tauri-utils::resource_dir` returns the
executable's own directory when the binary sits under `target/<profile>`, and `tauri-build`
copies `resources/` there during the build. So the app reads
`target/debug/resources/{podium,web}` — that is what you restage when you swap the sidecar
between runs, *not* `src-tauri/resources`. Do not symlink `target/debug/resources`; the build
already created it, and the link lands inside it as a self-referencing entry.

`frontendDist` points at `apps/web/dist` and there is no `devUrl`, so the window loads the
bundled assets from the `tauri://` origin either way — which is what you want. Do not
set `PODIUM_DESKTOP_RUNTIME_PROBE=1`: it makes a debug build load
`http://127.0.0.1:<port>` directly, turning the page same-origin and quietly destroying any
cross-origin test.

## Running it

WebKitGTK on a virtual display has no GPU, and its DMABUF/compositing paths fail as a
**blank window** rather than an error. Force the software path:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=x11 NO_AT_BRIDGE=1 \
  apps/desktop/src-tauri/target/debug/podium-desktop &
```

There is no window manager, so `xdotool windowactivate` (which needs one) fails —
use `xdotool windowfocus $(xdotool search --name . | tail -1)` before typing. `xdotool search`
returns three windows; the one named `Podium` (not `podium-desktop`) is the webview.
`xdotool windowsize` is also a no-op without a WM, so you cannot force a repaint that way.

The shell picks an **ephemeral** port for its sidecar (`spawning … on port 37119`), not the
port derived from `PODIUM_INSTANCE`. Read the real one from `desktop-native.ndjson` before
curling anything; the derived ports still matter, because they are what keeps the test
instance off the live daemon's 45777/45778.

Do not clean up with `pkill -f podium-desktop`: the pattern matches your own shell's command
line, so the tool call kills itself and reports exit 144 with the actual work half-done. Kill
the recorded PID, or match on a string your command does not contain.

### The logs went missing

`NOTIFY_SOCKET` is set inside a systemd user service, and a Podium session started from one
inherits it. `resolveRunRecordMode` reads it as "I am a systemd unit" and the sidecar writes
**NDJSON to stdout** — which the desktop shell discards — instead of
`$PODIUM_STATE_DIR/logs/all-in-one.ndjson`. If your run produces no log file, check this
first; `env -u NOTIFY_SOCKET` is the fix. (Real desktop launches are unaffected: a
graphical session does not carry it.)

Two files appear, and both are wanted: `cli.ndjson` holds the boot records written before a
role is claimed, and `all-in-one.ndjson` everything after `configureProcessLogging`
re-registers under the claimed role.

## Reading what the webview actually sent

For anything origin- or header-shaped, do not infer from behaviour — record it. A
throwaway middleware in `startServer`, registered **before** the cors middleware (which
short-circuits `OPTIONS` and would hide every preflight), costs one `bun scripts/build-bun.ts`:

```ts
const originProbe: MiddlewareHandler = async (c, next) => {
  log.warn('http probe', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    origin: c.req.header('origin') ?? '<none>',
  })
  await next()
}
app.use('/trpc/*', originProbe)
```

`warn` clears the default threshold, so the records land in `all-in-one.ndjson` without
raising any level. Remember to drop it before committing.

**What it answered (POD-1996).** The all-in-one webview sends a real origin, not the opaque
`null` some `tauri://` builds produce:

```
PROBE GET     tauri://localhost   /auth/status
PROBE GET     tauri://localhost   /setup/config
PROBE GET     tauri://localhost   /trpc/setup.options,setup.commandFor,auth.status
PROBE OPTIONS tauri://localhost   /trpc/setup.connect
PROBE POST    tauri://localhost   /trpc/setup.connect     <- preflight passed, mutation sent
```

That is the whole reason an allow-list can work here: an origin you can match beats a
wildcard you cannot use with credentials.

**A blocked CORS response still reaches the server.** The browser hides the *response*; it
does not withhold the request. So a simple GET that fails the CORS check is still executed
and still logged. A preflighted request (any POST with `content-type: application/json`,
i.e. every tRPC mutation) is the opposite: if the preflight fails, the POST is never sent
and the server sees nothing. That asymmetry is the cleanest pass/fail signal available —
`setup.complete` writes `config.json`, so **the file exists iff the credentialed POST got
through**, and no screenshot is needed to tell.

## Run the failing build too

One green run proves the app works; it does not prove *your change* is why. Reverting the
fix and repeating the identical clicks costs one `bun scripts/build-bun.ts` (~10s) plus a
restage and a `rm -rf "$PODIUM_STATE_DIR"`, and it is what turns "it works" into a cause.
Do not rebuild the Rust shell for this — only the sidecar changed.

The two traces from POD-1996, same binary, same two clicks:

| | pass (`podiumCors()`) | fail (wildcard `cors()`) |
|---|---|---|
| Preflight | `OPTIONS /trpc/setup.connect` | `OPTIONS /trpc/logs.forward` ×5 |
| The POST | sent 4 ms later | **never sent, ever** |
| `config.json` | written, `mode: all-in-one` | absent |
| Wizard screen | exposure options render | options list empty, button inert |

Two things worth stealing from that table. First, **the retries name the bug**: five
`logs.forward` preflights with no POST *is* the "no logs are being written" report — client
log forwarding rides the same transport it is supposed to report on, so a transport fault
erases its own evidence. Second, **the blocked screen still renders**. Every wizard query
has a `.catch`, so a failed load leaves an empty options list rather than an error, and the
page looks plausible. Read the probe, not the screenshot.

## Known-good checks, without the GUI

Most of what you want can be settled against the sidecar alone, which takes a minute
instead of an hour and needs no display at all:

```bash
env -u NOTIFY_SOCKET PODIUM_INSTANCE=desktoptest PODIUM_NO_RELAY=1 \
    PODIUM_ADOPT_STATE=1 PODIUM_DESKTOP_SUPERVISED=1 ./dist-bun/podium &

curl -si -X OPTIONS "http://127.0.0.1:20501/trpc/setup.complete?batch=1" \
  -H "Origin: tauri://localhost" -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" | grep -i '^access-control'
```

Run the GUI only for what this cannot reach: what the webview itself puts on the wire.

## Cleaning up

`kill` the app and any `dist-bun/podium` it spawned, then confirm the live daemon is still
listening on its own ports (`ss -ltn | grep 45777`). `/tmp` on this box is a quota'd tmpfs —
a full build can exhaust it, and the symptom is an unrelated-looking
`write error: Disk quota exceeded` from any command.
