#!/usr/bin/env bash
set -euo pipefail

KEY_DIR="${1:-/etc/claimflow/keys}"

mkdir -p "${KEY_DIR}"

PRIVATE_KEY_PATH="${KEY_DIR}/jwt_private.pem"
PUBLIC_KEY_PATH="${KEY_DIR}/jwt_public.pem"
MASTER_KEY_PATH="${KEY_DIR}/master.key"

openssl genrsa -out "${PRIVATE_KEY_PATH}" 2048
openssl rsa -in "${PRIVATE_KEY_PATH}" -pubout -out "${PUBLIC_KEY_PATH}"
openssl rand -hex 32 > "${MASTER_KEY_PATH}"

chmod 600 "${PRIVATE_KEY_PATH}" "${PUBLIC_KEY_PATH}" "${MASTER_KEY_PATH}"

echo "Keys generated in ${KEY_DIR}"