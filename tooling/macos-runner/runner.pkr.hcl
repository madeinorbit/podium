# Builds the macOS/iOS runner VM used for Mac CI and agent-driven click-testing.
#
# The image is deliberately identity-free: no repo checkout, no VCS credentials,
# no SSH private keys, no Apple account, no Tailscale login. Each instance
# authenticates itself after first boot. See README.md.
#
#   packer init .
#   packer build -var 'xcode_xip=/path/to/Xcode.xip' .   # unattended
#   packer build .                                        # prompts for an Apple ID

packer {
  required_plugins {
    tart = {
      version = ">= 1.14.0"
      source  = "github.com/cirruslabs/tart"
    }
  }
}

variable "vm_name" {
  type    = string
  default = "podium-apple-runner"
}

variable "base_image" {
  type    = string
  default = "ghcr.io/cirruslabs/macos-tahoe-base:latest"
}

variable "xcode_version" {
  type        = string
  default     = "26.6"
  description = "Xcode release to install. Must be an exact version from `xcodes list`."
}

variable "ios_runtime" {
  type        = string
  default     = "iOS"
  description = "Platform passed to `xcodebuild -downloadPlatform`. Only one runtime is installed."
}

variable "simulator_name" {
  type    = string
  default = "Podium Agent"
}

variable "simulator_device" {
  type    = string
  default = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
}

variable "xcode_xip" {
  type        = string
  default     = ""
  description = <<-EOT
    Optional path on the BUILD HOST to an already-downloaded Xcode .xip.
    Supply it to make the build fully unattended. Leave empty to have `xcodes`
    prompt for an Apple ID at build time (interactive; see README).
  EOT
}

# Sized to leave the host responsive. Adjust for your hardware; on a 10-core /
# 24 GB Mac this leaves 4 cores and ~14 GB for the host.
variable "cpu_count" {
  type    = number
  default = 6
}

variable "memory_gb" {
  type    = number
  default = 10
}

variable "disk_size_gb" {
  type    = number
  default = 150
}

source "tart-cli" "runner" {
  vm_base_name = var.base_image
  vm_name      = var.vm_name
  disk_size_gb = var.disk_size_gb
  cpu_count    = var.cpu_count
  memory_gb    = var.memory_gb
  headless     = true

  # The published cirruslabs base ships no Recovery partition, so this is a
  # no-op today. Kept so the build stays correct if that ever changes: without
  # it, a Recovery partition sitting after the container would block the resize.
  recovery_partition = "relocate"

  # Stock credentials of the cirruslabs base image; not a secret.
  ssh_username = "admin"
  ssh_password = "admin"
  ssh_timeout  = "900s"
}

build {
  sources = ["source.tart-cli.runner"]

  # The tart plugin grows the raw disk image but leaves the APFS container at
  # its original size, stranding the new space as unallocated.
  provisioner "shell" {
    inline = [
      "set -euo pipefail",
      "sudo diskutil apfs resizeContainer disk0s2 0",
      "df -h /",
    ]
  }

  provisioner "shell" {
    timeout         = "45m"
    environment_vars = ["NONINTERACTIVE=1"]
    inline = [
      "set -euo pipefail",
      # The -base image has no Homebrew; its installer bootstraps Command Line Tools.
      "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
      "echo 'eval \"$(/opt/homebrew/bin/brew shellenv)\"' >> ~/.zprofile",
    ]
  }

  provisioner "file" {
    source      = "provision.sh"
    destination = "/tmp/provision.sh"
  }

  # Optional: seed a locally-held Xcode .xip so the build needs no Apple login.
  dynamic "provisioner" {
    for_each = var.xcode_xip == "" ? [] : [var.xcode_xip]
    labels   = ["file"]
    content {
      source      = provisioner.value
      destination = "/tmp/Xcode.xip"
    }
  }

  provisioner "shell" {
    timeout = "180m"
    environment_vars = [
      "XCODE_VERSION=${var.xcode_version}",
      "IOS_RUNTIME=${var.ios_runtime}",
      "SIMULATOR_NAME=${var.simulator_name}",
      "SIMULATOR_DEVICE=${var.simulator_device}",
      "XCODE_XIP=${var.xcode_xip == "" ? "" : "/tmp/Xcode.xip"}",
    ]
    inline = ["chmod +x /tmp/provision.sh && /tmp/provision.sh"]
  }
}
