import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Trail SessionStart hook settings', () => {
  it('caps the command at eight seconds, not eight thousand seconds', () => {
    const settings = JSON.parse(readFileSync(resolve('.claude/settings.json'), 'utf8'));
    const hooks = settings.hooks.SessionStart.flatMap((group: { hooks: Array<{ type: string; command: string; timeout: number }> }) => group.hooks);
    const trail = hooks.filter((hook: { command: string }) => hook.command.includes('/.trail/hook.cjs'));

    expect(trail).toHaveLength(1);
    expect(trail[0].type).toBe('command');
    // Claude Code's hook timeout field is in seconds:
    // https://code.claude.com/docs/en/hooks#common-fields
    expect(trail[0].timeout).toBe(8);
  });
});
