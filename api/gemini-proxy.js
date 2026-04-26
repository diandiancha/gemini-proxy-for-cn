import { Readable } from 'node:stream';

const UPSTREAM_ORIGIN = 'https://generativelanguage.googleapis.com';
const UPSTREAM_TIMEOUT_MS = 120000;
const ALLOWED_PATH_PREFIXES = ['/v1/', '/v1alpha/', '/v1beta/'];
const HOP_BY_HOP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'x-vercel-ip-country',
  'x-vercel-ip-country-region',
  'x-vercel-ip-city'
]);
const HOP_BY_HOP_RESP_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'content-encoding'
]);

function toSingle(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function buildUpstreamUrl(req) {
  const pathValue = toSingle(req.query?.path);
  const upstreamPath = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  const url = new URL(upstreamPath, UPSTREAM_ORIGIN);

  const original = new URL(req.url || '/', 'http://localhost');
  original.searchParams.forEach((v, k) => {
    if (k === 'path') return;
    url.searchParams.append(k, v);
  });

  return url;
}

function isAllowedPath(pathname) {
  return ALLOWED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAuthorized(req) {
  const expected = process.env.PROXY_AUTH_TOKEN || '';
  if (!expected) return true;
  const auth = toSingle(req.headers?.authorization);
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const actual = auth.slice('Bearer '.length).trim();
  return actual === expected;
}

function filterRequestHeaders(headers) {
  const out = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if (HOP_BY_HOP_REQ_HEADERS.has(lower)) continue;
    out[key] = value;
  }

  return out;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (!isAuthorized(req)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Missing or invalid proxy token'
      });
      return;
    }

    if (req.method === 'TRACE' || req.method === 'CONNECT') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const upstreamUrl = buildUpstreamUrl(req);
    if (!isAllowedPath(upstreamUrl.pathname)) {
      res.status(403).json({
        error: 'path_not_allowed',
        message: `Blocked path: ${upstreamUrl.pathname}`
      });
      return;
    }

    const headers = filterRequestHeaders(req.headers);
    const body = req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await readRequestBody(req);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        signal: abortController.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    res.status(upstreamResp.status);
    upstreamResp.headers.forEach((value, key) => {
      if (HOP_BY_HOP_RESP_HEADERS.has(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    if (!upstreamResp.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstreamResp.body).pipe(res);
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.name === 'AbortError') {
      res.status(504).json({
        error: 'upstream_timeout',
        message: `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`
      });
      return;
    }
    res.status(502).json({
      error: 'proxy_request_failed',
      message
    });
  }
}

