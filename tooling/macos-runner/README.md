# macOS/iOS runner image

Builds a Tart VM on an Apple Silicon Mac that hosts Mac CI and agent-driven
iOS click-testing for machines that cannot run macOS themselves.

## What the image contains

| | |
|---|---|
| macOS | 26.6.2 (from `ghcr.io/cirruslabs/macos-tahoe-base`) |
| Xcode | 26.6 (build 17F113) |
| Simulator runtime | iOS 26.5 — the only one; no watchOS/tvOS/visionOS |
| Simulator | `Podium Agent`, iPhone 17 Pro — the only device |
| Tooling | Homebrew, git, node, bun, Temurin 17, Maestro, Tailscale |
| Resources | 6 CPU, 10 GB RAM, 150 GB disk |

## What it deliberately does NOT contain

No repo checkout, no VCS credentials, no SSH private keys, no Apple account, no
Tailscale login, no CI runner registration, no API keys, no DerivedData. Every
instance authenticates itself after first boot, so the image can be cloned
freely without carrying one machine's identity into another.

## Build

Requires `tart` and `packer` on the host.

```sh
packer init .
packer build .
```

### The Apple ID gate

`xcodes` downloads Xcode from Apple and needs an Apple ID with MFA. Two options:

1. **Interactive** (default) — the build pauses for Apple ID, password, and a
   2FA code. Over SSH the keychain cannot store the credential (it fails with
   `OSStatus -25308`, "User interaction is not allowed"), so nothing is
   persisted. The same limitation makes `xcodes`' final privileged step fail;
   `provision.sh` redoes that step itself, so the failure is expected and
   harmless.
2. **Unattended** — download the `.xip` once, keep it on the build host, and
   pass it in. No Apple login during the build at all:

   ```sh
   packer build -var 'xcode_xip=/path/to/Xcode_26.6.xip' .
   ```

   This is the better option if you rebuild often.

## First boot

```sh
tart run --no-graphics podium-apple-runner &
tart ip podium-apple-runner --wait 240
```

The image ships the cirruslabs base's stock credentials, `admin` / `admin`, with
passwordless `sudo`. **Do not bother changing the password. Disable password
authentication instead.**

That is not laziness, it is the stronger control, and changing the password is
close to worthless here:

- Every legitimate connection arrives over **Tailscale SSH**, which is
  identity-based and never consults the account password. Changing it protects
  nothing on the path that is actually used.
- Unattended reboots need **auto-login**, and auto-login stores the password in
  `/etc/kcpassword` XOR'd against a fixed, publicly documented 11-byte key.
  Anyone who can read that file — or the VM's disk image on the host —
  recovers the plaintext immediately. With auto-login on, the password is
  obfuscated, not secret.
- The only surface that honours it is the guest's OpenSSH on the hypervisor's
  host-only interface (`192.168.64.x`), reachable solely from processes already
  running on the host — which can read `kcpassword` anyway.

So remove the surface rather than the default value:

```sh
sudo tee /etc/ssh/sshd_config.d/100-podium-runner.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo launchctl kickstart -k system/com.openssh.sshd
sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'   # verify
```

Verify from the host-only address, which must refuse:

```
$ ssh -o PreferredAuthentications=password admin@192.168.64.6
admin@192.168.64.6: Permission denied (publickey).
```

Keeping the password at the stock `admin` then has two practical benefits: the
golden image stays reproducible, and you avoid the failure modes below.

The runner is still not a security boundary in either direction — anything with
code execution on the host is root in the VM. And if you ever run the VM
bridged onto a LAN, port 22 is LAN-reachable, which is precisely why password
auth should already be off.

#### Changing the account password breaks two things

Both of these cost real debugging time, and both are avoidable by leaving it
alone:

