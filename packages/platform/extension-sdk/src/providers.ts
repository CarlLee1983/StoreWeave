import type { Logger } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';

/**
 * Provider Contract —— Extension 對外部世界（金流／物流／ERP／通知）的可替換介面。
 * Core 只認識這些介面，不認識任何供應商名稱。
 */
export type ProviderKind = 'payment' | 'shipping' | 'erp' | 'invoice';

export interface ProviderBase {
  readonly id: string;
  readonly kind: ProviderKind;
  /** 健康檢查，供 `commerce doctor` 與 /health/dependencies 使用。 */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}

/** A payment option configured by the store and offered by a provider. */
export interface PaymentMethod {
  /** Provider-local stable identifier selected by the store before payment starts. */
  readonly code: string;
  readonly label: string;
  /** Whether the payment is expected to resolve immediately or after customer action. */
  readonly timing: 'immediate' | 'deferred';
}

/** Input for one idempotent attempt to start a payment. */
export interface PaymentStartInput {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amountCents: number;
  readonly currency: string;
  /** Must be one of the provider's configured `paymentMethods()` codes. */
  readonly method: string;
  /** 由呼叫端提供的唯一參考；Provider 必須用它做去重。 */
  readonly reference: string;
}

/** A browser action needed to continue an off-site payment flow. */
export type PaymentRedirectAction =
  | { readonly type: 'redirect'; readonly url: string }
  | { readonly type: 'form_post'; readonly url: string; readonly fields: Readonly<Record<string, string>> };

/** Human-presentable information for a payment that will be completed later. */
export interface PaymentInstruction {
  readonly label: string;
  readonly value: string;
}

export interface PaymentConfirmedResult {
  readonly status: 'confirmed';
  readonly providerRef: string;
  readonly message?: string;
}

export interface PaymentRedirectResult {
  readonly status: 'redirect';
  readonly providerRef: string;
  readonly action: PaymentRedirectAction;
}

export interface PaymentAwaitingPaymentResult {
  readonly status: 'awaiting_payment';
  readonly providerRef: string;
  readonly instructions: readonly PaymentInstruction[];
  /** ISO 8601 instant after which the payment instructions are no longer valid. */
  readonly expiresAt: string;
}

export interface PaymentFailedResult {
  readonly status: 'failed';
  /** Some gateways reject before allocating their own payment identifier. */
  readonly providerRef?: string;
  readonly message?: string;
}

/**
 * A normalized outcome for payment initiation. The platform owns the order
 * state transition; providers only describe how the customer continues.
 */
export type PaymentStartResult =
  | PaymentConfirmedResult
  | PaymentRedirectResult
  | PaymentAwaitingPaymentResult
  | PaymentFailedResult;

