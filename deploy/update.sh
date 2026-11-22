#!/usr/bin/env bash
# Pull the latest code on both web servers and restart the app, one server at
# a time so the load balancer always has one healthy server.
# Run from your computer (Git Bash, WSL, macOS or Linux):  bash deploy/update.sh
set -euo pipefail

SSH_USER="${SSH_USER:-ubuntu}"
HOSTS=("${WEB01:-18.171.204.227}" "${WEB02:-18.171.160.168}")
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [ -n "${SSH_KEY:-}" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

for host in "${HOSTS[@]}"; do
  echo "==> $host"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$host" \
    'cd ~/clearday && git pull --ff-only && sudo systemctl restart clearday && sleep 2 && curl -fsS http://127.0.0.1/api/health && echo'
done
