#!/usr/bin/env bash
#
# check-no-phi.sh — fail CI if tests / fixtures / seed scripts / sample payloads
# contain values that look like REAL personal/health information.
#
# This is a guard, not a guarantee — it errs on the side of false positives.
# When a real-looking value is intentional (rare), prefix it with one of the
# documented synthetic markers (TEST-, TRAINING-, SANDBOX-, DEMO-, EXAMPLE-) or
# add an inline allowlist comment `phi-allowlist:reason`.
#
# Patterns we look for:
#   - Kenyan-format mobile numbers: +254 7|1 NNN NN NN NN  or  07/01 + 8 digits
#   - National ID-shaped values: bare 8-digit numbers NOT carrying a synthetic marker
#   - SHA Civil Registration numbers (CR + 9 digits)
#
# Scope: tests, fixtures, scripts, sandbox/seed data — everything checked into the
# repo that could leak real PHI. Production source code is excluded (it doesn't
# contain literals).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Files to scan (newline-delimited).
SCAN_FILES=$(git ls-files \
  'scripts/seed-*.sh' \
  'scripts/sandbox-*' \
  'packages/api/src/__tests__/**' \
  'packages/rule-engine/__tests__/**' \
  'packages/shared/src/__tests__/**' \
  'packages/sync-agent/src/__tests__/**' \
  'packages/sdk-node/src/__tests__/**' \
  'packages/web/tests/**' \
  'packages/ml-service/tests/**' \
  'sdks/python/tests/**' \
  'docs/sandbox-quickstart.md' \
  2>/dev/null | sort -u)

# Synthetic / allowlist markers — a line containing any of these is accepted
# even when it matches a PHI-shaped pattern. Add new markers here (with a
# comment) when introducing a new synthetic identifier convention.
#
# Includes well-established synthetic patterns:
#   - CR123456789 / CR999999999 / CR000000000 / CR111…CR999 (sequential, all-zeros, repeated-digit)
#   - 0700000000 / 0712345678 (all-zeros / sequential mobile numbers)
#   - all-same-digit and sequential 8-digit IDs (12345678, 87654321, 99999999, etc.)
SYNTHETIC_RE='TEST-|TRAINING-|SANDBOX-|EXAMPLE-|FAKE-|MOCK-|DEMO|example\.org|@example\.|placeholder|phi-allowlist:|Training Patient|SANDBOX Test Patient|FID-22-106718-4|CR(0|1|2|3|4|5|6|7|8|9)\1{8}|CR123456789|0+|1{8}|2{8}|3{8}|4{8}|5{8}|6{8}|7{8}|8{8}|9{8}|12345678|23456789|34567890|45678901|56789012|67890123|78901234|89012345|90123456|98765432|87654321|76543210|65432109|54321098|43210987|32109876|21098765|10987654'

# Specific allowlisted bare numbers that have meaning in the codebase but are NOT
# personal data (facility codes, SHA file references, etc.). Be conservative.
# Includes UUIDs: an 8-hex-digit segment followed by '-NNNN-' is unambiguously a
# UUID, not a National ID; the 8-digit-National-ID matcher would otherwise hit.
NUMERIC_ALLOWLIST='22106718|00000210|22-106718-4|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'

EXIT=0
HITS=$(mktemp)
trap 'rm -f "$HITS"' EXIT

scan_pattern() {
  local label="$1"; shift
  local pattern="$1"; shift
  if [ -z "$SCAN_FILES" ]; then return 0; fi
  # -E extended regex, -H show filename, -n line numbers, -I skip binaries
  echo "$SCAN_FILES" | xargs -r grep -EHnI "$pattern" 2>/dev/null \
    | grep -vE "$SYNTHETIC_RE" \
    | grep -vE "$NUMERIC_ALLOWLIST" \
    | awk -v label="$label" '{ printf("  [%s] %s\n", label, $0) }' \
    >> "$HITS" || true
}

# 1. Kenyan mobile numbers in international or local format. Mobile numbers are
#    9 digits after the country code (the leading 0 is stripped going international).
scan_pattern "KE-MOBILE-INT"   '\+254[[:space:]]*[71]([[:space:]-]*[0-9]){8}'
scan_pattern "KE-MOBILE-LOCAL" '\b0[71][0-9]{8}\b'

# 2. SHA Civil Registration shaped numbers (CR followed by 9 digits).
scan_pattern "SHA-CR"          '\bCR[0-9]{9}\b'

# 3. Bare 8-digit National-ID-shaped numbers in test data.
#    Only flag when the surrounding line lacks a synthetic marker. The numeric
#    allowlist above covers facility/registry codes.
scan_pattern "KE-NATIONAL-ID"  '\b[0-9]{8}\b'

if [ -s "$HITS" ]; then
  EXIT=1
  echo "ERROR: possible REAL PHI detected in scanned files." >&2
  echo "Each line below is a suspected real-PHI shape with no synthetic marker." >&2
  echo "Fix by replacing with synthetic data (TEST-/TRAINING-/SANDBOX-/EXAMPLE-)," >&2
  echo "or, if a value is intentionally bare, append the comment 'phi-allowlist:<reason>'." >&2
  echo "" >&2
  cat "$HITS" >&2
  echo "" >&2
  echo "(${SYNTHETIC_RE//|/, } are accepted as synthetic markers.)" >&2
fi

if [ "$EXIT" -eq 0 ]; then
  echo "no-PHI guard: OK ($(echo "$SCAN_FILES" | wc -l) files scanned)."
fi
exit "$EXIT"
