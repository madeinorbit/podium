# Installer testing playbook, round 5

> Historical scenario notes from September–October 2026. Builds, UI wording and box
> assignments below describe that run, not the current fleet. Start with [README.md](README.md),
> claim your slots and use the release issue's selected build and test credentials.

Build under test: dev channel. dev/mw `36ef8b1233` = the new setup order + `podium doctor`
(POD-5958), plus the Ctrl-C fix `dfb7212b59` from the issue branch.
Every block is copy-paste. Run `HOST$` lines on your machine, from the lab directory:

```
cd tools/vps-lab  # from the repository root
```

| Box  | State                                                                     |
|------|---------------------------------------------------------------------------|
| vps1 | server on a Cloudflare quick tunnel, password `<lab-ui-password>`                |
| vps2 | joined to vps1                                                            |
| vps3 | server on a Cloudflare quick tunnel (my 2026-10-11 walk), `<lab-ui-password>`    |
| vps4 | installed, not set up (my Ctrl-C drills)                                  |
| vps5 | fresh                                                                     |

All boxes: user `mgw`, ssh password `podium`. Reset a box to fresh: `./lab reset 5`.

---

## 1. Fresh server, new order (vps5)

```
./lab ssh 5
```
```
curl -fsSL https://github.com/madeinorbit/podium/releases/download/dev/install.sh | sh -s -- --channel dev
```
1. **Run the Podium server AND agents here**. Expect right away: "Podium is running. Until it
   has a password, only this machine can use it."
2. **Cloudflare quick tunnel** → download **Yes** → the tunnel is up → `Reachable — …`.
3. Password: press Enter on an empty one (refused), then type two different ones (asked again),
   then the same one twice. There is no "run without a password" choice any more.
4. systemd **Yes**.

## 2. Doctor (vps5 or vps3)

```
podium status
podium doctor
```
Six lines, all OK: service, server, tunnel service, cloudflared, public address, Connect. Break
things and repair them:
```
systemctl --user stop podium-tunnel; podium doctor; podium doctor --fix
rm ~/.podium/bin/cloudflared; podium doctor --fix
systemctl --user stop podium; podium doctor --fix
podium doctor --report
podium restart
podium logs tunnel
```
A new tunnel address takes about a minute to answer; run `podium doctor` again after that.
`podium restart` restarts the tunnel too, so the address changes.

## 3. Ctrl-C saves nothing (vps4)

```
./lab ssh 4
```
```
podium setup
```
Choose the server, then **Cloudflare quick tunnel**, and press Ctrl-C while "Starting the
Cloudflare tunnel" spins. Expect "Stopped. Nothing was saved." Then check:
```
cat ~/.podium/config.json; pgrep -a podium; ls ~/.config/systemd/user/
```
Only `configVersion` and `updateChannel` are left, nothing runs, and there is no tunnel unit. Try
Ctrl-C at the password prompt too.

## 4. Change the password (vps1)

```
./lab ssh 1
```
```
curl -fsSL https://github.com/madeinorbit/podium/releases/download/dev/install.sh | sh -s -- --channel dev
podium setup
```
→ **Change the login password**, type it twice. The browser asks for the new one at once, with no
restart. Set it back to `<lab-ui-password>`.

## 5. Tunnel health in Settings (any server)

Settings → Network shows the tunnel's state ("working" about a minute after it starts). The
tunnel checks its own address every five minutes, and restarts itself after three failures in a
row. To watch that happen (~16 min):
```
HOST$ docker exec vps3 sh -c 'echo "127.0.0.2 <address-host>.trycloudflare.com" >> /etc/hosts'
```
Expect "public address failed three checks; restarting cloudflared" in `podium logs tunnel`, then
a new address. Undo by removing that line from `/etc/hosts`.
