const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitiveKey = /token|secret|password|authorization|cookie|credential|api.?key/i;

export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) =>
    sensitiveKey.test(key) ? '[REDACTED]' : item);
  text = String(text ?? '');
  for (const secret of secrets) if (secret?.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)[\w-]*["']?\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export function createLogger({ level = 'info', output = process.stderr, env = process.env } = {}) {
  if (!(level in levels)) throw new Error('LOG_LEVEL 必须是 debug、info、warn 或 error');
  const secrets = Object.entries(env).filter(([key]) => sensitiveKey.test(key)).map(([, value]) => value);
  return Object.fromEntries(Object.entries(levels).map(([name, rank]) => [name, (scope, message, fields) => {
    if (rank < levels[level]) return;
    output.write(`${new Date().toISOString()} [${scope}] ${redact(message, secrets)}${fields ? ` ${redact(fields, secrets)}` : ''}\n`);
  }]));
}
