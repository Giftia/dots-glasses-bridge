import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WebhookError, isPublicAddress, sendEvent, verifyCallback } from './webhook.mjs';

const PROXY_ENDPOINT = 'http://127.0.0.1:17327';
const MAX_BYTES = 256 * 1024;
const TIMEOUT = 10000;
const fail = reason => { throw new WebhookError(reason); };

function proxyAuthorization(value) {
  // The sole approved proxy is a separately supervised, authenticated loopback
  // listener. Accept only generated URL-safe credentials, not arbitrary URLs.
  const matched = typeof value === 'string' && /^http:\/\/([A-Za-z0-9_-]{1,256}):([A-Za-z0-9_-]{16,256})@127\.0\.0\.1:17327\/?$/.exec(value);
  if (!matched) fail('invalid_proxy_configuration');
  return 'Basic ' + Buffer.from(matched[1] + ':' + matched[2], 'utf8').toString('base64');
}

function destination(options, body) {
  if (!options || !Buffer.isBuffer(body) || body.length > MAX_BYTES) fail('invalid_request');
  const { hostname, pinnedAddress, family, port, path } = options;
  if (typeof hostname !== 'string' || !hostname || /[\s\x00-\x1f\x7f\/@?#\[\]]/.test(hostname)
    || !isPublicAddress(pinnedAddress) || isIP(pinnedAddress) !== family
    || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x20\x7f]/.test(path)
    || options.rejectUnauthorized === false) fail('invalid_request');
  const host = (isIP(hostname) === 6 ? '[' + hostname + ']' : hostname) + (port === 443 ? '' : ':' + port);
  const timeout = options.timeout === undefined ? TIMEOUT : options.timeout;
  const maxBytes = options.maxBytes === undefined ? MAX_BYTES : options.maxBytes;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail('invalid_request');
  return { hostname, pinnedAddress, family, port, path, host, timeout, maxBytes };
}

export function createProxyRequest(proxyUrl, { httpsRequest = https.request, Agent = HttpsProxyAgent } = {}) {
  const authorization = proxyAuthorization(proxyUrl);
  return async (options, body) => {
    const target = destination(options, body);
    const externalSignal = options.signal;
    if (externalSignal && (typeof externalSignal.addEventListener !== 'function' || typeof externalSignal.removeEventListener !== 'function')) fail('invalid_request');
    if (externalSignal?.aborted) fail('timeout');
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let request, response, agent, timer, settled = false;
      const close = () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onAbort);
        controller.abort();
        response?.destroy();
        request?.destroy();
        agent?.destroy();
      };
      const finish = (reason, result) => {
        if (settled) return;
        settled = true;
        close();
        if (reason) reject(new WebhookError(reason));
        else resolve(result);
      };
      const onAbort = () => finish('timeout');
      timer = setTimeout(() => finish('timeout'), target.timeout);
      externalSignal?.addEventListener('abort', onAbort, { once: true });
      if (externalSignal?.aborted) { finish('timeout'); return; }
      try {
        // Do not pass credentials in the constructor URL: the dependency can log
        // that URL under DEBUG. Proxy authorization belongs only to CONNECT.
        agent = new Agent(PROXY_ENDPOINT, {
          keepAlive: false, signal: controller.signal,
          headers: () => ({ 'Proxy-Authorization': authorization })
        });
        const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([key]) => !['host', 'proxy-authorization', 'proxy-connection', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())));
        headers.Host = target.host;
        headers.Connection = 'close';
        headers['Content-Length'] = body.length;
        request = httpsRequest({
          hostname: target.pinnedAddress, port: target.port, path: target.path,
          method: 'POST', headers, family: target.family,
          // CONNECT is to the checked IP, while SNI and certificate identity
          // remain the original callback hostname. No environment proxy lookup.
          servername: isIP(target.hostname) ? undefined : target.hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, certificate) => checkServerIdentity(target.hostname, certificate),
          agent, signal: controller.signal, timeout: target.timeout
        }, incoming => {
          response = incoming;
          if (settled) { incoming.destroy(); return; }
          let size = 0;
          const chunks = [];
          incoming.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > target.maxBytes) finish('response_too_large');
            else chunks.push(chunk);
          });
          incoming.on('end', () => {
            if (!Number.isInteger(incoming.statusCode) || incoming.statusCode < 100 || incoming.statusCode > 599) { finish('invalid_response'); return; }
            finish(null, { status: incoming.statusCode, body: Buffer.concat(chunks), headers: incoming.headers });
          });
          incoming.on('aborted', () => finish('network_error'));
          incoming.on('error', () => finish('network_error'));
        });
        request.on('error', () => finish('network_error'));
        request.setTimeout(target.timeout, () => finish('timeout'));
        request.end(body);
      } catch { finish('network_error'); }
    });
  };
}

export function createProxyWebhookTransport(proxyUrl, deps = {}) {
  const request = createProxyRequest(proxyUrl, deps);
  const options = { lookup: deps.lookup, now: deps.now, request };
  return {
    verifyCallback: subscription => verifyCallback(subscription, options),
    sendEvent: (subscription, event) => sendEvent(subscription, event, options)
  };
}
