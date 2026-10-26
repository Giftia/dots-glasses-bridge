import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OAuthServer, OAuthError, hashOwnerCode, SCOPES, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, CHATGPT_CLIENT_METADATA } from '../lib/oauth.mjs';

// The prototype runtime includes Node 16.14.2, before node:test existed.
const nativeTest = Number(process.versions.node.split('.')[0]) >= 18 ? (await import('node:test')).default : null;
const legacyCases = [];
const test = nativeTest || ((name, body) => legacyCases.push({ name, body }));
const copy = value => JSON.parse(JSON.stringify(value));
const OWNER_CODE = 'fixture-owner-pairing-code-01_ABCDEF';
const BASE = 'https://bridge.example.com/dots';
const RESOURCE = BASE + '/mcp';
const VERIFIER = 'v'.repeat(64);
const challenge = value => createHash('sha256').update(value, 'ascii').digest('base64url');
const rejected = (body, error, status) => assert.throws(body, value => value instanceof OAuthError && value.error === error && (status === undefined || value.status === status));

function fixture(overrides = {}) {
  let now = 1700000000000, persisted = null, broken = false, failAfterWrite = false;
  const config = { publicBaseUrl: BASE, resource: RESOURCE, clientMetadata: copy(CHATGPT_CLIENT_METADATA), ownerCodeHash: hashOwnerCode(OWNER_CODE),
    now: () => now, loadState: () => persisted === null ? null : copy(persisted),
    saveState: state => { if (broken && !failAfterWrite) throw Error('private storage failure'); persisted = copy(state); if (broken) throw Error('private storage failure'); }, ...overrides };
  let server = new OAuthServer(config);
  return { get server() { return server; }, config,
    advance: amount => { now += amount; }, restart: () => { server = new OAuthServer(config); return server; },
    snapshot: () => copy(persisted), replace: value => { persisted = value; },
    breakStorage: (afterWrite = false) => { broken = true; failAfterWrite = afterWrite; }, repairStorage: () => { broken = false; } };
}
function request(overrides = {}) {
  return { client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, resource: RESOURCE, response_type: 'code',
    state: 'client-state-with-+/?&=characters', code_challenge_method: 'S256', code_challenge: challenge(VERIFIER),
    scope: 'glasses:read glasses:reply events:subscribe', ...overrides };
}
function consent(f, requestOverrides = {}) {
  const interaction = f.server.beginAuthorization(request(requestOverrides));
  const redirect = new URL(f.server.completeAuthorization({ ...interaction, pairingCode: OWNER_CODE, approved: true }).redirectUrl);
  return { interaction, redirect, code: redirect.searchParams.get('code') };
}
function codeParams(code, overrides = {}) {
  return { grant_type: 'authorization_code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI,
    resource: RESOURCE, code, code_verifier: VERIFIER, ...overrides };
}
function refreshParams(refreshToken, overrides = {}) {
  return { grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: refreshToken, ...overrides };
}
function grant(f, requestOverrides = {}) {
  const authorization = consent(f, requestOverrides);
  return { ...authorization, tokens: f.server.token(codeParams(authorization.code)) };
}

