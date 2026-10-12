// Low-level X (Twitter) API v2 pieces: OAuth 1.0a signing, the post call, and
// X's own way of counting characters. No I/O beyond the injected fetch.

import { createHmac, randomBytes } from 'node:crypto';

export const X_POST_URL = 'https://api.x.com/2/tweets';

// Free accounts may post 280 "weighted" characters. Japanese and most other
// non-Latin characters weigh 2, so the practical limit is 140 of them.
export const X_MAX_WEIGHT = 280;
const URL_WEIGHT = 23;
const LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const URL_RE = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|jp|app|io|co|me|link|ly)(?:\/\S*)?/gi;

export function hasLink(text) {
  return new RegExp(URL_RE.source, 'i').test(text);
}

export function xWeight(text) {
  let weight = 0;
  const rest = text.replace(URL_RE, () => {
    weight += URL_WEIGHT;
    return '';
  });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    weight += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return weight;
}

const pe = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// OAuth 1.0a "Authorization" header. A JSON body is not part of the signature;
// `extraParams` exists only so the documented test vector can be checked.
export function oauthHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp, extraParams = {} }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const all = { ...extraParams, ...oauth };
  const paramString = Object.keys(all).map((k) => [pe(k), pe(all[k])]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const base = [method.toUpperCase(), pe(url), pe(paramString)].join('&');
  const signature = createHmac('sha1', `${pe(consumerSecret)}&${pe(tokenSecret)}`).update(base).digest('base64');
  return { header: `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pe(k)}="${pe(v)}"`).join(', ')}`, signature };
}

// One POST. Classifies the outcome for the journal:
//   published  - X returned the new post id
//   rejected   - X answered 4xx: it refused, so nothing was posted
//   unknown    - network failure, 5xx, or a 2xx without an id: it may be live
export async function postToX({ text, creds, fetchImpl }) {
  const { header } = oauthHeader({ method: 'POST', url: X_POST_URL, consumerKey: creds.apiKey, consumerSecret: creds.apiSecret, token: creds.accessToken, tokenSecret: creds.accessSecret });
  let res;
  let body = '';
  try {
    res = await fetchImpl(X_POST_URL, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    body = await res.text();
  } catch (err) {
    return { outcome: 'unknown', detail: `request failed: ${err.message}` };
  }
  if (res.status >= 400 && res.status < 500) return { outcome: 'rejected', detail: `HTTP ${res.status}: ${body}` };
  if (!res.ok) return { outcome: 'unknown', detail: `HTTP ${res.status}: ${body}` };
  let id = null;
  try {
    id = JSON.parse(body)?.data?.id ?? null;
  } catch {
    // fall through: a 2xx we cannot read may still be a live post
  }
  return id ? { outcome: 'published', id } : { outcome: 'unknown', detail: `HTTP ${res.status} without a post id: ${body}` };
}
