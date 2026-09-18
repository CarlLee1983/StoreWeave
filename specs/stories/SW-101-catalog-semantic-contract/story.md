# Story: SW-101 Catalog semantic public-contract coverage

## Goal

讓 B17 的 Commerce public-contract ledger 以可執行的 Catalog schema 案例，證明五個既有但尚未覆蓋的 Catalog 輸入／輸出契約。

## Context

B17 的 structural artifact 能偵測 Catalog 公開面漂移，但 provenance 不等於語意驗證。現有 semantic ledger 有三個 Catalog 案例，仍將五個 schema-runtime facet 列在 `remaining`。

## Classification

* Security sensitive: no
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Risk

* Level: medium
* Reason: `versioned-surface`

## Scope

### In Scope

* Add executable Catalog schema cases for the five currently uncovered facets in the B17 semantic ledger.
* Regenerate the checked-in semantic artifact and keep its coverage accounting exact.
* Verify the Catalog package and ledger regression tests.

### Out of Scope

* Change Catalog commands, queries, DTO schemas, HTTP routes, or product behaviour.
* Cover another Commerce package, add a new semantic runner category, or reduce any external B17 release gate.

## Inputs

* The composed Commerce structural and HTTP contract artifacts.
* The existing `@storeweave/catalog` command and query schemas.

## Outputs

* Five executable semantic cases and an updated semantic ledger with their matching facets removed from `remaining`.

## Rules

* R1: Each case may cover only facets belonging to its declared Catalog surface.
* R2: A facet leaves `remaining` only through a case executed by the existing schema runner.
* R3: The change preserves all existing Catalog schemas and public behaviour.

## Expected Errors

* Invalid representative input must remain an executable schema rejection, not be normalized into a successful case.

## Dependencies

* Ticket 100 Story-format pilot.
* B17 semantic ledger and its existing schema runner.
* The completed `@storeweave/catalog` module.

## Constraints

* Keep the product boundary to `@storeweave/catalog`; shared B17 ledger files may change only to record and execute this package's cases.
* Do not add dependencies, migrations, runtime configuration, or external-service work.
