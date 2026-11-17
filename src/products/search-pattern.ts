// The search term is plain text, but LIKE and ILIKE give three characters a
// meaning: "%" (any run of characters), "_" (any one character) and "\" (the
// escape character). A shopper who types "100%" or "a_b" must search for exactly
// that, so each of them is escaped with a backslash, which is the default escape
// character of PostgreSQL's LIKE.
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

// "contains this text, in any case" for ILIKE.
export function containsPattern(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}
