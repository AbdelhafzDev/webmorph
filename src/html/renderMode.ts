import type { RenderMode } from '../schemas/pageInventory.js';

export interface RenderSignals {
  htmlLength: number;
  textLength: number;
  scriptCount: number;
  internalLinkCount: number;
  frameworks: string[];
  hasRootMount: boolean;
}

/**
 * Decide whether the static HTML is a faithful view of the page. An SPA shell
 * means later stages must go browser-first for this page or site.
 *
 * A shell needs positive evidence (an empty mount node, a client framework, or
 * an essentially empty body with scripts). Small static pages with an analytics
 * tag are static, not shells.
 */
export function classifyRenderMode(s: RenderSignals): RenderMode {
  const textDensity = s.htmlLength > 0 ? s.textLength / s.htmlLength : 0;
  const reasons: string[] = [];
  const little = s.textLength < 300;

  const emptyMount = s.hasRootMount && little;
  const frameworkShell = s.frameworks.length > 0 && s.textLength < 200;
  const bareScripts = s.scriptCount > 0 && s.textLength < 60 && s.internalLinkCount === 0;

  if (emptyMount || frameworkShell || bareScripts) {
    if (s.hasRootMount) reasons.push('empty mount node');
    if (s.frameworks.length) reasons.push(`frameworks: ${s.frameworks.join(', ')}`);
    reasons.push(`only ${s.textLength} chars of text`);
    if (s.internalLinkCount < 3) reasons.push(`only ${s.internalLinkCount} internal links`);
    return { kind: 'spa-shell', textDensity: round(textDensity), reasons };
  }

  if (s.frameworks.length > 0 || s.hasRootMount) {
    if (s.frameworks.length) reasons.push(`hydrated framework markup: ${s.frameworks.join(', ')}`);
    if (s.hasRootMount) reasons.push('mount node with server-rendered content');
    return { kind: 'hybrid', textDensity: round(textDensity), reasons };
  }

  reasons.push('server-rendered HTML with content');
  return { kind: 'static', textDensity: round(textDensity), reasons };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
