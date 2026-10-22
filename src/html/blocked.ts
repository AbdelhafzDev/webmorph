/**
 * Recognize bot-protection and rate-limit responses. Returns a short signal
 * name or null. Detection only: WebMorph never attempts to get past these.
 */
export function detectBlockSignal(status: number | undefined, headers: Record<string, string>, bodyText: string): string | null {
  const h = (name: string) => headers[name]?.toLowerCase() ?? '';
  const body = bodyText.slice(0, 20_000);

  if (h('cf-mitigated').includes('challenge')) return 'cloudflare-challenge';
  if (/just a moment|checking your browser|cf-browser-verification|cf_chl_|__cf_chl/i.test(body)) return 'cloudflare-challenge';
  if (headers['x-datadome'] !== undefined || /datadome/i.test(body)) return 'datadome';
  if (/perimeterx|px-captcha|_pxhd|human challenge/i.test(body)) return 'perimeterx';
  if (headers['x-iinfo'] !== undefined || /incapsula|imperva/i.test(body)) return 'imperva';
  if (/pardon our interruption/i.test(body)) return 'distil';
  if (/access denied[\s\S]{0,400}reference\s*#/i.test(body) || (status === 403 && /akamai/i.test(h('server')))) return 'akamai-access-denied';
  if (status === 403 && h('server').includes('cloudflare')) return 'cloudflare-403';
  if (status === 429) return 'rate-limited';
  if ((status === 403 || status === 503 || status === 401) && /captcha|are you a robot|verify you are human|unusual traffic/i.test(body)) return 'captcha';
  if (status === 503 && /retry-after/i.test(Object.keys(headers).join(' ')) && /temporarily unavailable|overloaded/i.test(body)) return 'rate-limited';
  return null;
}
