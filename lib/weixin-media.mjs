import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HOST = 'novac2c.cdn.weixin.qq.com';
const BASE = `https://${HOST}/c2c/download`;
const MAX = 4 * 1024 * 1024;
const DEADLINE = 10000;
const DECRYPT_ERRORS = new Set(['ERR_OSSL_BAD_DECRYPT', 'ERR_OSSL_EVP_BAD_DECRYPT', 'ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'ERR_OSSL_EVP_WRONG_FINAL_BLOCK_LENGTH', 'ERR_CRYPTO_INVALID_KEYLEN', 'ERR_CRYPTO_INVALID_IV']);
export class WeixinMediaError extends Error {
  constructor(code, { httpStatus } = {}) {
    super('Weixin image ' + code); this.name = 'WeixinMediaError'; this.code = code;
    if (Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
}
const fail = code => { throw new WeixinMediaError(code); };
function publicAddress(address) {
  if (isIP(address) === 4) {
    const n = address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
    const inRange = (start, bits) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(start.split('.').reduce((value, part) => value * 256 + Number(part), 0) / 2 ** (32 - bits));
    return address !== '168.63.129.16' && ![['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]].some(([start,bits]) => inRange(start,bits));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left;
  if (parts.length !== 8) return false;
  const value = parts.reduce((n, part) => (n << 16n) + BigInt(parseInt(part,16)), 0n);
  const prefix = (hex,bits) => value >> BigInt(128-bits) === BigInt('0x'+hex.padEnd(32,'0')) >> BigInt(128-bits);
  return prefix('2',3) && ![['2001',23],['20010db8',32],['2002',16],['3fff',20]].some(([hex,bits]) => prefix(hex,bits));
}
function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) fail('unsafe_directory');
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_directory');
    if (path.dirname(current) === current) break;
  }
  const result = fs.realpathSync.native(directory);
  if (result.split(path.sep).some(part => ['.public','public','wwwroot','htdocs'].includes(part.toLowerCase()))) fail('unsafe_directory');
  if (process.platform !== 'win32' && (fs.statSync(result).mode & 0o077)) fail('unsafe_directory');
  return result;
}
function imageUrl(image) {
  if (!image || typeof image !== 'object' || !image.media || typeof image.media !== 'object') fail('invalid_image');
  let url;
  const full = image.media.full_url !== undefined;
  if (full) {
    if (typeof image.media.full_url !== 'string' || image.media.full_url.length > 8192 || /[\x00-\x20\x7f]/u.test(image.media.full_url)) fail('invalid_url');
    try { url = new URL(image.media.full_url); } catch { fail('invalid_url'); }
    // A signed full URL is opaque. Never parse/rebuild its query parameters:
    // their names, ordering, duplicate keys and encoding may be signed bytes.
    if (url.search !== image.media.full_url.slice(image.media.full_url.indexOf('?'))) fail('invalid_url');
  } else {
    const query = image.media.encrypt_query_param;
    if (typeof query !== 'string' || !query || query.length > 16384 || /[\x00-\x1f\x7f]/u.test(query)) fail('invalid_url');
    url = new URL(BASE); url.searchParams.set('encrypted_query_param', query);
  }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.hash || url.pathname !== '/c2c/download' || !url.search) fail('invalid_url');
  if (!full && ([...url.searchParams.keys()].some(key => key !== 'encrypted_query_param') || url.searchParams.getAll('encrypted_query_param').length !== 1 || !url.searchParams.get('encrypted_query_param'))) fail('invalid_url');
  return url;
}
function imageKey(image) {
  if (image.aeskey !== undefined) {
    if (typeof image.aeskey !== 'string' || !/^[0-9a-f]{32}$/iu.test(image.aeskey)) fail('invalid_key');
    return Buffer.from(image.aeskey,'hex');
  }
  const encoded = image.media.aes_key;
  if (encoded === undefined) return null;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail('invalid_key');
  const raw = Buffer.from(encoded,'base64');
  if (raw.toString('base64').replace(/=+$/u,'') !== encoded.replace(/=+$/u,'')) fail('invalid_key');
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[0-9a-f]{32}$/iu.test(raw.toString('ascii'))) return Buffer.from(raw.toString('ascii'),'hex');
  fail('invalid_key');
}
function mime(prefix) {
  if (prefix.length >= 3 && prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return 'image/jpeg';
  if (prefix.length >= 8 && prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (prefix.length >= 12 && prefix.subarray(0,4).toString('ascii') === 'RIFF' && prefix.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  fail('invalid_content');
}

/** request is a Node https.request-compatible injection. No bot credential is sent to CDN. */
export async function downloadWeixinImage(image, { directory, request = https.request, lookup = hostname => dnsLookup(hostname,{all:true,verbatim:true}), now = Date.now } = {}) {
  let targetDirectory, url, key;
  try { targetDirectory = privateDirectory(directory); url = imageUrl(image); key = imageKey(image); }
  catch (error) { if (error instanceof WeixinMediaError) throw error; fail('unsafe_directory'); }
  const started = now(), controller = new AbortController();
  let timer, transfer, rejectTransfer, incoming, outgoing, writer, descriptor, temp, identity, successful = false;
  const removeCreated = () => {
    if (!temp || !identity) return;
    try {
      const stat = fs.lstatSync(temp);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino) fs.unlinkSync(temp);
    } catch (error) { if (error.code !== 'ENOENT') fail('cleanup_failed'); }
  };
  const stop = () => { controller.abort(); if (rejectTransfer) rejectTransfer(new WeixinMediaError('timeout')); if (outgoing) outgoing.destroy(); if (incoming) incoming.destroy(); if (writer) writer.destroy(); };
  try {
    return await Promise.race([
      (async () => {
        let addresses;
        try { addresses = await lookup(HOST); } catch { fail('dns_failed'); }
        if (controller.signal.aborted || now()-started >= DEADLINE) fail('timeout');
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || isIP(item.address) !== item.family || !publicAddress(item.address))) fail('non_public_address');
        const pinned = addresses[0];
        privateDirectory(targetDirectory);
        temp = path.join(targetDirectory,'.weixin-image-'+randomBytes(16).toString('hex')+'.tmp');
        descriptor = fs.openSync(temp,'wx',0o600); identity = fs.fstatSync(descriptor);
        let plainSize = 0, cipherSize = 0, prefix = Buffer.alloc(0), mimeType;
        const digest = createHash('sha256');
        transfer = new Promise((resolve,reject) => {
          rejectTransfer = reject;
          try {
            outgoing = request({hostname:HOST,port:443,path:url.pathname+url.search,method:'GET',servername:HOST,rejectUnauthorized:true,agent:false,family:pinned.family,signal:controller.signal,
              lookup:(_hostname,_options,callback) => callback(null,pinned.address,pinned.family),headers:{Accept:'application/octet-stream, image/jpeg, image/png, image/webp','Accept-Encoding':'identity'}}, response => {
              incoming = response;
              incoming.on('error',reject);
              try {
                if (controller.signal.aborted) fail('timeout');
                if (response.statusCode >= 300 && response.statusCode < 400) fail('redirect');
                if (response.statusCode !== 200) {
                  const status = response.statusCode;
                  const code = [404,410].includes(status) ? 'media_expired' : status === 429 || status >= 500 && status <= 599 ? 'http_retryable' : status >= 400 && status <= 499 ? 'media_rejected' : 'http_error';
                  throw new WeixinMediaError(code,{httpStatus:status});
                }
                const encoding = response.headers['content-encoding'];
                if (encoding && encoding.toLowerCase() !== 'identity') fail('unsupported_encoding');
                const length = response.headers['content-length'];
                if (length !== undefined && (typeof length !== 'string' || !/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) fail('invalid_length');
                const cipherLimit = MAX + (key ? 16 : 0);
                if (length !== undefined && Number(length) > cipherLimit) fail('too_large');
                const cipherCheck = new Transform({transform(chunk,_encoding,callback) {
                  cipherSize += chunk.length;
                  callback(cipherSize > cipherLimit ? new WeixinMediaError('too_large') : null,chunk);
                },flush(callback) { callback(length !== undefined && cipherSize !== Number(length) ? new WeixinMediaError('invalid_length') : null); }});
                const plainCheck = new Transform({transform(chunk,_encoding,callback) {
                  plainSize += chunk.length;
                  if (plainSize > MAX) { callback(new WeixinMediaError('too_large')); return; }
                  if (prefix.length < 12) prefix = Buffer.concat([prefix,chunk.subarray(0,12-prefix.length)]);
                  digest.update(chunk); callback(null,chunk);
                },flush(callback) { try { mimeType = mime(prefix); callback(); } catch(error) { callback(error); } }});
                writer = fs.createWriteStream(temp,{fd:descriptor,autoClose:false,highWaterMark:65536});
                const streams = key ? [response,cipherCheck,createDecipheriv('aes-128-ecb',key,null),plainCheck,writer] : [response,cipherCheck,plainCheck,writer];
                pipeline(...streams).then(resolve,reject);
              } catch(error) { reject(error); }
            });
            outgoing.on('error',reject); outgoing.end();
          } catch(error) { reject(error); }
        });
        await transfer;
        if (controller.signal.aborted || now()-started >= DEADLINE) fail('timeout');
        fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
        successful = true;
        return {path:temp,mimeType,size:plainSize,sha256:digest.digest('hex'),cleanup:removeCreated};
      })(),
      new Promise((_,reject) => { timer = setTimeout(() => { stop(); reject(new WeixinMediaError('timeout')); },DEADLINE); }),
    ]);
  } catch(error) {
    if (error instanceof WeixinMediaError) throw error;
    if (DECRYPT_ERRORS.has(error?.code)) fail('decrypt_failed');
    fail(controller.signal.aborted ? 'timeout' : 'download_failed');
  } finally {
    clearTimeout(timer);
    if (!successful) {
      stop();
      if (transfer) { try { await transfer; } catch {} }
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} descriptor = undefined; }
      removeCreated();
    }
  }
}
