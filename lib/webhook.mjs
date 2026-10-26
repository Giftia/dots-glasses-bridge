import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 256 * 1024;
const TIMEOUT = 10000;
export class WebhookError extends Error {
  constructor(reason,diagnostics) { super(`Webhook ${reason}`); this.name = 'WebhookError'; this.reason = reason; this.code = 'CALLBACK_ENDPOINT_ERROR'; if(diagnostics)this.diagnostics=diagnostics; }
}
const fail = reason => { throw new WebhookError(reason); };

export function validateSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) fail('invalid_secret');
  const raw = secret.slice(6), key = Buffer.from(raw, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) fail('invalid_secret');
  return key;
}

export function normalizeCallbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname || url.href.length > 4096) fail('invalid_url');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.endsWith('.') || /(^|\.)(localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname) || hostname === 'metadata.google.internal') fail('non_public_address');
  return url.href;
}

function ipv4Number(address) { return address.split('.').reduce((n, part) => n * 256 + Number(part), 0); }
function in4(value, start, bits) { return Math.floor(value / 2 ** (32 - bits)) === Math.floor(ipv4Number(start) / 2 ** (32 - bits)); }
function ipv6Number(address) {
  if (address.includes('.') || address.includes('%')) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (parts.length !== 8 || parts.some(x => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.reduce((n, x) => (n << 16n) + BigInt(parseInt(x, 16)), 0n);
}
function in6(value, start, bits) { return value >> BigInt(128 - bits) === ipv6Number(start) >> BigInt(128 - bits); }
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4Number(address);
    if (address === '168.63.129.16') return false;
    return ![['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]].some(([start,bits]) => in4(n,start,bits));
  }
  if (family === 6) {
    const n = ipv6Number(address);
    // Admit global unicast only; exclude special-purpose, documentation and 6to4 ranges.
    return n !== null && in6(n,'2000::',3) && ![['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]].some(([start,bits]) => in6(n,start,bits));
  }
  return false;
}

export async function validateCallbackUrl(value, { lookup = hostname => dnsLookup(hostname, { all: true, verbatim: true }) } = {}) {
  const url = new URL(normalizeCallbackUrl(value)), hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await lookup(hostname); } catch { fail('dns_failed'); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(x => !x || !isPublicAddress(x.address) || isIP(x.address) !== x.family)) fail('non_public_address');
  return { url, hostname, pinnedAddress: addresses[0].address, family: addresses[0].family };
}

export function signHeaders(subscription, id, body, nowMs = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) fail('invalid_event_id');
  if (!Buffer.isBuffer(body)) body = Buffer.from(body, 'utf8');
  const timestamp = String(Math.floor(nowMs / 1000));
  const sign = secret => 'v1,' + createHmac('sha256', validateSecret(secret)).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const signatures = [sign(subscription.secret)];
  if (subscription.previousSecret && subscription.previousSecretExpiresAt > nowMs && subscription.previousSecret !== subscription.secret) signatures.push(sign(subscription.previousSecret));
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id };
}

function defaultRequest(options, body) {
  return new Promise((resolve, reject) => {
    const { hostname, port, path, headers, pinnedAddress, family, signal } = options;
    const request = https.request({ hostname, port, path, method: 'POST', headers, servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true, agent: false, family, signal,
      lookup: (_host, _options, callback) => callback(null, pinnedAddress, family) }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); request.destroy(); reject(new WebhookError('response_too_large')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
      response.on('error', () => reject(new WebhookError('network_error')));
    });
    request.setTimeout(TIMEOUT, () => request.destroy(new WebhookError('timeout')));
    request.on('error', error => reject(error instanceof WebhookError ? error : new WebhookError('network_error')));
    request.end(body);
  });
}

async function post(subscription, id, body, { lookup, request = defaultRequest, now = Date.now } = {}) {
  if (body.length > MAX_BYTES) fail('payload_too_large');
  validateSecret(subscription.secret);
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      (async () => {
        const destination = await validateCallbackUrl(subscription.url, { lookup });
        if (controller.signal.aborted) fail('timeout');
        const response = await request({ ...destination, port: Number(destination.url.port || 443), path: destination.url.pathname + destination.url.search,
          method: 'POST', redirect: 'error', servername: destination.hostname, rejectUnauthorized: true,
          timeout: TIMEOUT, maxBytes: MAX_BYTES, signal: controller.signal, headers: {...signHeaders(subscription, id, body, now()),'User-Agent':'DotsBridge-Webhook/0.1.0',Accept:'application/json'} }, body);
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail('invalid_response');
        const responseBody = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '', 'utf8');
        if (responseBody.length > MAX_BYTES) fail('response_too_large');
        if (response.status >= 300 && response.status < 400) fail('redirect');
        return { status: response.status, body: responseBody, contentType:String(response.headers?.['content-type']||''),server:String(response.headers?.server||'') };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(new WebhookError('timeout')); controller.abort(); }, TIMEOUT); })
    ]);
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError('network_error');
  } finally { clearTimeout(timer); }
}

export async function verifyCallback(subscription, options = {}) {
  const challenge = randomBytes(32).toString('base64url');
  const body = Buffer.from(JSON.stringify({ type: 'verification', challenge }), 'utf8');
  const response = await post(subscription, `msg_verification_${randomUUID()}`, body, options);
  const diagnostics={httpStatus:response.status,responseBytes:response.body.length,jsonBody:false,hasChallenge:false,challengeMatches:false};
  const responseText=response.body.toString('utf8');
  diagnostics.htmlResponse=/text\/html/i.test(response.contentType)||/^\s*(?:<!doctype html|<html)/i.test(responseText);
  diagnostics.cloudflareResponse=/cloudflare/i.test(response.server)||/cloudflare/i.test(responseText);
  diagnostics.browserChallenge=/challenges\.cloudflare\.com|cf-chl-|enable javascript and cookies|just a moment/i.test(responseText);
  diagnostics.accessDenied=/access denied|you have been blocked|request blocked/i.test(responseText);
  let echoed;
  try { const parsed=JSON.parse(responseText);diagnostics.jsonBody=true;echoed=parsed?.challenge;diagnostics.hasChallenge=typeof echoed==='string'; } catch { throw new WebhookError('challenge_failed',diagnostics); }
  const expected = Buffer.from(challenge), received = typeof echoed === 'string' ? Buffer.from(echoed) : Buffer.alloc(0);
  diagnostics.challengeMatches=received.length===expected.length&&timingSafeEqual(expected,received);
  if (response.status < 200 || response.status >= 300 || !diagnostics.challengeMatches) throw new WebhookError('challenge_failed',diagnostics);
  return { verified: true, status: response.status };
}

export async function sendEvent(subscription, event, options = {}) {
  const body = Buffer.from(JSON.stringify(event), 'utf8');
  const response = await post(subscription, event.eventId, body, options);
  return { accepted: response.status >= 200 && response.status < 300, status: response.status };
}
