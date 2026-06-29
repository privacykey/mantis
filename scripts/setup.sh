#!/usr/bin/env bash
# Mantis setup — prepares .env for a `docker compose up` deployment.
#
# Idempotent and safe to re-run: it creates .env from .env.example if missing,
# then fills in the two required secrets ONLY when they're empty or still the
# insecure quickstart default:
#   - POSTGRES_PASSWORD     random 192-bit, URL-safe. Single source of truth for
#                           the DB password; docker-compose derives DATABASE_URL
#                           from it.
#   - MANTIS_API_KEY_PEPPER random. HMAC key for hashing API keys at rest. Never
#                           rotated once set (rotating invalidates every key).
#
# Existing non-default values are left untouched.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"
EXAMPLE_FILE=".env.example"

# hex is URL-safe (no / + = @ : characters), so POSTGRES_PASSWORD drops cleanly
# into a postgres:// connection string without any percent-encoding.
gen_pw()     { openssl rand -hex 24; }      # 192 bits
gen_pepper() { openssl rand -base64 32; }   # matches the docs' pepper recipe

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  echo "▸ created $ENV_FILE from $EXAMPLE_FILE"
else
  echo "▸ $ENV_FILE already exists — updating only empty/default secrets"
fi

# Current value of KEY in .env (empty if unset or blank; ignores commented lines).
cur() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n1; }

# Set KEY=VALUE: replace the first `KEY=` line if present, else append. Rebuilt
# via a temp file so it's portable across BSD/macOS and GNU sed. VALUE is taken
# literally — the generators above emit no awk metacharacters.
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" '
      !done && index($0, k"=") == 1 { print k"="v; done = 1; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

# Generate KEY with GEN unless it already holds a real (non-empty, non-WEAK) value.
ensure_secret() {
  local key="$1" gen="$2" weak="${3:-}" val
  val="$(cur "$key")"
  if [ -z "$val" ] || { [ -n "$weak" ] && [ "$val" = "$weak" ]; }; then
    set_env "$key" "$("$gen")"
    echo "▸ generated $key"
  else
    echo "▸ $key already set — left unchanged"
  fi
}

ensure_secret POSTGRES_PASSWORD     gen_pw     mantis
ensure_secret MANTIS_API_KEY_PEPPER gen_pepper

cat <<'EOF'

Setup complete. Next:
  docker compose up -d

Then read the one-time bootstrap admin key:
  docker compose logs -f mantis | grep -m1 -A1 'bootstrap API key'

Security reminders:
  • Postgres publishes no host port and is on an internal-only docker network.
  • Do NOT expose mantis over plain HTTP. Put it behind a tunnel
    (docker compose --profile tailscale up) or a TLS-terminating reverse proxy —
    over plain HTTP the API key and session cookie travel in cleartext.
EOF