1. **It desynchronises the login keychain.** `dscl . -passwd` and
   `sysadminctl -newPassword` change the account password without re-encrypting
   `~/Library/Keychains/login.keychain-db`, which stays locked by the *old* one.
   `security list-keychains` then returns only `System.keychain`, and anything
   that reads a certificate or secret from the login keychain fails. Reverting
   the password to its original value restores access, since the keychain was
   never re-keyed.

2. **It locks the account out via auto-login.** `/etc/kcpassword` still holds
   the old password, so `loginwindow` submits a wrong credential on every boot.
   Three failures trip macOS's escalating lockout and the console shows *"your
   account is locked, try again in 1 minute"*, getting worse with each reboot.
   Tailscale SSH keeps working throughout, which is the way back in:

   ```sh
   sudo rm -f /etc/kcpassword                              # stop the retry loop
   sudo dscl . -delete /Users/admin accountPolicyData      # clear the lockout
   sudo pwpolicy -u admin -clearaccountpolicies
   ```

   `sysadminctl -autologin set` can fail with `SACSetAutoLoginPassword
   error:22` even with FileVault off. Writing the file directly works; note the
   padding, which must be a multiple of 12 bytes or `loginwindow` ignores it:

   ```python
   key = bytes([0x7D,0x89,0x52,0x23,0xD2,0xBC,0xDD,0xEA,0xA3,0xB9,0x1F])
   pw = bytearray(b"admin"); pw.append(0)
   while len(pw) % 12: pw.append(0)
   open("/etc/kcpassword","wb").write(
       bytes(b ^ key[i % len(key)] for i, b in enumerate(pw)))
   ```

   Then `sudo chmod 600 /etc/kcpassword` and
   `sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string admin`.

### Do not expose this runner to untrusted code

A self-hosted runner executes whatever the workflow tells it to. On a **public**
repository, a pull request from a fork can modify the workflow file, so
targeting a self-hosted runner from a fork-triggered workflow hands arbitrary
code execution to anyone who can open a PR — on a machine with passwordless
sudo, sitting inside your private network.

Only target this runner from triggers an outsider cannot reach: `push` to
branches in the repository itself, `workflow_dispatch`, or `pull_request_target`
gated behind an explicit maintainer-applied label. For public repositories,
hosted runners are the correct default and this one should stay opt-in.

### Joining the tailnet

The image ships Tailscale installed but logged out. On each instance:

```sh
tailscale up --ssh --hostname=<instance-name>
```

`--ssh` means authorization happens by tailnet identity, so no SSH keys exist
anywhere — none in the VM, and nothing the VM could use to reach outward.

**Remote access.** The reference setup reaches the runner over a private
network overlay (Tailscale), which lets the driving machines authenticate by
network identity so no SSH keys exist anywhere. Any equivalent works — a VPN, a
bastion, or plain `authorized_keys` on a trusted LAN. The rest of this section
is specific to the Tailscale route; skip it if you use something else.

If you do use Tailscale SSH, its default rule is

```jsonc
{ "action": "check", "src": ["autogroup:member"],
  "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"] }
```

`check` grants access but forces a periodic browser re-auth (12h by default),
which hangs a non-interactive agent on a login URL it cannot open.

Adding an `accept` rule alongside it does NOT help, and reordering does not
either. Tailscale SSH is **most-restrictive-wins, not first-match**: "if both a
check and an accept rule exist for a given connection, the check rule applies."
Since `autogroup:nonroot` covers `admin`, the default rule keeps matching and
keeps winning.

The fix is to move the runner out of the check rule's scope. Tag it: a tagged
node has no user owner, so it is no longer in `autogroup:self` and the default
rule cannot match it.

```jsonc
"tagOwners": {
  "tag:macos-runner": ["autogroup:admin"],
},
"ssh": [
  { "action": "accept", "src": ["autogroup:member"],
    "dst": ["tag:macos-runner"], "users": ["admin"] },
  // default rule, left untouched -- it no longer matches the tagged runner
  { "action": "check", "src": ["autogroup:member"],
    "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"] },
],
```

