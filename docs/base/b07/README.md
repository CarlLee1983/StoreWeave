# B07 — Base Notifications

`@storeweave/notifications` is an always-composed `platform-notifications`
module. It replaces the `notification` Extension Provider entirely: there is one
delivery path, and the mock notification extension is gone.

## Contract

- A notification is a recipient, a template, a set of channels and a stable
  `reference`. The recipient is a platform user id, a bare email address, or
  both — never a commerce Customer, so a base-only release notifies people too.
- `runtime.notifications.send(tx, request, enqueue, now)` creates the immutable
  record and one delivery row per channel inside the caller's transaction;
  `dispatch(request)` is the stand-alone path for callers that are not already
  in one (HTTP handlers, scripts).
- The reference is the idempotency identity. Re-sending it returns the existing
  notification; re-sending it with different content is rejected, so a replayed
  event, a retried job and a duplicate command all produce exactly one delivery.
- The template snapshot (all channels, all translations) and the variables are
  stored with the notification, so a later template edit cannot rewrite queued
  work. Locale selection is exact BCP-47 tag, then base language.
- `{placeholder}` substitution is checked at creation time: a placeholder with
  no variable fails the send rather than mailing `{orderNumber}` to a customer.
  HTML is escaped by `@storeweave/mail` when the email channel renders.

## Channels

`inapp` is complete when the transaction commits — the inbox row *is* the
delivery, so it needs no job and cannot half-fail. `email` hands the rendered
message to B06 mail through its own `platform.notification.deliver` job. One
channel failing therefore never affects the other, and each retries alone.

Email outcomes map from mail's diagnostics: accepted/partial → `sent`,
rejected → `failed`, which dead-letters the job rather than hammering an address
the server refused; redriving it re-delivers the same durable mail message. A
timeout or a recovered in-flight attempt is `unknown`: recorded, and deliberately
**not** replayed, because SMTP may already have taken it. When `mail.transport` is `disabled`,
the email delivery is recorded as `skipped` with a diagnostic and no job is
queued: an unconfigured transport is a deployment decision, not a failure to
retry forever.

## Reading notifications

- `GET /api/v1/notifications` and `POST /api/v1/notifications/read` are the
  signed-in account's own inbox. There is no recipient parameter: the scope is
  the actor, enforced in SQL, so an id from someone else's inbox matches nothing.
  `storeweave notifications:list <recipient>` / `notifications:read <recipient> <ids...>`
  are the CLI equivalents, where the operator names the account explicitly.
- `GET /api/v1/notifications/deliveries` (`notifications:read`) is the operator
  view of delivery evidence. Recipients are masked (`b***@example.test`), so are
  addresses quoted back inside a transport diagnostic, and the rendered body is
  not part of that projection at all.

## Commerce migration

Commerce keeps the mapping — which event tells whom, with which template — in
`packages/commerce/notification`, and the coupon, reward-expiry and password
reset notices keep their own templates in their own modules. None of them keeps
delivery state: `commerce.notification.listLifecycleDeliveries` still answers
the same HTTP contract, but its status, attempts, `providerRef` and error come
from the base capability through a bound port. Its `status` gained `skipped`
and `unknown` for the two outcomes above, and filtering by status now filters
the merged page rather than a stale stored column, so a filtered page can be
shorter than its limit.

Records created before B07 have no base notification and keep showing their own
stored evidence — old rows stay readable, they just no longer change. The
dedupe identity is unchanged (`(event_id, template)` and the
`lifecycle:<eventId>:<template>` reference), and the reference is now literally
the base notification's identity, so a migrated event cannot be delivered twice.

## Validation and release gate

Automated coverage:

- `packages/platform/notifications/test/contract.test.ts`: channel/recipient
  requirements and recipient masking;
- `tests/integration/notifications.test.ts`: both channels from one request,
  the in-app inbox over real HTTP (read and mark-read), masked evidence, a
  rejected recipient isolated from the in-app copy, `skipped` with no queued
  job when mail is disabled, and one reference producing one message;
- `tests/integration/lifecycle-notifications.test.ts`: order/shipment lifecycle
  against a real SMTP sink, no re-send across repeated worker drains, and the
  rejected and disabled-transport paths;
- `tests/integration/password-reset.test.ts`, `coupon-signup.test.ts`,
  `reward-expiry-notice.test.ts`: the migrated commerce notices.

The in-app channel is a capability, not a UI: the operator and customer screens
for it belong to B13, so F05 stays open until then.
