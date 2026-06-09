# claimflow (Python SDK)

Python client for the ClaimFlow API.

The pydantic models in `claimflow/models.py` are **generated from
[`docs/openapi.yaml`](../../docs/openapi.yaml)** (the source of truth) by
`scripts/generate-sdks.sh`. The client is a thin, stable hand-written wrapper. It
exposes scores, flags, reason codes and the closed audit summary only — never
detection-rule internals.

## Install

```bash
pip install claimflow
```

Requires Python 3.11+.

## Quickstart

### API key

```python
from claimflow import ClaimFlowClient

client = ClaimFlowClient("https://claimflow.hospital.example", api_key="cf_live_…")

score = client.score_claim(fhir_claim, idempotency_key="…")
print(score["riskLevel"], score["recommendedAction"], score["flags"])
```

### OAuth2 client-credentials

```python
client = ClaimFlowClient(
    "https://claimflow.hospital.example",
    client_id="…",
    client_secret="…",
    scope="claim:create",
)
# The bearer token is fetched from /v1/oauth/token and cached until expiry.
```

### Batch submit + poll

```python
import time

accepted = client.submit_claim_batch({"claims": [c1, c2, c3]}, idempotency_key="…")
status = client.get_claim_batch(accepted["batchId"])
while status["status"] in ("QUEUED", "PROCESSING"):
    time.sleep(2)
    status = client.get_claim_batch(accepted["batchId"])
```

## Error handling

```python
from claimflow import ClaimFlowError

try:
    client.score_claim(bad_claim)
except ClaimFlowError as err:
    print(err.status, err.code, err.detail, err.errors, err.request_id)
```

## Regenerating

Do not edit `claimflow/models.py` by hand. Regenerate from the spec:

```bash
bash scripts/generate-sdks.sh            # regenerate TS + Python + docs
bash scripts/generate-sdks.sh --check    # CI guard: fail if out of date
```
