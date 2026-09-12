import type { MfaSecretRewrapReport, MfaService } from '@storeweave/identity';
import type { Database } from '@storeweave/db';

export interface MfaRewrapRuntime {
  activateRelease(mode: 'require-current'): Promise<readonly string[]>;
  readonly database: Pick<Database, 'transaction'>;
  readonly mfa: MfaService;
}

/** Testable operational seam used by the CLI command; it never removes a key. */
export async function rewrapMfaSecrets(runtime: MfaRewrapRuntime): Promise<MfaSecretRewrapReport> {
  await runtime.activateRelease('require-current');
  return runtime.database.transaction(tx => runtime.mfa.rewrapSecrets(tx));
}
