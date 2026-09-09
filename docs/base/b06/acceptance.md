# B06 acceptance

| Requirement | Evidence |
| --- | --- |
| Base-only generic mail capability | `platform-mail` is composed by `createRuntime`; `runtime.mail` and the reduced Extension SDK capability are public. |
| Explicit real SMTP only | `mail.transport: disabled\|smtp`; SMTP needs an explicit sender/configuration and has no mock fallback. |
| HTML/text localized templates and escaping | `MailTemplate.translations`, locale fallback and `formatMessage`/`escapeHtml`; integration snapshot assertion. |
| Attachment streams | `StorageManager.open()` feeds Nodemailer attachment streams; SMTP-sink integration verifies MIME attachment. |
| Immediate and queued paths | `sendNow`, transactional `queue`, stand-alone `enqueue`, and durable `platform.mail.send` job. |
| Traceable references/outcomes | unique reference/request hash, deterministic Message-ID, persisted template id/version and recipient diagnostics. |
| Safe retry posture | partial/accepted complete, explicit recipient rejection can be dead-letter retried with the same durable message, while timeout/recovered sends become `unknown` without automatic replay. |
| Automated checks | `packages/platform/mail/test/transport.test.ts`; `tests/integration/mail.test.ts`; `tests/integration/runtime-lifecycle.test.ts` for extension authorization/namespacing; typecheck and release regression checks. |
| External staging | Pending authorized SMTP/recipient execution; this is a release gate documented in README, not claimed as completed test evidence. |
