import type { Page } from 'playwright';

/**
 * Build a self-contained script from a function's source. Transpilers such as
 * esbuild with keepNames wrap inner functions in a `__name` helper that does
 * not exist inside the page, so the script defines it before running the
 * function. Only JSON-serializable arguments are supported.
 */
export function wrapForEvaluate(source: string, arg?: unknown): string {
  const call = arg === undefined ? '' : JSON.stringify(arg);
  return `(() => { const __name = (target) => target; const __fn = (${source}); return __fn(${call}); })()`;
}

/** Evaluate a page-side function regardless of which transpiler produced the running code. */
export async function evaluateInPage<A, R>(page: Page, fn: (arg: A) => R, arg?: A): Promise<R> {
  return (await page.evaluate(wrapForEvaluate(fn.toString(), arg))) as R;
}
