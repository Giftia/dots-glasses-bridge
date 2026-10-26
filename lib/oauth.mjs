import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Exact stable identity and redirect verified against the public CIMD and OpenAI's
// authentication guide. No remote client lookup or dynamic registration occurs here.
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const SCOPES = Object.freeze(['glasses:read', 'glasses:reply', 'glasses:notify', 'events:subscribe', 'messages:read', 'messages:reply']);
export const CHATGPT_CLIENT_METADATA = Object.freeze({
  client_id: CHATGPT_CLIENT_ID, client_name: 'ChatGPT',
  redirect_uris: Object.freeze([CHATGPT_REDIRECT_URI]),
  token_endpoint_auth_methods_supported: Object.freeze(['none', 'private_key_jwt']),
  grant_types: Object.freeze(['authorization_code', 'refresh_token']), response_types: Object.freeze(['code'])
});

export class OAuthError extends Error {
  constructor(error, status = 400, message = 'OAuth request rejected') {
    super(message); this.name = 'OAuthError'; this.error = error; this.code = error; this.status = status;
  }
}
const fail = (error, status, message) => new OAuthError(error, status, message);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const safeEqual = (a, b) => {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function hashOwnerCode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(code)) throw fail('invalid_request', 400, 'Invalid owner pairing code format');
  return digest(code);
}
function parameters(input) {
  const result = Object.create(null);
  const entries = input instanceof URLSearchParams ? [...input.entries()] : isObject(input) ? Object.entries(input) : null;
  if (!entries || entries.length > 32) throw fail('invalid_request', 400, 'Invalid OAuth parameters');
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key) || typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw fail('invalid_request', 400, 'Invalid or repeated OAuth parameter');
    result[key] = value;
  }
  return result;
}
function scopes(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw fail('invalid_scope', 400, 'Unsupported scopes');
  const requested = [...new Set(value.split(' ').filter(Boolean))];
  if (requested.some(scope => !SCOPES.includes(scope))) throw fail('invalid_scope', 400, 'Unsupported scopes');
  return SCOPES.filter(scope => requested.includes(scope));
}
function exactHttps(value, name) {
  let url;
  try { url = new URL(value); } catch { throw fail('server_error', 500, `Invalid ${name} configuration`); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value) throw fail('server_error', 500, `Invalid ${name} configuration`);
  return value;
}
function checkClient(metadata) {
  if (!isObject(metadata) || metadata.client_id !== CHATGPT_CLIENT_ID || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length !== 1 || metadata.redirect_uris[0] !== CHATGPT_REDIRECT_URI || !Array.isArray(metadata.token_endpoint_auth_methods_supported) || !metadata.token_endpoint_auth_methods_supported.includes('none') || !Array.isArray(metadata.grant_types) || !metadata.grant_types.includes('authorization_code') || !metadata.grant_types.includes('refresh_token') || !Array.isArray(metadata.response_types) || !metadata.response_types.includes('code')) throw fail('server_error', 500, 'Unsupported predefined ChatGPT client metadata');
  return { client_id: CHATGPT_CLIENT_ID, client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT_URI] };
}

/** Single-process prototype. loadState/saveState must be synchronous; saveState
 * must atomically replace its dedicated JSON file. Never share the legacy DB.
 * Callers must send no-store responses and bind sessionToken only to an HTTPS,
 * HttpOnly, SameSite cookie; never expose that token as a form field or URL.
 */
