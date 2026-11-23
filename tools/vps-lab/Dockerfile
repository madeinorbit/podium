# A stand-in VPS: Ubuntu with systemd as PID 1 and an sshd to get into it.
#
# SYSTEMD IS THE POINT. `podium install-finish` probes for a user manager and installs a
# systemd user service when it finds one; on a plain `docker run ubuntu` that probe fails and
# the installer takes its detached fallback path. A lab without systemd would therefore test
# the one path a real VPS never takes, and report it as a pass.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PODIUM_UPDATE_FEED_POLLING=off
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      openssh-server sudo ca-certificates curl wget iproute2 iputils-ping \
      less nano git \
 && rm -rf /var/lib/apt/lists/*

# sshd needs its runtime dir and host keys; the rest is so a password login actually works.
RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && systemctl enable ssh

# The operator account. Passwordless sudo mirrors the usual VPS-with-a-user case; root login
# stays available so the run-as-root path can be tested too.
ARG LAB_USER=mgw
ARG LAB_PASSWORD=podium
RUN useradd -m -s /bin/bash "$LAB_USER" \
 && echo "$LAB_USER:$LAB_PASSWORD" | chpasswd \
 && echo "root:$LAB_PASSWORD" | chpasswd \
 && echo "$LAB_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-lab \
 && chmod 0440 /etc/sudoers.d/90-lab \
 && loginctl enable-linger "$LAB_USER" || true

# `enable-linger` needs a running logind, so it is also done at boot by the unit below —
# without it a systemd USER service dies the moment the ssh session ends, which is exactly
# the failure an installer test must not be given for free.
RUN mkdir -p /etc/systemd/system && printf '%s\n' \
  '[Unit]' \
  'Description=Enable lingering for the lab user' \
  'After=systemd-logind.service' \
  '[Service]' \
  'Type=oneshot' \
  "ExecStart=/usr/bin/loginctl enable-linger $LAB_USER" \
  '[Install]' \
  'WantedBy=multi-user.target' \
  > /etc/systemd/system/lab-linger.service \
 && systemctl enable lab-linger.service

# Podium's own installer prerequisites are deliberately NOT pre-installed beyond what sshd
# dragged in; `lab bare <n>` strips curl and wget from a box to test that path.
COPY provision/ /root/lab/
RUN chmod +x /root/lab/*.sh && /root/lab/update-feed-policy.sh

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
