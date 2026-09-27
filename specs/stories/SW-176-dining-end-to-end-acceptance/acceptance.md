# SW-176 Acceptance

## Criteria

- [ ] AC-001: Spec 0012 §6.1 passes: one venue's table types, weekly starts, date overrides, duration, booking window and timezone work; duplicate capacity, timezone mutation after activity, and destructive supply changes fail.
- [ ] AC-002: Spec 0012 §6.2 passes: only open starts with suitable capacity accept requests; pending requests do not consume capacity; stable replay creates one request, a distinct submission may duplicate content, and the success page and receipt email show the same request number. Missing/invalid/over-limit source or recipient limits create neither request nor receipt.
- [ ] AC-003: Spec 0012 §6.3 passes: atomic acceptance rechecks current schedule and full interval; parallel acceptance and parallel supply/closure changes cannot oversell or accept a closed start; a failed acceptance stays pending and larger fitting types can be used.
- [ ] AC-004: Spec 0012 §6.4 passes: half-open 18:00–19:30 occupancy, true overlap blocking, 23:30 midnight crossing, and next-day closure behave by the start date.
- [ ] AC-005: Spec 0012 §6.5 passes: pre-start acceptance/cancellation, optional rejection and required cancellation reasons, no customer table-type disclosure, late rejection, and anonymized late rejection without mail all work.
- [ ] AC-006: Spec 0012 §6.6 passes: failed mail retries, unknown mail waits for a reservation-authorized operator's deliberate resend, Base Notification/Mail evidence agrees, and delivery failure never rolls back Dining decisions.
- [ ] AC-007: Spec 0012 §6.7 passes: operator lists cover pending, accepted by date, rejected, and cancelled with notification status; decisions, settings, and resend have actor/time/result audit and permission checks.
- [ ] AC-008: Spec 0012 §6.8 passes: each lifecycle cutoff clears personal data across Dining, Notification, Mail, jobs, and audit; queued or unknown mail cannot send after cleanup, while non-identifying dedupe and audit evidence remains.
- [ ] AC-009: The complete `make verify` gate passes with Dining selected alongside existing Base, Commerce, and Booking coverage.

## Evidence to collect

Use clean-PostgreSQL and controlled-time/transport integration fixtures. Record the exact test names and results for each AC, the `make verify` result, and independent review findings here when implemented. Do not check a criterion until its observed result passes.
