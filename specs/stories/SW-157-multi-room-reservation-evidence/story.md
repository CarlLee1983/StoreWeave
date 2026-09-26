# Story: SW-157 Multi-room Reservation PostgreSQL Evidence

## Goal

補齊 GitHub #110 與 Spec 0011 §9.13 的證據：多房入住人數規則、逐晚可售房數與 Reservation 建立在真正 PostgreSQL 交易中共同成立。

## Authority

* plan: yes
* modify: yes — tests and acceptance evidence only
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

2026-09-26 使用者要求派發 Sol 逐一完成剩餘 issue；本 Story 將 #110 拆成單一 repository integration test boundary，先記錄契約再實作。

## Scope

* Extend existing Booking PostgreSQL integration fixtures with real Reservation creation for two rooms over multiple local Room Nights.
* Cover valid adults/children, too few adults, excess occupants, insufficient units on a later night, and two competing requests for the final two units.
* Assert persisted Reservation rows and every affected Room Night before and after each operation. Observe actual PostgreSQL blocking in the contention case.
* Record focused checks and the full repository gate for SW-146.

## Rules

* A valid two-room Reservation increments reserved units by exactly two on every local night and persists the agreed occupancy and Quote.
* Failed requests create no Reservation and change no inventory, including a request whose first night is available but later night is not.
* Too few adults and excess occupants fail with recognizable validation errors before Room Night locking or inventory mutation. Property facts may be read to validate per-unit occupancy.
* Concurrent valid requests cannot both consume the final two units; assert the losing result, exact Reservation count and exact nightly inventory.
* Product source, schemas, migrations and financial behavior are out of scope. An observed product defect needs its own owning Story before implementation.

## Dependencies and Verification

* Existing SW-125/SW-149 Reservation and atomic Quote capability; SW-146 consumes this evidence.
* Use the existing Booking integration fixture and lowest useful real PostgreSQL seam. No mock result may stand in for persisted Reservation or inventory evidence.
* Run focused integration tests, independent Sol/high review, then `make verify` at the integration checkpoint. Preserve failures and record the source revision plus working-tree diff identity when uncommitted.
* No external UAT, SMTP delivery, deployment or issue closure is implied by these tests.
