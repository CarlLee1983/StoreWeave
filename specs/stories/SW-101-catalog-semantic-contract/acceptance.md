# Acceptance Criteria

## Happy Path

* [x] AC-001: The semantic ledger executes representative Catalog cases for `createProduct` output, `updateProduct` input and output, `getProduct` input, and `searchProducts` output.

## Business Rules

* [x] AC-002: Each new case covers only its own Catalog surface, and the five matching schema-runtime facets are removed from `remaining`.
* [x] AC-003: At least one new Catalog case records schema rejection for invalid representative input.

## Failure Cases

* [x] AC-004: The ledger check fails if a declared Catalog case is bound to a facet from another surface.

## Regression Requirements

* [x] AC-005: Existing Catalog commands, queries, DTO schemas, and HTTP routes remain unchanged.
* [x] AC-006: The checked-in semantic artifact is byte-stable under `--check` after regeneration.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | test | `tests/architecture/b17-public-contract-semantic.test.ts` | `updated Catalog schema cases` | `each case executes with its declared expected result` |
| `AC-002` | test | `tests/architecture/b17-public-contract-semantic.test.ts` | `five Catalog runtime facet identifiers` | `exactly those facets leave remaining and no case crosses a surface` |
| `AC-003` | test | `tests/architecture/b17-public-contract-semantic.test.ts` | `invalid Catalog update fixture` | `schema runner records validation issues rather than success` |
| `AC-004` | test | `tests/architecture/b17-public-contract-semantic.test.ts` | `synthetic foreign Catalog facet binding` | `assertCaseBindings rejects the cross-surface binding` |
| `AC-005` | command | `git diff -- packages/commerce/catalog` | `completed Story worktree` | `no Catalog production-source or route change` |
| `AC-006` | command | `pnpm exec tsx scripts/b17-public-contract-semantic.ts --check` | `regenerated semantic artifact` | `exit 0 without rewriting the artifact` |

## Verification Notes

Run the focused architecture test and Catalog package tests before the repository-level `make verify`. The final verification record must preserve the exact command outputs and source revision.