/** The unmodified HTTP material supplied to a provider for callback verification. */
export interface PaymentCallbackRequest {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly query: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface PaymentConfirmedCallback {
  readonly type: 'payment_confirmed';
  /** The platform reference originally passed to `start`. */
  readonly reference: string;
  readonly providerRef: string;
}

export interface PaymentInfoIssuedCallback {
  readonly type: 'payment_info_issued';
  readonly reference: string;
  readonly providerRef: string;
  readonly instructions: readonly PaymentInstruction[];
  readonly expiresAt: string;
}

export interface PaymentFailedCallback {
  readonly type: 'payment_failed';
  readonly reference: string;
  readonly providerRef?: string;
  readonly message?: string;
}

/** Vendor callback data mapped into payment-domain facts only. */
export type PaymentCallbackEvent =
  | PaymentConfirmedCallback
  | PaymentInfoIssuedCallback
  | PaymentFailedCallback;

/** The platform tells the provider whether the parsed callback was accepted. */
export interface PaymentCallbackHandlingResult {
  readonly accepted: boolean;
  readonly duplicate?: boolean;
  readonly message?: string;
}

/** Provider-controlled acknowledgement for callback retry semantics. */
export interface PaymentCallbackAcknowledgement {
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A platform-owned, replay-safe request to reverse one confirmed payment. */
export interface PaymentRefundInput {
  /** The gateway payment reference captured when the original payment settled. */
  readonly providerRef: string;
  readonly amountCents: number;
  readonly currency: string;
  /** A stable platform reference; adapters must use it to make retries safe. */
  readonly reference: string;
}

/** A definite gateway response. Transport uncertainty must reject instead. */
export type PaymentRefundResult =
  | { readonly status: 'succeeded'; readonly providerRefundRef: string; readonly message?: string }
  | { readonly status: 'rejected'; readonly message: string }
  | { readonly status: 'unsupported'; readonly message: string };

export interface PaymentProvider extends ProviderBase {
  readonly kind: 'payment';
  /** Store-selectable payment methods; callers choose one before any redirect. */
  paymentMethods(): readonly PaymentMethod[];
  start(input: PaymentStartInput): Promise<PaymentStartResult>;
  /**
   * Verification and parsing are deliberately atomic: providers that decrypt
   * callback payloads cannot implement them as independent operations safely.
   */
  parseCallback(request: PaymentCallbackRequest): Promise<PaymentCallbackEvent>;
  acknowledgeCallback(result: PaymentCallbackHandlingResult): PaymentCallbackAcknowledgement;
  refund(input: PaymentRefundInput): Promise<PaymentRefundResult>;
}

/** Provider-neutral destination captured by checkout; merchant pricing never calls a provider. */
export type ShippingDestination =
  | {
    readonly kind: 'taiwan_home';
    readonly recipient: string;
    readonly phone: string;
    readonly countryCode: 'TW';
    readonly postcode: string;
    readonly city: string;
    readonly district: string;
    readonly line1: string;
    readonly line2: string | null;
  }
  | {
    readonly kind: 'pickup_store';
    readonly recipient: string;
    readonly phone: string;
    readonly providerStoreId: string;
    readonly storeName: string;
    readonly storeAddress: string;
  };

/** A shipping provider fulfils an already-priced merchant method; it never quotes customer fees. */
export interface ShippingShipmentInput {
  readonly shipmentId: string;
  readonly orderId: string;
  /** Merchant-owned service code and type, frozen by the order before fulfilment. */
  readonly serviceCode: string;
  readonly serviceType: string;
  /** Idempotency reference assigned by the platform. */
  readonly reference: string;
  readonly destination: ShippingDestination;
}

/**
 * Opaque carrier-owned reference used later to prepare or print a label.
 * It is deliberately not a URL, signed download credential, or label content:
 * the platform persists it privately and an authorised back-office flow asks
 * the owning provider to turn it into a carrier-specific print/download action.
 */
export interface ShippingLabelReference {
  readonly reference: string;
}

export interface ShippingShipmentResult {
  readonly providerRef: string;
  readonly trackingNumber?: string;
  readonly label?: ShippingLabelReference;
}

/** Minimal carrier evidence needed to reconcile an already-created shipment. */
export interface ShippingShipmentStatusInput {
  readonly shipmentId: string;
  /** Platform idempotency reference, retained by the carrier adapter. */
  readonly reference: string;
  readonly providerRef: string;
  readonly trackingNumber?: string;
}

/** Provider-specific status stays private; adapters may map it to a stable domain stage. */
export interface ShippingShipmentStatusResult {
  readonly rawStatus: string;
  readonly stage?: 'shipped' | 'arrived' | 'completed';
}

/** The unmodified HTTP material supplied to a carrier for callback verification. */
export interface ShippingCallbackRequest {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly query: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * A carrier callback after its signature has been verified. Provider status
 * names remain operational evidence; only `stage` is a customer lifecycle fact.
 */
export interface ShippingCallbackEvent {
  readonly providerRef: string;
  readonly rawStatus: string;
  readonly stage?: 'shipped' | 'arrived' | 'completed';
  /** Stable carrier delivery/event identity, used by core replay protection. */
  readonly callbackId: string;
  /** Optional provider-owned public HTTPS tracking page; never a label URL. */
  readonly trackingUrl?: string;
}

export interface ShippingCallbackHandlingResult {
  readonly accepted: boolean;
  readonly duplicate?: boolean;
}

export interface ShippingCallbackAcknowledgement {
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A store record returned by a carrier-owned pickup selector. */
export interface PickupStore {
  readonly providerStoreId: string;
  readonly storeName: string;
  readonly storeAddress: string;
}

/**
 * Optional capability for carriers which support convenience-store pickup.
 * Core owns the short-lived selection token and only accepts a store id; the
 * adapter remains the authority for the display name and address.
 */
export interface PickupStoreSelectionInput {
  readonly serviceType: string;
}

export interface ShippingProvider extends ProviderBase {
  readonly kind: 'shipping';
  /**
   * The caller supplies a stable platform reference. Providers must make replay
   * safe with the carrier's supported idempotency or query/reconciliation
   * mechanism; core never assumes a carrier honours an idempotency key.
   */
  createShipment(input: ShippingShipmentInput): Promise<ShippingShipmentResult>;
  /** Optional because legacy/manual carriers may support creation only. */
  queryShipmentStatus?(input: ShippingShipmentStatusInput): Promise<ShippingShipmentStatusResult>;
  /** Optional: only callback-capable carriers expose this verified parser. */
  parseCallback?(request: ShippingCallbackRequest): Promise<ShippingCallbackEvent>;
  /** Optional because carriers without callbacks do not need an acknowledgement contract. */
  acknowledgeCallback?(result: ShippingCallbackHandlingResult): ShippingCallbackAcknowledgement;
  /** Absent means this carrier/method cannot be offered as a pickup selector. */
  pickupStores?(input: PickupStoreSelectionInput): Promise<readonly PickupStore[]>;
}

export interface ErpDocument {
  readonly documentType: string;
  readonly reference: string;
  readonly body: Record<string, unknown>;
}

export interface ErpProvider extends ProviderBase {
  readonly kind: 'erp';
  /** 必須以 `reference` 做冪等；同一 reference 重送不得產生第二筆單據。 */
  push(doc: ErpDocument): Promise<{ accepted: boolean; remoteId: string; message?: string }>;
}

/**
 * The checkout-time invoice choice. It is a deliberately small, provider-neutral
 * snapshot: a provider receives only the durable choice and sale facts, never an
 * Order repository or a browser request.
 */
export type InvoiceCarrier =
  | { readonly kind: 'ecpay' }
  | { readonly kind: 'mobile'; readonly number: string }
  | { readonly kind: 'natural_person'; readonly number: string }
  | { readonly kind: 'donation'; readonly loveCode: string };

export interface InvoiceLine {
  readonly name: string;
  readonly quantity: number;
  /** Tax-inclusive unit price in cents. */
  readonly unitPriceCents: number;
  /** Tax-inclusive line total after discounts in cents. */
  readonly amountCents: number;
}

/** One durable attempt to issue a B2C invoice after payment is settled. */
export interface InvoiceIssueInput {
  readonly invoiceId: string;
  /** Stable platform idempotency reference; adapters must preserve it on retry. */
  readonly reference: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly currency: string;
  /** Total including tax, in cents. */
  readonly amountCents: number;
  /** Tax amount included in amountCents, in cents. */
  readonly taxCents: number;
  readonly customer: { readonly email: string; readonly name: string; readonly phone: string };
  readonly carrier: InvoiceCarrier;
  readonly lines: readonly InvoiceLine[];
}

export type InvoiceIssueResult =
  | { readonly status: 'issued'; readonly providerRef: string; readonly invoiceNumber: string; readonly invoiceDate: string }
  | { readonly status: 'rejected'; readonly message: string };

export interface InvoiceVoidInput {
  readonly invoiceId: string;
  /** Stable platform idempotency reference; adapters must preserve it on retry. */
  readonly reference: string;
  readonly providerRef: string;
  readonly invoiceNumber: string;
  /** Provider-formatted invoice issue date. */
  readonly invoiceDate: string;
  readonly reason: string;
}

export type InvoiceVoidResult =
  | { readonly status: 'voided'; readonly providerRef: string }
  | { readonly status: 'rejected'; readonly message: string };

/**
 * Invoice adapters own provider authentication, encryption, and carrier/love-code
 * verification. Core owns the durable lifecycle and never calls provider APIs in
 * the payment/refund transaction.
 */
export interface InvoiceProvider extends ProviderBase {
  readonly kind: 'invoice';
  issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult>;
  void(input: InvoiceVoidInput): Promise<InvoiceVoidResult>;
  /** Required before accepting a donation choice; false means the code cannot be used. */
  validateLoveCode(loveCode: string): Promise<boolean>;
}

export type AnyProvider = PaymentProvider | ShippingProvider | ErpProvider | InvoiceProvider;

export interface ProviderRegistration {
  readonly provider: AnyProvider;
  readonly owner: string;
  readonly isDefault?: boolean;
}

export class ProviderRegistry {
  private readonly byKind = new Map<ProviderKind, Map<string, ProviderRegistration>>();
  private readonly defaults = new Map<ProviderKind, string>();

