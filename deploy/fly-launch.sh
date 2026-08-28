#!/usr/bin/env bash
# One-command Fly.io launch for mantis: app → Postgres → secrets → deploy.
#
#   bash deploy/fly-launch.sh --app my-mantis --region iad
#
# Safe to re-run: every step is idempotent, and the script REFUSES to
# overwrite an existing MANTIS_API_KEY_PEPPER (rotating it invalidates every
# API key ever minted). Re-running an already-launched app just redeploys.
#
# Options:
#   --app NAME       Fly app name (required; becomes <name>.fly.dev)
#   --region CODE    Fly region, default iad. `fly platform regions` to list.
#   --org ORG        Fly organization, default your personal org.
#   --db MODE        mpg (default) | unmanaged | external | none
#                      mpg       — Fly Managed Postgres (supported product)
#                      unmanaged — legacy `fly postgres`, NOT covered by Fly support
#                      external  — you supply DATABASE_URL in the environment
#                      none      — skip DB entirely (you wire it up later)
#   --db-plan PLAN   MPG hardware plan: basic (default) | launch | scale
#   --dry-run        Print every command without running anything.
#   --yes            Don't prompt for confirmation.
set -euo pipefail

APP=""
REGION="iad"
ORG=""
DB_MODE="mpg"
DB_PLAN="basic"
DRY_RUN=0
ASSUME_YES=0

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "▸ $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --org) ORG="${2:-}"; shift 2 ;;
    --db) DB_MODE="${2:-}"; shift 2 ;;
    --db-plan) DB_PLAN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# `run` executes (or, under --dry-run, just prints) a command.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Validate the public origin before provisioning or deploying. A stale
# *.fly.dev hostname silently mints every canary URL against the wrong app,
# while plain HTTP exposes the API key and session cookie in cleartext.
# Intentional custom HTTPS domains are valid and cannot be derived from --app,
# so accept them after surfacing what will be used.
validate_public_base_url() {
  local config_file="$1" configured expected
  configured="$(sed -n 's/^[[:space:]]*PUBLIC_BASE_URL[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$config_file" | head -n1)"
  expected="https://$APP.fly.dev"

  [ -n "$configured" ] || die "$config_file has no quoted PUBLIC_BASE_URL in [env].
  Set it to $expected (or your custom HTTPS domain) before deploying."

  case "$configured" in
    "$expected") ;;
    https://*.fly.dev)
      die "$config_file PUBLIC_BASE_URL points at a different Fly app:
  configured: $configured
  --app:      $APP
  expected:   $expected
Update PUBLIC_BASE_URL or rerun with the matching --app value."
      ;;
    https://*)
      info "custom PUBLIC_BASE_URL: $configured"
      ;;
    *)
      die "$config_file PUBLIC_BASE_URL must be an absolute https:// URL (got: $configured)"
      ;;
  esac
}

# --- preflight -------------------------------------------------------------

[ -n "$APP" ] || die "--app is required (e.g. --app my-mantis)"
case "$APP" in
  *[!a-z0-9-]*|-*|*-) die "--app must be lowercase letters, digits and inner hyphens: '$APP'" ;;
esac
case "$DB_MODE" in
  mpg|unmanaged|external|none) ;;
  *) die "--db must be one of: mpg, unmanaged, external, none" ;;
esac

FLY="$(command -v flyctl || command -v fly || true)"
[ -n "$FLY" ] || die "flyctl not found. Install it: https://fly.io/docs/flyctl/install/
  macOS:  brew install flyctl
  other:  curl -L https://fly.io/install.sh | sh"

[ -f docker/Dockerfile ] || die "run this from the repo root (docker/Dockerfile not found)"
[ -f deploy/fly.toml.example ] || die "deploy/fly.toml.example missing"

if ! "$FLY" auth whoami >/dev/null 2>&1; then
  die "not logged in to Fly. Run: $FLY auth login"
fi
info "flyctl: $("$FLY" version 2>/dev/null | head -1) — authenticated as $("$FLY" auth whoami 2>/dev/null)"

if [ "$DB_MODE" = "external" ] && [ -z "${DATABASE_URL:-}" ]; then
  die "--db external requires DATABASE_URL in the environment:
  DATABASE_URL='postgres://…' bash deploy/fly-launch.sh --app $APP --db external"
fi

