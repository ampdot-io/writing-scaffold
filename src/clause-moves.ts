/** Mechanical clause-movement proposals. Jev must still judge semantic attachment. */
export interface Move {
  start: number;
  end: number;
  original: string;
  replacement: string;
  kind: 'front-adjunct-to-end';
}
interface Range { start: number; end: number }
const WORDS = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
const NUMBERS = /\p{N}+(?:[.,:/%-]\p{N}+)*%?/gu;
const LOWER = (text: string): string => text.toLowerCase();

function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const patterns = [
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu,
    /`[^`]*(?:`|$)/gu,
    /(?:https?:\/\/|www\.)[^\s<>"']+/giu,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,
    /"[^"]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)/gu,
    /(?<![\p{L}\p{M}])'[^']*'(?![\p{L}\p{M}])/gu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** Lines are hard boundaries: no movement into a heading or another paragraph. */
function sentenceRanges(text: string): Range[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const ranges: Range[] = [];
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    // Markdown headings/list items and screenplay/dialogue lines are not prose slots.
    if (/^\s*(?:[#>*]|[-+•–—]\s*|\d+[.)]\s)/u.test(line[0])) continue;
    for (const part of segmenter.segment(line[0])) {
      const startTrim = part.segment.length - part.segment.trimStart().length;
      const trimmed = part.segment.trim();
      if (!trimmed) continue;
      const start = line.index + part.index + startTrim;
      ranges.push({ start, end: start + trimmed.length });
    }
  }
  return ranges;
}

function lexicalSignature(text: string): string {
  return [...text.matchAll(WORDS)].map(match => LOWER(match[0])).sort().join('\u0000');
}

/** Return only the one exact decomposition/reassembly approved by this operator. */
function moveInitialAdjunct(original: string): string | undefined {
  const match = /^(?<adjunct>(?:At|In|On|After|Before|During)\b[^,\r\n]+|For this reason|As a result(?: of [^,\r\n]+)?), +(?<body>.+?)(?<terminal>[.!?])$/u.exec(original);
  if (!match?.groups) return undefined;
  const { adjunct, body, terminal } = match.groups as { adjunct: string; body: string; terminal: string };
  const count = [...adjunct.matchAll(WORDS)].length;
  if (count < 2 || count > 12 || [...body.matchAll(WORDS)].length < 4) return undefined;
  // Restrictive/conditional phrases and infinitives can change scope when moved.
  if (/\b(?:if|unless|only|not|never|no|neither|nor|except|provided|assuming|case|to)\b/iu.test(adjunct)) return undefined;
  if (/^(?:After|Before)\s+[\p{L}\p{M}]+ing\b/u.test(adjunct)) return undefined;
  // A comma can split coordinated introductory adjuncts, not mark the main clause.
  // E.g. "In their posts, and in their conversations, ..." must remain intact.
  if (/^(?:and|or|but|nor|yet|so)\b/iu.test(body)) return undefined;
  // Avoid participial/dependent openers and mixed-clause scope in the retained body.
  if (/^(?:[\p{L}\p{M}]+ing|(?:everything|all|everyone|it)\s+being|because|although|though|if|unless|while|when)\b/iu.test(body)) return undefined;
  if (/[;:—–]/u.test(body) || /[.!?]$/u.test(body) || !/^\p{L}/u.test(body)) return undefined;
  const first = [...body][0]!;
  const promotedBody = first.toUpperCase() + body.slice(first.length);
  const movedAdjunct = adjunct[0]!.toLowerCase() + adjunct.slice(1);
  // Ordinary final time/place adjuncts are integrated, without an added pause.
  // Discourse/reason phrases retain their separating comma as supplements.
  const separator = /^(?:For this reason|As a result)\b/u.test(adjunct) ? ', ' : ' ';
  const replacement = promotedBody + separator + movedAdjunct + terminal;
  if (replacement === original) return undefined;
  // This also rejects case expansions such as ß -> SS. No word or digit is changed.
  if (lexicalSignature(original) !== lexicalSignature(replacement)) return undefined;
  if (JSON.stringify(original.match(NUMBERS) ?? []) !== JSON.stringify(replacement.match(NUMBERS) ?? [])) return undefined;
  return replacement;
}

export function discoverMoves(text: string, limit = 8): Move[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Move limit must be a nonnegative integer');
  if (!limit) return [];
  const protectedParts = protectedRanges(text), moves: Move[] = [];
  for (const span of sentenceRanges(text)) {
    if (protectedParts.some(range => range.start < span.end && span.start < range.end)) continue;
    const original = text.slice(span.start, span.end);
    const replacement = moveInitialAdjunct(original);
    if (!replacement) continue;
    moves.push({ ...span, original, replacement, kind: 'front-adjunct-to-end' });
    if (moves.length >= limit) break;
  }
  return moves;
}

export function applyMoves(text: string, moves: Move[]): string {
  // Re-discover, rather than trusting lexical multiset equality or caller offsets.
  const approved = new Map(discoverMoves(text, Number.MAX_SAFE_INTEGER).map(move => [move.start, move]));
  const sorted = [...moves].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0, result = '';
  for (const move of sorted) {
    if (!Number.isSafeInteger(move.start) || !Number.isSafeInteger(move.end) || move.start < cursor) throw new Error('Invalid or overlapping moves');
    const canonical = approved.get(move.start);
    if (!canonical || move.end !== canonical.end || move.original !== canonical.original ||
        move.replacement !== canonical.replacement || move.kind !== canonical.kind) throw new Error('Stale or forged movement candidate');
    result += text.slice(cursor, move.start) + move.replacement;
    cursor = move.end;
  }
  return result + text.slice(cursor);
}
