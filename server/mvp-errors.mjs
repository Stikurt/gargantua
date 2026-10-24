const DEFAULT_RATE_LIMIT_MS = 60000;
// A source can ask for a long cooldown; never turn that into a short retry loop.
const MAX_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export function mvpRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : NaN;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.max(1000, Math.min(MAX_RATE_LIMIT_MS, Math.ceil(milliseconds))) : DEFAULT_RATE_LIMIT_MS;
}
export function mvpRateLimitError(response, source) {
  return Object.assign(new Error('Источник просит снизить частоту запросов. Загрузка продолжится после паузы.'), {
    status: 429, code: 'SOURCE_RATE_LIMIT', source,
    retryAfterMs: mvpRetryAfterMs(response.headers.get('retry-after')),
  });
}