Then apply the tag to the runner in the admin console (Machines -> the device ->
... -> Edit ACL tags), which needs no re-authentication. Do not tag the machines
that *drive* the runner: tagging transfers ownership from the user to the tag,
and applying that to hosts you already reach can revoke your own access.

Verify from a driving machine that has never authenticated, not from one that
has. Check mode caches its result for ~12h, so a machine that passed a browser
check earlier will keep succeeding and will falsely look like proof the accept
rule works.

**Node-key expiry.** An untagged node key expires (180 days by default) and the
runner silently drops off the tailnet. Disable expiry for the runner in the
admin console: Machines -> the device -> ... -> Disable key expiry.

**Node naming.** Logging out leaves the old device record holding its name, so
the next login lands as `<name>-1`, and the suffix is sticky — `tailscale set
--hostname` will not reclaim the base name on its own. Delete the stale device
in the admin console, then rename the live one there (Machines -> ... -> Edit
machine name).

### Host keys on the machines that drive the runner

`ssh -o BatchMode=yes` refuses *all* prompts, including "accept this unknown
host key?", so the first-ever connection from a driving machine fails with
`Host key verification failed` before authentication is attempted. This looks
like an ACL problem and is not one. Once per driving machine:

```sh
ssh -o StrictHostKeyChecking=accept-new admin@<runner-name> true
```

or, for anything automated, in that machine's `~/.ssh/config`:

```
Host <runner-name> <runner-name>.<tailnet>.ts.net
    User admin
    StrictHostKeyChecking accept-new
```

Restoring from a golden clone preserves the host keys, since it is the same
disk. A fresh `packer build` generates new ones, and `accept-new` does not
accept a *changed* key — clear the old entry first with
`ssh-keygen -R <runner-name>` on each driving machine.

## Restoring after breaking an instance

Keep a pristine clone and restore from it — an APFS copy-on-write clone is
near-instant and initially costs no disk:

```sh
tart clone podium-apple-runner podium-apple-runner-golden   # snapshot
tart delete podium-apple-runner                             # after breaking it
tart clone podium-apple-runner-golden podium-apple-runner   # restore
```

