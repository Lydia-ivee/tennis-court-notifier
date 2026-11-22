// Small HTTP helpers shared by every API route.

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }
  // Never echo internal error details back to the caller.
  console.error(JSON.stringify({ event: 'unhandled_error', message: err?.message }));
  return json({ error: 'Internal server error.' }, 500);
}

// Read and parse a JSON body, refusing anything larger than `maxBytes`.
export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) {
    throw new HttpError(413, 'Request body too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new HttpError(413, 'Request body too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

// Mask an address for logs: "ace@example.com" -> "a***@example.com".
export function maskEmail(email) {
  const [user = '', domain = ''] = String(email).split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
