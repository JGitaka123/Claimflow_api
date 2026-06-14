# ClaimFlow Sandbox Quickstart

A self-contained sandbox for trying the ClaimFlow API and the official SDKs
against **synthetic data only** — there is no real PHI anywhere in the sandbox.

## 1. Seed the sandbox

With the stack running (`docker compose -f docker/docker-compose.yml --env-file docker/.env up -d`):

```bash
scripts/seed-sandbox.sh
```

This idempotently creates a `sandbox` tenant + facility + owner user, **one API
key**, **one OAuth2 client**, and **5 synthetic claims** (`SANDBOX-…`). It prints
the credentials at the end. They are fixed and safe to share — sandbox only:

| | |
|---|---|
| Tenant slug | `sandbox` |
| API key | `cf_5a4d6b0e_5e7b3c9a1f2d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b` |
| OAuth `client_id` | `cf-sandbox-client` |
| OAuth `client_secret` | `cf_sandbox_secret_3f1e5d7c9b1a3e5d7c9b1a3e5d7c9b1a` |
| Scopes | `claim:create`, `audit:trigger`, `export:evidence`, `dashboard:view` |

> **Never** use these in production. Rotate/disable the sandbox before any real
> traffic. The sandbox accepts synthetic claims only.

## 2a. Node / TypeScript SDK

```bash
pnpm add @claimflow/sdk-node
```

```ts
import { ClaimFlowClient } from '@claimflow/sdk-node';
import { randomUUID } from 'node:crypto';

// API key:
const client = new ClaimFlowClient({
  baseUrl: 'http://localhost:8080',
  apiKey: 'cf_5a4d6b0e_5e7b3c9a1f2d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b',
});

// ...or OAuth2 client-credentials:
// const client = new ClaimFlowClient({
//   baseUrl: 'http://localhost:8080',
//   oauth: { clientId: 'cf-sandbox-client', clientSecret: 'cf_sandbox_secret_3f1e5d7c9b1a3e5d7c9b1a3e5d7c9b1a' },
// });

// Score a (synthetic) FHIR R4 Claim:
const score = await client.scoreClaim(syntheticFhirClaim, randomUUID());
console.log(score.riskLevel, score.recommendedAction, score.flags);

// Submit a batch and poll:
const accepted = await client.submitClaimBatch({ claims: [syntheticFhirClaim] }, randomUUID());
let status = await client.getClaimBatch(accepted.batchId);
while (status.status === 'QUEUED' || status.status === 'PROCESSING') {
  await new Promise((r) => setTimeout(r, 2000));
  status = await client.getClaimBatch(accepted.batchId);
}
console.log(status.items);
```

## 2b. Python SDK

```bash
pip install claimflow
```

```python
import time, uuid
from claimflow import ClaimFlowClient

# API key:
client = ClaimFlowClient(
    "http://localhost:8080",
    api_key="cf_5a4d6b0e_5e7b3c9a1f2d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b",
)

# ...or OAuth2 client-credentials:
# client = ClaimFlowClient(
#     "http://localhost:8080",
#     client_id="cf-sandbox-client",
#     client_secret="cf_sandbox_secret_3f1e5d7c9b1a3e5d7c9b1a3e5d7c9b1a",
# )

score = client.score_claim(synthetic_fhir_claim, idempotency_key=str(uuid.uuid4()))
print(score["riskLevel"], score["recommendedAction"], score["flags"])

accepted = client.submit_claim_batch({"claims": [synthetic_fhir_claim]}, idempotency_key=str(uuid.uuid4()))
status = client.get_claim_batch(accepted["batchId"])
while status["status"] in ("QUEUED", "PROCESSING"):
    time.sleep(2)
    status = client.get_claim_batch(accepted["batchId"])
print(status["items"])
```

## 2c. Raw HTTP (no SDK)

```bash
# OAuth token
curl -s http://localhost:8080/v1/oauth/token \
  -H 'content-type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"cf-sandbox-client","client_secret":"cf_sandbox_secret_3f1e5d7c9b1a3e5d7c9b1a3e5d7c9b1a"}'

# Score with the API key
curl -s http://localhost:8080/v1/claims/score \
  -H 'X-Api-Key: cf_5a4d6b0e_5e7b3c9a1f2d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b' \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @synthetic-claim.json
```

## 3. API reference

Open [`docs/api/index.html`](api/index.html) in a browser — a fully self-contained,
offline rendering of [`docs/openapi.yaml`](openapi.yaml) (no CDN, no external
calls). It is the source of truth for the contract; both SDKs are generated from
it.

## What the sandbox returns

Scoring/batch responses expose **risk level, recommended action, public flags
(reason code + category + severity + message) and counts only** — never rule
thresholds, rule definitions, evidence, or model internals. The same closed
contract applies in production.
