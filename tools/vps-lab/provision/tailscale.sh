#!/bin/sh
# Tailscale, by the OFFICIAL instructions and nothing else.
# https://tailscale.com/download/linux  →  one command, which is this one.
#
# This file exists to save typing, not to do anything clever. If it ever stops matching what
# tailscale.com/install.sh does, delete it rather than patching around it — the point of the
# lab is that the boxes are stock.
set -eu

curl -fsSL https://tailscale.com/install.sh | sh

cat <<'NOTE'

Installed. To bring it up:

  sudo tailscale up

For an unattended join across several lab boxes, mint a REUSABLE, EPHEMERAL auth key at
https://login.tailscale.com/admin/settings/keys and use:

  sudo tailscale up --authkey tskey-auth-xxxxx --hostname "$(hostname)"

Ephemeral keys mean the nodes disappear from your tailnet when the containers stop, which is
what you want for throwaway boxes.
NOTE