test('discovery identifies the exact issuer, resource, public client and S256 only', () => {
  const f = fixture(), metadata = f.server.authorizationMetadata(), resource = f.server.protectedResourceMetadata();
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.authorization_endpoint, BASE + '/authorize');
  assert.equal(metadata.token_endpoint, BASE + '/token');
  assert.equal(metadata.revocation_endpoint, BASE + '/revoke');
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.deepEqual(resource, { resource: RESOURCE, authorization_servers: [BASE], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'] });
  metadata.scopes_supported.push('administrator');
  assert.deepEqual(f.server.authorizationMetadata().scopes_supported, [...SCOPES]);
});

test('configuration refuses insecure, ambiguous or unrelated resource and endpoint URLs', () => {
  for (const overrides of [
    { publicBaseUrl: 'http://bridge.example.com/dots' }, { publicBaseUrl: BASE + '/' },
    { publicBaseUrl: 'https://user:pass@bridge.example.com/dots' }, { resource: RESOURCE + '?other=1' },
    { resource: 'https://elsewhere.example/mcp' }, { resource: 'https://bridge.example.com/other/mcp' },
    { tokenEndpoint: 'https://bridge.example.com/dots-evil/token' }, { ownerCodeHash: 'not-a-hash' },
    { accessTtlMs: 0 }, { codeTtlMs: 300001 }, { refreshTtlMs: 2592000001 }, { interactionTtlMs: NaN }
  ]) rejected(() => fixture(overrides), 'server_error');
  const f = fixture({ authorizationEndpoint: BASE + '/oauth/authorize', tokenEndpoint: BASE + '/oauth/token', revocationEndpoint: BASE + '/oauth/revoke' });
  assert.equal(f.server.authorizationMetadata().token_endpoint, BASE + '/oauth/token');
});

test('only the pinned public ChatGPT metadata and exact stable redirect are accepted', () => {
  for (const metadata of [
    { ...copy(CHATGPT_CLIENT_METADATA), client_id: 'https://evil.example/client.json' },
    { ...copy(CHATGPT_CLIENT_METADATA), redirect_uris: ['https://chatgpt.com/connector/oauth/guessed-callback'] },
    { ...copy(CHATGPT_CLIENT_METADATA), redirect_uris: [CHATGPT_REDIRECT_URI, 'https://evil.example/callback'] },
    { ...copy(CHATGPT_CLIENT_METADATA), token_endpoint_auth_methods_supported: ['private_key_jwt'] }
  ]) rejected(() => fixture({ clientMetadata: metadata }), 'server_error');
  const f = fixture();
  rejected(() => f.server.beginAuthorization(request({ client_id: 'https://chatgpt.com.evil.example/oauth/client.json' })), 'invalid_client');
  for (const redirect_uri of [CHATGPT_REDIRECT_URI + '/extra', CHATGPT_REDIRECT_URI + '?x=1', 'https://chatgpt.com/connector/oauth/arbitrary']) rejected(() => f.server.beginAuthorization(request({ redirect_uri })), 'invalid_request');
});

test('authorization requires canonical S256, code response, state and the exact resource', () => {
  const f = fixture();
  for (const overrides of [{ code_challenge_method: 'plain' }, { code_challenge_method: '' }, { code_challenge: 'short' }, { code_challenge: 'A'.repeat(42) + 'B' }, { state: '' }]) rejected(() => f.server.beginAuthorization(request(overrides)), 'invalid_request');
  rejected(() => f.server.beginAuthorization(request({ response_type: 'token' })), 'unsupported_response_type');
  rejected(() => f.server.beginAuthorization(request({ response_mode: 'fragment' })), 'unsupported_response_type');
  rejected(() => f.server.beginAuthorization(request({ resource: 'https://evil.example/mcp' })), 'invalid_target');
});

test('duplicate and non-scalar OAuth parameters cannot bypass validation', () => {
  const f = fixture(), params = new URLSearchParams(request()); params.append('resource', RESOURCE);
  rejected(() => f.server.beginAuthorization(params), 'invalid_request');
  for (const input of [null, [], request({ resource: [RESOURCE] }), request({ state: 'bad\nstate' })]) rejected(() => f.server.beginAuthorization(input), 'invalid_request');
  const ordinary = new URLSearchParams(request());
  assert.equal(f.server.beginAuthorization(ordinary).clientName, 'ChatGPT');
});

test('consent shows only explicitly requested allowlisted scopes', () => {
  const f = fixture();
  rejected(() => f.server.beginAuthorization(request({ scope: 'glasses:read administrator' })), 'invalid_scope');
  rejected(() => f.server.beginAuthorization(request({ scope: 'openid email' })), 'invalid_scope');
  assert.deepEqual(f.server.beginAuthorization(request({ scope: 'glasses:reply glasses:read glasses:reply' })).scopes, ['glasses:read', 'glasses:reply']);
  const empty = grant(f, { scope: '' });
  assert.deepEqual(f.server.authenticate(empty.tokens.access_token).scopes, []);
  rejected(() => f.server.authenticate(empty.tokens.access_token, ['glasses:read']), 'insufficient_scope', 403);
});

test('owner verification is independent, exact, and never exposes the pairing code', () => {
  const f = fixture();
  assert.equal(f.server.verifyOwnerCode(OWNER_CODE), true);
  for (const value of [null, undefined, {}, OWNER_CODE + ' ', 'short', 'x'.repeat(257)]) assert.equal(f.server.verifyOwnerCode(value), false);
  assert.match(hashOwnerCode(OWNER_CODE), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(f.snapshot()).includes(OWNER_CODE));
  rejected(() => hashOwnerCode('short'), 'invalid_request');
});

test('authorization binds browser session, CSRF and interaction without accepting caller redirects', () => {
  const f = fixture(), first = f.server.beginAuthorization(request()), second = f.server.beginAuthorization(request());
  rejected(() => f.server.completeAuthorization({ ...first, sessionToken: second.sessionToken, pairingCode: OWNER_CODE, approved: true }), 'invalid_request');
  rejected(() => f.server.completeAuthorization({ ...first, csrfToken: second.csrfToken, pairingCode: OWNER_CODE, approved: true }), 'invalid_request');
  rejected(() => f.server.completeAuthorization({ ...first, pairingCode: OWNER_CODE }), 'invalid_request');
  const redirect = new URL(f.server.completeAuthorization({ ...first, pairingCode: OWNER_CODE, approved: true, redirectUri: 'https://evil.example/' }).redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, CHATGPT_REDIRECT_URI);
  assert.equal(redirect.searchParams.get('state'), request().state);
  assert.equal(redirect.searchParams.get('iss'), BASE);
  assert.match(redirect.searchParams.get('code'), /^[A-Za-z0-9_-]{43}$/);
  rejected(() => f.server.completeAuthorization({ ...first, pairingCode: OWNER_CODE, approved: true }), 'invalid_request');
});

test('denial returns the bound issuer and client state without issuing a code', () => {
  const f = fixture(), interaction = f.server.beginAuthorization(request());
  const redirect = new URL(f.server.completeAuthorization({ ...interaction, approved: false }).redirectUrl);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), request().state);
  assert.equal(redirect.searchParams.get('iss'), BASE);
  assert.equal(redirect.searchParams.has('code'), false);
  assert.equal(Object.keys(f.snapshot().codes).length, 0);
});

