import { describe, expect, it } from 'vitest';
import { softErrorFromTitle } from '../src/tools/interpreter.js';

describe('softErrorFromTitle', () => {
  it('recognizes error pages served with a 200 status by their title', () => {
    expect(softErrorFromTitle('Internal Server Error')).toBe('SITE_CHANGED');
    expect(softErrorFromTitle('500 Internal Server Error')).toBe('SITE_CHANGED');
    expect(softErrorFromTitle('Something went wrong | Syarah')).toBe('SITE_CHANGED');
    expect(softErrorFromTitle('404 - Page not found')).toBe('NOT_FOUND');
    expect(softErrorFromTitle('Page Not Found – Example')).toBe('NOT_FOUND');
    expect(softErrorFromTitle('Not found')).toBe('NOT_FOUND');
  });
  it('leaves ordinary titles alone, including ones that mention errors in passing', () => {
    expect(softErrorFromTitle('Used 2021 Renault Docker for sale - 320504 | Syarah')).toBeUndefined();
    expect(softErrorFromTitle('Error handling in Rust | Blog')).toBeUndefined();
    expect(softErrorFromTitle('404 Ways to Say Hello')).toBeUndefined();
    expect(softErrorFromTitle('سيارات للبيع في السعودية | موقع سيارة')).toBeUndefined();
    expect(softErrorFromTitle('')).toBeUndefined();
  });
});