ORG_ARGS=()
[ -n "$ORG" ] && ORG_ARGS=(--org "$ORG")

case "$DB_MODE" in
  mpg)       DB_NOTE="Fly Managed Postgres, plan '$DB_PLAN' — BILLED HOURLY.
             The 'basic' plan was ~\$38/mo + ~\$0.28/GB storage at time of
             writing; check https://fly.io/docs/mpg/ for current pricing.
             Cheaper options: --db external with a Neon/Supabase free tier,
             or --db unmanaged (a plain Fly machine, no support)." ;;
  unmanaged) DB_NOTE="legacy 'fly postgres' — cheap, but UNMANAGED: Fly support
             does not cover it. If it OOMs or fills its disk, that's on you." ;;
  external)  DB_NOTE="using the DATABASE_URL you supplied (nothing provisioned).
             Pooled/PgBouncer URLs are fine — the client sets prepare:false." ;;
  none)      DB_NOTE="skipped — set DATABASE_URL yourself before deploying." ;;
esac

cat <<EOF

  app        $APP   →  https://$APP.fly.dev
  region     $REGION
  org        ${ORG:-<personal>}
  config     fly.toml (generated from deploy/fly.toml.example)
  machine    shared-cpu-1x / 512MB  (~\$3-4/mo; measured peak use ~150MB)

  database   $DB_MODE
             $DB_NOTE
$([ "$DRY_RUN" = "1" ] && echo "
  DRY RUN — nothing will be created.")
EOF

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  printf '\nProceed? [y/N] '
  read -r reply
  case "$reply" in [yY]*) ;; *) die "aborted" ;; esac
fi

# --- fly.toml --------------------------------------------------------------

if [ -f fly.toml ]; then
  info "fly.toml already exists — leaving it alone"
  if ! grep -q "TRUST_PROXY_HEADERS" fly.toml; then
    echo "  ⚠ your fly.toml has no TRUST_PROXY_HEADERS — every hit will record"
    echo "    ip = null. Copy the [env] block from deploy/fly.toml.example."
  fi
else
  info "generating fly.toml for '$APP' in $REGION"
  if [ "$DRY_RUN" = "1" ]; then
    echo "   [dry-run] sed deploy/fly.toml.example > fly.toml"
  else
    sed -e "s/^app = \".*\"/app = \"$APP\"/" \
        -e "s/^primary_region = \".*\"/primary_region = \"$REGION\"/" \
        -e "s|https://mantis-CHANGE-ME.fly.dev|https://$APP.fly.dev|" \
        deploy/fly.toml.example > fly.toml
    grep -q "CHANGE-ME" fly.toml && die "fly.toml still contains CHANGE-ME — template drift, fix deploy/fly.toml.example"
  fi
fi

# Under --dry-run a missing fly.toml is only described, not generated, so
# there is no file to validate. Existing files are always checked.
if [ -f fly.toml ]; then
  validate_public_base_url fly.toml
fi

# --- app -------------------------------------------------------------------

if "$FLY" status --app "$APP" >/dev/null 2>&1; then
  info "app '$APP' already exists — skipping create"
else
  info "creating app '$APP'"
  run "$FLY" apps create "$APP" "${ORG_ARGS[@]+"${ORG_ARGS[@]}"}"
fi

# --- database --------------------------------------------------------------

