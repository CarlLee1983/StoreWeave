const SECRET_KEY_PATTERN = /(password|secret|token|apikey|api_key|authorization|credential|privatekey|private_key)/i;
const REDACTED = '[redacted]';

/** 遞迴遮蔽疑似機密的欄位。Audit log 與一般 log 都必須先過這一層。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