  constructor(private readonly logger?: Logger) {}

  register(reg: ProviderRegistration): void {
    const kind = reg.provider.kind;
    const bucket = this.byKind.get(kind) ?? new Map();
    if (bucket.has(reg.provider.id)) {
      throw PlatformError.conflict(`Provider "${kind}:${reg.provider.id}" already registered`);
    }
    bucket.set(reg.provider.id, reg);
    this.byKind.set(kind, bucket);
    if (reg.isDefault || !this.defaults.has(kind)) this.defaults.set(kind, reg.provider.id);
    this.logger?.debug({ kind, id: reg.provider.id, owner: reg.owner }, 'provider registered');
  }

  get<T extends AnyProvider>(kind: ProviderKind, id?: string): T {
    const bucket = this.byKind.get(kind);
    const resolved = id ?? this.defaults.get(kind);
    const found = resolved ? bucket?.get(resolved) : undefined;
    if (!found) throw PlatformError.notFound('Provider', `${kind}:${resolved ?? '<default>'}`);
    return found.provider as T;
  }

  has(kind: ProviderKind, id?: string): boolean {
    const resolved = id ?? this.defaults.get(kind);
    return Boolean(resolved && this.byKind.get(kind)?.has(resolved));
  }

  list(): { kind: ProviderKind; id: string; owner: string; isDefault: boolean }[] {
    const out: { kind: ProviderKind; id: string; owner: string; isDefault: boolean }[] = [];
    for (const [kind, bucket] of this.byKind) {
      for (const [id, reg] of bucket) {
        out.push({ kind, id, owner: reg.owner, isDefault: this.defaults.get(kind) === id });
      }
    }
    return out;
  }
}
