#!/usr/bin/env bash
# =============================================================================
# One-time droplet bootstrap (Session 13, D10). Ubuntu 24.04, run as root by
# the owner, from a copy of this repo's infra/ directory on the droplet:
#
#   scp -r infra root@<droplet-ip>:/root/visorfans-infra
#   ssh root@<droplet-ip> 'bash /root/visorfans-infra/bootstrap.sh'
#
# Idempotent: every step checks before it changes, so re-running is safe.
# It will NOT lock you out: root login and password auth are disabled only
# after /home/deploy/.ssh/authorized_keys is confirmed to hold a key that is
# not the CI forced-command key (copied from /root/.ssh/authorized_keys, where
# DigitalOcean put yours). If that check fails, sshd is left untouched and the
# script exits non-zero.
#
# What it does: UTC; Docker Engine + Compose plugin from Docker's apt repo;
# Docker log + proxy defaults; 2 GB swap (swappiness 10); `deploy` user (docker
# group, sudo WITH a password — never passwordless); sshd hardening;
# unattended security upgrades with a 04:30 UTC reboot window; ufw 22/80/443;
# /opt/visorfans/{env,certs,bin,releases} with strict permissions; installs
# deploy.sh + deploy-gate (root-owned, so the deploy user cannot change them).
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/visorfans
DEPLOY_USER=deploy
log() { printf '\n[bootstrap] %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[[ "$ID" == "ubuntu" ]] || { echo "Ubuntu only (found $ID)" >&2; exit 1; }
for f in deploy.sh deploy-gate; do
  [[ -f "$here/$f" ]] || { echo "missing $here/$f — copy the whole infra/ directory" >&2; exit 1; }
done

# ── Time ─────────────────────────────────────────────────────────────────────
log "timezone UTC"
timedatectl set-timezone UTC

# ── Packages ─────────────────────────────────────────────────────────────────
log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg ufw unattended-upgrades util-linux

log "Docker Engine + Compose plugin (Docker's official apt repository)"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
repo_line="deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable"
if [[ "$(cat /etc/apt/sources.list.d/docker.list 2>/dev/null)" != "$repo_line" ]]; then
  echo "$repo_line" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
fi
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

log "Docker daemon defaults"
# json-file logs capped per container (compose sets the same per service);
# userland-proxy off so published ports use iptables DNAT and Caddy sees the
# real client address (the API's per-IP rate limits depend on it).
daemon_json='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "userland-proxy": false,
  "live-restore": true
}'
if [[ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon_json" ]]; then
  echo "$daemon_json" > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker

# ── Swap ─────────────────────────────────────────────────────────────────────
log "2 GB swap, swappiness 10"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [[ -f /swapfile ]] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-visorfans.conf
sysctl -q --system

# ── deploy user ──────────────────────────────────────────────────────────────
log "user '$DEPLOY_USER'"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
usermod -aG docker,sudo "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
if [[ ! -s "$keys" && -s /root/.ssh/authorized_keys ]]; then
  # The owner's key(s), as DigitalOcean installed them for root.
  cp /root/.ssh/authorized_keys "$keys"
fi
touch "$keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$keys"
chmod 600 "$keys"
# sudo for the owner, always WITH a password.
if passwd -S "$DEPLOY_USER" | awk '{exit !($2 != "P")}'; then
  log "set a sudo password for '$DEPLOY_USER' (used for sudo only; SSH stays key-only)"
  passwd "$DEPLOY_USER"
fi

# ── /opt/visorfans ───────────────────────────────────────────────────────────
log "$ROOT layout"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ROOT" "$ROOT/releases"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ROOT/env"
install -d -m 750 -o root -g "$DEPLOY_USER" "$ROOT/certs"
install -d -m 755 -o root -g root "$ROOT/bin"
# Root-owned: the CI key can only ever run what root installed here.
install -m 755 -o root -g root "$here/deploy.sh" "$ROOT/bin/deploy.sh"
install -m 755 -o root -g root "$here/deploy-gate" "$ROOT/bin/deploy-gate"
for f in api.env compose.env; do
  [[ -f "$ROOT/env/$f" ]] || install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$ROOT/env/$f"
  chmod 600 "$ROOT/env/$f"
done
touch "$ROOT/deploy.log"
chown "$DEPLOY_USER:$DEPLOY_USER" "$ROOT/deploy.log"

# ── Unattended security upgrades ─────────────────────────────────────────────
log "unattended-upgrades (security), reboot window 04:30 UTC"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52visorfans-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
systemctl enable --now unattended-upgrades

# ── Firewall (mirrors the DigitalOcean cloud firewall) ───────────────────────
log "ufw 22/80/443"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for port in 22 80 443; do ufw allow "$port/tcp" >/dev/null; done
ufw --force enable >/dev/null

# ── sshd — only once the deploy user is reachable by key ─────────────────────
log "sshd hardening"
# Owner keys = authorized_keys lines that are NOT forced-command (CI) keys.
owner_keys="$(grep -Ec '^(ssh-|ecdsa-|sk-)' "$keys" || true)"
if [[ "$owner_keys" -lt 1 ]]; then
  echo "[bootstrap] REFUSING to disable root/password login: $keys holds no plain (owner) key." >&2
  echo "[bootstrap] Add your public key there, check 'ssh $DEPLOY_USER@<ip>' works, then re-run." >&2
  exit 1
fi
cat > /etc/ssh/sshd_config.d/99-visorfans.conf <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
X11Forwarding no
CONF
sshd -t
systemctl reload ssh

log "done. Next: docs/deployment/runbook.md §3 (env files), then §4 (deploy key)."
echo "[bootstrap] Before closing this root session, confirm in a NEW terminal: ssh $DEPLOY_USER@<droplet-ip>"