Snapshot only from a **logged-out** state. Tailscale keeps its node key and a
cached netmap (your tailnet's peer list) under `/Library/Tailscale`; a clone
taken after login carries both. To re-seal an instance:

```sh
sudo tailscale logout
sudo launchctl bootout system/com.tailscale.tailscaled
sudo rm -rf /Library/Tailscale/profile-data /Library/Tailscale/files \
            /Library/Tailscale/tailscaled.state /Library/Tailscale/derpmap.cached.json
```

## Keeping the VM up

A Tart VM is a persistent disk image, not a container. `tart run` boots the
existing VM off its current disk — it does not reset anything, and if the VM is
already running it refuses with `VM "<name>" is already running!` and leaves the
running one alone. Only `tart clone` from the golden gives you a fresh machine.

| command | effect |
|---|---|
| `tart stop` then `tart run` | clean shutdown, cold boot; disk persists |
| `tart suspend` then `tart run` | saves RAM state, fast resume |
| `tart clone <golden> <name>` | the only way to get a fresh machine |

### Run it headless — UI testing does not need a display

`--no-graphics` is correct and deliberate, and the plist ships with it. UI
automation inside the guest needs **no window, no display and no Aqua session**.
This was verified rather than assumed, with `/dev/console` owned by `root` and
no `gui/<uid>` launchd domain at all:

```
console      = root
gui/501      = MISSING
simctl boot  → exit 0, Podium Agent (Booted)

maestro test
 > Flow headless-check
Launch app "com.apple.Preferences"... COMPLETED
Assert that "General" is visible...  COMPLETED
Take screenshot headless-check...    COMPLETED
```

That flow also passes when driven over SSH from a Linux host, which is the real
use case. So do not "fix" a broken UI test by adding a display.

Two traps around this:

- **`launchctl print gui/<uid>/...CoreSimulatorService` returning nothing proves
  nothing.** CoreSimulatorService does not live in the `gui` domain. Its absence
  there is a red herring that looks exactly like a smoking gun.
- **`/dev/console` owned by `root` means the guest's auto-login failed**, and the
  cause is almost always a stale `/etc/kcpassword` after a password change — not
  `--no-graphics`. Headless auto-login works fine with a correct `kcpassword`;
  once it completes, `console` reads `admin`. See
  [Changing the account password breaks two things](#changing-the-account-password-breaks-two-things).

`com.podium.macos-runner.plist` in this directory keeps it running. Install it
as a **LaunchAgent**, not a LaunchDaemon — Virtualization.framework needs a
logged-in user session, so a system daemon cannot start a VM. Consequences:

- The host needs automatic login enabled, or the VM stays down after a reboot
  until someone logs in.
- **The host must not sleep.** On a laptop this is the failure mode that will
  actually bite: lid closed or on battery, the VM stops and every job targeting
  it queues until timeout.

  ```sh
  sudo pmset -c sleep 0 disksleep 0        # on AC power
  sudo pmset -b sleep 0                    # on battery, laptops only
  sudo pmset -a womp 1                     # wake for network access
  ```

  Verify with `pmset -g`; `sleep` should read `0`, and anything holding a sleep
  assertion is listed there too.

A long-lived VM does not need rebuilding per job. Prefer cheap per-job hygiene
inside it — `xcrun simctl erase <simulator>` and clearing DerivedData — and
restore from the golden clone only when something wedges:

```sh
tart stop podium-apple-runner && tart delete podium-apple-runner
tart clone podium-apple-runner-golden podium-apple-runner
```

Per-job VM disposal is worth its cost only when the runner executes untrusted
code — a public repo where fork pull requests can reach it. For private repos it
mostly buys a cold simulator boot on every job.

## Notes and gotchas

- **`MAESTRO_DRIVER_STARTUP_TIMEOUT=600000` is required.** Maestro's XCUITest
  driver exceeds its default startup timeout inside a VM and fails with a bare
  stack trace. Baked into `.zshrc`.
- **Maestro's XCUITest driver can wedge between runs.** The symptom is
  `java.net.ConnectException: Failed to connect to /127.0.0.1:<port>` and a
  flow that stalls on its first command, which reads like a network or SSH
  problem and is neither. Recover by resetting the simulator:

  ```sh
  pkill -f maestro; pkill -f XCTestRunner
  xcrun simctl shutdown "<simulator>"; xcrun simctl boot "<simulator>"
  xcrun simctl bootstatus "<simulator>" -b
  ```

  Worth doing unconditionally at the start of a CI run rather than diagnosing
  it each time.
- **Maestro screenshot paths must be relative.** Absolute paths are rejected as
  resolving outside the run's output folder. Output lands in
  `~/.maestro/tests/<timestamp>/`.
- **`maestro mcp`** speaks JSON-RPC over stdio and exposes `list_devices`,
  `take_screenshot`, `run`, `inspect_screen`, `cheat_sheet`,
  `open_maestro_viewer` plus cloud equivalents.
- **Homebrew's `xcodes` formula cannot be used** — it builds from source and
  requires full Xcode's XCBuild, which is the thing being installed. The
  provisioner uses the upstream release binary instead.
- **The Packer tart plugin does not grow the APFS container.** It resizes the
  raw disk image only; `provision.sh` runs `diskutil apfs resizeContainer`.
- **No Recovery partition exists** in the published cirruslabs base, so
  `recovery_partition = "relocate"` is currently a no-op. It is kept as a guard.
- **First simulator boot takes several minutes** and Xcode auto-creates a full
  default device set, which the provisioner trims.
- **Disk:** the image settles around 55–60 GB. Building needs roughly 90 GB free,
  since the base OCI cache (~31 GB) coexists with the growing VM.
