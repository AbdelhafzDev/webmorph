/** Decode a response body honoring the declared charset (header first, then meta tags), defaulting to UTF-8. */
export function decodeHtml(body: Buffer, contentType: string | undefined): { text: string; charset: string } {
  let charset = charsetFrom(contentType);
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    const meta = head.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9_.:-]+)/i) ?? head.match(/<meta[^>]+content=["'][^"']*charset=([a-zA-Z0-9_.:-]+)/i);
    charset = meta?.[1]?.toLowerCase();
  }
  const label = normalizeLabel(charset ?? 'utf-8');
  try {
    return { text: new TextDecoder(label).decode(body), charset: label };
  } catch {
    return { text: body.toString('utf8'), charset: 'utf-8' };
  }
}

export function charsetFrom(contentType: string | undefined): string | undefined {
  const m = contentType?.match(/charset\s*=\s*"?([a-zA-Z0-9_.:-]+)/i);
  return m?.[1]?.toLowerCase();
}

function normalizeLabel(label: string): string {
  const l = label.toLowerCase();
  if (l === 'utf8') return 'utf-8';
  if (l === 'latin1' || l === 'iso8859-1' || l === 'iso-8859-1') return 'windows-1252';
  return l;
}
