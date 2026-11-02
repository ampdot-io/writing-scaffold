import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits, candidateAllowed, discoverSpans, protectedRanges } from '../src/hybrid-spans.js';
import type { Span } from '../src/hybrid-spans.js';

const spanFor = (text: string, original: string): Span => {
  const start = text.indexOf(original);
  const sentence = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .find(part => part.index <= start && start + original.length <= part.index + part.segment.length)!;
  return { start, end: start + original.length, original, sentenceStart: sentence.index, sentenceEnd: sentence.index + sentence.segment.length };
};

test('discovery requires an inherited contiguous phrase and budgets one per sentence', () => {
  const scaffold = 'We worked in order to finish early. The river ran past the old house. We rested in the quiet room.';
  const draft = 'We walked in order to reach town. The river ran past the red house. We rested in the quiet room.';
  const spans = discoverSpans(scaffold, draft);
  assert.equal(new Set(spans.map(span => span.sentenceStart)).size, spans.length);
  assert.ok(spans.length >= 2);
  for (const span of spans) {
    assert.equal(draft.slice(span.start, span.end), span.original);
    assert.ok(span.original.split(/\s/u).length >= 2 && span.original.split(/\s/u).length <= 6);
    assert.ok(scaffold.toLowerCase().includes(span.original.toLowerCase()));
  }
  assert.deepEqual(discoverSpans('nothing inherited here', 'The second text is unrelated.'), []);
});

test('formulaic phrases are prioritized while unprioritized sentences are spread deterministically', () => {
  const text = 'We worked beside the river. We rested under the trees. We sat near the window. We left in order to arrive early. We waited inside the house.';
  const first = discoverSpans(text, text, 1);
  assert.equal(first.length, 1);
  assert.ok(first[0]!.original.includes('in order to'));
  const more = discoverSpans(text, text, 3);
  assert.deepEqual(more, discoverSpans(text, text, 3));
  assert.equal(more.length, 3);
  assert.equal(discoverSpans(text, text, 0).length, 0);
  assert.throws(() => discoverSpans(text, text, -1));
});

test('discovery excludes inherited grammatical glue rather than spending an edit slot on it', () => {
  const glue = 'to the. I have. into the. said the. all of. it has been in the.';
  assert.deepEqual(discoverSpans(glue, glue), []);
  assert.deepEqual(discoverSpans('We spoke to the editor.', 'They ran to the station.'), []);
  assert.deepEqual(discoverSpans('We said the name.', 'They said the word.'), []);
});

test('meaningful short phrases survive the glue filter and lexical 3–5-word spans take priority', () => {
  const pair = discoverSpans('He spoke with a colleague.', 'They spoke with several friends.');
  assert.deepEqual(pair.map(span => span.original), ['spoke with']);
  const triple = discoverSpans('They obtained an audience before dinner.', 'We obtained an audience after lunch.');
  assert.deepEqual(triple.map(span => span.original), ['obtained an audience']);
  const text = 'We spoke with the local organizer near the station.';
  const chosen = discoverSpans(text, text, 1)[0]!;
  assert.ok(chosen.original.split(' ').length >= 3 && chosen.original.split(' ').length <= 5);
  assert.ok(/spoke|organizer|station/.test(chosen.original));
});

test('quotes including multiline text, URLs, code, numbers and proper names are protected', () => {
  const text = 'We call Alice Smith at https://example.com/some/path in 2026. "These are\nliteral words." “These too.” We use `plain text` and ```\ncode here\n```. Pip spoke softly.';
  const ranges = protectedRanges(text);
  for (const literal of ['Alice', 'Smith', 'https://example.com/some/path', '2026', '"These are\nliteral words."', '“These too.”', '`plain text`', 'Pip']) {
    const start = text.indexOf(literal);
    assert.ok(ranges.some(range => range.start <= start && range.end >= start + literal.length), literal);
  }
  const found = discoverSpans(text, text);
  assert.ok(found.every(span => !ranges.some(range => span.start < range.end && range.start < span.end)));
});

test('UTF-16 offsets survive emoji, combining characters and repeated phrases', () => {
  const text = '🦥 We worked in order to finish. We worked in order to finish.';
  const spans = discoverSpans(text, text, 2);
  assert.equal(spans.length, 2);
  const edited = applyEdits(text, spans.map(span => ({ span, replacement: span.original.replace('in order to', 'to') })));
  assert.equal(edited, '🦥 We worked to finish. We worked to finish.');
  assert.ok(edited.startsWith('🦥'));
  const combining = 'We visited the café by the river.';
  const s = spanFor(combining, 'by the river');
  assert.equal(applyEdits(combining, [{ span: s, replacement: 'near the river' }]), 'We visited the café near the river.');
});

