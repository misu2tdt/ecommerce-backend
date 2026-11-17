import { containsPattern, escapeLikePattern } from './search-pattern';

describe('search pattern', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('relaxed tee')).toBe('relaxed tee');
    expect(escapeLikePattern('')).toBe('');
    expect(escapeLikePattern('Cinder & Oak-5')).toBe('Cinder & Oak-5');
  });

  it('escapes the percent sign, the underscore and the backslash', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
  });

  it('escapes every occurrence', () => {
    expect(escapeLikePattern('%%__')).toBe('\\%\\%\\_\\_');
  });

  it('wraps the escaped text so it means "contains"', () => {
    expect(containsPattern('tee')).toBe('%tee%');
    expect(containsPattern('50%')).toBe('%50\\%%');
    expect(containsPattern('_')).toBe('%\\_%');
  });

  it('does not touch quotes: the term is a bound parameter, never SQL text', () => {
    expect(escapeLikePattern('o\'brien " ; --')).toBe('o\'brien " ; --');
  });
});
