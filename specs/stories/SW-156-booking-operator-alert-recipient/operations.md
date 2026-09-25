# Late Payment alert recovery

Configure `booking.operatorAlertEmail` to a monitored Booking operator mailbox or alias before starting both the server and worker. An absent or malformed address stops Booking bootstrap. Do not use the Site contact address or a Booker address.

## Find and retry a failed live event

The first Late classification commits a refund header and `booking.reservation.latePayment.v1` outbox event together. Its event delivery job has type `platform.event.deliver`. Inspect the dead-job view with a `jobs:read` operator, or identify the exact job and outbox event with a read-only query:

```sql
SELECT j.id AS job_id, j.status, j.payload->>'outboxId' AS outbox_id,
       j.payload->'event'->'payload'->>'paymentAttemptId' AS payment_attempt_id
FROM platform_jobs AS j
WHERE j.type = 'platform.event.deliver'
  AND j.payload->'event'->>'name' = 'booking.reservation.latePayment.v1'
  AND j.status = 'dead';
```

After correcting the recipient, retry each selected dead job through `POST /api/v1/system/jobs/dead/:jobId/retry` with `jobs:write` and an idempotency key. This invokes `platform.jobs.retryJob` on the **same job**. A dead or quarantined outbox relay is a different failure: inspect `GET /api/v1/system/outbox/failures` and use `platform.outbox.redriveFailure` with the frozen subscriber snapshot and operator evidence. Do not insert jobs or rewrite outbox payloads directly.

## Reconcile earlier Late Attempts

The worker's hourly `booking.reservation.reconcile-late-notifications` schedule captures a cutoff and walks Late Attempts in pages of at most 100. Each continuation keeps that cutoff and cursor. The audited `booking.reservation.reconcileLatePaymentNotifications` system command also accepts `{ cutoff, afterAttemptId?, limit }` for a controlled immediate run; it enqueues its own continuation when a page is full. The result and audit record include `scanned`, `enqueued`, `missingRefunds` and `nextAfterAttemptId`. A missing refund is an anomaly to investigate; reconciliation never charges or refunds again.

Verify each Attempt by joining `booking_reservation_notification_links.payment_attempt_id` and `refund_id` to the required `late_payment` refund, then inspect its exact `booking.reservation.late-payment` Base request and delivery status. `requested` means Base accepted an immutable request; it does not mean Email was delivered. A request already addressed to an incorrect mailbox remains bound to that mailbox and needs an explicit operator case. Changing config must not silently retarget it.

Keep ECPay staging refund UAT, real SMTP acceptance and deployment as separate release gates. Once Late rows exist, rollback needs a reader compatible with the new kind and columns or a forward correction; an old reader may reject them.