test('pairing attempts are bounded per interaction and across browser sessions', () => {
  const f = fixture();
  for (let group = 0; group < 2; group++) {
    const interaction = f.server.beginAuthorization(request());
    for (let attempt = 0; attempt < 5; attempt++) rejected(() => f.server.completeAuthorization({ ...interaction, pairingCode: 'incorrect-pairing-code', approved: true }), 'access_denied', 403);
    rejected(() => f.server.completeAuthorization({ ...interaction, pairingCode: OWNER_CODE, approved: true }), 'invalid_request');
  }
  const blocked = f.server.beginAuthorization(request());
  rejected(() => f.server.completeAuthorization({ ...blocked, pairingCode: OWNER_CODE, approved: true }), 'access_denied', 429);
  f.advance(900001);
  assert.ok(consent(f).code);
});

test('expired interactions and authorization codes cannot be exchanged', () => {
  const f = fixture(), interaction = f.server.beginAuthorization(request());
  f.advance(600000);
  rejected(() => f.server.completeAuthorization({ ...interaction, pairingCode: OWNER_CODE, approved: true }), 'invalid_request');
  const { code } = consent(f); f.advance(300000);
  rejected(() => f.server.token(codeParams(code)), 'invalid_grant');
});

test('default authorization code survives a 75-second callback delay without replacing an existing grant', () => {
  const f = fixture(), old = grant(f), { code } = consent(f, { scope: 'messages:read messages:reply' });
  assert.equal(f.server.ttl.codeTtlMs, 300000);
  f.advance(75000); f.restart();
  const tokens = f.server.token(codeParams(code));
  assert.deepEqual(f.server.authenticate(tokens.access_token).scopes, ['messages:read', 'messages:reply']);
  assert.deepEqual(f.server.authenticate(old.tokens.access_token).scopes, ['glasses:read', 'glasses:reply', 'events:subscribe']);
  assert.equal(Object.keys(f.snapshot().families).length, 2);
  rejected(() => f.server.token(codeParams(code)), 'invalid_grant');
  assert.equal(f.server.authenticate(old.tokens.access_token).principal, 'owner');
});

