#!/usr/bin/env bash
#
# generate-sdks.sh — regenerate every SDK/doc artifact FROM docs/openapi.yaml.
#
# The OpenAPI spec is the single source of truth. This script regenerates:
#   1. packages/sdk-node/src/generated/types.ts   (openapi-typescript)
#   2. sdks/python/claimflow/models.py            (datamodel-code-generator, pydantic v2)
#   3. docs/api/index.html                         (vendored Redoc, spec inlined)
#
# Everything is local and offline — no network calls, no LLM. The hand-written
# SDK client wrappers (client.ts / client.py) are NOT touched; they are typed off
# these generated artifacts so a new spec field flows through automatically.
#
# Usage:
#   scripts/generate-sdks.sh           regenerate in place
#   scripts/generate-sdks.sh --check   regenerate, then fail if the tree changed
#                                       (the CI drift guard — committed == spec)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SPEC="docs/openapi.yaml"
TS_OUT="packages/sdk-node/src/generated/types.ts"
PY_OUT="sdks/python/claimflow/models.py"

GENERATED_HEADER_TS="// AUTO-GENERATED from docs/openapi.yaml by scripts/generate-sdks.sh — DO NOT EDIT."

echo "==> [1/3] TypeScript types -> $TS_OUT"
node_modules/.bin/openapi-typescript "$SPEC" -o "$TS_OUT" --root-types >/dev/null
# Prepend a do-not-edit banner (openapi-typescript already adds its own).
printf '%s\n%s\n' "$GENERATED_HEADER_TS" "$(cat "$TS_OUT")" > "$TS_OUT.tmp" && mv "$TS_OUT.tmp" "$TS_OUT"

echo "==> [2/3] Python pydantic v2 models -> $PY_OUT"
# `--formatters builtin` keeps output dependency-free (no black/isort), so the
# committed file is reproducible across environments regardless of which black
# version happens to be installed — important for the --check drift guard.
datamodel-codegen \
  --input "$SPEC" \
  --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel \
  --use-double-quotes \
  --target-python-version 3.11 \
  --formatters builtin \
  --disable-timestamp \
  --custom-file-header "# AUTO-GENERATED from docs/openapi.yaml by scripts/generate-sdks.sh — DO NOT EDIT." \
  --output "$PY_OUT" 2>/dev/null

echo "==> [3/3] Rendered docs -> docs/api/index.html"
node scripts/build-redoc-html.mjs

if [[ "${1:-}" == "--check" ]]; then
  echo "==> --check: verifying committed artifacts match the spec"
  if ! git diff --exit-code -- "$TS_OUT" "$PY_OUT" docs/api/index.html; then
    echo ""
    echo "ERROR: generated SDK/doc artifacts are out of date with docs/openapi.yaml." >&2
    echo "       Run scripts/generate-sdks.sh and commit the result." >&2
    exit 1
  fi
  echo "OK: SDK artifacts are in sync with the spec."
fi

echo "Done."
