#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo 'SKIP: Docker is unavailable'
  exit 0
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
run_image() {
  image=$1
  profile=$2
  login_shell=$3
  echo "container smoke: $image ($profile)"
  docker run --rm \
    --volume "$repo_root:/workspace:ro" \
    --workdir /workspace \
    --env "PODIUM_TEST_LOGIN_SHELL=$login_shell" \
    --entrypoint /bin/sh \
    "$image" -ceu '
      harness_bin=/opt/podium-harness-bin
      mkdir -p "$harness_bin"
      for name in claude codex grok opencode agent; do
        cp /workspace/scripts/harness-environment-fake-cli.sh "$harness_bin/$name"
        chmod 755 "$harness_bin/$name"
      done
      if [ "$PODIUM_TEST_LOGIN_SHELL" = /bin/bash ]; then
        printf "%s\n" "export PATH=$harness_bin:/usr/local/bin:/usr/bin:/bin" > /root/.bash_profile
      else
        printf "%s\n" "export PATH=$harness_bin:/usr/local/bin:/usr/bin:/bin" > /root/.profile
      fi
      env -i HOME=/root PATH=/usr/bin:/bin SHELL="$PODIUM_TEST_LOGIN_SHELL" PODIUM_DESKTOP_SUPERVISED=1 /usr/local/bin/bun --conditions=@podium/source /workspace/scripts/harness-environment-container-probe.ts "$harness_bin"
    '
}

run_image oven/bun:1-debian bash /bin/bash
run_image oven/bun:1-alpine ash /bin/ash
