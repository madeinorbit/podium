#!/usr/bin/env bash
# Provision the unique seed container; its committed layer is removed after the run.
set -Eeuo pipefail

uid=$1
gid=$2

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  bash \
  busybox-static \
  ca-certificates \
  curl \
  gcc \
  dbus-user-session \
  git \
  gzip \
  jq \
  openssl \
  procps \
  libc6-dev \
  sqlite3 \
  sudo \
  systemd \
  systemd-sysv \
  tar
rm -rf /var/lib/apt/lists/*
# Match the invoking user so bind-mounted evidence remains writable. Some Ubuntu
# bases reserve uid/gid 1000 for an `ubuntu` account; rename that exact owner
# rather than failing or silently creating Podium under a different identity.
if ! getent group podium >/dev/null; then
  existing_group="$(getent group "$gid" | cut -d: -f1 || true)"
  if [[ -n "$existing_group" ]]; then
    groupmod --new-name podium "$existing_group"
  else
    groupadd --gid "$gid" podium
  fi
fi
if ! getent passwd podium >/dev/null; then
  existing_user="$(getent passwd "$uid" | cut -d: -f1 || true)"
  if [[ -n "$existing_user" ]]; then
    usermod --login podium --home /home/podium --move-home --shell /bin/bash "$existing_user"
  else
    useradd --uid "$uid" --gid podium --create-home --shell /bin/bash podium
  fi
fi
install -d -o podium -g podium /work \
  /home/podium/.config \
  /home/podium/.local/bin \
  /home/podium/.local/share \
  /home/podium/.local/state
printf 'podium ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/podium-e2e
chmod 0440 /etc/sudoers.d/podium-e2e
systemctl mask apt-daily-upgrade.service apt-daily-upgrade.timer \
  apt-daily.service apt-daily.timer e2scrub_reap.service \
  systemd-networkd-wait-online.service
# Every child container gets a distinct machine id on its first systemd boot.
rm -f /var/lib/dbus/machine-id
: >/etc/machine-id
