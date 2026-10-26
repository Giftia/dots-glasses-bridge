import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const HOST = 'ilinkai.weixin.qq.com';
const BASE = `https://${HOST}`;
const LIMIT = 1024 * 1024;
const STATE_LIMIT = 4 * LIMIT;
const NOTIFICATION_LIMIT = 10000;
const INBOX_LIMIT = 64;
const LEGACY_MARKERS = ['bridge.sqlite', 'credentials.json', 'pairing.json'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const hash = value => createHash('sha256').update(value).digest('hex');
const messages = {
  invalid_state_dir: '请使用独立、明确的绝对数据目录', unsafe_path: '数据目录或文件包含不安全的链接或类型',
  busy: '通道正在处理另一项操作', invalid_state: '通道数据无法安全读取，请人工检查',
  stale_lock: '通道留下了未清理的操作锁，请先人工核对，不自动抢占',
  untrusted_host: '已拒绝未知的微信服务地址', network_error: '微信网络请求失败，未输出私密响应',
  timeout: '微信请求超时，发送结果可能未确认', response_too_large: '微信响应超过大小限制',
  invalid_response: '微信响应格式不正确', unsafe_message_id: '微信消息编号格式或范围不正确',
  http_error: '微信返回非成功的 HTTP 状态', remote_rejected: '微信拒绝本次请求',
  invalid_notification: '通知编号或文本不正确', notification_conflict: '同一通知编号对应了不同内容',
  already_bound: '此目录已绑定微信用户，请勿替换接收者', storage_error: '通道数据无法安全保存',
  legacy_state_dir: '指定目录或祖先存在旧桥接数据，已拒绝共用', capacity_exceeded: '通道记录容量已满，未发起新的发送，请人工处理',
  invalid_inbox_operation: '收件操作参数不正确', inbox_conflict: '同一微信消息对应了不同内容',
};
export class WeixinError extends Error {
  constructor(code, detail = {}) {
    super(messages[code] || messages.invalid_response); this.name = 'WeixinError'; this.code = code;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {};
    this.diagnostics = {};
    if (Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) this.diagnostics.httpStatus = detail.httpStatus;
    for (const key of ['ret', 'errcode']) if (Number.isSafeInteger(detail[key]) && Math.abs(detail[key]) <= 2147483648) this.diagnostics[key] = detail[key];
    if (['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENETUNREACH','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID'].includes(detail.networkCode)) this.diagnostics.networkCode = detail.networkCode;
  }
}
const fail = code => { throw new WeixinError(code); };
function safeString(value, max = 8192) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}
const inboxErrors = ['missing_message_id', 'invalid_message_id', 'missing_message_time', 'invalid_text', 'invalid_image', 'too_many_images', 'unsupported_message', 'empty_message'];
const messageIdValid = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value) && (value.length < 20 || value <= '18446744073709551615');
const textValid = value => typeof value === 'string' && value.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
function inboxRequestId(binding, messageId) { return 'weixin-' + hash(JSON.stringify([binding.botId, binding.ownerId, messageId])); }
function pickImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.media || typeof value.media !== 'object' || Array.isArray(value.media)) throw new Error('invalid_image');
  const media = {};
  for (const [key, max] of [['encrypt_query_param', 16384], ['aes_key', 128], ['full_url', 8192]]) {
    // Optional protobuf strings may be present with their empty default.
    // Omit those values so URL/key precedence matches Tencent's downloader.
    if (value.media[key] !== undefined && value.media[key] !== '') { if (!safeString(value.media[key], max)) throw new Error('invalid_image'); media[key] = value.media[key]; }
  }
  if (value.media.encrypt_type !== undefined) { if (![0, 1].includes(value.media.encrypt_type)) throw new Error('invalid_image'); media.encrypt_type = value.media.encrypt_type; }
  if (!media.encrypt_query_param && !media.full_url) throw new Error('invalid_image');
  const image = { media };
  if (value.aeskey !== undefined && value.aeskey !== '') { if (!safeString(value.aeskey, 128)) throw new Error('invalid_image'); image.aeskey = value.aeskey; }
  return image;
}
function normalizeInboxMessage(message, binding, receivedAt, createdAt, requireTime) {
  const validId = messageIdValid(message.message_id);
  const messageId = validId ? message.message_id : 'invalid-' + hash(JSON.stringify(message));
  const entry = { messageId, requestId: validId ? inboxRequestId(binding, messageId) : null, text: '', receivedAt, createdAt };
  if (!validId) { entry.error = message.message_id === undefined ? 'missing_message_id' : 'invalid_message_id'; return entry; }
  if (requireTime && createdAt === null) { entry.error = 'missing_message_time'; return entry; }
  if (!Array.isArray(message.item_list) || !message.item_list.length) { entry.error = 'empty_message'; return entry; }
  const texts = []; let images = 0;
  for (const item of message.item_list) {
    if (item?.type === 1) {
      if (!textValid(item.text_item?.text)) { entry.error = 'invalid_text'; break; }
      texts.push(item.text_item.text);
    } else if (item?.type === 2) {
      if (++images > 1) { entry.error = 'too_many_images'; break; }
      try { entry.image = pickImage(item.image_item); } catch { entry.error = 'invalid_image'; break; }
    } else { entry.error = 'unsupported_message'; break; }
  }
  entry.text = texts.join('\n');
  if (!textValid(entry.text)) { entry.text = ''; entry.error = 'invalid_text'; }
  if (!entry.error && !entry.text.trim() && !entry.image) entry.error = 'empty_message';
  return entry;
}
export function officialBase(value) {
  let url;
  try { url = new URL(value); } catch { fail('untrusted_host'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' ||
      url.search || url.hash || !(url.hostname === HOST || url.hostname.endsWith(`.${HOST}`))) fail('untrusted_host');
  return url.origin;
}
function directoryParts(directory) {
  const root = path.parse(directory).root;
  const parts = directory.slice(root.length).split(path.sep).filter(Boolean);
  return { root, parts };
}
function assertTree(directory, create = false) {
  const { root, parts } = directoryParts(directory);
  let current = root;
  const rejectLegacy = parent => {
    for (const marker of LEGACY_MARKERS) {
      try { fs.lstatSync(path.join(parent, marker)); fail('legacy_state_dir'); }
      catch (error) { if (error.code !== 'ENOENT') { if (error instanceof WeixinError) throw error; fail('unsafe_path'); } }
    }
  };
  rejectLegacy(root);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
    } catch (error) {
      if (error.code === 'ENOENT' && create) { fs.mkdirSync(current, { mode: 0o700 }); }
      else if (error instanceof WeixinError) throw error;
      else fail('unsafe_path');
    }
    rejectLegacy(current);
  }
}
function regular(file, maxBytes) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('unsafe_path');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; if (error instanceof WeixinError) throw error; fail('unsafe_path'); }
}
function preserveMessageIds(source) {
  const parts = [];
  let copied = 0;
  let position = 0;
  while (position < source.length) {
    if (source[position] !== '"') { position++; continue; }
    const start = position++;
    let closed = false;
    while (position < source.length) {
      const character = source[position++];
      if (character === '\\') position++;
      else if (character === '"') { closed = true; break; }
    }
    if (!closed) break; // JSON.parse below reports malformed strings without exposing them.
    const end = position;
    let after = end;
    while (/[ \t\r\n]/u.test(source[after] || 'x')) after++;
    if (source[after] !== ':') continue;
    const key = JSON.parse(source.slice(start, end));
    if (!['message_id', 'ret', 'errcode'].includes(key)) continue;
    let valueStart = after + 1;
    while (/[ \t\r\n]/u.test(source[valueStart] || 'x')) valueStart++;
    if (!/[-0-9]/u.test(source[valueStart] || 'x')) continue;
    let valueEnd = valueStart;
    while (valueEnd < source.length && !/[ \t\r\n,}\]]/u.test(source[valueEnd])) valueEnd++;
    const raw = source.slice(valueStart, valueEnd);
    if (key !== 'message_id') {
      if (!/^-?(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Math.abs(Number(raw)) > 2147483648) fail('invalid_response');
      position = valueEnd;
      continue;
    }
    if (!/^(0|[1-9][0-9]*)$/u.test(raw) || raw.length > 20 ||
        (raw.length === 20 && raw > '18446744073709551615')) fail('unsafe_message_id');
    // Quote the original decimal token before JSON.parse can round it. Strings,
    // including quoted text that merely contains a similar key, are never edited.
    parts.push(source.slice(copied, valueStart), JSON.stringify(raw));
    copied = valueEnd;
    position = valueEnd;
  }
  parts.push(source.slice(copied));
  return parts.join('');
}
function parseResponse(body) {
  const bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : null;
  if (!bytes) fail('invalid_response');
  if (bytes.length > LIMIT) fail('response_too_large');
  try {
    const data = JSON.parse(preserveMessageIds(bytes.toString('utf8')), (key, value) => {
      if (key === 'message_id' && !safeString(value, 256)) fail('unsafe_message_id');
      if ((key === 'ret' || key === 'errcode') && (!Number.isSafeInteger(value) || Math.abs(value) > 2147483648)) fail('invalid_response');
      return value;
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_response');
    return data;
  } catch (error) { if (error instanceof WeixinError) throw error; fail('invalid_response'); }
}
export function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const request = https.request(options.url, { method: options.method, headers: options.headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        finish(new WeixinError('http_error', { httpStatus: response.statusCode }));
        response.destroy(); request.destroy(); return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          finish(new WeixinError('response_too_large')); response.destroy(); request.destroy(); return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new WeixinError('network_error')));
      response.on('end', () => finish(null, { statusCode: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', error => finish(new WeixinError('network_error', { networkCode: error.code })));
    timer = setTimeout(() => { finish(new WeixinError('timeout')); request.destroy(); }, options.timeoutMs);
    request.end(options.body || undefined);
  });
}

/** Request injection: async ({url,method,headers,body,timeoutMs,maxResponseBytes}) => ({statusCode,body:Buffer|string}). */
export class WeixinChannel {
  constructor({ stateDir, request = httpsRequest, now = Date.now } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('invalid_state_dir');
    this.stateDir = path.resolve(stateDir);
    if (this.stateDir === path.parse(this.stateDir).root) fail('invalid_state_dir');
    const parts = directoryParts(this.stateDir).parts.map(x => x.toLowerCase());
    if (parts.some(x => ['.public', 'qianwen-dot-bridge', 'qianwen-dot-bridge-node16', 'bridge-runtime', 'public-runtime-private'].includes(x))) fail('invalid_state_dir');
    assertTree(this.stateDir, true);
    this.stateDir = fs.realpathSync.native(this.stateDir);
    if (directoryParts(this.stateDir).parts.some(x => ['.public', 'qianwen-dot-bridge', 'qianwen-dot-bridge-node16', 'bridge-runtime', 'public-runtime-private'].includes(x.toLowerCase()))) fail('invalid_state_dir');
    this.file = path.join(this.stateDir, 'weixin-channel.json');
    this.lockFile = path.join(this.stateDir, 'weixin-channel.lock');
    this.request = request;
    this.now = now;
    this.queue = Promise.resolve();
  }
  _lock() {
    assertTree(this.stateDir);
    const nonce = randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }), 'utf8');
        fs.closeSync(fd);
        return nonce;
      } catch (error) {
        if (error.code !== 'EEXIST') fail('storage_error');
        regular(this.lockFile, 1024);
        let previous;
        try { previous = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { fail('busy'); }
        if (!Number.isInteger(previous.pid) || previous.pid < 1) fail('busy');
        try { process.kill(previous.pid, 0); fail('busy'); }
        catch (probe) { if (probe.code !== 'ESRCH') fail('busy'); }
        fail('stale_lock');
      }
    }
    fail('busy');
  }
  _load() {
    assertTree(this.stateDir);
    if (!regular(this.file, STATE_LIMIT)) return { version: 1, binding: null, login: null, context: null, cursor: '', seenOwnerIds: [], notifications: {}, inbox: [] };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !data.notifications || typeof data.notifications !== 'object' || Array.isArray(data.notifications) ||
          !Array.isArray(data.seenOwnerIds) || data.seenOwnerIds.length > 256 || !data.seenOwnerIds.every(x => safeString(x, 256)) ||
          typeof data.cursor !== 'string' || data.cursor.length > 131072 || Object.keys(data.notifications).length > NOTIFICATION_LIMIT) fail('invalid_state');
      if (data.binding) {
        officialBase(data.binding.baseUrl);
        if (!safeString(data.binding.token) || !safeString(data.binding.ownerId, 512) || !safeString(data.binding.botId, 512)) fail('invalid_state');
      }
      if (data.context && (!data.binding || !safeString(data.context.token, 32768) || !Number.isFinite(data.context.receivedAt) || !safeString(data.context.messageId, 256))) fail('invalid_state');
      if (data.login && (!safeString(data.login.code) || !safeString(data.login.content, 32768) || !Number.isFinite(data.login.expiresAt))) fail('invalid_state');
      if (data.login) officialBase(data.login.pollBase);
      if (data.inbox === undefined) data.inbox = [];
      if (!Array.isArray(data.inbox) || data.inbox.length > INBOX_LIMIT || data.inbox.length && !data.binding) fail('invalid_state');
      const inboxIds = new Set();
      for (const entry of data.inbox) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !safeString(entry.messageId, 256) || inboxIds.has(entry.messageId) ||
            !textValid(entry.text) || !Number.isFinite(entry.receivedAt) || !(entry.createdAt === null || Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0) ||
            (entry.error !== undefined && !inboxErrors.includes(entry.error)) ||
            Object.keys(entry).some(key => !['messageId', 'requestId', 'text', 'image', 'receivedAt', 'createdAt', 'error'].includes(key))) fail('invalid_state');
        if (messageIdValid(entry.messageId)) {
          if (entry.requestId !== inboxRequestId(data.binding, entry.messageId)) fail('invalid_state');
        } else if (!/^invalid-[a-f0-9]{64}$/u.test(entry.messageId) || entry.requestId !== null || !['missing_message_id', 'invalid_message_id'].includes(entry.error)) fail('invalid_state');
        if (entry.image !== undefined) { try { if (JSON.stringify(pickImage(entry.image)) !== JSON.stringify(entry.image)) fail('invalid_state'); } catch { fail('invalid_state'); } }
        inboxIds.add(entry.messageId);
      }
      for (const [id, record] of Object.entries(data.notifications)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id) || !record || !['sending', 'accepted', 'unknown', 'rejected'].includes(record.state) ||
            !/^[a-f0-9]{64}$/u.test(record.textHash) || !/^xdn-[a-f0-9]{32}$/u.test(record.clientId) ||
            !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
            (record.reason !== undefined && record.reason !== 'interrupted' && !own(messages, record.reason)) ||
            (record.acceptedAt !== undefined && !Number.isFinite(record.acceptedAt))) fail('invalid_state');
        if (record.diagnostics !== undefined) {
          if (!record.diagnostics || typeof record.diagnostics !== 'object' || Array.isArray(record.diagnostics)) fail('invalid_state');
          const safe = new WeixinError('http_error', record.diagnostics).diagnostics;
          if (Object.keys(record.diagnostics).some(key => !own(safe,key) || safe[key] !== record.diagnostics[key])) fail('invalid_state');
        }
        if (record.state === 'sending') { record.state = 'unknown'; record.reason = 'interrupted'; record.updatedAt = this.now(); }
      }
      return data;
    } catch (error) { if (error instanceof WeixinError) throw error; fail('invalid_state'); }
  }
  _save(data) {
    let serialized;
    try { serialized = JSON.stringify(data); } catch { fail('storage_error'); }
    if (Buffer.byteLength(serialized, 'utf8') > STATE_LIMIT || Object.keys(data.notifications).length > NOTIFICATION_LIMIT || (data.inbox || []).length > INBOX_LIMIT) fail('capacity_exceeded');
    assertTree(this.stateDir);
    regular(this.file, STATE_LIMIT);
    const temporary = path.join(this.stateDir, `.weixin-${randomBytes(12).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch { if (fd !== undefined) fs.closeSync(fd); fail('storage_error'); }
  }
  _run(operation) {
    const job = this.queue.then(async () => {
      const nonce = this._lock();
      try {
        const data = this._load();
        this._save(data); // Also commit recovery of interrupted sends before any network request.
        return await operation(data);
      } finally {
        if (regular(this.lockFile, 1024)) {
          let lock;
          try { lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { lock = {}; }
          if (lock.nonce === nonce) fs.unlinkSync(this.lockFile);
        }
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  _headers(token, post) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' };
    if (post) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64') });
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  _baseInfo() { return { channel_version: '2.4.10', bot_agent: 'DotsGlassesBridge/0.1.0' }; }
  async _call(base, endpoint, { body, token, timeoutMs = 15000 } = {}) {
    const origin = officialBase(base);
    const url = new URL(endpoint, `${origin}/`);
    if (url.origin !== origin || !url.pathname.startsWith('/ilink/bot/')) fail('untrusted_host');
    const post = body !== undefined;
    let timer;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => this.request({ url: url.href, method: post ? 'POST' : 'GET',
          headers: this._headers(token, post), body: post ? JSON.stringify(body) : null,
          timeoutMs: Math.min(timeoutMs, 40000), maxResponseBytes: LIMIT })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new WeixinError('timeout')), Math.min(timeoutMs, 40000)); }),
      ]);
      if (!response || !Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) throw new WeixinError('http_error', { httpStatus: response?.statusCode });
      const result = parseResponse(response.body);
      if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) throw new WeixinError('remote_rejected', { ret: result.ret, errcode: result.errcode });
      return result;
    } catch (error) { if (error instanceof WeixinError) throw error; throw new WeixinError('network_error', { networkCode: error.code }); }
    finally { clearTimeout(timer); }
  }
  _summary(data) {
    const counts = {};
    for (const record of Object.values(data.notifications)) counts[record.state] = (counts[record.state] || 0) + 1;
    return { state: data.binding ? (data.context ? 'ready' : 'waiting_for_owner_context') :
      data.login ? (this.now() >= data.login.expiresAt ? 'login_expired' : 'waiting_for_scan') : 'not_bound',
    ownerBound: Boolean(data.binding), contextReady: Boolean(data.binding && data.context),
    contextUpdatedAt: data.context?.receivedAt ?? null, notifications: counts, pendingCount: (data.inbox || []).length,
    inboxErrorCount: (data.inbox || []).filter(item => item.error).length };
  }
  status() { return this._run(async data => this._summary(data)); }
  beginLogin({ allowNew = true, forceRefresh = false, beforeNew, prepareNew } = {}) {
    return this._run(async data => {
      if (data.binding) fail('already_bound');
      if (!data.login || this.now() >= data.login.expiresAt || (forceRefresh === true && allowNew === true)) {
        if (allowNew !== true) return { state: data.login ? 'login_expired' : 'not_started' };
        if (beforeNew && await beforeNew(data.login) !== true) return { state: 'login_request_not_repeated' };
        const qr = await this._call(BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
        if (!safeString(qr.qrcode) || !safeString(qr.qrcode_img_content, 32768)) fail('invalid_response');
        const login = { code: qr.qrcode, content: qr.qrcode_img_content, pollBase: BASE, expiresAt: this.now() + 300000 };
        if (prepareNew) await prepareNew({state:'waiting_for_scan',qrCode:login.code,qrContent:login.content,expiresAt:login.expiresAt}, data.login);
        data.login = login;
        this._save(data);
      }
      return { state: 'waiting_for_scan', qrCode: data.login.code, qrContent: data.login.content, expiresAt: data.login.expiresAt };
    });
  }
  pollLogin() {
    return this._run(async data => {
      if (data.binding) return this._summary(data);
      if (!data.login) return { state: 'not_started' };
      // The local display wait limit is not proof that a scanned QR was rejected.
      // An explicit check asks the official endpoint once; it never refreshes here.
      const result = await this._call(data.login.pollBase, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(data.login.code)}`, { timeoutMs: 35000 });
      if (result.status === 'scaned_but_redirect') {
        if (!safeString(result.redirect_host, 253) || /[\\/@?#]/u.test(result.redirect_host)) fail('untrusted_host');
        data.login.pollBase = officialBase(`https://${result.redirect_host}`);
        this._save(data);
        return { state: 'waiting_for_scan' };
      }
      if (result.status === 'confirmed') {
        if (!safeString(result.bot_token) || !safeString(result.ilink_bot_id, 512) || !safeString(result.ilink_user_id, 512)) fail('invalid_response');
        const baseUrl = officialBase(result.baseurl || data.login.pollBase);
        data.binding = { token: result.bot_token, botId: result.ilink_bot_id, ownerId: result.ilink_user_id, baseUrl };
        data.login = null; data.context = null; data.cursor = ''; data.seenOwnerIds = []; data.inbox = [];
        this._save(data);
        return this._summary(data);
      }
      if (['need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) return { state: 'user_intervention_required', reason: result.status };
      if (result.status === 'expired') { data.login.expiresAt = this.now(); this._save(data); return { state: 'login_expired' }; }
      if (['wait', 'scaned'].includes(result.status)) return { state: 'waiting_for_scan' };
      fail('invalid_response');
    });
  }
  pollOwnerContext() {
    return this._run(async data => {
      if (!data.binding) return this._summary(data);
      const result = await this._call(data.binding.baseUrl, 'ilink/bot/getupdates', { token: data.binding.token, timeoutMs: 35000,
        body: { get_updates_buf: data.cursor, base_info: this._baseInfo() } });
      if (!Array.isArray(result.msgs)) fail('invalid_response');
      for (const message of result.msgs) {
        if (!message || message.from_user_id !== data.binding.ownerId || message.message_type !== 1 ||
            (message.to_user_id && message.to_user_id !== data.binding.botId) || !Array.isArray(message.item_list)) continue;
        const isText = message.item_list.some(item => item?.type === 1 && typeof item.text_item?.text === 'string' && item.text_item.text.trim());
        if (!isText || !safeString(message.context_token, 32768)) continue;
        const id = safeString(message.message_id, 256) ? message.message_id : Number.isSafeInteger(message.message_id) ? String(message.message_id) : hash(message.context_token);
        if (data.seenOwnerIds.includes(id)) continue;
        data.context = { token: message.context_token, receivedAt: this.now(), messageId: id };
        data.seenOwnerIds = [...data.seenOwnerIds, id].slice(-256);
      }
      if (result.get_updates_buf !== undefined) {
        if (typeof result.get_updates_buf !== 'string' || result.get_updates_buf.length > 131072) fail('invalid_response');
        if (result.get_updates_buf) data.cursor = result.get_updates_buf;
      }
      this._save(data);
      return this._summary(data);
    });
  }
  pollOwnerMessages({ notBeforeMs = 0 } = {}) {
    if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < 0) return Promise.reject(new WeixinError('invalid_inbox_operation'));
    return this._run(async data => {
      if (!data.binding) return { state: 'not_bound', pendingCount: 0, skippedHistoricalCount: 0 };
      if (data.inbox.length >= INBOX_LIMIT) return { state: 'inbox_full', pendingCount: data.inbox.length, skippedHistoricalCount: 0 };
      const result = await this._call(data.binding.baseUrl, 'ilink/bot/getupdates', { token: data.binding.token, timeoutMs: 35000,
        body: { get_updates_buf: data.cursor, base_info: this._baseInfo() } });
      if (result.msgs !== undefined && !Array.isArray(result.msgs) || result.get_updates_buf !== undefined && (typeof result.get_updates_buf !== 'string' || result.get_updates_buf.length > 131072)) fail('invalid_response');
      let skippedHistoricalCount = 0;
      for (const message of result.msgs || []) {
        if (!message || message.from_user_id !== data.binding.ownerId || message.message_type !== 1 || message.group_id ||
            (message.to_user_id && message.to_user_id !== data.binding.botId)) continue;
        const createdAt = Number.isSafeInteger(message.create_time_ms) && message.create_time_ms >= 0 ? message.create_time_ms : null;
        const validId = messageIdValid(message.message_id);
        if (validId && safeString(message.context_token, 32768)) data.context = { token: message.context_token, receivedAt: this.now(), messageId: message.message_id };
        if (createdAt !== null && createdAt < notBeforeMs) { skippedHistoricalCount++; continue; }
        const entry = normalizeInboxMessage(message, data.binding, this.now(), createdAt, notBeforeMs > 0);
        const old = data.inbox.find(item => item.messageId === entry.messageId);
        if (old) {
          const identity = item => JSON.stringify([item.requestId, item.text, item.image || null, item.createdAt, item.error || null]);
          if (identity(old) !== identity(entry)) fail('inbox_conflict');
          continue;
        }
        if (data.seenOwnerIds.includes(entry.messageId)) continue;
        if (data.inbox.length >= INBOX_LIMIT) fail('capacity_exceeded');
        data.inbox.push(entry);
        data.seenOwnerIds = [...data.seenOwnerIds, entry.messageId].slice(-256);
      }
      if (result.get_updates_buf) data.cursor = result.get_updates_buf;
      // Inbox and cursor are one durable state replacement. A failed commit
      // leaves the preceding cursor available for replay, never a cursor-only ACK.
      this._save(data);
      return { state: data.inbox.length ? 'pending' : 'idle', pendingCount: data.inbox.length, skippedHistoricalCount };
    });
  }
  peekOwnerMessages({ limit = 1 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > INBOX_LIMIT) return Promise.reject(new WeixinError('invalid_inbox_operation'));
    return this._run(async data => JSON.parse(JSON.stringify(data.inbox.slice(0, limit))));
  }
  ackOwnerMessage({ messageId } = {}) {
    if (!safeString(messageId, 256)) return Promise.reject(new WeixinError('invalid_inbox_operation'));
    return this._run(async data => {
      const index = data.inbox.findIndex(item => item.messageId === messageId);
      if (index < 0) return { state: 'not_pending', pendingCount: data.inbox.length };
      data.inbox.splice(index, 1);
      if (!data.seenOwnerIds.includes(messageId)) data.seenOwnerIds = [...data.seenOwnerIds, messageId].slice(-256);
      this._save(data);
      return { state: 'acknowledged', pendingCount: data.inbox.length };
    });
  }
  sendNotification({ notificationId, text } = {}) {
    return this._run(async data => {
      if (typeof notificationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(notificationId) || typeof text !== 'string' || !text.trim() || text.length > 4000) fail('invalid_notification');
      const digest = hash(text);
      if (own(data.notifications, notificationId)) {
        const previous = data.notifications[notificationId];
        if (previous.textHash !== digest) fail('notification_conflict');
        return this._receipt(notificationId, previous);
      }
      if (!data.binding || !data.context) return { notificationId, state: 'waiting_for_owner_context' };
      const record = { state: 'sending', textHash: digest, clientId: `xdn-${randomBytes(16).toString('hex')}`, createdAt: this.now(), updatedAt: this.now() };
      data.notifications[notificationId] = record;
      this._save(data);
      try {
        await this._call(data.binding.baseUrl, 'ilink/bot/sendmessage', { token: data.binding.token, body: {
          msg: { from_user_id: '', to_user_id: data.binding.ownerId, client_id: record.clientId, message_type: 2, message_state: 2,
            context_token: data.context.token, item_list: [{ type: 1, text_item: { text } }] }, base_info: this._baseInfo() } });
        // Tencent makes ret optional. _call already validates HTTP, JSON and
        // every present ret/errcode; absence is not an unknown delivery result.
        record.state = 'accepted'; record.acceptedAt = this.now();
      } catch (error) { record.state = error.code === 'remote_rejected' ? 'rejected' : 'unknown'; record.reason = error.code || 'network_error'; if (error instanceof WeixinError && Object.keys(error.diagnostics).length) record.diagnostics = error.diagnostics; }
      record.updatedAt = this.now();
      this._save(data);
      return this._receipt(notificationId, record);
    });
  }
  _receipt(notificationId, record) {
    return { notificationId, state: record.state, ...(record.acceptedAt !== undefined ? { acceptedAt: record.acceptedAt } : {}), ...(record.reason ? { reason: record.reason } : {}), ...(record.diagnostics ? { diagnostics: record.diagnostics } : {}) };
  }
}
