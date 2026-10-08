# Acceptance

- [x] AC-001: `seed:ops` requires the selected Release to be current and activates configured extensions before operations writes, without applying pending migrations.
- [x] AC-002: The complete operations seed reaches payment, shipment/refund/RMA and ERP dead-letter examples with mock providers.
- [x] AC-003: Repeated operations seeding creates another successful batch.
- [x] AC-004: The ERP job uses its registered type and strict versioned payload.
- [x] AC-005: Focused regression coverage and `make verify` pass.
