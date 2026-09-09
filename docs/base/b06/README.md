# B06 — Base Mail

`@storeweave/mail` is an always-composed `platform-mail` module. It is usable
by base-only releases: Commerce notification remains a separate B07 migration
consumer and is not a fallback transport.

## Contract

- `runtime.mail.queue(tx, request)` creates the immutable rendered message and
  its `platform.mail.send` job in the same transaction. `enqueue` is the
  stand-alone SDK path; `sendNow` is for an explicitly immediate attempt.
- A request carries a stable reference, template id/version and locale. The
  module snapshots selected HTML/text/subject and attachment locators before
  enqueueing; jobs pin id and version, so later template edits cannot alter a
  pending send. Reusing a reference with different content is rejected.
- HTML substitutions are escaped with `@storeweave/i18n`; text and subject are
  plain text and a rendered subject may not contain CR/LF. Translation lookup
  uses an exact BCP-47 tag then its base language.
- Attachments are opened as streams from the durable object store at send time.
  A missing object is a permanent, recorded rejection before SMTP I/O.
- The deterministic Message-ID is derived from the store ID and reference. It helps
  reconciliation; it is not a delivery receipt and cannot promise exactly once
  mail delivery.

## SMTP and outcomes

`mail.transport` is `disabled` by default. The only enabled production option
is `smtp`; it requires `mail.from`, host/port/TLS settings, paired optional
credential references, and bounded connection/socket timeouts. There is no
mock or silent fallback. Missing configured credentials prevent runtime
creation.

Each durable message records `accepted`, `partial`, `rejected`, or `unknown`,
including recipient-level accepted/rejected/unknown arrays and a masked-safe
diagnostic category. SMTP acceptance is explicitly **not** delivery. A
auth/configuration failure, or missing attachment dead-letters the job. A
partial result is completed without automatic subset retry (to avoid duplicating
already-accepted recipients). Socket/DATA timeout is `unknown` and is not automatically
retried, because SMTP may already have accepted it. A recovered `sending` job
is similarly marked unknown rather than replayed. Operators must reconcile an
unknown result before deliberately initiating a new attempt.
`runtime.mail.resendUnknown(reference)` is that explicit, audited action; it
reuses the durable rendered snapshot and Message-ID.

Extensions declare `mail:send`; the SDK prefixes their local references and
authorizes every call. Its mail surface intentionally has no attachment
locator, so an extension cannot exfiltrate another module's private object.

```ts
// extension manifest: permissions: ['mail:send']
await ctx.mail.enqueue({
  reference: `report-ready:${reportId}`,
  to: [{ email: recipient }],
  template: { id: 'report-ready', version: 1,
    subject: 'Report {reportId}', text: 'Your report {reportId} is ready.',
    html: '<p>Your report {reportId} is ready.</p>' },
  variables: { reportId },
});
```

## Validation and release gate

Automated coverage:

- local SMTP sink: MIME alternative, streamed attachment, partial recipient
  rejection, SMTP auth rejection, and socket timeout classification;
- real DB/worker: queue transaction, escaped localized snapshot, durable
  template/job version, attachment streaming, missing attachment failure, and
  a dead-letter retry against a recovered SMTP recipient;
- reference fingerprint collision protection.

Before a production SMTP enablement, send to explicitly authorized staging
recipients and retain the resulting `platform_mail_messages` diagnostics. This
repository cannot perform that external send without the recipient/SMTP
authorization; it remains an operational release gate, not evidence that SMTP
accepted means delivered.
