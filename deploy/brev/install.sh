#!/usr/bin/env bash
# Run on the Brev GPU box (Ubuntu, user ubuntu) after Ollama + qwen3.6:35b-a3b are installed
# (docs/GPU_SERVER.md). Copy .env and data/ (cqa.db, dev.json, audio/) separately: they are not in git.
set -euo pipefail
APP=/home/ubuntu/cqa-hackathon
if [ ! -d "$APP/.git" ]; then git clone https://github.com/azimxxd/cqa-hackathon.git "$APP"; fi
cd "$APP" && git checkout main && git pull --ff-only && npm ci --omit=dev
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i /tmp/cloudflared.deb
fi
sudo cp "$APP/deploy/brev/cqa.service" "$APP/deploy/brev/cqa-tunnel.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cqa.service cqa-tunnel.service
sudo systemctl restart cqa.service
sleep 10
journalctl -u cqa-tunnel --no-pager | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1
