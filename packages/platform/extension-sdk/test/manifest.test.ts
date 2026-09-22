import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestExtensionContext, defineExtension } from '../src';

function definition(secrets: { requiredSecrets?: readonly string[]; optionalSecrets?: readonly string[] }) {
  return {
    id: 'secret-probe',
    name: 'Secret probe',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    configuration: z.object({}).strict(),
    permissions: [],
    subscribedEvents: [],
    registeredCommands: [],
    registeredQueries: [],
    registeredProviders: [],
    ...secrets,
  };
}

describe('Extension manifest secrets', () => {
  it('accepts an optional secret declaration', () => {
    expect(() => defineExtension({ manifest: definition({ optionalSecrets: ['OPTIONAL'] }), setup: () => ({}) })).not.toThrow();
  });

  it('rejects duplicate and overlapping secret declarations', () => {
    expect(() => defineExtension({ manifest: definition({ requiredSecrets: ['REQUIRED', 'REQUIRED'] }), setup: () => ({}) }))
      .toThrow(/same required secret/);
    expect(() => defineExtension({ manifest: definition({ requiredSecrets: ['SHARED'], optionalSecrets: ['SHARED'] }), setup: () => ({}) }))
      .toThrow(/both required and optional/);
  });

  it('mirrors declared required and optional secret access in the test context', () => {
    const context = createTestExtensionContext({
      extensionId: 'secret-probe',
      config: {},
      declaredSecrets: ['REQUIRED', 'OPTIONAL'],
      secrets: { REQUIRED: 'required-value' },
    });
    expect(context.secret('REQUIRED')).toBe('required-value');
    expect(context.secret('OPTIONAL')).toBeUndefined();
    expect(() => context.secret('UNDECLARED')).toThrow(/must declare secret/);
  });
});