test('candidate validation permits a contextual phrase while preserving logical operators', () => {
  const text = 'We could not finish in order to leave.';
  const phrase = spanFor(text, 'in order to');
  assert.equal(candidateAllowed(text, phrase, 'to'), true);
  const protectedLogic = spanFor(text, 'could not finish');
  assert.equal(candidateAllowed(text, protectedLogic, 'could finish'), false);
  assert.equal(candidateAllowed(text, protectedLogic, 'must not finish'), false);
  assert.equal(candidateAllowed(text, protectedLogic, "couldn't finish"), true);
  const quantified = 'We agree almost entirely with the proposal.';
  assert.equal(candidateAllowed(quantified, spanFor(quantified, 'almost entirely'), 'for the most part'), false);
});

test('post-holdout regression: negative tense/aspect cannot drift across lexical alternatives', () => {
  const text = "We don't know the visitor.";
  const span = spanFor(text, "don't know");
  assert.equal(candidateAllowed(text, span, "haven't met"), false);
  assert.equal(candidateAllowed(text, span, 'do not know'), true);
  const past = "We didn't know the visitor.";
  assert.equal(candidateAllowed(past, spanFor(past, "didn't know"), 'did not know'), true);
  assert.equal(candidateAllowed(past, spanFor(past, "didn't know"), 'do not know'), false);
});

test('negative auxiliary classes normalize contractions and include the unchanged context', () => {
  for (const [before, equivalent, differentAspect] of [
    ["doesn't know", 'does not know', 'has not known'],
    ["haven't met", 'have not met', 'had not met'],
    ["hasn't met", 'has not met', 'does not meet'],
    ["hadn't met", 'had not met', 'have not met'],
    ["isn't ready", 'is not ready', 'was not ready'],
    ["aren't ready", 'are not ready', 'were not ready'],
    ["wasn't ready", 'was not ready', 'is not ready'],
    ["weren't ready", 'were not ready', 'are not ready'],
  ]) {
    const subject = /^(?:doesn't|hasn't|isn't|wasn't)/u.test(before!) ? 'The visitor' : 'We';
    const text = `${subject} ${before}.`, span = spanFor(text, before!);
    assert.equal(candidateAllowed(text, span, equivalent!), true, before);
    assert.equal(candidateAllowed(text, span, differentAspect!), false, before);
  }
  const text = 'We do not know the answer.';
  const span = spanFor(text, 'not know');
  assert.equal(candidateAllowed(text, span, 'not recognize'), true);
  assert.equal(candidateAllowed(text, span, 'have not discovered'), false);
  const adverb = 'We do really not know the answer.';
  assert.equal(candidateAllowed(adverb, spanFor(adverb, 'do really not know'), 'have really not learned'), false);
});

test('positive be/have remain available for faithful phrase restructuring', () => {
  const agreement = 'We are in agreement.';
  assert.equal(candidateAllowed(agreement, spanFor(agreement, 'are in agreement'), 'agree'), true);
  const look = 'We have a look at the map.';
  assert.equal(candidateAllowed(look, spanFor(look, 'have a look'), 'look'), true);
});

test('malformed, overlong, boundary-changing or literal-changing alternatives are rejected', () => {
  const text = 'We walked in order to reach town.';
  const span = spanFor(text, 'in order to');
  for (const candidate of ['', ' to', 'to ', 'to\n', 'to\u200b', '<|endoftext|>', 'to 42', 'to Alice', 'to "town"', 'one two three four five six seven eight nine']) {
    assert.equal(candidateAllowed(text, span, candidate), false, JSON.stringify(candidate));
  }
  assert.equal(candidateAllowed(text, { ...span, original: 'wrong anchor' }, 'to'), false);
  assert.equal(candidateAllowed(text, { ...span, start: span.start + 1, original: span.original.slice(1) }, 'to'), false);
  const quoted = 'We read "in order to" together.';
  assert.equal(candidateAllowed(quoted, spanFor(quoted, 'in order to'), 'to'), false);
});

test('edits reject stale and overlapping intervals and preserve every outside character', () => {
  const text = '\tWe waited in order to leave.\r\nWe stood beside the wall.  ';
  const first = spanFor(text, 'in order to'), second = spanFor(text, 'beside the wall');
  assert.equal(applyEdits(text, [{ span: second, replacement: 'by the wall' }, { span: first, replacement: 'to' }]), '\tWe waited to leave.\r\nWe stood by the wall.  ');
  assert.throws(() => applyEdits(text, [{ span: first, replacement: 'to' }, { span: first, replacement: 'to' }]), /Overlapping/);
  assert.throws(() => applyEdits(text.replace('order', 'plans'), [{ span: first, replacement: 'to' }]), /Stale/);
  assert.equal(applyEdits(text, []), text);
});
