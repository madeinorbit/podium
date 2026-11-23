#!/usr/bin/env bash
# Publishing runners only: check scoped credentials and provide the S3 client.
set -euo pipefail
if [[ ${PODIUM_PUBLISH_RELEASE_MIRROR:-} != 1 ]]; then exit 0; fi
for credential_name in PODIUM_RELEASE_R2_ENDPOINT PODIUM_RELEASE_R2_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z ${!credential_name:-} ]]; then
    echo "Release mirror requires $credential_name" >&2
    exit 1
  fi
done
if ! command -v aws >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) mirror_arch=x86_64 ;;
    aarch64|arm64) mirror_arch=aarch64 ;;
    *) echo 'Unsupported mirror publishing runner architecture' >&2; exit 1 ;;
  esac
  mirror_tools="${RUNNER_TEMP:?RUNNER_TEMP is required}/podium-mirror-aws"
  mkdir -p "$mirror_tools"
  curl --fail --silent --show-error --location "https://awscli.amazonaws.com/awscli-exe-linux-${mirror_arch}.zip" -o "$mirror_tools/aws.zip"
  unzip -q "$mirror_tools/aws.zip" -d "$mirror_tools"
  "$mirror_tools/aws/install" --install-dir "$mirror_tools/client" --bin-dir "$mirror_tools/bin"
  echo "$mirror_tools/bin" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
  "$mirror_tools/bin/aws" --version
else
  aws --version
fi
