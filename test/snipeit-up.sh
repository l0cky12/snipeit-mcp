#!/usr/bin/env bash
# Boot a throwaway Snipe-IT with demo data and write an admin API token to test/.snipeit-token.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d
echo -n "waiting for app"
for i in $(seq 1 90); do
  if curl -fsS -o /dev/null http://localhost:8765/ 2>/dev/null || curl -sS -o /dev/null -w '%{http_code}' http://localhost:8765/ 2>/dev/null | grep -q '^30'; then break; fi
  echo -n .; sleep 2
done; echo
art() { docker compose exec -T app php artisan "$@"; }
art migrate --force
art db:seed --force
art passport:install --force --no-interaction || art passport:keys --force
art tinker --execute='echo App\Models\User::where("username","admin")->firstOrFail()->createToken("mcp-test")->accessToken;' | tail -1 | tr -d '\r\n' > .snipeit-token
echo "token written to test/.snipeit-token ($(wc -c < .snipeit-token) bytes)"