test('default authorization code remains valid before 300 seconds and is rejected at the exact expiry', () => {
  const before = fixture(), usable = consent(before);
  before.advance(299999);
  assert.equal(before.server.token(codeParams(usable.code)).token_type, 'Bearer');
  const expired = fixture(), stale = consent(expired);
  expired.advance(300000); expired.restart();
  rejected(() => expired.server.token(codeParams(stale.code)), 'invalid_grant');
  assert.equal(Object.keys(expired.snapshot().families).length, 0);
  assert.equal(Object.keys(expired.snapshot().access).length, 0);
  assert.equal(Object.keys(expired.snapshot().refresh).length, 0);
});

test('authorization code exchange issues opaque scoped tokens, persisting only hashes', () => {
  const f = fixture(), { code, tokens, interaction } = grant(f);
  assert.equal(tokens.token_type, 'Bearer'); assert.equal(tokens.expires_in, 900);
  assert.notEqual(tokens.access_token, tokens.refresh_token);
  const principal = f.server.authenticate(tokens.access_token, ['glasses:read']);
  assert.equal(principal.principal, 'owner'); assert.equal(principal.clientId, CHATGPT_CLIENT_ID); assert.equal(principal.resource, RESOURCE);
  assert.deepEqual(principal.scopes, ['glasses:read', 'glasses:reply', 'events:subscribe']);
  const saved = JSON.stringify(f.snapshot());
  for (const secret of [code, tokens.access_token, tokens.refresh_token, interaction.sessionToken, interaction.csrfToken, interaction.interactionId, OWNER_CODE]) assert.ok(!saved.includes(secret));
  for (const key of ['codes', 'access', 'refresh', 'interactions']) for (const id of Object.keys(f.snapshot()[key])) assert.match(id, /^[a-f0-9]{64}$/);
  rejected(() => f.server.authenticate(tokens.access_token, ['glasses:notify']), 'insufficient_scope', 403);
});

test('authenticated grant expiry is distinct from access expiry and remains fixed across token refresh and restart', () => {
  const f = fixture(), { tokens } = grant(f), first = f.server.authenticate(tokens.access_token);
  assert.equal(first.grantExpiresAt - first.expiresAt, 2592000000 - 900000);
  assert.equal(first.grantExpiresAt, f.snapshot().families[first.grantId].expiresAt);
  f.advance(3600001);
  const refreshed = f.server.token(refreshParams(tokens.refresh_token)); f.restart();
  const current = f.server.authenticate(refreshed.access_token);
  assert.equal(current.grantId, first.grantId); assert.equal(current.grantExpiresAt, first.grantExpiresAt);
  assert.ok(current.expiresAt > first.expiresAt); assert.ok(current.expiresAt < current.grantExpiresAt);
  rejected(() => f.server.authenticate(tokens.access_token), 'invalid_token');
});

test('code exchange binds verifier and redirect, consuming a failed known code', () => {
  for (const overrides of [{ code_verifier: 'w'.repeat(64) }, { code_verifier: 'v'.repeat(42) }, { redirect_uri: CHATGPT_REDIRECT_URI + '/wrong' }]) {
    const f = fixture(), { code } = consent(f);
    rejected(() => f.server.token(codeParams(code, overrides)), 'invalid_grant');
    rejected(() => f.server.token(codeParams(code)), 'invalid_grant');
  }
});

test('code and token endpoints reject wrong client, resource and unsupported client authentication', () => {
  const f = fixture(), { code } = consent(f);
  rejected(() => f.server.token(codeParams(code, { client_id: 'other' })), 'invalid_client');
  rejected(() => f.server.token(codeParams(code, { resource: 'https://evil.example/' })), 'invalid_target');
  const missing = codeParams(code); delete missing.resource;
  rejected(() => f.server.token(missing), 'invalid_target');
  for (const field of ['client_secret', 'client_assertion', 'client_assertion_type']) rejected(() => f.server.token(codeParams(code, { [field]: 'not-supported' })), 'invalid_client');
  rejected(() => f.server.token(codeParams(code, { grant_type: 'client_credentials' })), 'unsupported_grant_type');
  assert.ok(f.server.token(codeParams(code)).access_token);
});

