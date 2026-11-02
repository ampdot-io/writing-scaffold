/** Upper bound for list_scaffolds limit. */
export const MAX_PAGE_LIMIT = 50_000;
/**
 * Default target for one list_scaffolds page, measured in rendered TSV UTF-16 code units.
 * An eligible first row is always included, even if it exceeds the target.
 * This is not a hard response-size ceiling or a token budget.
 */
export const DEFAULT_PAGE_CHARS = 45_000;
export const MIN_PAGE_CHARS = 1_000;
export const MAX_PAGE_CHARS = 100_000_000;
