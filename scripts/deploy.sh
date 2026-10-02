#!/usr/bin/env bash
# TumaFly — manual EF deploy wrapper
#
# Session 45 delivery. For the rare case where you need to trigger an EF deploy
# from the terminal rather than via a branch push (e.g. CI is down, or you need
# to roll back a specific function without reverting the commit).
#
# Normal flow is: push to staging → A3 auto-deploys; merge+push to main → prod
# auto-deploys. Only reach for this script when the push flow isn't available.
#
# Usage:
#   ./scripts/deploy.sh --env a3           # deploy all EFs to A3 sandbox
#   ./scripts/deploy.sh --env prod         # deploy all EFs to production (prompts)
#   ./scripts/deploy.sh --env a3 <fn>      # deploy ONE EF to A3
#   ./scripts/deploy.sh --env prod <fn>    # deploy ONE EF to prod (prompts)
#
# Requires: SUPABASE_ACCESS_TOKEN in environment (`mark-a3` or `mark-prod` alias
# will have exported it from the GPG vault). The script does NOT fetch tokens
# itself — the shell-tab alias is still the source of truth per RUNBOOK §26.4a.

set -euo pipefail

ENV=""
FUNCTION_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      echo "Usage: $0 --env {a3|prod} [function_name]" >&2
      exit 2
      ;;
    *)
      if [ -z "$FUNCTION_NAME" ]; then
        FUNCTION_NAME="$1"
        shift
      else
        echo "Unexpected argument: $1 (one function at a time)" >&2
        exit 2
      fi
      ;;
  esac
done

case "$ENV" in
  a3)
    PROJECT_REF="nljxqcrmmkodbzsrzdba"
    ENV_LABEL="A3 sandbox"
    ;;
  prod)
    PROJECT_REF="wmplcauhaqtyenwvkrkq"
    ENV_LABEL="PRODUCTION"
    ;;
  "")
    echo "Error: --env is required." >&2
    echo "Usage: $0 --env {a3|prod} [function_name]" >&2
    exit 2
    ;;
  *)
    echo "Error: --env must be 'a3' or 'prod' (got: $ENV)" >&2
    exit 2
    ;;
esac

# Preflight: Supabase CLI available + access token exported.
if ! command -v supabase >/dev/null 2>&1; then
  echo "Error: supabase CLI not found in PATH." >&2
  echo "Install: https://supabase.com/docs/guides/local-development/cli/getting-started" >&2
  exit 3
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "Error: SUPABASE_ACCESS_TOKEN not set in environment." >&2
  echo "Run 'mark-$ENV' alias first, or export the token manually from the GPG vault." >&2
  exit 3
fi

echo "[deploy] Target: $ENV_LABEL ($PROJECT_REF)"
if [ -n "$FUNCTION_NAME" ]; then
  echo "[deploy] Function: $FUNCTION_NAME"
else
  echo "[deploy] Functions: ALL (expected $(ls -1 supabase/functions/ 2>/dev/null | grep -v '^_shared$' | wc -l))"
fi

# Prod gate: typed confirmation.
if [ "$ENV" = "prod" ]; then
  echo ""
  echo "⚠️  You are about to deploy to PRODUCTION."
  echo "    Normal flow is to merge staging → main and let CI deploy."
  echo "    Terminal deploys bypass CI logging and the branch audit trail."
  echo ""
  read -r -p "Type 'yes' to proceed, anything else to abort: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "[deploy] Aborted."
    exit 1
  fi
fi

# Execute.
if [ -n "$FUNCTION_NAME" ]; then
  supabase functions deploy "$FUNCTION_NAME" \
    --project-ref "$PROJECT_REF" \
    --no-verify-jwt
else
  supabase functions deploy \
    --project-ref "$PROJECT_REF" \
    --no-verify-jwt
fi

echo ""
echo "[deploy] ✓ Deployed to $ENV_LABEL."
if [ "$ENV" = "prod" ]; then
  echo "[deploy] Run './scripts/post_deploy_smoke.sh --target prod' per SOP §5."
else
  echo "[deploy] Run './scripts/post_deploy_smoke.sh --target a3' to verify."
fi