test('replaying a successful authorization code revokes its entire token family', () => {
  const f = fixture(), { code, tokens } = grant(f);
  rejected(() => f.server.token(codeParams(code)), 'invalid_grant');
  rejected(() => f.server.authenticate(tokens.access_token), 'invalid_token', 401);
  rejected(() => f.server.token(refreshParams(tokens.refresh_token)), 'invalid_grant');
});

test('expired access tokens do not prevent a valid bound refresh', () => {
  const f = fixture(), { tokens } = grant(f); f.advance(900000);
  rejected(() => f.server.authenticate(tokens.access_token), 'invalid_token', 401);
  const rotated = f.server.token(refreshParams(tokens.refresh_token, { resource: RESOURCE }));
  assert.ok(f.server.authenticate(rotated.access_token));
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
});

test('refresh rotation detects old-token reuse and revokes both old and new access tokens', () => {
  const f = fixture(), { tokens } = grant(f), rotated = f.server.token(refreshParams(tokens.refresh_token));
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.ok(f.server.authenticate(rotated.access_token));
  rejected(() => f.server.token(refreshParams(tokens.refresh_token)), 'invalid_grant');
  for (const access of [tokens.access_token, rotated.access_token]) rejected(() => f.server.authenticate(access), 'invalid_token');
  rejected(() => f.server.token(refreshParams(rotated.refresh_token)), 'invalid_grant');
});

test('refresh scopes may narrow but cannot expand again', () => {
  const f = fixture(), { tokens } = grant(f);
  rejected(() => f.server.token(refreshParams(tokens.refresh_token, { scope: 'glasses:notify' })), 'invalid_scope');
  const narrowed = f.server.token(refreshParams(tokens.refresh_token, { scope: 'glasses:read' }));
  assert.deepEqual(f.server.authenticate(narrowed.access_token).scopes, ['glasses:read']);
  rejected(() => f.server.authenticate(narrowed.access_token, ['glasses:reply']), 'insufficient_scope');
  rejected(() => f.server.token(refreshParams(narrowed.refresh_token, { scope: 'glasses:read glasses:reply' })), 'invalid_scope');
  const again = f.server.token(refreshParams(narrowed.refresh_token));
  assert.equal(again.scope, 'glasses:read');
});

test('refresh cannot change client or audience and rejected requests do not consume it', () => {
  const f = fixture(), { tokens } = grant(f);
  rejected(() => f.server.token(refreshParams(tokens.refresh_token, { client_id: 'other' })), 'invalid_client');
  rejected(() => f.server.token(refreshParams(tokens.refresh_token, { resource: BASE + '/elsewhere' })), 'invalid_target');
  assert.ok(f.server.token(refreshParams(tokens.refresh_token)).access_token);
});

test('refresh lifetime is absolute rather than sliding indefinitely', () => {
  const f = fixture({ accessTtlMs: 1000, refreshTtlMs: 3000 }), { tokens } = grant(f);
  f.advance(2000); const rotated = f.server.token(refreshParams(tokens.refresh_token));
  assert.equal(rotated.expires_in, 1); f.advance(1000);
  rejected(() => f.server.token(refreshParams(rotated.refresh_token)), 'invalid_grant');
  rejected(() => f.server.authenticate(rotated.access_token), 'invalid_token');
});

test('revocation is idempotent and access or refresh revocation closes the whole grant', () => {
  for (const kind of ['access_token', 'refresh_token']) {
    const f = fixture(), { tokens } = grant(f), input = { client_id: CHATGPT_CLIENT_ID, token: tokens[kind] };
    assert.deepEqual(f.server.revoke(input), {}); assert.deepEqual(f.server.revoke(input), {});
    rejected(() => f.server.authenticate(tokens.access_token), 'invalid_token');
    rejected(() => f.server.token(refreshParams(tokens.refresh_token)), 'invalid_grant');
  }
  const f = fixture();
  assert.deepEqual(f.server.revoke({ client_id: CHATGPT_CLIENT_ID, token: 'unknown-token' }), {});
  rejected(() => f.server.revoke({ client_id: CHATGPT_CLIENT_ID }), 'invalid_request');
  rejected(() => f.server.revoke({ client_id: 'other', token: 'unknown' }), 'invalid_client');
});