export class OAuthServer {
  constructor({ publicBaseUrl, resource, clientMetadata = CHATGPT_CLIENT_METADATA, ownerCodeHash,
    loadState = () => null, saveState, now = Date.now, authorizationEndpoint, tokenEndpoint, revocationEndpoint,
    interactionTtlMs = 600000, codeTtlMs = 300000, accessTtlMs = 900000, refreshTtlMs = 2592000000 } = {}) {
    this.issuer = exactHttps(publicBaseUrl, 'publicBaseUrl');
    if (this.issuer.endsWith('/')) throw fail('server_error', 500, 'Issuer must not end with a slash');
    this.resource = exactHttps(resource, 'resource');
    const issuerUrl = new URL(this.issuer), resourceUrl = new URL(this.resource);
    const withinIssuer = url => url.origin === issuerUrl.origin && (url.pathname === issuerUrl.pathname || url.pathname.startsWith(issuerUrl.pathname + '/'));
    if (!withinIssuer(resourceUrl)) throw fail('server_error', 500, 'Resource must belong to this issuer');
    this.endpoints = {
      authorization_endpoint: exactHttps(authorizationEndpoint || this.issuer + '/authorize', 'authorization endpoint'),
      token_endpoint: exactHttps(tokenEndpoint || this.issuer + '/token', 'token endpoint'),
      revocation_endpoint: exactHttps(revocationEndpoint || this.issuer + '/revoke', 'revocation endpoint')
    };
    if (Object.values(this.endpoints).some(value => !withinIssuer(new URL(value)))) throw fail('server_error', 500, 'OAuth endpoints must belong to this issuer');
    if (!hashPattern.test(ownerCodeHash || '') || typeof saveState !== 'function' || typeof loadState !== 'function' || typeof now !== 'function') throw fail('server_error', 500, 'OAuth persistence and owner configuration required');
    this.client = checkClient(clientMetadata); this.ownerCodeHash = ownerCodeHash;
    this.saveState = saveState; this.now = now; this.failed = false;
    this.ttl = { interactionTtlMs, codeTtlMs, accessTtlMs, refreshTtlMs };
    for (const [key, maximum] of Object.entries({ interactionTtlMs: 600000, codeTtlMs: 300000, accessTtlMs: 3600000, refreshTtlMs: 2592000000 })) {
      if (!integer(this.ttl[key]) || this.ttl[key] < 1000 || this.ttl[key] > maximum) throw fail('server_error', 500, 'Invalid OAuth lifetime configuration');
    }
    this.fingerprint = digest(JSON.stringify({ issuer: this.issuer, resource: this.resource, client: this.client, ownerCodeHash }));
    let loaded;
    try { loaded = loadState(); } catch { throw fail('server_error', 503, 'OAuth state could not be loaded'); }
    if (loaded && typeof loaded.then === 'function') throw fail('server_error', 500, 'OAuth persistence must be synchronous');
    if (loaded !== null && loaded !== undefined) {
      this.validateState(loaded); this.state = clone(loaded);
    } else {
      this.state = { version: 1, fingerprint: this.fingerprint, interactions: {}, codes: {}, families: {}, access: {}, refresh: {}, ownerFailures: [] };
      this.commit(this.state);
    }
  }
  clock() {
    if (this.failed) throw fail('server_error', 503, 'OAuth storage unavailable; restart after inspection');
    const now = this.now();
    if (!integer(now)) throw fail('server_error', 500, 'Invalid OAuth clock');
    return now;
  }
  validateState(state) {
    const invalid = () => { throw fail('server_error', 503, 'OAuth state is invalid or belongs to another installation'); };
    if (!isObject(state) || state.version !== 1 || state.fingerprint !== this.fingerprint || !['interactions', 'codes', 'families', 'access', 'refresh'].every(key => isObject(state[key])) || !Array.isArray(state.ownerFailures) || state.ownerFailures.length > 10 || state.ownerFailures.some(value => !integer(value))) invalid();
    const validScopes = value => Array.isArray(value) && value.every(scope => SCOPES.includes(scope)) && new Set(value).size === value.length;
    const bound = row => isObject(row) && row.clientId === CHATGPT_CLIENT_ID && row.resource === this.resource && validScopes(row.scopes);
    for (const [id, row] of Object.entries(state.interactions)) if (!hashPattern.test(id) || !bound(row) || row.redirectUri !== CHATGPT_REDIRECT_URI || !hashPattern.test(row.sessionHash || '') || !hashPattern.test(row.csrfHash || '') || !opaquePattern.test(row.challenge || '') || typeof row.oauthState !== 'string' || row.oauthState.length > 2048 || !integer(row.expiresAt) || !integer(row.attempts) || row.attempts > 5) invalid();
    for (const [id, row] of Object.entries(state.codes)) if (!hashPattern.test(id) || !bound(row) || row.redirectUri !== CHATGPT_REDIRECT_URI || !opaquePattern.test(row.challenge || '') || !opaquePattern.test(row.familyId || '') || !integer(row.expiresAt) || (row.usedAt !== null && !integer(row.usedAt))) invalid();
    for (const [id, row] of Object.entries(state.families)) if (!opaquePattern.test(id) || !bound(row) || !integer(row.expiresAt) || (row.revokedAt !== null && !integer(row.revokedAt))) invalid();
    for (const key of ['access', 'refresh']) for (const [id, row] of Object.entries(state[key])) if (!hashPattern.test(id) || !isObject(row) || !state.families[row.familyId] || !integer(row.expiresAt) || row.expiresAt > state.families[row.familyId].expiresAt || !validScopes(row.scopes) || row.scopes.some(scope => !state.families[row.familyId].scopes.includes(scope)) || (key === 'refresh' && row.usedAt !== null && !integer(row.usedAt))) invalid();
  }
  commit(next) {
    try {
      const result = this.saveState(clone(next));
      if (result && typeof result.then === 'function') throw new Error('asynchronous persistence');
      this.state = next;
    } catch {
      this.failed = true;
      throw fail('server_error', 503, 'OAuth state could not be saved');
    }
  }
  draft(now) {
    const next = clone(this.state);
    for (const key of ['interactions', 'codes']) for (const [id, row] of Object.entries(next[key])) if (row.expiresAt <= now) delete next[key][id];
    for (const [id, row] of Object.entries(next.families)) if (row.expiresAt <= now) delete next.families[id];
    for (const key of ['access', 'refresh']) for (const [id, row] of Object.entries(next[key])) if (!next.families[row.familyId] || (key === 'access' && row.expiresAt <= now)) delete next[key][id];
    next.ownerFailures = next.ownerFailures.filter(time => time > now - 900000);
    return next;
  }
  authorizationMetadata() {
    return { issuer: this.issuer, ...this.endpoints, authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'], response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES] };
  }
  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'] };
  }
  verifyOwnerCode(pairingCode) {
    return typeof pairingCode === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(pairingCode) && safeEqual(digest(pairingCode), this.ownerCodeHash);
  }
  clientId(value) {
    if (value !== CHATGPT_CLIENT_ID) throw fail('invalid_client', 400, 'Unsupported OAuth client');
  }
  target(value, required = true) {
    if ((required || value !== undefined) && value !== this.resource) throw fail('invalid_target', 400, 'Unexpected OAuth resource');
  }
  beginAuthorization(input) {
    const now = this.clock(), params = parameters(input);
    this.clientId(params.client_id); this.target(params.resource);
    if (params.redirect_uri !== CHATGPT_REDIRECT_URI) throw fail('invalid_request', 400, 'Redirect URI is not registered');
    if (params.response_type !== 'code' || (params.response_mode !== undefined && params.response_mode !== 'query')) throw fail('unsupported_response_type', 400, 'Only authorization code query responses are supported');
    if (params.code_challenge_method !== 'S256' || !opaquePattern.test(params.code_challenge || '') || Buffer.from(params.code_challenge, 'base64url').length !== 32 || Buffer.from(params.code_challenge, 'base64url').toString('base64url') !== params.code_challenge) throw fail('invalid_request', 400, 'PKCE S256 is required');
    if (!params.state || params.state.length > 2048) throw fail('invalid_request', 400, 'OAuth state is required');
    const requested = scopes(params.scope), next = this.draft(now);
    if (Object.keys(next.interactions).length >= 128 || Object.keys(next.codes).length >= 256) throw fail('temporarily_unavailable', 503, 'Too many pending authorization requests');
    const interactionId = opaque(), sessionToken = opaque(), csrfToken = opaque();
    const row = { clientId: params.client_id, redirectUri: params.redirect_uri, resource: params.resource, scopes: requested,
      challenge: params.code_challenge, oauthState: params.state, sessionHash: digest(sessionToken), csrfHash: digest(csrfToken), expiresAt: now + this.ttl.interactionTtlMs, attempts: 0 };
    next.interactions[digest(interactionId)] = row; this.commit(next);
    return { interactionId, sessionToken, csrfToken, clientName: this.client.client_name, redirectUri: row.redirectUri, resource: row.resource, scopes: [...requested], expiresAt: row.expiresAt };
  }
  completeAuthorization({ interactionId, sessionToken, csrfToken, pairingCode, approved } = {}) {
    const now = this.clock();
    if (![interactionId, sessionToken, csrfToken].every(value => typeof value === 'string' && opaquePattern.test(value))) throw fail('invalid_request', 400, 'Invalid authorization interaction');
    const next = this.draft(now), id = digest(interactionId), row = next.interactions[id];
    if (!row || !safeEqual(row.sessionHash, digest(sessionToken)) || !safeEqual(row.csrfHash, digest(csrfToken))) throw fail('invalid_request', 400, 'Authorization interaction expired or mismatched');
    if (typeof approved !== 'boolean') throw fail('invalid_request', 400, 'Explicit authorization consent required');
    const redirect = new URL(row.redirectUri);
    redirect.searchParams.set('state', row.oauthState); redirect.searchParams.set('iss', this.issuer);
    if (!approved) {
      delete next.interactions[id]; this.commit(next); redirect.searchParams.set('error', 'access_denied');
      return { redirectUrl: redirect.href };
    }
    if (next.ownerFailures.length >= 10) throw fail('access_denied', 429, 'Owner authorization temporarily locked');
    if (!this.verifyOwnerCode(pairingCode)) {
      row.attempts++; next.ownerFailures.push(now);
      if (row.attempts >= 5) delete next.interactions[id];
      this.commit(next); throw fail('access_denied', 403, 'Owner pairing code rejected');
    }
    if (Object.keys(next.families).length >= 64) throw fail('temporarily_unavailable', 503, 'Authorization capacity reached');
    const code = opaque();
    next.codes[digest(code)] = { clientId: row.clientId, redirectUri: row.redirectUri, resource: row.resource, scopes: row.scopes,
      challenge: row.challenge, familyId: opaque(), expiresAt: now + this.ttl.codeTtlMs, usedAt: null };
    delete next.interactions[id]; next.ownerFailures = []; this.commit(next);
    redirect.searchParams.set('code', code); return { redirectUrl: redirect.href };
  }
  issue(next, familyId, grantedScopes, now) {
    const family = next.families[familyId];
    const accessToken = opaque(), refreshToken = opaque(), expiresAt = Math.min(now + this.ttl.accessTtlMs, family.expiresAt);
    next.access[digest(accessToken)] = { familyId, scopes: [...grantedScopes], expiresAt };
    next.refresh[digest(refreshToken)] = { familyId, scopes: [...grantedScopes], expiresAt: family.expiresAt, usedAt: null };
    return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.floor((expiresAt - now) / 1000), refresh_token: refreshToken, scope: grantedScopes.join(' ') };
  }
  token(input) {
    const now = this.clock(), params = parameters(input);
    this.clientId(params.client_id);
    if (['client_secret', 'client_assertion', 'client_assertion_type'].some(key => Object.prototype.hasOwnProperty.call(params, key))) throw fail('invalid_client', 400, 'Only public-client PKCE authentication is supported');
    if (params.grant_type !== 'authorization_code' && params.grant_type !== 'refresh_token') throw fail('unsupported_grant_type', 400, 'Unsupported OAuth grant');
    this.target(params.resource, params.grant_type === 'authorization_code');
    const next = this.draft(now);
    if (params.grant_type === 'authorization_code') {
      if (typeof params.code !== 'string' || !opaquePattern.test(params.code)) throw fail('invalid_grant', 400, 'Authorization code rejected');
      const row = next.codes[digest(params.code)];
      if (!row) throw fail('invalid_grant', 400, 'Authorization code rejected');
      if (row.usedAt !== null) {
        if (next.families[row.familyId]) next.families[row.familyId].revokedAt = now;
        this.commit(next); throw fail('invalid_grant', 400, 'Authorization code was already used');
      }
      row.usedAt = now;
      const validVerifier = typeof params.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier);
      const challenge = validVerifier ? createHash('sha256').update(params.code_verifier, 'ascii').digest('base64url') : '';
      if (params.redirect_uri !== row.redirectUri || !validVerifier || !safeEqual(challenge, row.challenge)) {
        this.commit(next); throw fail('invalid_grant', 400, 'Authorization code binding rejected');
      }
      next.families[row.familyId] = { clientId: row.clientId, resource: row.resource, scopes: row.scopes, expiresAt: now + this.ttl.refreshTtlMs, revokedAt: null };
      const result = this.issue(next, row.familyId, row.scopes, now); this.commit(next); return result;
    }
    if (typeof params.refresh_token !== 'string' || !opaquePattern.test(params.refresh_token)) throw fail('invalid_grant', 400, 'Refresh token rejected');
    const row = next.refresh[digest(params.refresh_token)], family = row && next.families[row.familyId];
    if (!row || !family || family.revokedAt !== null || row.expiresAt <= now) throw fail('invalid_grant', 400, 'Refresh token rejected');
    if (row.usedAt !== null) {
      family.revokedAt = now; this.commit(next); throw fail('invalid_grant', 400, 'Refresh token replay detected');
    }
    const granted = params.scope === undefined ? row.scopes : scopes(params.scope);
    if (granted.some(scope => !row.scopes.includes(scope))) throw fail('invalid_scope', 400, 'Refresh cannot expand scopes');
    row.usedAt = now;
    const result = this.issue(next, row.familyId, granted, now); this.commit(next); return result;
  }
  authenticate(accessToken, requiredScopes = []) {
    const now = this.clock();
    if (typeof accessToken !== 'string' || !opaquePattern.test(accessToken)) throw fail('invalid_token', 401, 'Access token rejected');
    const row = this.state.access[digest(accessToken)], family = row && this.state.families[row.familyId];
    if (!row || !family || family.revokedAt !== null || row.expiresAt <= now || family.expiresAt <= now || family.resource !== this.resource || family.clientId !== CHATGPT_CLIENT_ID) throw fail('invalid_token', 401, 'Access token rejected');
    if (!Array.isArray(requiredScopes) || requiredScopes.some(scope => !row.scopes.includes(scope))) throw fail('insufficient_scope', 403, 'Required scope was not granted');
    return { principal: 'owner', clientId: family.clientId, resource: family.resource, scopes: [...row.scopes], expiresAt: row.expiresAt, grantExpiresAt: family.expiresAt, grantId: row.familyId };
  }
  grantIsActive(grantId, requiredScope) {
    const now = this.clock(), family = this.state.families[grantId];
    return Boolean(family && family.revokedAt === null && family.expiresAt > now &&
      family.resource === this.resource && family.clientId === CHATGPT_CLIENT_ID &&
      (!requiredScope || family.scopes.includes(requiredScope)));
  }
  revoke(input) {
    const now = this.clock(), params = parameters(input);
    this.clientId(params.client_id); this.target(params.resource, false);
    if (!params.token) throw fail('invalid_request', 400, 'Revocation token required');
    const next = this.draft(now), tokenHash = digest(params.token);
    const row = next.access[tokenHash] || next.refresh[tokenHash];
    if (row && next.families[row.familyId]) { next.families[row.familyId].revokedAt = now; this.commit(next); }
    return {};
  }
}
