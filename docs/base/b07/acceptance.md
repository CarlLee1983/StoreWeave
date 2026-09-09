# B07 acceptance

| Requirement | Evidence |
| --- | --- |
| Generic recipient/template/channel/delivery vocabulary | `@storeweave/notifications`: recipient is a user id and/or address, one template carries every channel's content and its translations, one delivery row per channel. |
| Real email plus in-app inbox with read state | `email` renders through B06 mail's SMTP transport; `inapp` commits its inbox row in the creating transaction and carries `read_at`. |
| Commerce event → template mapping stays in commerce | `packages/commerce/notification/src/templates.ts`, `coupon/src/templates.ts`, `loyalty/src/templates.ts`, `apps/api/src/storefront/password-reset-template.ts`; base knows only recipients. |
| HTTP/CLI read and mark your own in-app notifications | `GET /api/v1/notifications`, `POST /api/v1/notifications/read` (scope enforced in SQL from the actor, no recipient parameter); `storeweave notifications:list` / `notifications:read`. |
| Per-channel failure retries alone | Each channel has its own delivery row; only `email` has a job, so a rejected address cannot roll back or delay the in-app copy — `tests/integration/notifications.test.ts`. |
| Delivery records mask personal data | `maskRecipient` / `maskEmailsIn` on the evidence projection and on recorded transport errors; the rendered body is not in that projection. |
| Existing order/shipment notifications keep their semantics | `commerce.notification.listLifecycleDeliveries` keeps its HTTP contract and its `(event_id, template)` identity; status/attempts/`providerRef` now come from the base capability, with `skipped`/`unknown` added for outcomes the old provider could not express. |
| No double path, old records preserved | The `notification` provider kind and the mock-notification extension are deleted, so exactly one delivery path exists. The `lifecycle:<eventId>:<template>` reference is now the base notification identity; pre-B07 rows have no base notification and keep their own stored evidence. |
| Automated checks | `packages/platform/notifications/test/contract.test.ts`; `tests/integration/notifications.test.ts`; `tests/integration/lifecycle-notifications.test.ts`; the migrated `password-reset` / `coupon-signup` / `reward-expiry-notice` suites; typecheck and release-composition regressions (`base-release`, `release-manifest`, `release-transition`, `release-artifacts`, `release-roles`). |
| Open | The operator and account UI for in-app notifications is B13's; F05 does not close with this package. External SMTP delivery remains B06's operational release gate. |
