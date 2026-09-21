# Acceptance Criteria

## Happy Path

* [x] AC-001: Selected ReleaseDefinition supplies the configuration schema and default filename.
* [x] AC-002: Commerce continues to load and validate `commerce.yaml` unchanged.

## Failure Cases

* [x] AC-003: Missing contribution and invalid config errors identify the selected release/schema.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `tests/unit/release-config.test.ts` | config target key selects the schema and `defaultFilename`; no release-id branch |
| `AC-002` | test | `tests/unit/release-config.test.ts` | Commerce still validates with the same schema/defaults and `commerce.yaml` |
| `AC-003` | test | `tests/unit/release-config.test.ts` | missing/duplicate contributions fail before resolution; invalid selected config errors include release and schema ids |
