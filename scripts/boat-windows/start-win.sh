# Runs ON a fresh boat sandbox (via `boat ssh ID 'bash -s' < start-win.sh`) to start
# the Windows guest the first time. Before running it, copy oem-install.bat to
# ~/win/oem/install.bat and create the host key ~/.ssh/win_ed25519 whose public half
# that file installs. Only needed when re-baking the base snapshot; agents use
# boat-win.sh up, which forks the baked snapshot instead.
set -e
docker rm -f win >/dev/null 2>&1 || true
mkdir -p "$HOME/win/storage" "$HOME/win/oem" "$HOME/win/shared"
# qcow2, no TRIM, no preallocation: the disk file stays DENSE (no holes) and only as big
# as the data in it. Boat cannot restore sparse files (they hang on first read) and
# fetches each file whole at ~60 MB/s, so every GB here is resume time.
# writeback/threads: boat's FUSE home rejects O_DIRECT reads (EINVAL), which kills QEMU.
# No restart policy: boat-win.sh starts the container once the restore is complete.
# 6 GB of the 8 GB trial sandbox goes to Windows; raise RAM_SIZE/CPU_CORES on --type large.
docker run -d --name win --restart no \
  --device=/dev/kvm --device=/dev/net/tun --cap-add NET_ADMIN \
  -e VERSION=11l -e RAM_SIZE=6G -e CPU_CORES=4 -e DISK_SIZE=60G \
  -e DISK_FMT=qcow2 -e DISK_DISCARD=ignore -e ALLOCATE=N -e DISK_CACHE=writeback -e DISK_IO=threads \
  -e USERNAME=podium -e PASSWORD=podium -e USER_PORTS=22 \
  -p 8006:8006 -p 2222:22 \
  -v "$HOME/win/storage:/storage" -v "$HOME/win/oem:/oem" -v "$HOME/win/shared:/data" \
  --stop-timeout 120 dockurr/windows
