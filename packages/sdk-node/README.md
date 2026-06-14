# @claimflow/sdk-node

Typed Node/TypeScript client for the ClaimFlow API.

The request/response types in `src/generated/types.ts` are **generated from
[`docs/openapi.yaml`](../../docs/openapi.yaml)** (the source of truth) by
`scripts/generate-sdks.sh`. The client and error classes are thin, stable,
hand-written wrappers — so adding a field to the spec flows straight through to
the SDK types. The SDK exposes scores, flags, reason codes and the closed audit
summary only; it never carries detection-rule internals.

## Install

```bash
pnpm add @claimflow/sdk-node
```

Requires Node 20+ (uses the built-in global `fetch`).

## Quickstart

### API key

```ts
import { ClaimFlowClient } from '@claimflow/sdk-node';

const client = new ClaimFlowClient({
  baseUrl: 'https://claimflow.hospital.example',
  apiKey: 'cf_live_…',
});

const score = await client.scoreClaim(fhirClaim, crypto.randomUUID()); // 2nd arg = Idempotency-Key
console.log(score.riskLevel, score.recommendedAction, score.flags);
```

### OAuth2 client-credentials

```ts
const client = new ClaimFlowClient({
  baseUrl: 'https://claimflow.hospital.example',
  oauth: { clientId: '…', clientSecret: '…', scope: 'claim:create' },
});
// The bearer token is fetched from /v1/oauth/token and cached until expiry.
```

### Batch submit + poll

```ts
const accepted = await client.submitClaimBatch({ claims: [c1, c2, c3] }, idempotencyKey);
let status = await client.getClaimBatch(accepted.batchId);
while (status.status === 'QUEUED' || status.status === 'PROCESSING') {
  await new Promise((r) => setTimeout(r, 2000));
  status = await client.getClaimBatch(accepted.batchId);
}
```

## Error handling

Every non-2xx response throws a `ClaimFlowError`, which parses **both** the
`application/problem+json` (machine credentials) and `{ errors, meta }` (human
session) shapes into one surface:

```ts
import { ClaimFlowError } from '@claimflow/sdk-node';

try {
  await client.scoreClaim(badClaim);
} catch (err) {
  if (err instanceof ClaimFlowError) {
    console.error(err.status, err.code, err.detail, err.errors, err.requestId);
  }
}
```

## Regenerating

Do not edit `src/generated/types.ts` by hand. Regenerate from the spec:

```bash
bash scripts/generate-sdks.sh            # regenerate TS + Python + docs
bash scripts/generate-sdks.sh --check    # CI guard: fail if out of date
```
