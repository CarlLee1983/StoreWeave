export type OverlapPolicy = 'queue' | 'skip';

export interface IntervalScheduleDeclaration {
  readonly everyMs: number;
  readonly catchUp?: number;
  readonly overlap?: OverlapPolicy;
}

export interface CronScheduleDeclaration {
  readonly cron: string;
  readonly timezone: string;
  readonly catchUp?: number;
  readonly overlap?: OverlapPolicy;
}

/** Declarative recurring schedule shared by Core modules and Extensions. */
export type ScheduleDeclaration = IntervalScheduleDeclaration | CronScheduleDeclaration;

/**
 * Runtime-safe discriminator for values crossing an untyped extension/config boundary.
 * A mixed object is not a cron declaration with ignored interval fields: it is invalid.
 */
export function scheduleDeclarationKind(value: unknown): 'interval' | 'cron' | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hasInterval = Object.prototype.hasOwnProperty.call(value, 'everyMs');
  const hasCron = Object.prototype.hasOwnProperty.call(value, 'cron');
  return hasInterval === hasCron ? undefined : hasCron ? 'cron' : 'interval';
}

/** Shared boundary checks that do not depend on the kernel's cron engine. */
export function scheduleDeclarationIssue(value: unknown): string | undefined {
  const kind = scheduleDeclarationKind(value);
  if (!kind) return 'must declare exactly one of everyMs or cron';
  const declaration = value as Record<string, unknown>;
  const catchUp = declaration.catchUp ?? 1;
  if (!Number.isSafeInteger(catchUp) || (catchUp as number) < 1) return 'catchUp must be a positive integer';
  const overlap = declaration.overlap ?? 'queue';
  if (overlap !== 'queue' && overlap !== 'skip') return 'overlap must be queue or skip';
  if (kind === 'interval') {
    return typeof declaration.everyMs === 'number' && Number.isFinite(declaration.everyMs) && declaration.everyMs > 0
      ? undefined : 'everyMs must be positive';
  }
  if (typeof declaration.cron !== 'string' || declaration.cron.length === 0) return 'cron must be non-empty';
  if (typeof declaration.timezone !== 'string' || declaration.timezone.length === 0) return 'timezone must be non-empty';
  return undefined;
}
