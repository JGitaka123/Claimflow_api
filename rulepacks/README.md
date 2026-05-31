# Rulepacks

Versioned YAML rulepacks loaded by `@claimflow/rule-engine`. Rules are **data** — for
changes that alter audit outcomes, create a new version directory rather than mutating an
existing one in place (determinism guarantee).

## Layout

Rulepacks are **payer-namespaced**. The loader resolves a pack from:

```
<RULEPACK_DIR>/<payerSlug>/<version>/   # payer-namespaced (preferred for new payers)
<RULEPACK_DIR>/<version>/               # legacy flat layout = default SHA pack
```

`loadRulepack(dir, version, payerSlug?)`:
- With a `payerSlug`, it resolves `<dir>/<payerSlug>/<version>/` and does **not** fall back
  to the flat layout — a missing payer rulepack errors rather than silently auditing against
  another payer's rules.
- Without a `payerSlug`, it resolves the legacy flat `<dir>/<version>/` (the current SHA pack).

Each version directory contains a `manifest.yaml` plus one file per category:
`identity.yaml`, `documentation.yaml`, `clinical.yaml`, `authorization.yaml`,
`financial.yaml`, `structural.yaml`. The manifest's `rule_count` must equal the total number
of rules across the category files.

## Adding a payer

Adding a new insurer is a **data** change, not an engineering one:

1. Author `rulepacks/<payerSlug>/<version>/` with the manifest + six category files.
2. Flip the payer's `status` to `ACTIVE` and set its `rulepack_version` in the `payers`
   catalog (see `migrations/016_payers.sql`).

See `docs/multi-payer-design.md` for the full design.
