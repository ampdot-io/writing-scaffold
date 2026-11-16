export function extractTopics(key, record) {
  if (record.bodyEncoding && record.bodyEncoding !== 'utf8') return [];
  let body;
  try { body = JSON.parse(record.body); } catch { return []; }
  return (Array.isArray(body) ? body : [body]).flatMap((call, index) => {
    if (call?.method !== 'tools/call' || call.params?.name !== 'write_with_scaffold') return [];
    const args = call.params.arguments;
    if (!args || typeof args !== 'object') return [];
    return [{ id: `${key}#${index}`, timestamp: record.timestamp, status: record.status,
      topic: typeof args.topic === 'string' ? args.topic : null,
      objective: typeof args.objective === 'string' ? args.objective : null }];
  });
}

export function permittedRequest(request, port) {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  return !origin || origin === `http://${host}`;
}

// An overlap also catches requests whose log write finishes after a previous poll.
export function keyBefore(time, overlapMs = 300_000) {
  const iso = new Date(time - overlapMs).toISOString();
  return `${iso.slice(0, 10)}/${iso.replaceAll(':', '-')}`;
}
