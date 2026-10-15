#!/usr/bin/env bash
# Boot a throwaway Snipe-IT with demo data and write an admin API token to test/.snipeit-token.
# The image's entrypoint runs migrations itself (slowly); we only wait for them, then seed.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d
art() { docker compose exec -T app php artisan "$@"; }
echo -n "waiting for app"
for i in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8765/ || true)
  case "$code" in 200|30*) break;; esac
  echo -n .; sleep 2
done; echo
echo -n "waiting for migrations"
for i in $(seq 1 240); do
  n=$(art migrate:status 2>/dev/null | grep -c -i pending || true)
  [ "$n" = "0" ] && break
  echo -n .; sleep 5
done; echo
art db:seed --force
art passport:install --force --no-interaction || art passport:keys --force
art tinker --execute='echo App\Models\User::where("username","admin")->firstOrFail()->createToken("mcp-test")->accessToken;' | tail -1 | tr -d '\r\n' > .snipeit-token
echo "token written to test/.snipeit-token ($(wc -c < .snipeit-token) bytes). Login: admin / password"
