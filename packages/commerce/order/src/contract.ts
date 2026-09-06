export const orderStatuses = ['pending', 'payment_processing', 'awaiting_payment', 'paid', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const orderAdjustmentSources = ['promotion', 'reward'] as const;
export type OrderAdjustmentSource = (typeof orderAdjustmentSources)[number];
