import { Readable } from 'node:stream';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { baseConfigSchema, type SecretProvider } from '@storeweave/config';
import { createSmtpMailTransport, MailTransportFailure } from '@storeweave/mail';

const servers: SMTPServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function smtp(options: ConstructorParameters<typeof SMTPServer>[0] = {}) {
  const server = new SMTPServer({ disabledCommands: ['STARTTLS', 'AUTH'], ...options });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP server did not expose a TCP port');
  return address.port;
}

function transport(port: number) {
  const config = baseConfigSchema.parse({ version: 1, store: { id: 'mail-test', name: 'Mail test' }, database: { url: 'postgres://unused.invalid/test' },
    mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port, connectionTimeoutMs: 1_000, socketTimeoutMs: 1_000 } },
  });
  const secrets: SecretProvider = { get: () => undefined, has: () => false, listNames: () => [] };
  return createSmtpMailTransport(config.mail, secrets);
}

describe('Nodemailer SMTP transport', () => {
  it('writes an HTML/text MIME alternative with a streamed attachment', async () => {
    let received = '';
    const port = await smtp({ onData(stream, _session, callback) {
      stream.on('data', chunk => { received += chunk.toString('utf8'); });
      stream.on('end', callback);
    } });
    const result = await transport(port).send({ from: 'sender@example.test', to: [{ email: 'buyer@example.test', name: 'Buyer' }],
      subject: 'Receipt', html: '<p>Hello &amp; welcome</p>', text: 'Hello & welcome', messageId: '<stable@example.test>',
      attachments: [{ filename: 'note.txt', contentType: 'text/plain', content: Readable.from('attachment body') }],
    });
    expect(result.accepted).toEqual(['buyer@example.test']);
    expect(received).toContain('Message-ID: <stable@example.test>');
    expect(received).toContain('multipart/mixed');
    expect(received).toContain('multipart/alternative');
    expect(received).toContain('name=note.txt');
  });

  it('reports accepted and rejected recipients independently', async () => {
    const port = await smtp({ onRcptTo(address, _session, callback) {
      if (address.address === 'nope@example.test') return callback(Object.assign(new Error('unknown recipient'), { responseCode: 550 }));
      callback();
    }, onData(stream, _session, callback) { stream.resume(); stream.on('end', callback); } });
    const result = await transport(port).send({ from: 'sender@example.test', to: [{ email: 'ok@example.test' }, { email: 'nope@example.test' }],
      subject: 'Partial', html: '<p>partial</p>', text: 'partial', messageId: '<partial@example.test>', attachments: [],
    });
    expect(result.accepted).toEqual(['ok@example.test']);
    expect(result.rejected).toEqual(['nope@example.test']);
  });

  it('does not let a display name replace the recipient envelope address', async () => {
    const recipients: string[] = [];
    const port = await smtp({ onRcptTo(address, _session, callback) { recipients.push(address.address); callback(); },
      onData(stream, _session, callback) { stream.resume(); stream.on('end', callback); } });
    await transport(port).send({ from: 'sender@example.test', to: [{ email: 'victim@example.test', name: 'Alice <attacker@example.test>' }],
      subject: 'Address safety', html: '<p>safe</p>', text: 'safe', messageId: '<address-safety@example.test>', attachments: [],
    });
    expect(recipients).toEqual(['victim@example.test']);
  });

  it('normalizes SMTP authentication failures into a durable diagnostic category', async () => {
    const port = await smtp({ disabledCommands: ['STARTTLS'], authOptional: false, onAuth(_auth, _session, callback) {
      callback(Object.assign(new Error('bad credentials'), { responseCode: 535 }));
    } });
    const config = baseConfigSchema.parse({ version: 1, store: { id: 'mail-auth', name: 'Mail auth' }, database: { url: 'postgres://unused.invalid/test' },
      mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port, usernameRef: 'SMTP_USER', passwordRef: 'SMTP_PASS' } },
    });
    const secrets: SecretProvider = { get: name => name === 'SMTP_USER' ? 'user' : name === 'SMTP_PASS' ? 'wrong' : undefined, has: () => true, listNames: () => ['SMTP_USER', 'SMTP_PASS'] };
    await expect(createSmtpMailTransport(config.mail, secrets).send({ from: 'sender@example.test', to: [{ email: 'buyer@example.test' }],
      subject: 'Auth', html: '<p>auth</p>', text: 'auth', messageId: '<auth@example.test>', attachments: [],
    })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies a socket timeout as unknown rather than a safe retry', async () => {
    const port = await smtp({ onData(stream) { stream.resume(); /* Deliberately never acknowledge DATA. */ } });
    const config = baseConfigSchema.parse({ version: 1, store: { id: 'mail-timeout', name: 'Mail timeout' }, database: { url: 'postgres://unused.invalid/test' },
      mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port, socketTimeoutMs: 100, connectionTimeoutMs: 1_000 } },
    });
    const secrets: SecretProvider = { get: () => undefined, has: () => false, listNames: () => [] };
    await expect(createSmtpMailTransport(config.mail, secrets).send({ from: 'sender@example.test', to: [{ email: 'buyer@example.test' }],
      subject: 'Timeout', html: '<p>timeout</p>', text: 'timeout', messageId: '<timeout@example.test>', attachments: [],
    })).rejects.toMatchObject({ kind: 'timeout' });
  });
});
