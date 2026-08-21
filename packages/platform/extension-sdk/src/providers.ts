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

export interface PaymentChargeInput {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amountCents: number;
  readonly currency: string;
  /** 由呼叫端提供的唯一參考；Provider 必須用它做去重。 */
  readonly reference: string;
}

export interface PaymentChargeResult {
  readonly status: 'succeeded' | 'failed';
  readonly providerRef: string;
  readonly message?: string;
}

export interface PaymentProvider extends ProviderBase {
  readonly kind: 'payment';
  charge(input: PaymentChargeInput): Promise<PaymentChargeResult>;
  refund(input: { providerRef: string; amountCents: number }): Promise<{ status: 'succeeded' | 'failed'; message?: string }>;
}

export interface ShippingRateInput {
  readonly destinationCountry: string;
  readonly destinationPostcode?: string;
  readonly weightGrams: number;
  readonly subtotalCents: number;
}

export interface ShippingProvider extends ProviderBase {
  readonly kind: 'shipping';
  quote(input: ShippingRateInput): Promise<{ serviceCode: string; label: string; priceCents: number }[]>;
  createShipment(input: { orderId: string; serviceCode: string; reference: string }): Promise<{ trackingNumber: string }>;
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
