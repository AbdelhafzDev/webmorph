import type { z } from 'zod';
import type { LlmsTxt } from '../schemas/documentationIndex.js';

type Parsed = z.infer<typeof LlmsTxt>;

/** Parse the llms.txt convention: an H1 title, an optional blockquote summary, H2 sections with link lists. */
export function parseLlmsTxt(text: string, url: string): Parsed {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Parsed = { url, sections: [] };
  let current: Parsed['sections'][number] | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1 && !out.title) {
      out.title = h1[1]!.trim().slice(0, 200);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote && !out.summary) {
      out.summary = quote[1]!.trim().slice(0, 500);
      continue;
    }
    const h2 = line.match(/^#{2,3}\s+(.+)$/);
    if (h2) {
      current = { heading: h2[1]!.trim().slice(0, 120), links: [] };
      out.sections.push(current);
      continue;
    }
    const link = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.+))?$/);
    if (link) {
      if (!current) {
        current = { heading: 'Links', links: [] };
        out.sections.push(current);
      }
      let href = link[2]!;
      try {
        href = new URL(href, url).toString();
      } catch {
        continue;
      }
      if (current.links.length < 200) current.links.push({ title: link[1]!.trim().slice(0, 160), url: href, ...(link[3] ? { note: link[3].trim().slice(0, 300) } : {}) });
    }
  }
  return out;
}
