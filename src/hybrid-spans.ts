/** Pure, conservative phrase-edit planning. All offsets are UTF-16 string offsets. */
export interface Span {
  start: number;
  end: number;
  original: string;
  sentenceStart: number;
  sentenceEnd: number;
}

type Range = { start: number; end: number };
type Word = Range & { value: string; normalized: string };
const WORD = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;
const NUMBER_WORDS = new Set(('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion first second third fourth fifth').split(' '));
const OPERATORS = new Set(('no not never neither nor can could may might must shall should will would ought only all any every none most some almost entirely always often sometimes rarely seldom usually possibly probably certainly definitely if unless because although though').split(' '));
const OPENERS = new Set(('a an the this that these those it there i we you he she they our your their its in on at by for from with to of as and but or if when while once although though because unless however furthermore therefore indeed also all any every no not never only almost one first second').split(' '));
const CONTRACTIONS: Record<string, string[]> = {
  cannot: ['can', 'not'], "can't": ['can', 'not'], "won't": ['will', 'not'],
  "couldn't": ['could', 'not'], "wouldn't": ['would', 'not'], "shouldn't": ['should', 'not'],
  "mustn't": ['must', 'not'], "shan't": ['shall', 'not'], "mightn't": ['might', 'not'],
  "isn't": ['not'], "aren't": ['not'], "wasn't": ['not'], "weren't": ['not'],
  "don't": ['not'], "doesn't": ['not'], "didn't": ['not'],
  "haven't": ['not'], "hasn't": ['not'], "hadn't": ['not'], "needn't": ['not'],
};
const FORMULAIC = [
  'due to the fact that', 'at this point in time', 'it is worth noting that',
  'it is important to', 'it is necessary to', 'it is furthermore imperative to',
  'for the purpose of', 'with the aim of', 'as a matter of fact',
  'it stands to reason', 'it is clear that', 'in order to', 'as a result of',
  'for this reason', 'on the other hand', 'in the context of', 'in terms of',
  'a wide range of', 'plays a role in', 'at the appointed moment',
];
const normalized = (value: string): string => value.toLowerCase().replaceAll('’', "'");

function words(text: string): Word[] {
  return [...text.matchAll(WORD)].map(match => ({
    start: match.index, end: match.index + match[0].length,
    value: match[0], normalized: normalized(match[0]),
  }));
}

function sentences(text: string): Range[] {
  const result: Range[] = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  // A blank line ends a sentence for our edit budget, even without punctuation.
  let start = 0;
  const paragraphs = [...text.matchAll(/\r?\n[\t ]*\r?\n/gu)];
  const ends = [...paragraphs.map(match => match.index), text.length];
  ends.forEach((end, index) => {
    for (const segment of segmenter.segment(text.slice(start, end))) {
      if (segment.segment.trim()) result.push({ start: start + segment.index, end: start + segment.index + segment.segment.length });
    }
    if (index < paragraphs.length) start = paragraphs[index]!.index + paragraphs[index]![0].length;
  });
  return result;
}

function intersects(a: Range, b: Range): boolean { return a.start < b.end && b.start < a.end; }