test('restart preserves pending authorization, codes, rotation and replay revocation', () => {
  const f = fixture(), interaction = f.server.beginAuthorization(request()); f.restart();
  const redirect = new URL(f.server.completeAuthorization({ ...interaction, pairingCode: OWNER_CODE, approved: true }).redirectUrl);
  const code = redirect.searchParams.get('code'); f.restart();
  const tokens = f.server.token(codeParams(code)); f.restart();
  assert.ok(f.server.authenticate(tokens.access_token));
  const rotated = f.server.token(refreshParams(tokens.refresh_token)); f.restart();
  rejected(() => f.server.token(refreshParams(tokens.refresh_token)), 'invalid_grant'); f.restart();
  rejected(() => f.server.authenticate(rotated.access_token), 'invalid_token');
});

test('a failed storage commit returns no token and poisons further authentication until restart', () => {
  const f = fixture(), { code } = consent(f); f.breakStorage();
  rejected(() => f.server.token(codeParams(code)), 'server_error', 503);
  rejected(() => f.server.beginAuthorization(request()), 'server_error', 503);
  rejected(() => f.server.authenticate('x'.repeat(43)), 'server_error', 503);
  f.repairStorage(); f.restart();
  assert.ok(f.server.token(codeParams(code)).access_token);
});

test('ambiguous storage failure after a write cannot mint a second token family on retry', () => {
  const f = fixture(), { code } = consent(f); f.breakStorage(true);
  rejected(() => f.server.token(codeParams(code)), 'server_error');
  f.repairStorage(); f.restart();
  rejected(() => f.server.token(codeParams(code)), 'invalid_grant');
  assert.equal(Object.keys(f.snapshot().families).length, 1);
  assert.ok(Object.values(f.snapshot().families).every(family => family.revokedAt !== null));
});

test('state corruption or a different installation fails closed without resetting grants', () => {
  const mutations = [state => { state.fingerprint = '0'.repeat(64); }, state => { state.access = null; },
    state => { Object.values(state.families)[0].resource = 'https://evil.example/'; },
    state => { Object.values(state.access)[0].scopes = ['administrator']; },
    state => { Object.values(state.refresh)[0].familyId = 'unknown'; }];
  for (const change of mutations) {
    const f = fixture(); grant(f); const state = f.snapshot(); change(state); f.replace(state);
    rejected(() => f.restart(), 'server_error', 503);
    assert.deepEqual(f.snapshot(), state);
  }
});

test('identity results cannot be mutated to expand stored authorization', () => {
  const f = fixture(), { tokens } = grant(f, { scope: 'glasses:read' });
  f.server.authenticate(tokens.access_token).scopes.push('glasses:reply');
  rejected(() => f.server.authenticate(tokens.access_token, ['glasses:reply']), 'insufficient_scope');
});

test('protocol errors never interpolate codes, tokens, owner secrets or raw storage errors', () => {
  const f = fixture(), secret = 'PRIVATE-REQUEST-SECRET-abcdefghijklmnop';
  for (const body of [() => f.server.token(codeParams(secret)), () => f.server.authenticate(secret),
    () => f.server.beginAuthorization(request({ redirect_uri: secret }))]) {
    try { body(); assert.fail('expected rejection'); } catch (error) { assert.ok(error instanceof OAuthError); assert.ok(!error.message.includes(secret)); }
  }
  f.breakStorage();
  try { f.server.beginAuthorization(request()); assert.fail('expected storage rejection'); } catch (error) { assert.equal(error.error, 'server_error'); assert.ok(!error.message.includes('private storage failure')); }
});

if (!nativeTest) {
  let failures = 0;
  for (let index = 0; index < legacyCases.length; index++) {
    const { name, body } = legacyCases[index];
    try { body(); console.log(`ok ${index + 1} - ${name}`); }
    catch (error) { failures++; console.error(`not ok ${index + 1} - ${name}`); console.error(error.stack); }
  }
  console.log(`1..${legacyCases.length}`);
  if (failures) process.exitCode = 1;
}
