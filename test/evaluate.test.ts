import { describe, expect, it } from 'vitest';
import { wrapForEvaluate } from '../src/browser/evaluate.js';

describe('wrapForEvaluate', () => {
  it('runs sources that reference the esbuild __name helper', () => {
    const source = 'function probe(o) { const double = __name((x) => x * 2, "double"); return double(o.n) + 1; }';
    const result = new Function(`return ${wrapForEvaluate(source, { n: 20 })}`)();
    expect(result).toBe(41);
  });
  it('supports functions without arguments and arrow sources', () => {
    expect(new Function(`return ${wrapForEvaluate('() => 7')}`)()).toBe(7);
    expect(new Function(`return ${wrapForEvaluate('(a) => a.join("-")', ['x', 'y'])}`)()).toBe('x-y');
  });
});
