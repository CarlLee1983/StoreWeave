import { PlatformError, type DomainEvent, type DomainEventDescriptor, type EventHandlerFn } from '@storeweave/contracts';

export interface EventSubscription {
  /** 訂閱者識別（extension id 或 core 模組名稱）。與 outbox id 一起構成投遞去重鍵。 */
  readonly subscriberId: string;
  readonly eventName: string;
  readonly handler: EventHandlerFn;
  readonly maxAttempts?: number;
}

/**
 * Domain Event 目錄與訂閱登記處。
 * 這裡不做即時派送 —— 所有投遞都經過 Outbox + 背景工作，
 * 因此 Extension 的錯誤不可能讓核心交易處於不一致狀態。
 */
export class EventBus {
  private readonly events = new Map<string, DomainEventDescriptor>();
  private readonly subscriptions: EventSubscription[] = [];

  registerEvent(descriptor: DomainEventDescriptor): void {
    const existing = this.events.get(descriptor.name);
    if (existing && existing !== descriptor) {
      throw PlatformError.conflict(`Event "${descriptor.name}" already registered`);
    }
    this.events.set(descriptor.name, descriptor);
  }

  registerEvents(descriptors: readonly DomainEventDescriptor[]): void {
    for (const d of descriptors) this.registerEvent(d);
  }

  getEvent(name: string): DomainEventDescriptor {
    const d = this.events.get(name);
    if (!d) throw PlatformError.validation(`Unknown domain event "${name}"`);
    return d;
  }

  hasEvent(name: string): boolean {
    return this.events.has(name);
  }

  listEvents(): DomainEventDescriptor[] {
    return [...this.events.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  subscribe(sub: EventSubscription): void {
    this.getEvent(sub.eventName); // 訂閱未知事件立即失敗
    if (this.subscriptions.some((s) => s.subscriberId === sub.subscriberId && s.eventName === sub.eventName)) {
      throw PlatformError.conflict(`"${sub.subscriberId}" already subscribes to "${sub.eventName}"`);
    }
    this.subscriptions.push(sub);
  }

  hasSubscription(subscriberId: string, eventName: string): boolean {
    return this.subscriptions.some((subscription) =>
      subscription.subscriberId === subscriberId && subscription.eventName === eventName);
  }

  subscribersFor(eventName: string): EventSubscription[] {
    return this.subscriptions.filter((s) => s.eventName === eventName);
  }

  listSubscriptions(): readonly EventSubscription[] {
    return this.subscriptions;
  }

  /** 派送前驗證 payload，確保 Extension 拿到的是符合契約的資料。 */
  parse(event: DomainEvent): DomainEvent {
    const descriptor = this.getEvent(event.name);
    const parsed = descriptor.payload.safeParse(event.payload);
    if (!parsed.success) {
      throw PlatformError.validation(`Event payload for "${event.name}" failed validation`, parsed.error.issues);
    }
    return { ...event, payload: parsed.data };
  }
}
