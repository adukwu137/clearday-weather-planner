#!/usr/bin/env bash
# Sets up (or refreshes) ClearDay on one web server. Run it on web-01 and on
# web-02 from inside the cloned repository:   bash deploy/setup-server.sh
# It is safe to run more than once.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$APP_DIR" != "/home/ubuntu/clearday" ]; then
  echo "Clone the repository to /home/ubuntu/clearday (the path used by clearday.service)." >&2
  exit 1
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  echo "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y nginx

echo "Installing the service and the Nginx site"
sudo cp "$APP_DIR/deploy/clearday.service" /etc/systemd/system/clearday.service
sudo cp "$APP_DIR/deploy/nginx-clearday.conf" /etc/nginx/sites-available/clearday
sudo ln -sf /etc/nginx/sites-available/clearday /etc/nginx/sites-enabled/clearday
if [ -e /etc/nginx/sites-enabled/default ]; then
  sudo mv /etc/nginx/sites-enabled/default /etc/nginx/default-site.backup
fi
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl enable clearday
sudo systemctl restart clearday
sudo systemctl reload nginx || sudo systemctl restart nginx

sleep 1
curl -fsS http://127.0.0.1/api/health && echo
echo "ClearDay is running on $(hostname)"
