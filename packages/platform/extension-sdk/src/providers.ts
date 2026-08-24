import type { Logger } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';

/**
 * Provider Contract —— Extension 對外部世界（金流／物流／ERP／通知）的可替換介面。
 * Core 只認識這些介面，不認識任何供應商名稱。
 */
export type ProviderKind = 'payment' | 'shipping' | 'erp' | 'notification';

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
  refund(input: { providerRef: string; amountCents: number }): Promise<{ status: 'succeeded' | 'failed'; message?: string }>;
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

export interface ShippingProvider extends ProviderBase {
  readonly kind: 'shipping';
  createShipment(input: ShippingShipmentInput): Promise<{ providerRef: string; trackingNumber?: string }>;
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

export interface NotificationMessage {
  /** 具名樣板，例如 `customer.password-reset`。Core 只給名字與變數，不給內文。 */
  readonly template: string;
  readonly to: { email: string; name?: string };
  readonly variables?: Record<string, unknown>;
  /** BCP 47 語言標籤；不給就由 Provider 決定。 */
  readonly locale?: string;
  /** 由呼叫端提供的唯一參考；Provider 必須用它做去重。 */
  readonly reference: string;
}

export interface NotificationSendResult {
  readonly status: 'sent' | 'failed';
  readonly providerRef: string;
  readonly message?: string;
}

export interface NotificationProvider extends ProviderBase {
  readonly kind: 'notification';
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}

export type AnyProvider = PaymentProvider | ShippingProvider | ErpProvider | NotificationProvider;

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
