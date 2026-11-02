import assert from 'node:assert/strict';
import {test} from 'node:test';
import {discoverMoves,applyMoves,type Move} from '../src/clause-moves.js';

test('moves an existing temporal adjunct without generating or losing words',()=>{
  const text='At the station, she waited for the next train.';
  const moves=discoverMoves(text);
  assert.equal(moves.length,1);
  assert.equal(moves[0]!.replacement,'She waited for the next train at the station.');
  assert.equal(applyMoves(text,moves),moves[0]!.replacement);
});

test('preserves proper names and numeric literal sequences',()=>{
  const text='On Tuesday, María sent 12 messages to José.';
  assert.equal(applyMoves(text,discoverMoves(text)),'María sent 12 messages to José on Tuesday.');
  assert.equal(discoverMoves('At 8, she waited for the next train.').length,1);
  // The conservative operator retains the order of numeric literals too.
  assert.equal(discoverMoves('At 8, she sent 12 messages to José.').length,0);
});

test('uses exact UTF-16 offsets and keeps neighboring paragraphs and whitespace unchanged',()=>{
  const text='🦥 Quiet morning.\r\n\r\n  In the café, she waited for the next train.  \r\nThe next paragraph stays.';
  const moves=discoverMoves(text);
  assert.equal(moves.length,1);
  assert.equal(text.slice(moves[0]!.start,moves[0]!.end),moves[0]!.original);
  assert.equal(applyMoves(text,moves),'🦥 Quiet morning.\r\n\r\n  She waited for the next train in the café.  \r\nThe next paragraph stays.');
});

test('avoids quotes, dialogue, code, URLs and headings even across sentence boundaries',()=>{
  const examples=[
    '"At the station, she waited for the next train."',
    '“Hello. At the station, she waited for the next train.”',
    "'At the station, she waited for the next train.'",
    '```\nAt the station, she waited for the next train.\n```',
    '`At the station, she waited for the next train.`',
    'At the station, she read https://example.com before the train.',
    '# At the station, she waited for the next train.',
    '- At the station, she waited for the next train.',
    '— At the station, she waited for the next train.',
    '1. At the station, she waited for the next train.',
  ];
  for(const text of examples)assert.deepEqual(discoverMoves(text),[],text);
});

test('avoids purpose/conditional/participial adjuncts and subject commas',()=>{
  const examples=[
    'In order to catch the train, she left the house early.',
    'In case of trouble, she would call the station manager.',
    'After leaving the house, she walked toward the station.',
    'Before boarding the train, she checked her ticket again.',
    'Only at the station, she could find the missing ticket.',
    'After no warning, she suddenly left the station behind.',
    'To catch the train, she left the house early.',
    'The station manager, she said, had already left the building.',
    'At dawn, everything being ready, she left the house.',
    'At the station, waiting for the train was exhausting.',
  ];
  for(const text of examples)assert.equal(discoverMoves(text).length,0,text);
});

test('moves reason phrases and handles multiple sentence anchors independently',()=>{
  const text='For this reason, we should check every door. After the meeting, they went straight back home.';
  const moves=discoverMoves(text);
  assert.equal(moves.length,2);
  assert.equal(applyMoves(text,[...moves].reverse()),'We should check every door, for this reason. They went straight back home after the meeting.');
  assert.equal(discoverMoves(text,1).length,1);
  assert.deepEqual(discoverMoves(text,0),[]);
});

test('rejects forged permutations despite equal word multisets and rejects stale anchors',()=>{
  const text='At the station, she waited for the next train.';
  const move=discoverMoves(text)[0]!;
  const forged={...move,replacement:'She waited at the station for the next train.'};
  assert.throws(()=>applyMoves(text,[forged]),/forged/);
  assert.throws(()=>applyMoves(text,[{...move,replacement:text}]),/forged/);
  assert.throws(()=>applyMoves(text,[{...move,replacement:'She waited for a train, at the station.'}]),/forged/);
  assert.throws(()=>applyMoves(text,[{...move,start:move.start+1}]),/forged/);
  assert.throws(()=>applyMoves(text+' changed',[{...move,original:move.original+' changed'}]),/forged/);
  assert.throws(()=>applyMoves(text,[move,move]),/overlapping/);
  assert.throws(()=>applyMoves(text,[{...move,kind:'invented' as Move['kind']}]),/forged/);
});

test('limits adjunct length, never crosses lines, and validates configuration',()=>{
  assert.equal(discoverMoves('At dawn before the long and unusually difficult annual festival at the station, she waited for the train.').length,0);
  assert.equal(discoverMoves('At the station,\nshe waited for the next train.').length,0);
  assert.throws(()=>discoverMoves('text',-1),/limit/);
  assert.throws(()=>discoverMoves('text',NaN),/limit/);
  assert.equal(applyMoves('unchanged',[]),'unchanged');
});

test('integrates trailing temporal and location adjuncts without a comma',()=>{
  const examples=[
    ['In South Africa, churches were prominent in the anti-apartheid struggle.', 'Churches were prominent in the anti-apartheid struggle in South Africa.'],
    ['At dawn, she walked straight back home.', 'She walked straight back home at dawn.'],
    ['On Tuesday, she walked straight back home.', 'She walked straight back home on Tuesday.'],
    ['After the meeting, she walked straight back home.', 'She walked straight back home after the meeting.'],
    ['Before the meeting, she walked straight back home.', 'She walked straight back home before the meeting.'],
    ['During the meeting, she checked every open window.', 'She checked every open window during the meeting.'],
    ['As a result, she checked every open window.', 'She checked every open window, as a result.'],
    ['As a result of the storm, she checked every open window.', 'She checked every open window, as a result of the storm.'],
  ];
  for(const [original,replacement] of examples){
    const moves=discoverMoves(original!);
    assert.equal(moves.length,1,original);
    assert.equal(applyMoves(original!,moves),replacement);
    const oldPunctuation={...moves[0]!,replacement:replacement!.replace(/ (at|in|on|after|before|during)\b/u,', $1')};
    if(oldPunctuation.replacement!==replacement)assert.throws(()=>applyMoves(original!,[oldPunctuation]),/forged/);
  }
});

test('does not split coordinated introductory adjuncts at their first comma',()=>{
  const examples=[
    'In their posts, and in their conversations with me, they emphasized the need for patience.',
    'At the station, or on the train, she always kept her ticket close.',
    'After the meeting, but before dinner, they discussed the open questions.',
    'In the first week, and throughout the next month, she checked every open window.',
  ];
  for(const original of examples)assert.deepEqual(discoverMoves(original),[],original);
});
