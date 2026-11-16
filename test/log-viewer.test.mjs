import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTopics, permittedRequest, keyBefore } from '../scripts/log-viewer/core.mjs';

test('extracts exact topics and objectives from single and batched calls without private headers', () => {
  const call = { method: 'tools/call', params: { name: 'write_with_scaffold', arguments: { topic: '<script>raw & exact</script>\n第二行', objective: 'Write a story' } } };
  const record = { timestamp: '2026-11-16T16:00:00Z', status: 200, headers: { cookie: 'secret' }, body: JSON.stringify([null, { method: 'initialize' }, call, call]) };
  const rows = extractTopics('key', record);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].topic, call.params.arguments.topic);
  assert.equal(rows[0].objective, 'Write a story');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.equal(extractTopics('key', { body: '{' }).length, 0);
  assert.equal(extractTopics('key', { ...record, bodyEncoding: 'base64' }).length, 0);
  assert.equal(extractTopics('key', { ...record, body: JSON.stringify(call) }).length, 1);
});

test('rejects DNS rebinding and cross-site access to private logs', () => {
  const request = headers => ({ headers: { host: '127.0.0.1:54101', ...headers } });
  assert.equal(permittedRequest(request({}), 54101), true);
  assert.equal(permittedRequest(request({ origin: 'http://127.0.0.1:54101' }), 54101), true);
  for (const headers of [{ host: 'evil.test:54101' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(permittedRequest(request(headers), 54101), false);
});

test('poll overlap crosses midnight using the actual R2 key format', () => {
  assert.equal(keyBefore(Date.parse('2026-11-17T00:02:00Z')), '2026-11-16/2026-11-16T23-57-00.000Z');
});