/** A heuristic: uncertain capitalized words are protected rather than renamed. */
export function protectedRanges(text: string): Range[] {
  const result: Range[] = [];
  const patterns = [
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu,
    /`[^`]*(?:`|$)/gu,
    /(?:https?:\/\/|www\.)[^\s<>"']+/giu,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,
    /"[^"]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)/gu,
    /(?<![\p{L}\p{M}])'[^']*'(?![\p{L}\p{M}])/gu,
    /\p{N}+(?:[.,:/%-]\p{N}+)*%?/gu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    result.push({ start: match.index, end: match.index + match[0].length });
  }
  const bounds = sentences(text);
  for (const word of words(text)) {
    if (NUMBER_WORDS.has(word.normalized)) {
      result.push(word); continue;
    }
    if (!/\p{Lu}/u.test(word.value)) continue;
    const sentence = bounds.find(bound => word.start >= bound.start && word.end <= bound.end);
    const atStart = sentence && !/[\p{L}\p{N}]/u.test(text.slice(sentence.start, word.start));
    const plainInitial = /^\p{Lu}[\p{Ll}\p{M}]*$/u.test(word.value);
    if (!(atStart && plainInitial && OPENERS.has(word.normalized))) result.push(word);
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

function ngrams(text: string): Set<string> {
  const tokens = words(text), found = new Set<string>();
  for (let start = 0; start < tokens.length; start++) {
    for (let count = 2; count <= 6 && start + count <= tokens.length; count++) {
      const group = tokens.slice(start, start + count);
      if (group.slice(1).some((word, index) => !/^[\t ]+$/u.test(text.slice(group[index]!.end, word.start)))) break;
      found.add(group.map(word => word.normalized).join(' '));
    }
  }
  return found;
}

function spread<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  if (count === 1) return [items[Math.floor(items.length / 2)]!];
  return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]!);
}

export function discoverSpans(scaffold: string, text: string, limit = 8): Span[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Span limit must be a nonnegative integer');
  if (!limit) return [];
  // Discovery needs something worth rewriting, not just an accidental alignment
  // of grammatical glue. This is a lexical-content heuristic, not a POS parser.
  // Reporting glue such as "said the" is deliberately low-value for this operator.
  const glue = new Set(('a an the this that these those i we you he she it they me us him her them my our your his its their '+
    'is am are was were be been being do does did done doing have has had having '+
    'to of in on at by for from with without within into onto upon over under about through throughout across between among '+
    'before after during until since against despite except per via as than up down out off inside outside '+
    'and or but if unless because although though while whether when where who whom whose what which why how '+
    'there here then now very more less much many little few such same other another own just also even rather quite well so too yet still '+
    'further perhaps already currently previously particularly especially clearly extremely strongly highly aptly largely simply generally really truly '+
    "said says say saying it's that's there's here's what's who's i'm you're we're they're i've you've we've they've i'd you'd we'd they'd i'll you'll we'll they'll").split(' '));
  const lexicalCount = (group: Word[]): number => group.filter(word =>
    !glue.has(word.normalized) && !OPERATORS.has(word.normalized) && !NUMBER_WORDS.has(word.normalized) && !CONTRACTIONS[word.normalized]).length;
  const lengthBand = (count: number): number => count >= 3 && count <= 5 ? 0 : count === 2 ? 1 : 2;
  const inherited = ngrams(scaffold), tokens = words(text), protectedParts = protectedRanges(text);
  const perSentence: (Span & { priority: number; count: number; lexical: number })[] = [];
  for (const sentence of sentences(text)) {
    const local = tokens.filter(word => word.start >= sentence.start && word.end <= sentence.end);
    const choices: (Span & { priority: number; count: number; lexical: number })[] = [];
    for (let index = 0; index < local.length; index++) {
      for (let count = 2; count <= 6 && index + count <= local.length; count++) {
        const group = local.slice(index, index + count);
        if (group.slice(1).some((word, i) => !/^[\t ]+$/u.test(text.slice(group[i]!.end, word.start)))) break;
        const start = group[0]!.start, end = group.at(-1)!.end;
        if (protectedParts.some(range => intersects({ start, end }, range))) continue;
        const key = group.map(word => word.normalized).join(' ');
        if (!inherited.has(key)) continue;
        const priority = Math.max(0, ...FORMULAIC.filter(phrase => (` ${key} `).includes(` ${phrase} `)).map(phrase => phrase.split(' ').length));
        const lexical = lexicalCount(group);
        // A short span remains useful when it carries lexical content ("spoke
        // with", "the audience"). Pure auxiliary/preposition/determiner spans
        // are rejected regardless of length rather than spending provider calls.
        if (!lexical) continue;
        choices.push({ start, end, original: text.slice(start, end), sentenceStart: sentence.start, sentenceEnd: sentence.end, priority, count, lexical });
      }
    }
    choices.sort((a, b) => b.priority - a.priority || lengthBand(a.count) - lengthBand(b.count) ||
      b.lexical - a.lexical || Math.abs(a.count - 4) - Math.abs(b.count - 4) || a.start - b.start);
    if (choices[0]) perSentence.push(choices[0]);
  }
  const preferred = perSentence.filter(span => span.priority > 0).sort((a, b) => b.priority - a.priority || a.start - b.start);
  const selected = preferred.slice(0, limit);
  if (selected.length < limit) selected.push(...spread(perSentence.filter(span => span.priority === 0), limit - selected.length));
  return selected.sort((a, b) => a.start - b.start).map(({ priority: _priority, count: _count, lexical: _lexical, ...span }) => span);
}

function semanticSignature(text: string): string {
  const tokens = words(text).flatMap(word => CONTRACTIONS[word.normalized] ?? [word.normalized]);
  return tokens.filter(word => OPERATORS.has(word) || NUMBER_WORDS.has(word)).sort().join('\u0000');
}

/** Keep tense/aspect of a negated auxiliary without freezing positive be/have. */
function negativeAuxiliarySignature(text: string): string {
  const expanded: Record<string, string[]> = {
    "don't": ['do', 'not'], "doesn't": ['does', 'not'], "didn't": ['did', 'not'],
    "haven't": ['have', 'not'], "hasn't": ['has', 'not'], "hadn't": ['had', 'not'],
    "isn't": ['is', 'not'], "aren't": ['are', 'not'],
    "wasn't": ['was', 'not'], "weren't": ['were', 'not'],
  };
  const classes: Record<string, string> = {
    do: 'present_simple', does: 'present_simple', did: 'past_simple',
    have: 'present_perfect', has: 'present_perfect', had: 'past_perfect',
    is: 'present_be', am: 'present_be', are: 'present_be', was: 'past_be', were: 'past_be',
  };
  const adverbs = new Set(('really actually quite exactly even ever necessarily simply just always entirely fully generally definitely').split(' '));
  const tokens = words(text).flatMap(word => expanded[word.normalized] ?? [word.normalized]);
  const signature: string[] = [];
  tokens.forEach((token, index) => {
    const auxiliaryClass = classes[token];
    if (!auxiliaryClass) return;
    // Support "do really not know", but do not mistake "do things not words"
    // for a negated auxiliary by scanning across an arbitrary noun or predicate.
    let next = index + 1;
    while (next <= index + 3 && adverbs.has(tokens[next] ?? '')) next++;
    if (tokens[next] === 'not') signature.push(auxiliaryClass);
  });
  return signature.sort().join('\u0000');
}

function validAnchor(text: string, span: Span): boolean {
  if (![span.start, span.end, span.sentenceStart, span.sentenceEnd].every(Number.isSafeInteger) ||
      span.sentenceStart < 0 || span.sentenceEnd > text.length || span.start < span.sentenceStart ||
      span.end > span.sentenceEnd || span.end <= span.start || span.original !== text.slice(span.start, span.end)) return false;
  if (!span.original || span.original.trim() !== span.original) return false;
  const bound = sentences(text).find(sentence => sentence.start === span.sentenceStart && sentence.end === span.sentenceEnd);
  return Boolean(bound) && !/[\p{L}\p{M}\p{N}'’\-]$/u.test(text.slice(0, span.start)) &&
    !/^[\p{L}\p{M}\p{N}'’\-]/u.test(text.slice(span.end));
}

export function candidateAllowed(text: string, span: Span, replacement: string): boolean {
  if (!validAnchor(text, span) || typeof replacement !== 'string' || replacement.trim() !== replacement || !replacement) return false;
  if (protectedRanges(text).some(range => intersects(span, range))) return false;
  if (/[\p{Cc}\p{Cf}]/u.test(replacement) || /[<>\[\]⟦⟧`]/u.test(replacement)) return false;
  // A phrase candidate may contain words, spaces, apostrophes and internal hyphens.
  // Sentence punctuation and formatting are outside this conservative operator.
  if (!/^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*(?: +[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*)*$/u.test(replacement)) return false;
  if (words(replacement).length > 8 || !words(replacement).length) return false;
  if (semanticSignature(span.original) !== semanticSignature(replacement)) return false;
  const originalSentence = text.slice(span.sentenceStart, span.sentenceEnd);
  const revisedSentence = text.slice(span.sentenceStart, span.start) + replacement + text.slice(span.end, span.sentenceEnd);
  if (negativeAuxiliarySignature(originalSentence) !== negativeAuxiliarySignature(revisedSentence)) return false;
  if (protectedRanges(replacement).length) return false;
  // Explicitly keep the numeric invariant even if the lexical grammar later grows.
  if (JSON.stringify(span.original.match(/\p{N}+/gu) ?? []) !== JSON.stringify(replacement.match(/\p{N}+/gu) ?? [])) return false;
  return true;
}

export function applyEdits(text: string, edits: { span: Span; replacement: string }[]): string {
  const sorted = [...edits].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  let cursor = 0, result = '';
  for (const { span, replacement } of sorted) {
    if (span.start < cursor) throw new Error('Overlapping span edits');
    if (!candidateAllowed(text, span, replacement)) throw new Error('Stale or invalid span edit');
    result += text.slice(cursor, span.start) + replacement;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
