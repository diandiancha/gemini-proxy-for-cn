import { Readable } from 'node:stream';

const UPSTREAM_ORIGIN = 'https://generativelanguage.googleapis.com';

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

function filterRequestHeaders(headers) {
  const out = {};
  const blocked = new Set([
    'host',
    'connection',
    'content-length',
    'x-forwarded-for',
    'x-real-ip',
    'cf-connecting-ip',
    'x-vercel-ip-country',
    'x-vercel-ip-country-region',
    'x-vercel-ip-city'
  ]);

  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if (blocked.has(lower)) continue;
    out[key] = value;
  }

  return out;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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

    const upstreamUrl = buildUpstreamUrl(req);
    const headers = filterRequestHeaders(req.headers);
    const body = req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await readRequestBody(req);

    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body
    });

    res.status(upstreamResp.status);
    upstreamResp.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstreamResp.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstreamResp.body).pipe(res);
  } catch (error) {
    res.status(502).json({
      error: 'proxy_request_failed',
      message: String(error?.message || error)
    });
  }
}

