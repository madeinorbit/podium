# VPS lab

Reusable local Docker stand-ins for fresh Linux installer, onboarding, join, tunnel and
upgrade tests. Each box is Ubuntu 24.04 with **systemd as PID 1**, sshd and a sudo user;
boxes reach each other by name on the `podium-lab` Docker bridge. No cloud VPS is provisioned.

The versioned entry point is **`tools/vps-lab/lab`**, from any checkout. There is no separate
`vpslab` command to install. Use [the testing guide](../../docs/agents/testing.md#disposable-vps-lab)
to choose this rig and [release testing](../../docs/release-testing.md) for the release cases.

## Host and prerequisites

Run the script from a checkout containing `tools/vps-lab/` on a Linux Docker host. For a
shared fleet, obtain the host connection details and slot assignments from the test issue;
connect to that host before running the commands below. `127.0.0.1` means the Docker host.
Each Docker host gets a separate local fleet. Script copies in different worktrees on the
**same host** operate on the same container names, network and image.

The host needs Bash, Docker access, OpenSSH, internet access for image/package downloads,
`/dev/net/tun`, and a Linux cgroup setup that supports systemd containers. Containers run
privileged, use the host cgroup namespace and mount `/sys/fs/cgroup` read/write. This is a
trusted Linux test host rig; Docker Desktop and arm64 emulation are not covered here.

systemd matters: a plain Ubuntu container misses the user service manager and tests the
installer's detached fallback instead of the service path used on a real VPS. Lingering
keeps the user manager alive after SSH disconnects. `NET_ADMIN` and `/dev/net/tun` let real
Tailscale run when a scenario requires it.

## Select and claim a slot

Inspect the fleet and the release issue before changing anything:

```sh
# From the repository root, on the Docker host:
tools/vps-lab/lab status
podium lock acquire lab:vpsN --ttl 30m
podium lock status lab:vpsN
```

Replace `N` with your assigned number. Record host, slot, container ID and selected build on
the test issue; renew the lease during long runs and release it after the handoff. Existing
boxes can contain preserved installs and another agent's test data. Coordinate before reuse.

## Create, connect and resume

```sh
# Only on an empty or explicitly assigned disposable fleet:
tools/vps-lab/lab build
tools/vps-lab/lab up 5             # recreates vps1..vps5

# For one claimed slot (verify ownership/name/port before replacing anything):
tools/vps-lab/lab reset N          # creates or recreates vpsN from the base image
tools/vps-lab/lab ssh N            # sudo user, default mgw
tools/vps-lab/lab ssh N root       # root install path
tools/vps-lab/lab exec N id        # noninteractive root command

# Resume a preserved stopped box without recreating it:
docker start vpsN
```

`up [count]` defaults to five and **removes/recreates every `vps1` through `vps<count>`**.
`reset N` removes/recreates that one slot. Build the base image before using `reset` on a
new host. SSH binds only to `127.0.0.1`, port **2200 + N** (vps1 → 2201). The script installs
`~/.ssh/id_ed25519.pub`, falling back to `id_rsa.pub`; it keeps lab host keys in ignored
`.known_hosts`. Default user/password are `mgw`/`podium`, with the same password for root.
Set `LAB_USER` and `LAB_PASSWORD` consistently for build and use to override them. Choose a
separate task-specific password during Podium setup; never put it in committed playbooks.

Run the selected release's ordinary installer inside `lab ssh N`. Interactive onboarding
needs a terminal; a remote command without a PTY takes the noninteractive installer path.
Cloudflare quick tunnels are an installer choice and need no separate tunnel credentials.

## Snapshot, reset and clean up

```sh
tools/vps-lab/lab snapshot N clean-N  # save the selected box as an image
tools/vps-lab/lab reset N clean-N     # replace it from that snapshot
tools/vps-lab/lab bare N              # remove curl/wget for prerequisite tests
podium lock release lab:vpsN
```

Image tags are shared across the host; pick a task/slot-specific tag. `lab down` removes
**all vps-prefixed containers**, retaining images/snapshots. `lab nuke` also removes the
network and every `podium-vps-lab:*` image. Use them only when you own the entire fleet.
Preserve failed fixtures and record their state before releasing ownership. Logs, SSH host
keys, credentials and screenshots belong in ignored local files or issue artifacts.

## Provisioning and polling

`provision/tailscale.sh` and `provision/cloudflared.sh` provide the vendor install commands
inside each box at `/root/lab/`. Tailscale enrollment and named tunnels need their own
credentials; the installer's Cloudflare quick-tunnel route does not.

New/reset boxes explicitly set `PODIUM_UPDATE_FEED_POLLING=off` for container environment,
SSH login shells and systemd user services via `provision/update-feed-policy.sh`. Releases
that support this flag opt out of background public-feed polling. A polling test must enable
it in the affected service against its chosen feed. Existing containers keep their current
policy until reset; changing these scripts does not change a running fixture.

## Scenario runner and historical playbooks

`./tools/vps-lab/walk --list` lists the saved automated installer scenarios. Running `walk`
resets vps1–vps5, downloads the **dev** channel and writes ignored `walk-logs/`; `--tunnel`
also exercises Cloudflare. It preserves older CLI/config assumptions and is not a current
release acceptance gate. Review it against your selected build and claim all affected slots
before running it. For current S/U cases, follow [release testing](../../docs/release-testing.md).

[TESTING.md](TESTING.md), [PLAYBOOK.md](PLAYBOOK.md) and
[PLAYBOOK-5921.md](PLAYBOOK-5921.md) preserve historical manual scenarios. Their recorded
fleet assignments and build results are not an inventory of the current lab.
