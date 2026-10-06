# Windows sandboxes on boat.dev

Agents build and test the Podium Windows version in boat.dev sandboxes instead of
GitHub's `windows-latest` runners. A sandbox costs about a cent an hour, is billed only
while it runs, forks from a baked image in about 3 minutes, and can be entered over SSH.
You can also watch its Windows screen in a browser.

## How it works

```
your machine ──boat ssh──▶ boat sandbox (Ubuntu 24.04, 4 vCPU / 8 GB, nested KVM)
                             └─ docker: dockurr/windows (QEMU/KVM), started by boat-win.sh
                                  └─ Windows 11 IoT LTSC guest (6 GB RAM)
                                       sshd :22 → sandbox :2222  (key ~/.ssh/win_ed25519)
                                       noVNC screen          → sandbox :8006
                                       \\host.lan\Data       = sandbox ~/win/shared
```

The Windows disk is one file, `~/win/storage/data.qcow2`. Boat snapshots the sandbox
filesystem, so a stopped, forked or resumed sandbox brings the whole Windows install
with it. RAM is not kept: after a resume, Windows cold-boots in about 20 s.

Two named snapshots:

| snapshot | contents | size |
| --- | --- | --- |
| `win11-clean` | Windows + SSH + power settings, nothing else. Base for any Windows work. | 6.3 GB |
| `podium-win` | `win11-clean` + Git, mise (Bun per `mise.toml`), Rust MSVC (`rust-toolchain.toml`), VS 2022 C++ Build Tools, Windows 11 SDK, WebView2; long paths on, Defender real-time and Windows Update off; `C:\src\podium` with warm `node_modules`, Bun cache and cargo `target/` | 13.2 GB |

## Using one (agents)

All commands go through `scripts/boat-windows/boat-win.sh`:

```bash
W=scripts/boat-windows/boat-win.sh
ID=$($W up)                       # fork podium-win, wait until Windows SSH answers (~3 min)
                                  # BOAT_WIN_BASE=win11-clean $W up  for a bare Windows (~1.5 min)
$W sync $ID                       # ship HEAD (or: $W sync $ID <ref>) to C:\src\podium (~25 s)
$W win $ID 'cd C:\src\podium; bun install --frozen-lockfile'
$W win $ID 'cd C:\src\podium; bun run --cwd apps/desktop build -- --no-bundle'
$W pull $ID 'C:\src\podium\some\log.txt' ./log.txt
$W desktop $ID                    # private URL of the Windows screen, for GUI checks
$W extend $ID 30                  # still working: push auto-stop 30 min out
$W stop $ID                       # pause: clean shutdown + boat snapshot; free while stopped
$W resume $ID                     # later: same disk, warm caches
$W rm $ID                         # done with it
```

`win` runs PowerShell. The script travels base64-encoded, so quote it once for bash
and write normal PowerShell inside. A failing command makes `win` exit non-zero (boat
reports every failure as exit code 1).

Until POD-5301 is fixed, the desktop build hangs forever at "archiving ... with pigz"
when mise is on PATH. Run Bun without mise's directories on PATH, so the build falls
back to gzip:

```powershell
$bun = "$env:LOCALAPPDATA\mise\installs\bun\1.4.2\bin"
$env:Path = "$bun;$env:USERPROFILE\.cargo\bin;" + ((($env:Path -split ';') | ? { $_ -notmatch 'mise' }) -join ';')
```

### Rules

- **Short leases.** `up` and `resume` set a 30-minute auto-stop (`BOAT_WIN_TTL`, in
  seconds). Boat's auto-stop is time-based only, with no idle detection. Call
  `extend` while you still need the sandbox. A forgotten one stops by itself soon after.
- **Stop when you go idle, even for a short while.** While a sandbox runs, boat
  snapshots it about every minute and bills by the second. `stop` returns in seconds;
  boat then uploads the changed disk in the background (several minutes for a
  touched Windows disk) and stops billing once that's done.
- **Use `stop` and `resume` while iterating, and `rm` and `up` for a fresh start.** A
  resumed sandbox keeps your checkout and build caches. A fork starts from the baked
  ones.
- **Always `stop` through `boat-win.sh`.** It shuts Windows down cleanly and makes the
  disk file dense first (see below). A TTL stop by boat skips both. Windows recovers
  from that like after a power cut, which usually works, but not always.
