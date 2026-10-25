import { describe, expect, it } from 'vitest';
import { browserAddress } from './browser-address';
describe('browser address entry', () => {
  it('preserves explicit URLs, protocols, hashes and blank input for Main validation', () => {
    for (const value of [
      'http://localhost:3210/#route',
      'https://example.com/#route',
      'file:///private/file',
      'javascript:alert(1)',
      'custom://app',
    ])
      expect(browserAddress(value)).toBe(value);
    expect(browserAddress('   ')).toBe('');
  });
  it('expands a bare host and searches plain words', () => {
    expect(browserAddress('example.com/path#hash')).toBe('https://example.com/path#hash');
    expect(browserAddress('localhost:3210')).toBe('https://localhost:3210');
    expect(browserAddress('浏览器 页面搜索')).toBe('https://www.baidu.com/s?wd=' + encodeURIComponent('浏览器 页面搜索'));
  });
});
