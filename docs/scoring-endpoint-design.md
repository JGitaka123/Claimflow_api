# Scoring Endpoint Design — `POST /v1/claims/score`

> Backlog item 3. Status: **implemented** (core). The Auditor-General typology mapping remains a
> follow-up pending the authoritative list. This plan landed before the implementation per the
> operating rules.

## Purpose

A machine-facing endpoint that accepts a **FHIR R4 Claim** resource, runs the deterministic
per-payer rulepack against it, persists the claim + an audit session, and returns a
**public-safe scored result** — risk score, flagged patterns, reason codes, and a recommended
action — **without leaking any detection-rule internals** (thresholds, logic keys, params, raw
rule definitions, or evidence).

## Confirmed decisions

1. **Reason codes — build now, map later.** Flags carry a ClaimFlow-owned reason code derived
   from the deterministic rulepack. A `auditorGeneralTypology` field is present but stays
   `null` until the authoritative SHA Auditor-General typology list is supplied
   (`reference-data/`). We never fabricate or claim provenance we don't have.
2. **Persist claim + audit.** Each score call creates a claim (reusing `claim-service`, so it
   inherits payer resolution, dedup, idempotency, and the audit trail) and an audit session,
   giving a full, reproducible record. (PHI persistence — acceptable under the hosted-SaaS
   model; revisit retention in compliance item 9.)
3. **problem+json for public endpoints only.** `POST /v1/claims/score` returns RFC 7807
   `application/problem+json` errors. The existing internal `{ data, meta, errors }` envelope is
   unchanged everywhere else (no breaking refactor of the web frontend or existing routes).

## Adjudication integrity (non-negotiable)

- **Fail closed**: a claim whose payer is not `ACTIVE` (no authoritative rulepack) is rejected
  (`409/422`), never scored. Reuses the slice-2 payer registry + `resolveClaimPayer`.
- **No fabricated data**: reason codes come only from the deterministic rulepack; the
  Auditor-General mapping is empty until provided.
- **No internals leak**: the public response excludes `logic_key`, `params`, thresholds,
  `evidence_json`, and raw rulepack definitions. It returns scores, flags, reason codes,
  category, severity bucket, and a short public message only.

## Input — FHIR R4 Claim (pragmatic subset)

Request body: `{ facilityId: uuid, payerId?: uuid, claim: <FHIR Claim> }`. `facilityId` is required
(mapping a FHIR `provider` reference to an internal facility UUID needs a registry lookup, out of
scope here); `payerId` defaults to SHA. Supported FHIR Claim fields:

| FHIR path | ClaimFlow field |
|---|---|
| `claim.patient.identifier.value` | `patientShaId` |
| `claim.type.coding[].code` | `claimType` (mapped; default `OUTPATIENT`) |
| `claim.billablePeriod.start` | `admissionDate` (required) |
| `claim.billablePeriod.end` | `dischargeDate` |
| `claim.diagnosis[sequence=1].diagnosisCodeableConcept.coding[].code` | `primaryDiagnosisCode` |
| `claim.item[].productOrService.coding[].code` | line `shaServiceCode` |
| `claim.item[].productOrService.text` | line `description` |
| `claim.item[].quantity.value` | line `quantity` |
| `claim.item[].unitPrice.value` / `net.value` | line `unitPrice` |

Validated with Zod (`FhirClaimResourceSchema`), `resourceType` pinned to `'Claim'`.

## Flow

1. Validate request (`ScoreClaimSchema`); problem+json on validation failure.
2. Map FHIR Claim → `CreateClaimInput`.
3. `claimService.createClaim(...)` — payer resolution (fail closed on non-ACTIVE), dedup,
   idempotency (via `Idempotency-Key` header), audit trail. Persists the claim.
4. `auditPipeline.scoreClaimStructured(...)` — document-less evaluation: builds `RuleEngineInput`
   with `documents: []`, selects the payer's engine, evaluates, persists an `audit_sessions` row
   (payer + rulepack version recorded) + `rule_results`, sets `last_audit_session_id`.
   Document-dependent rules deterministically return `INCOMPLETE`.
5. Map `RuleEngineOutput` → public `ClaimScoreResult` (no internals).

## Output — `ClaimScoreResult` (public-safe)

```
{
  claimId, auditId,
  payer: { slug, name },
  decision: PASSED | FAILED | WARNING,
  riskScore: 0..100,            // (1 - deterministicScore) * 100, rounded
  riskLevel: LOW | MEDIUM | HIGH,
  recommendedAction: READY_FOR_SUBMISSION | REVIEW_RECOMMENDED | FIX_REQUIRED | DO_NOT_SUBMIT,
  flags: [{
    reasonCode,                 // ClaimFlow taxonomy, e.g. "CF-FIN-021"
    category,                   // IDENTITY | DOCUMENTATION | ... (classification, not a definition)
    severity,                   // HARD_STOP | MAJOR | MINOR | INFO
    message,                    // short public description (no thresholds)
    auditorGeneralTypology: null // populated when the official mapping is supplied
  }],
  counts: { failed, warning, incomplete, passed }
}
```

Only `FAIL` / `WARNING` / `INCOMPLETE` results become flags. Returned via `{ data, meta }`.

## Errors — RFC 7807

`application/problem+json`: `{ type, title, status, detail, code, instance, errors? }`. Scoped to the
public score path in the error handler; the internal envelope is untouched elsewhere.

## List endpoints (item 3 tail)

Claims list already supports cursor pagination + filters (status, claimType, facility, date, q).
Slice 2 added `payer_id`; confirm/expose payer filtering as needed.

## Tests

- **Unit**: FHIR→claim mapping; public output mapper (no internals; correct riskScore/level/action);
  reason-code derivation; problem+json formatter.
- **Integration**: score persists claim + audit session (payer recorded); response carries score +
  flags + reason codes and **no** rule internals; fail-closed on a `COMING_SOON` payer
  (problem+json); idempotent replay via `Idempotency-Key`. Synthetic FHIR only — no real PHI.

## Follow-ups

- Populate the Auditor-General typology mapping once the authoritative list is supplied.
- Map a FHIR `provider`/`facility` reference to internal facility (registry lookup) so `facilityId`
  can be optional.