- **Record the sandbox id in your issue** (comment `boat windows sandbox: bx_…`), so
  the next session resumes it instead of forking. Delete it when the issue closes.
- **Concurrency:** the trial allows 2 running sandboxes; a paid plan allows 100+.
  Stopped ones don't count. Never stop or delete a sandbox another issue records.

## Measured (2026-10-06, trial, 4 vCPU / 8 GB)

| step | time |
| --- | --- |
| `up` from `podium-win` → Windows SSH | 172 s |
| `up` from `win11-clean` → Windows SSH | 88 s |
| `sync` (whole repo as a git bundle) | 25 s |
| desktop build on a fork or resume (warm caches) | 171–240 s |
| desktop build, cold | 721 s |
| `stop` command | ~6 s (Windows shutdown); upload then runs on boat's side |
| `resume` → Windows SSH | 151–153 s (9 s resume, ~120 s restoring the 13.4 GB disk at ~110 MB/s, ~24 s boot); one outlier at 452 s |
| boat upload after `stop` (billed, nobody waits) | 490–585 s |

## Why the disk is set up the way it is

Boat restores a sandbox through a lazy FUSE filesystem (`ascii-lazyfs`) over
`/home/user`. Measured behaviour, which shapes everything above:

1. **It fetches a file whole before serving any read of it**, at roughly 60–110 MB/s.
   A 100 KB read of a 12 GB file waited for all 12 GB. Splitting a file into pieces
   doesn't help: the pieces download in parallel at the same total rate. So resume time
   is about disk-image size ÷ 100 MB/s, and the image is kept small. `compact`
   zero-fills free space in Windows and rewrites the disk as a zstd-compressed qcow2.
2. **It never serves a sparse file.** A file with holes is "not direct-plannable"; the
   restore declares itself done without it, and the first read hangs forever. The raw
   `data.img` dockur creates by default is sparse, which is what broke the first
   attempt. So: qcow2, `ALLOCATE=N`, `DISK_DISCARD=ignore` (TRIM would punch holes),
   and `stop`/`bake` run `fallocate` over the file to fill any hole before boat
   snapshots it.
3. **A process that opens the file while it is still downloading is never woken**,
   even after the download finishes. So the container has no restart policy, and
   `boat-win.sh` starts it only once `/var/lib/ascii-lazy/status.json` reports
   `"phase":"done"`.
4. **It rejects `O_DIRECT` reads (EINVAL)**, which kills QEMU's default
   `cache=none`. So: `DISK_CACHE=writeback`, `DISK_IO=threads`.

`boat-win.sh` recreates the container from `start-win.sh` on every start, so its
settings come from this repo, not from whatever a snapshot captured.

## Re-baking the images

Re-bake `podium-win` when the toolchain pins change, and both images about every 80
days: the Evaluation edition of Windows stops working 90 days after its install date,
and every fork inherits that date.

```bash
W=scripts/boat-windows/boat-win.sh
# win11-clean: fresh unattended install (~15 min). The sandbox needs the private key whose
# public half is in oem-install.bat; copy ~/.ssh/win_ed25519 from any existing image's sandbox.
ID=$(boat new --ttl 3600 --json | tail -1 | jq -r '.sandbox.id // .id')
boat scp scripts/boat-windows/oem-install.bat $ID:/home/user/win/oem/install.bat
boat ssh $ID 'bash -s' < scripts/boat-windows/start-win.sh
#   wait until `$W win $ID hostname` answers (watch with `$W desktop $ID`), then:
$W compact $ID && $W bake $ID win11-clean

# podium-win: fork the clean image, provision, build once to warm the caches, compact.
ID=$(BOAT_WIN_BASE=win11-clean $W up)
boat scp scripts/boat-windows/provision-guest.ps1 $ID:/home/user/win/shared/provision.ps1
$W win $ID 'powershell -ExecutionPolicy Bypass -File \\host.lan\Data\provision.ps1'
$W sync $ID && $W win $ID '<the desktop build above>'
$W compact $ID && $W bake $ID podium-win
```

Wait until a baked sandbox reports `stopped` before forking its snapshot. A fork taken
while the source is still stopping came up without the disk file once.
