// src/lib/api/logger.ts
// Minimal structured JSON logger with redaction. Swap for pino/your observability SDK if the project has one,
// but keep the redaction rules.
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|email|set-cookie/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack, cause: redact(value.cause, depth + 1) };
  }
  if (typeof value === 'string') return value.replace(EMAIL, '[email]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...(redact(fields) as object) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields),
};
