#!/usr/bin/env bash
# scripts/verify_secrets.sh
# Verifies TumaFly's Supabase Edge Function secrets.
#
# Modes:
#   Default (remote existence check): reads `supabase secrets list --project-ref XXX`
#     and confirms every expected secret is present. Does NOT show values.
#   --local FILE: additionally reads values from FILE (KEY=value format, no
#     surrounding quotes) and checks whitespace + expected prefix. Local file is
#     up to the operator to maintain; do NOT commit it to git.
#
# Exit codes:
#   0 = all expected secrets present (and, in --local mode, all values pass)
#   1 = one or more expected secrets missing on remote
#   2 = one or more values failed local-mode checks
#   3 = tool-invocation error (supabase CLI missing, argument error)
#
# See TumaFly_SOP_Master.md §1 (Secret Rotation) for context.

set -u

PROJECT_REF="wmplcauhaqtyenwvkrkq"

EXPECTED_SECRETS=(
  DUFFEL_API_KEY
  PAYSTACK_API_KEY
  AT_API_KEY
  RESEND_API_KEY
  TURNSTILE_SECRET
  DARAJA_CONSUMER_KEY
  DARAJA_CONSUMER_SECRET
  DARAJA_PASSKEY
  DUFFEL_WEBHOOK_SECRET
  PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET
  REFUND_NOTIFICATION_WEBHOOK_SECRET
  SEND_OTP_HOOK_SECRET
  AUTH_JWT_SECRET
  SERVICE_ROLE_KEY
)

LOCAL_PREFIX_EXPECTATIONS=(
  "DUFFEL_API_KEY:duffel_test_|duffel_live_"
  "PAYSTACK_API_KEY:sk_test_|sk_live_"
  "RESEND_API_KEY:re_"
  "SERVICE_ROLE_KEY:eyJ"
  "SEND_OTP_HOOK_SECRET:v1,whsec_"
)

LOCAL_ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      shift
      LOCAL_ENV_FILE="${1:-}"
      if [[ -z "$LOCAL_ENV_FILE" || ! -f "$LOCAL_ENV_FILE" ]]; then
        echo "ERROR: --local requires a readable file path" >&2
        exit 3
      fi
      shift
      ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \?//' | head -25
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 3
      ;;
  esac
done

if ! command -v supabase >/dev/null 2>&1; then
  echo "ERROR: supabase CLI not found in PATH" >&2
  exit 3
fi

echo "── Remote existence check (Supabase project: $PROJECT_REF) ──"

remote_output=$(supabase secrets list --project-ref "$PROJECT_REF" 2>&1) || {
  echo "ERROR: supabase secrets list failed:" >&2
  echo "$remote_output" >&2
  exit 3
}

missing_count=0
for secret in "${EXPECTED_SECRETS[@]}"; do
  if echo "$remote_output" | grep -qE "^\s*$secret\s"; then
    echo "  $secret: OK (present)"
  else
    echo "  $secret: FAIL (missing on remote)"
    missing_count=$((missing_count + 1))
  fi
done

local_fail_count=0
if [[ -n "$LOCAL_ENV_FILE" ]]; then
  echo ""
  echo "── Local value check (source: $LOCAL_ENV_FILE) ──"

  declare -A LOCAL_VALS
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    LOCAL_VALS[$key]="$val"
  done < "$LOCAL_ENV_FILE"

  for secret in "${EXPECTED_SECRETS[@]}"; do
    if [[ -z "${LOCAL_VALS[$secret]:-}" ]]; then
      echo "  $secret: SKIP (not in local file)"
      continue
    fi
    val="${LOCAL_VALS[$secret]}"

    trimmed="${val#"${val%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [[ "$trimmed" != "$val" ]]; then
      echo "  $secret: FAIL (leading/trailing whitespace)"
      local_fail_count=$((local_fail_count + 1))
      continue
    fi

    prefix_expected=0
    prefix_ok=0
    for entry in "${LOCAL_PREFIX_EXPECTATIONS[@]}"; do
      exp_name="${entry%%:*}"
      exp_prefixes="${entry#*:}"
      if [[ "$exp_name" == "$secret" ]]; then
        prefix_expected=1
        IFS='|' read -ra prefixes <<< "$exp_prefixes"
        for p in "${prefixes[@]}"; do
          if [[ "$val" == "$p"* ]]; then
            prefix_ok=1
            break
          fi
        done
        break
      fi
    done

    if [[ $prefix_expected -eq 0 ]]; then
      echo "  $secret: OK (whitespace clean; no prefix rule)"
    elif [[ $prefix_ok -eq 1 ]]; then
      echo "  $secret: OK (whitespace clean, prefix matches)"
    else
      echo "  $secret: FAIL (value present but does not match expected prefix)"
      local_fail_count=$((local_fail_count + 1))
    fi
  done
fi

echo ""
echo "── Summary ──"
echo "  Expected: ${#EXPECTED_SECRETS[@]} secrets"
echo "  Missing on remote: $missing_count"
if [[ -n "$LOCAL_ENV_FILE" ]]; then
  echo "  Local value failures: $local_fail_count"
fi

if [[ $missing_count -gt 0 ]]; then
  exit 1
fi
if [[ $local_fail_count -gt 0 ]]; then
  exit 2
fi
echo "All expected secrets present."
exit 0
