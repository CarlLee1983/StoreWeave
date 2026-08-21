# StoreWeave domain glossary

## Order

A customer's immutable-priced purchase request. An Order is `pending` until a payment request is made, `payment_processing` while the provider is being contacted, `paid` after payment is confirmed, `cancelled` after an explicit cancellation, or `expired` when its payment reservation reaches its deadline.

## Inventory reservation

A temporary claim on sellable stock made for every Order line. It increases `reserved` without reducing `on_hand`; it is committed on payment, or released on cancellation or expiry. `available` is `on_hand - reserved`.

## Payment request

The durable request to charge a provider for an Order. It is not a successful payment; the only successful payment transition is `markPaid` after provider confirmation.
