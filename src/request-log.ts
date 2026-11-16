export interface RequestLogBucket {
  put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
export const MAX_REQUEST_BYTES = 1024 * 1024;
const sensitive = /authorization|cookie|token|secret|password|api[-_]?key/i;

function redactedUrl(request: Request): string {
  const url = new URL(request.url);
  for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, '[REDACTED]');
  return url.toString();
}

/** Persist every request before acknowledging it; logging outages fail closed. */
export async function logRequest(request: Request, bucket: RequestLogBucket,
  route: (request: Request) => Promise<Response>): Promise<Response> {
  const started = Date.now();
  const id = crypto.randomUUID();
  const timestamp = new Date(started).toISOString();
  const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name, sensitive.test(name) ? '[REDACTED]' : value]));
  let size = 0;
  let truncated = false;
  const chunks: Uint8Array[] = [];
  let response: Response;
  let errorMessage: string | undefined;
  try {
    const reader = request.body?.getReader();
    if (reader) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = MAX_REQUEST_BYTES - size;
        if (next.value.byteLength > remaining) {
          chunks.push(next.value.slice(0, remaining));
          size += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    response = truncated ? new Response('Request is too large', { status: 413 }) : await route(new Request(request.url, {
      method: request.method, headers: request.headers, signal: request.signal,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: bytes }),
    }));
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error('writing-scaffold request failed', id, errorMessage);
    response = new Response('Internal server error', { status: 500 });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const contentType = request.headers.get('content-type') ?? '';
  const isText = /json|text\/|xml|form-urlencoded/.test(contentType) || !contentType;
  const body = isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64');
  const entry = { version: 1, id, timestamp, method: request.method, url: redactedUrl(request),
    headers, body, bodyEncoding: isText ? 'utf8' : 'base64', bodyBytes: size, bodyTruncated: truncated,
    status: response.status, durationMs: Date.now() - started, ...(errorMessage ? { error: errorMessage } : {}) };
  const key = `${timestamp.slice(0, 10)}/${timestamp.replaceAll(':', '-')}-${id}.json`;
  try {
    await bucket.put(key, JSON.stringify(entry), { httpMetadata: { contentType: 'application/json' } });
  } catch (error) {
    console.error('writing-scaffold persistent request log failed', id, error);
    // Do not return a successful application response if the audit record was lost.
    void response.body?.cancel().catch(() => {});
    return new Response('Request logging unavailable', { status: 503 });
  }
  return response;
}