case "$DB_MODE" in
  mpg)
    CLUSTER="$APP-db"
    info "creating Managed Postgres cluster '$CLUSTER' (plan: $DB_PLAN)"
    if "$FLY" mpg list 2>/dev/null | grep -q "[[:space:]]$CLUSTER[[:space:]]\|^$CLUSTER[[:space:]]"; then
      info "cluster '$CLUSTER' already exists — skipping create"
    else
      run "$FLY" mpg create --name "$CLUSTER" --region "$REGION" --plan "$DB_PLAN" "${ORG_ARGS[@]+"${ORG_ARGS[@]}"}"
    fi

    # `fly mpg attach` wants the cluster ID, not its name.
    if [ "$DRY_RUN" = "1" ]; then
      echo "   [dry-run] $FLY mpg attach <cluster-id of $CLUSTER> --app $APP"
    else
      CLUSTER_ID="$("$FLY" mpg list 2>/dev/null \
        | awk -v n="$CLUSTER" '$0 ~ n {for(i=1;i<=NF;i++) if($i==n){print $1; exit}}')"
      if [ -n "$CLUSTER_ID" ] && [ "$CLUSTER_ID" != "$CLUSTER" ]; then
        info "attaching cluster $CLUSTER_ID → $APP (sets DATABASE_URL)"
        "$FLY" mpg attach "$CLUSTER_ID" --app "$APP" || \
          echo "  ⚠ attach failed — run it yourself: $FLY mpg attach $CLUSTER_ID --app $APP"
      else
        echo "  ⚠ could not auto-detect the cluster ID from '$FLY mpg list'."
        echo "    Finish with:  $FLY mpg list        # copy the ID for $CLUSTER"
        echo "                  $FLY mpg attach <id> --app $APP"
      fi
    fi
    ;;
  unmanaged)
    echo "  ⚠ 'fly postgres' clusters are UNMANAGED — Fly support does not cover them."
    info "creating unmanaged Postgres '$APP-db'"
    run "$FLY" postgres create --name "$APP-db" --region "$REGION" "${ORG_ARGS[@]+"${ORG_ARGS[@]}"}"
    run "$FLY" postgres attach "$APP-db" --app "$APP"
    ;;
  external)
    info "setting DATABASE_URL from the environment"
    if [ "$DRY_RUN" = "1" ]; then
      echo "   [dry-run] printf 'DATABASE_URL=…' | $FLY secrets import --app $APP"
    else
      printf 'DATABASE_URL=%s\n' "$DATABASE_URL" | "$FLY" secrets import --app "$APP"
    fi
    ;;
  none)
    info "skipping database setup (--db none) — set DATABASE_URL before deploying"
    ;;
esac

# --- secrets ---------------------------------------------------------------
# The pepper is write-once: rotating it invalidates every minted API key, so
# we only ever set it when the app has none.

BOOTSTRAP_KEY=""
if [ "$DRY_RUN" = "1" ]; then
  echo "   [dry-run] $FLY secrets list --app $APP   # check for MANTIS_API_KEY_PEPPER"
  echo "   [dry-run] printf 'MANTIS_API_KEY_PEPPER=…\\nBOOTSTRAP_API_KEY=…' | $FLY secrets import --app $APP"
elif "$FLY" secrets list --app "$APP" 2>/dev/null | grep -q 'MANTIS_API_KEY_PEPPER'; then
  info "MANTIS_API_KEY_PEPPER already set — NOT rotating it (would invalidate every API key)"
else
  info "generating MANTIS_API_KEY_PEPPER + first admin key"
  PEPPER="$(openssl rand -base64 32)"
  # Format required by isWellFormedApiKey(): mantis_live_ + >16 chars.
  BOOTSTRAP_KEY="mantis_live_$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  # Piped via `secrets import` (stdin) so neither value lands in argv or history.
  printf 'MANTIS_API_KEY_PEPPER=%s\nBOOTSTRAP_API_KEY=%s\n' "$PEPPER" "$BOOTSTRAP_KEY" \
    | "$FLY" secrets import --app "$APP"
  unset PEPPER
fi

# --- deploy ----------------------------------------------------------------

info "deploying (builds docker/Dockerfile remotely)"
run "$FLY" deploy --app "$APP" --config fly.toml

if [ "$DRY_RUN" = "1" ]; then
  echo
  info "dry run complete — nothing was created."
  exit 0
fi

# --- done ------------------------------------------------------------------

cat <<EOF

──────────────────────────────────────────────────────────────
  mantis is live:  https://$APP.fly.dev
EOF

if [ -n "$BOOTSTRAP_KEY" ]; then
  cat <<EOF

  Admin API key (shown once — save it now):

      $BOOTSTRAP_KEY

  Sign in at https://$APP.fly.dev/login, or:
      mantis login --url https://$APP.fly.dev
EOF
else
  cat <<EOF

  Existing app — your original API keys still work.
  Lost them? Mint a new one from the dashboard, or check first-boot logs:
      $FLY logs --app $APP | grep -A1 'bootstrap API key'
EOF
fi

cat <<EOF

  Check it:   curl https://$APP.fly.dev/api/health
  Logs:       $FLY logs --app $APP
  Redeploy:   $FLY deploy --app $APP

  Before exposing canary URLs publicly, read the edge-limit rules:
  https://docs.mantis.privacykey.org/deployment/edge-limits#flyio
──────────────────────────────────────────────────────────────
EOF
