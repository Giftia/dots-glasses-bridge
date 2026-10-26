import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MediaStore } from '../lib/media.mjs';
import { createApp } from '../server.mjs';
import { hashOwnerCode, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, SCOPES } from '../lib/oauth.mjs';

const BASE = 'https://bridge.example.com/dots';
const RESOURCE = BASE + '/mcp';
const EVENT = 'glasses.message.created';
const OWNER_CODE = 'http-fixture-owner-code-2026_ABCDEF';
const VERIFIER = 'http-fixture-pkce-verifier-'.repeat(3);
const TEST_ROOT = resolve(tmpdir(), 'dots-public-http-tests');
const copy = value => JSON.parse(JSON.stringify(value));

test('dedicated WeChat feed is disabled by default and cannot grant MCP access',async t=>{
  const disabled=await fixture(t);assert.equal((await disabled.request('/dots/weixin/outbox')).status,404);
  const token='relay-fixture-'.repeat(4),f=await fixture(t,{relayToken:token});
  assert.equal((await f.request('/dots/weixin/outbox')).status,401);
  assert.equal((await f.request('/dots/weixin/outbox',{headers:{Authorization:'Bearer '+f.config.platformToken}})).status,401);
  assert.equal((await f.rpc('initialize',{}, {token,glasses:true})).status,401);
  const auth={Authorization:'Bearer '+token};
  assert.equal((await f.request('/dots/weixin/outbox?after=garbage',{headers:auth})).status,400);
  assert.equal((await f.request('/dots/weixin/outbox',{method:'POST',headers:auth})).status,405);
  const task=f.app.store.enqueue({message:'private photo instruction',owner:'owner'});
  f.app.store.submitReply({taskId:task.id,replyId:'real-reply',text:'已看到白色瓶子',owner:'owner'});
  const response=await f.request('/dots/weixin/outbox?since=0',{headers:auth});
  assert.equal(response.status,200);assert.match(response.headers['cache-control'],/no-store/);
  assert.equal(response.json.items.length,1);assert.equal(response.json.items[0].text,'Dots 回复了：\n已看到白色瓶子');
  assert.doesNotMatch(response.text,/private photo instruction|platformToken|images/);
});

async function fixture(t, { mediaRequest, relayToken, onVerify } = {}) {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'case-'));
  let now = 1700000000000, app, port, requestId = 0, callbackFailure = false;
  const verified = [], sent = [], eventAudits=[];
  const config = { publicBaseUrl: BASE, dataDir: dir, listenHost: '127.0.0.1', port: 17326,
    platformToken: randomBytes(32).toString('base64url'), ownerCodeHash: hashOwnerCode(OWNER_CODE) };
  if(relayToken)config.weixinRelayToken=relayToken;
  const dependencies = { now: () => now, eventAudit:entry=>eventAudits.push(copy(entry)), transport: {
    verifyCallback: async subscription => {
      verified.push(copy(subscription));
      if(onVerify)await onVerify(app);
      if (callbackFailure) throw Error('synthetic callback verification failure');
      return { verified: true, status: 200 };
    },
    sendEvent: async (subscription, event) => {
      sent.push({ subscription: copy(subscription), event: copy(event) });
      return { accepted: true, status: 202 };
    }
  } };
  if(mediaRequest)dependencies.media=new MediaStore(dir,{now:()=>now,lookup:async()=>[{address:'8.8.8.8',family:4}],request:mediaRequest});
  async function open() {
    app = createApp(config, dependencies);
    await new Promise((done, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); done(); });
    });
    const address = app.server.address();
    assert.equal(address.address, '127.0.0.1');
    port = address.port;
  }
  async function close() {
    if (app?.server.listening) await new Promise((done, reject) => app.server.close(error => error ? reject(error) : done()));
  }
  t.after(async () => {
    await close();
    const root = realpathSync(TEST_ROOT), target = realpathSync(dir);
    assert.ok(target.startsWith(root + sep), 'cleanup must stay inside this task test directory');
    rmSync(target, { recursive: true, force: true });
  });
  await open();
  function request(path, { method = 'GET', json, form, raw, headers = {} } = {}) {
    const body = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : raw;
    return new Promise((done, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false,
        headers: { Host: 'bridge.example.com', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let value;
          try { value = JSON.parse(text); } catch { value = null; }
          done({ status: response.statusCode, headers: response.headers, text, bytes:Buffer.concat(chunks), json: value });
        });
      });
      req.setTimeout(5000, () => req.destroy(Error('local HTTP test request timed out')));
      req.on('error', reject); req.end(body);
    });
  }
  const rpc = (method, params = {}, { token, glasses = false, headers = {} } = {}) => request(glasses ? '/dots/glasses/mcp' : '/dots/mcp', {
    method: 'POST', json: { jsonrpc: '2.0', id: ++requestId, method, params },
    headers: { ...(token !== undefined ? { Authorization: 'Bearer ' + token } : {}), ...headers }
  });
  const glasses = (name, args = {}) => rpc('tools/call', { name, arguments: args }, { glasses: true, token: config.platformToken });
  const dot = (token, name, args = {}) => rpc('tools/call', { name, arguments: args }, { token });
  return { config, request, rpc, glasses, dot, verified, sent, eventAudits, get app() { return app; },
    advance: amount => { now += amount; }, now: () => now,
    restart: async () => { await close(); await open(); }, failVerification: value => { callbackFailure = value; } };
}
function authorizationParams(scope = SCOPES.join(' ')) {
  return { client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, resource: RESOURCE, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    state: 'http-fixture-state-01', scope };
}
function hidden(html, name) {
  const match = html.match(new RegExp('name="' + name + '" value="([A-Za-z0-9_-]+)"'));
  assert.ok(match, 'authorization page must include bound ' + name);
  return match[1];
}
async function begin(f, scope) {
  const result = await f.request('/dots/authorize?' + new URLSearchParams(authorizationParams(scope)));
  assert.equal(result.status, 200);
  assert.match(result.headers['cache-control'], /no-store/);
  assert.equal(result.headers['referrer-policy'], 'same-origin', 'native form submission must retain its same-origin Origin');
  const formAction = /(?:^|;)\s*form-action\s+([^;]+)/.exec(result.headers['content-security-policy'])?.[1];
  assert.equal(formAction, "'self' " + CHATGPT_REDIRECT_URI, 'native browser form redirects must permit only self and the registered ChatGPT callback');
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  const setCookie = result.headers['set-cookie']?.[0];
  assert.ok(setCookie); assert.match(setCookie, /; Secure/); assert.match(setCookie, /; HttpOnly/); assert.match(setCookie, /SameSite=Lax/);
  return { cookie: setCookie.split(';')[0], interaction_id: hidden(result.text, 'interaction_id'), csrf: hidden(result.text, 'csrf') };
}
async function authorize(f, scope) {
  const pending = await begin(f, scope);
  const consent = await f.request('/dots/authorize', { method: 'POST', headers: { Cookie: pending.cookie, Origin: new URL(BASE).origin },
    form: { interaction_id: pending.interaction_id, csrf: pending.csrf, pairing_code: OWNER_CODE, approved: 'yes' } });
  assert.equal(consent.status, 302);
  const redirect = new URL(consent.headers.location);
  assert.equal(redirect.origin + redirect.pathname, CHATGPT_REDIRECT_URI);
  assert.equal(redirect.searchParams.get('iss'), BASE); assert.equal(redirect.searchParams.get('state'), 'http-fixture-state-01');
  const exchange = await f.request('/dots/token', { method: 'POST', form: {
    grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: VERIFIER,
    client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, resource: RESOURCE } });
  assert.equal(exchange.status, 200); assert.equal(exchange.json.token_type, 'Bearer');
  assert.match(exchange.json.access_token, /^[A-Za-z0-9_-]{43}$/); assert.ok(exchange.json.refresh_token);
  return exchange.json;
}
function toolValue(response) {
  assert.equal(response.status, 200);
  assert.ok(response.json && !response.json.error, 'MCP call should have a result');
  assert.equal(response.json.result.isError, false);
  assert.deepEqual(JSON.parse(response.json.result.content[0].text), response.json.result.structuredContent);
  return response.json.result.structuredContent;
}
function rpcFailure(response) {
  assert.equal(response.status, 200);
  assert.ok(response.json?.error || response.json?.result?.isError === true, 'conflicting operation must fail');
}
const PHOTO=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=','base64');
function mediaTransport(){
  const calls=[];
  return {calls,request:(options,callback)=>{
    calls.push(options);const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const incoming=new PassThrough(),pdf=options.path.startsWith('/report');
      incoming.statusCode=options.path.startsWith('/expired')?403:options.path.startsWith('/redirect')?302:200;
      incoming.headers={'content-type':pdf?'application/pdf':'image/png'};
      callback(incoming);incoming.end(pdf?Buffer.from('%PDF-1.7\nsynthetic-file\n%%EOF'):PHOTO);
    });return req;
  }};
}

test('reply query remains lightweight and does not read binary attachments through the dialogue path',async t=>{
  const transport=mediaTransport(),f=await fixture(t,{mediaRequest:transport.request}),tokens=await authorize(f);
  const task=toolValue(await f.glasses('send_to_assistant',{message:'看图测试'}));
  toolValue(await f.dot(tokens.access_token,'submit_glasses_reply',{task_id:task.id,reply_id:'light-query',text:'正文已经保存',summary:'简短摘要',files:[{download_url:'https://files.example.org/picture',file_id:'light-image',mime_type:'image/png',file_name:'图.png'}]}));
  const response=await f.glasses('query_assistant_result',{task_id:task.id});
  const value=toolValue(response);assert.equal(value.reply,'正文已经保存');assert.equal(value.replySummary,'简短摘要');assert.equal(value.attachments.length,1);assert.ok(value.resultUrl);
  assert.deepEqual(response.json.result.content.map(x=>x.type),['text'],'phone links carry rich output without injecting binary images into each dialogue turn');
  assert.ok(response.bytes.length<32768);
  f.app.media.readImage=()=>{throw Object.assign(new Error('synthetic unavailable binary image'),{status:500});};
  const degraded=toolValue(await f.glasses('query_assistant_result',{task_id:task.id}));assert.equal(degraded.reply,'正文已经保存');assert.equal(degraded.replySummary,'简短摘要');
});

test('photo bytes reach Dot, follow-ups reuse the same photo, and rich reply produces bounded signed phone results',async t=>{
  const transport=mediaTransport(),f=await fixture(t,{mediaRequest:transport.request}),tokens=await authorize(f);
  await subscribe(f,tokens.access_token);
  const input={message:'请看照片中的颜色和物体，并给我图片和报告。',request_id:'photo-http-1',imageUrl:'https://photos.example.org/capture?temporary-secret=synthetic'};
  const task=toolValue(await f.glasses('send_to_assistant',input));
  assert.equal(task.images.length,1);assert.equal(task.images[0].sha256,createHash('sha256').update(PHOTO).digest('hex'));
  assert.equal(JSON.stringify(task).includes('temporary-secret'),false);assert.equal(transport.calls.length,1);
  const duplicate=toolValue(await f.glasses('send_to_assistant',input));assert.equal(duplicate.deduplicated,true);assert.equal(transport.calls.length,1);
  rpcFailure(await f.glasses('send_to_assistant',{...input,imageUrl:'https://photos.example.org/changed'}));assert.equal(transport.calls.length,1);
  await f.app.dispatchPending();assert.deepEqual(Object.keys(f.sent[0].event.data).sort(),['channel','task_id']);
  const read=await f.dot(tokens.access_token,'read_glasses_message',{task_id:task.id});
  assert.equal(read.json.result.content[1].type,'image');assert.deepEqual(Buffer.from(read.json.result.content[1].data,'base64'),PHOTO);
  const follow=toolValue(await f.glasses('send_to_assistant',{message:'同一张图，左边是什么？',request_id:'photo-follow-1',source_task_id:task.id}));
  assert.equal(follow.images[0].id,task.images[0].id);assert.equal(transport.calls.length,1);
  const tools=await f.rpc('tools/list',{}, {token:tokens.access_token});
  assert.deepEqual(tools.json.result.tools.find(tool=>tool.name==='submit_glasses_reply')._meta['openai/fileParams'],['files']);
  const args={task_id:task.id,reply_id:'photo-reply-http',text:'完整图文结果：<script>不可执行</script>。',summary:'图文结果已备好，请在手机查看。',files:[
    {download_url:'https://files.example.org/picture',file_id:'file-image-1',file_name:'结果图.png'},
    {download_url:'https://files.example.org/report',file_id:'file-report-1',mime_type:'application/pdf',file_name:'报告.pdf'}]};
  toolValue(await f.dot(tokens.access_token,'submit_glasses_reply',args));assert.equal(transport.calls.length,3);
  const reordered={...args,files:args.files.map(file=>Object.fromEntries(Object.entries(file).reverse())).map(file=>({...file,download_url:file.download_url+'?renewed=1'}))};
  toolValue(await f.dot(tokens.access_token,'submit_glasses_reply',reordered));assert.equal(transport.calls.length,3,'same file IDs with fresh temporary URLs and property order must not download twice');
  toolValue(await f.dot(tokens.access_token,'submit_glasses_reply',args));assert.equal(transport.calls.length,3);
  const result=toolValue(await f.glasses('query_assistant_result',{task_id:task.id}));
  assert.equal(result.replySummary,args.summary);assert.equal(result.attachments.length,2);assert.ok(result.resultUrl.startsWith(BASE+'/results/'));
  const queryAgain=await f.glasses('query_assistant_result',{task_id:task.id});assert.deepEqual(queryAgain.json.result.content.map(x=>x.type),['text']);
  const pageUrl=new URL(result.resultUrl),assetUrl=new URL(result.attachments[0].url);
  const page=await f.request(pageUrl.pathname+pageUrl.search);assert.equal(page.status,200);assert.match(page.text,/&lt;script&gt;/);assert.doesNotMatch(page.text,/<script>/);assert.match(page.text,/<img/);
  assert.match(page.headers['content-security-policy'],/default-src 'none'/);assert.equal(page.headers['referrer-policy'],'no-referrer');
  const asset=await f.request(assetUrl.pathname+assetUrl.search);assert.equal(asset.status,200);assert.deepEqual(asset.bytes,PHOTO);
  const reportUrl=new URL(result.attachments[1].url),report=await f.request(reportUrl.pathname+reportUrl.search);assert.equal(report.status,200);assert.match(report.headers['content-disposition'],/^attachment/);
  const tampered=new URL(result.attachments[0].url);tampered.searchParams.set('task',follow.id);assert.equal((await f.request(tampered.pathname+tampered.search)).status,404);
  assert.equal((await f.request(assetUrl.pathname)).status,404);
  await f.restart();assert.equal((await f.request(pageUrl.pathname+pageUrl.search)).status,200);
  f.advance(15*60*1000+1);assert.equal((await f.request(pageUrl.pathname+pageUrl.search)).status,404);
  const fresh=toolValue(await f.glasses('query_assistant_result',{task_id:task.id}));assert.notEqual(fresh.resultUrl,result.resultUrl);
  f.advance(24*60*60*1000);const expired=toolValue(await f.glasses('query_assistant_result',{task_id:task.id}));assert.equal(expired.attachmentsExpired,true);assert.equal(expired.reply,args.text);
});

test('unsafe or expired photos cannot enqueue events; source ownership and file schemas are enforced',async t=>{
  const transport=mediaTransport(),f=await fixture(t,{mediaRequest:transport.request}),tokens=await authorize(f);
  for(const imageUrl of ['http://photos.example.org/a','https://127.0.0.1/secret','https://photos.example.org/expired','https://photos.example.org/redirect'])rpcFailure(await f.glasses('send_to_assistant',{message:'看这张图',imageUrl}));
  assert.equal(f.app.store.read().tasks.length,0);assert.equal(f.app.store.read().events.length,0);
  const other=f.app.store.enqueue({message:'其他用户的任务',owner:'other'});rpcFailure(await f.glasses('send_to_assistant',{message:'引用其他用户',source_task_id:other.id}));
  const task=toolValue(await f.glasses('send_to_assistant',{message:'普通文本'})),before=transport.calls.length;
  rpcFailure(await f.dot(tokens.access_token,'submit_glasses_reply',{task_id:task.id,reply_id:'bad-file',text:'回复',files:[{download_url:'https://files.example.org/a'}]}));
  rpcFailure(await f.dot(tokens.access_token,'submit_glasses_reply',{task_id:task.id,reply_id:'bad-extra',text:'回复',files:[{download_url:'https://files.example.org/a',file_id:'1',headers:{Authorization:'no'}}]}));
  assert.equal(transport.calls.length,before);
  assert.equal(f.app.store.view(task.id).state,'queued');
});

test('failed multi-file replies release only their newly downloaded bytes and remain safely retryable',async t=>{
  const transport=mediaTransport(),f=await fixture(t,{mediaRequest:transport.request}),tokens=await authorize(f);
  const task=toolValue(await f.glasses('send_to_assistant',{message:'已保存原始照片',imageUrl:'https://photos.example.org/input'}));
  const source=task.images[0];
  const files=[{download_url:'https://files.example.org/picture',file_id:'one'}, {download_url:'https://files.example.org/expired',file_id:'two'}];
  const args={task_id:task.id,reply_id:'partial-download-reply',text:'未完成的附件',files};
  for(let i=0;i<2;i++){
    rpcFailure(await f.dot(tokens.access_token,'submit_glasses_reply',args));
    assert.equal(f.app.media.readManifest().assets.length,1);assert.equal(f.app.media.get(source.id).sha256,source.sha256);
    assert.equal(f.app.store.view(task.id).reply,null);
  }
  rpcFailure(await f.dot(tokens.access_token,'submit_glasses_reply',{...args,files:files.map(file=>({...file,download_url:'https://files.example.org/picture'}))}));
  assert.equal(f.app.media.readManifest().assets.length,1,'second image rejection also releases both new images');
  const successful=toolValue(await f.dot(tokens.access_token,'submit_glasses_reply',{...args,files:[files[0]]}));assert.equal(successful.state,'replied');
  assert.equal(f.app.media.readManifest().assets.length,2);
});
async function subscribe(f, token, overrides = {}) {
  const response = await f.rpc('events/subscribe', { name: EVENT, arguments: { channel: 'n1pro' },
    delivery: { mode: 'webhook', url: 'https://callbacks.example.org/mcp-events/http-fixture', secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') },
    cursor: null, ...overrides }, { token });
  assert.equal(response.status, 200); assert.ok(response.json.result?.id, 'subscription should be accepted');
  return response.json.result;
}

test('glasses text, additional photos and old photo follow-ups reach the same Dot with labelled history', async t => {
  const transport = mediaTransport(), f = await fixture(t, { mediaRequest: transport.request }), tokens = await authorize(f);
  const first = toolValue(await f.glasses('send_to_assistant', { message: '测试颜色青蓝色', request_id: 'chat-first' }));
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: first.id, reply_id: 'chat-reply', text: '已记住青蓝色' }));
  const photo = toolValue(await f.glasses('send_to_assistant', { message: '附加这张照片', imageUrl: 'https://photos.example.org/input', conversation_id: first.conversationId }));
  assert.equal(photo.conversationId, first.conversationId);
  const text = toolValue(await f.glasses('send_to_assistant', { message: '请结合刚才的颜色描述照片', conversation_id: first.conversationId }));
  const read = await f.dot(tokens.access_token, 'read_glasses_message', { task_id: text.id });
  const context = toolValue(read).conversation;
  assert.equal(context.history[0].reply, '已记住青蓝色');
  assert.equal(context.history[1].imageAvailability, 'attached');
  assert.equal(read.json.result.content.filter(row => row.type === 'image').length, 1);
  assert.ok(read.json.result.content.some(row => row.type === 'text' && row.text.includes('第2轮附加的照片')));
  const follow = toolValue(await f.glasses('send_to_assistant', { message: '上一张图左边呢', use_previous_image: true, conversation_id: first.conversationId }));
  assert.equal(follow.images[0].id, photo.images[0].id); assert.equal(transport.calls.length, 1);
  const extra = toolValue(await f.glasses('send_to_assistant', { message: '再加一张比较', imageUrl: 'https://photos.example.org/second', conversation_id: first.conversationId }));
  const compared = await f.dot(tokens.access_token, 'read_glasses_message', { task_id: extra.id });
  assert.equal(compared.json.result.content.filter(row => row.type === 'image').length, 2);
  assert.equal(compared.json.result.content[1].type, 'image');
  assert.equal(transport.calls.length, 2);
});

test('conversation-scoped latest replies do not select a different conversation or claim an old reply for a new turn', async t => {
  const f = await fixture(t), tokens = await authorize(f);
  const first = toolValue(await f.glasses('send_to_assistant', { message: '第一段' }));
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: first.id, reply_id: 'first-answer', text: '第一段回答' }));
  const fresh = toolValue(await f.glasses('send_to_assistant', { message: '重新开始', new_conversation: true }));
  assert.equal(toolValue(await f.glasses('query_assistant_result', { conversation_id: first.conversationId })).reply, '第一段回答');
  assert.equal(toolValue(await f.glasses('query_assistant_result')).id, fresh.id);
  rpcFailure(await f.glasses('query_assistant_result', { task_id: fresh.id, conversation_id: first.conversationId }));
  const next = toolValue(await f.glasses('send_to_assistant', { message: '继续第一段', conversation_id: first.conversationId }));
  const pending = toolValue(await f.glasses('query_assistant_result', { conversation_id: first.conversationId }));
  assert.equal(pending.id, next.id); assert.equal(pending.reply, null);
  await f.restart();
  assert.equal(toolValue(await f.glasses('query_assistant_result', { conversation_id: first.conversationId })).id, next.id);
});

test('expired historical photographs do not stop text dialogue; explicit old photo reuse fails before enqueue', async t => {
  const transport = mediaTransport(), f = await fixture(t, { mediaRequest: transport.request }), tokens = await authorize(f);
  toolValue(await f.glasses('send_to_assistant', { message: '旧照片', imageUrl: 'https://photos.example.org/input' }));
  f.advance(24 * 60 * 60 * 1000 + 1);
  const renewed = await authorize(f);
  const latest = toolValue(await f.glasses('send_to_assistant', { message: '文字继续' }));
  const read = await f.dot(renewed.access_token, 'read_glasses_message', { task_id: latest.id });
  const context = toolValue(read).conversation;
  assert.equal(context.history[0].imageAvailability, 'expired');
  assert.equal(read.json.result.content.filter(row => row.type === 'image').length, 0);
  const count = f.app.store.read().tasks.length;
  rpcFailure(await f.glasses('send_to_assistant', { message: '再看旧照片', use_previous_image: true }));
  assert.equal(f.app.store.read().tasks.length, count);
});

test('bad conversation flags or references cannot download a photograph or enqueue a message', async t => {
  const transport = mediaTransport(), f = await fixture(t, { mediaRequest: transport.request });
  for (const args of [{ new_conversation: 'true' }, { use_previous_image: 1 }, { new_conversation: true, conversation_id: 'conversation_' + 'a'.repeat(32) }, { use_previous_image: true }, { conversation_id: 'conversation_' + 'b'.repeat(32) }, { conversation_id: false }, { use_previous_image: true, source_task_id: 'QG-old' }]) {
    rpcFailure(await f.glasses('send_to_assistant', { message: '不能发送', imageUrl: 'https://photos.example.org/input', ...args }));
  }
  assert.equal(transport.calls.length, 0); assert.equal(f.app.store.read().tasks.length, 0);
});

test('event diagnostics distinguish callback failure and accepted subscription without exposing destinations or secrets',async t=>{
  const f=await fixture(t),tokens=await authorize(f);
  const rejected=await f.rpc('events/subscribe',{name:'private-content-must-not-be-logged',arguments:{channel:'n1pro'},delivery:{mode:'webhook'}},{token:tokens.access_token});
  assert.ok(rejected.json.error);
  f.failVerification(true);
  await f.rpc('events/subscribe',{name:EVENT,arguments:{channel:'n1pro'},delivery:{mode:'webhook',url:'https://callbacks.example.org/private-callback',secret:'whsec_private-test-secret'}},{token:tokens.access_token});
  f.failVerification(false);await subscribe(f,tokens.access_token);
  assert.deepEqual(f.eventAudits.map(x=>x.stage),['subscribe_received','subscribe_failed','subscribe_received','callback_rejected','subscribe_received','subscription_saved']);
  assert.equal(f.eventAudits[1].reason,'invalid_request');assert.equal(f.eventAudits[3].reason,'challenge_failed');
  for(const entry of f.eventAudits)assert.ok(Object.keys(entry).every(key=>['component','at','stage','reason','eventChannel','requestedTtlMode','grantedTtlMode','grantedTtlMs','isRenewal'].includes(key)));
  assert.equal(f.eventAudits[0].eventChannel,'invalid');assert.equal(f.eventAudits[0].requestedTtlMode,'omitted');
  const saved=f.eventAudits[5];assert.equal(saved.eventChannel,'n1pro');assert.equal(saved.requestedTtlMode,'omitted');assert.equal(saved.grantedTtlMode,'finite');assert.equal(saved.grantedTtlMs,2592000000);assert.equal(saved.isRenewal,false);
  assert.doesNotMatch(JSON.stringify(f.eventAudits),/private-content|private-callback|whsec_|access_token|callbacks\.example|secret/);
});

test('HTTP authorization, MCP discovery, subscription, callback receipt and Dot reply complete one correlated round trip', async t => {
  const f = await fixture(t);
  const resource = await f.request('/.well-known/oauth-protected-resource/dots/mcp');
  const metadata = await f.request('/.well-known/oauth-authorization-server/dots');
  assert.equal(resource.status, 200); assert.equal(resource.json.resource, RESOURCE);
  assert.deepEqual(resource.json.authorization_servers, [BASE]);
  assert.equal(metadata.json.issuer, BASE); assert.equal(metadata.json.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.json.code_challenge_methods_supported, ['S256']);
  const tokens = await authorize(f);
  const discovery = await f.rpc('server/discover', {}, { token: tokens.access_token, headers: { Origin: 'https://chatgpt.com' } });
  assert.equal(discovery.status, 200); assert.equal(discovery.json.result.resultType, 'complete');
  assert.deepEqual(discovery.json.result.supportedVersions, ['2026-07-28']);
  assert.ok(discovery.json.result.capabilities.events);
  const tools = await f.rpc('tools/list', {}, { token: tokens.access_token });
  assert.deepEqual(tools.json.result.tools.map(tool => tool.name).sort(), ['list_pending_glasses_messages', 'notify_glasses', 'read_glasses_message', 'submit_glasses_reply']);
  for (const tool of tools.json.result.tools) assert.equal(tool.securitySchemes[0].type, 'oauth2');
  const events = await f.rpc('events/list', {}, { token: tokens.access_token });
  assert.equal(events.status, 200); assert.equal(events.json.result.events[0].name, EVENT);
  assert.deepEqual(events.json.result.events[0].delivery, ['webhook']);
  const subscription = await subscribe(f, tokens.access_token);
  assert.equal(f.verified.length, 1); assert.equal(f.verified[0].id, subscription.id);
  const task = toolValue(await f.glasses('send_to_assistant', { message: '合成验收消息，请回复通道正常', request_id: 'round-trip-1' }));
  assert.equal(task.state, 'queued');
  await f.app.dispatchPending();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].event.data.task_id, task.id);
  assert.deepEqual(Object.keys(f.sent[0].event.data).sort(), ['channel', 'task_id']);
  assert.equal(f.sent[0].event.owner, undefined);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: task.id })).state, 'notified');
  assert.equal(toolValue(await f.dot(tokens.access_token, 'read_glasses_message', { task_id: task.id })).message, task.message);
  const replied = toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: task.id, reply_id: 'reply-round-trip', text: '合成验收回复：通道正常' }));
  assert.equal(replied.state, 'replied');
  const result = toolValue(await f.glasses('query_assistant_result', { task_id: task.id }));
  assert.equal(result.reply, '合成验收回复：通道正常'); assert.equal(result.state, 'replied');
  await f.app.dispatchPending(); assert.equal(f.sent.length, 1, 'accepted callback must not be sent twice');
});

test('HTTP request and reply IDs are idempotent and conflicts cannot change another task', async t => {
  const f = await fixture(t), tokens = await authorize(f);
  const first = toolValue(await f.glasses('send_to_assistant', { message: '合成任务甲', request_id: 'same-request' }));
  const retry = toolValue(await f.glasses('send_to_assistant', { message: '合成任务甲', request_id: 'same-request' }));
  assert.equal(retry.id, first.id); assert.equal(retry.deduplicated, true);
  rpcFailure(await f.glasses('send_to_assistant', { message: '冲突内容', request_id: 'same-request' }));
  const second = toolValue(await f.glasses('send_to_assistant', { message: '合成任务乙', request_id: 'second-request' }));
  const payload = { task_id: first.id, reply_id: 'one-reply-id', text: '只属于任务甲的回复' };
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', payload));
  assert.equal(toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', payload)).deduplicated, true);
  rpcFailure(await f.dot(tokens.access_token, 'submit_glasses_reply', { ...payload, text: '修改相同回复编号' }));
  rpcFailure(await f.dot(tokens.access_token, 'submit_glasses_reply', { ...payload, task_id: second.id }));
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: first.id })).reply, payload.text);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: second.id })).reply, null);
});

test('rebuilding createApp with the same dedicated directory retains OAuth, subscription, reply and pending event', async t => {
  const f = await fixture(t), tokens = await authorize(f); await subscribe(f, tokens.access_token);
  const completed = toolValue(await f.glasses('send_to_assistant', { message: '重启前已回复', request_id: 'persist-replied' }));
  await f.app.dispatchPending();
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: completed.id, reply_id: 'persist-reply', text: '保留这条合成回复' }));
  const pending = toolValue(await f.glasses('send_to_assistant', { message: '重启后继续投递', request_id: 'persist-pending' }));
  const pendingEventId = f.app.store.outgoingDeliveries()[0].event.eventId;
  await f.restart();
  assert.equal((await f.rpc('events/list', {}, { token: tokens.access_token })).status, 200);
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured, true);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: completed.id })).reply, '保留这条合成回复');
  await f.app.dispatchPending();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].event.eventId, pendingEventId); assert.equal(f.sent[1].event.data.task_id, pending.id);
  await f.app.dispatchPending(); assert.equal(f.sent.length, 2);
  const refreshed = await f.request('/dots/token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: tokens.refresh_token, resource: RESOURCE } });
  assert.equal(refreshed.status, 200); assert.notEqual(refreshed.json.refresh_token, tokens.refresh_token);
});

test('revoking the OAuth family stops queued and future callback delivery and clears connected status', async t => {
  const f = await fixture(t), tokens = await authorize(f); await subscribe(f, tokens.access_token);
  toolValue(await f.glasses('send_to_assistant', { message: '撤销前尚未投递', request_id: 'before-revoke' }));
  const revoked = await f.request('/dots/revoke', { method: 'POST', form: { client_id: CHATGPT_CLIENT_ID, token: tokens.refresh_token } });
  assert.equal(revoked.status, 200);
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured, false);
  await f.app.dispatchPending(); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.app.store.subscriptions('owner'), []);
  toolValue(await f.glasses('send_to_assistant', { message: '撤销后的合成请求', request_id: 'after-revoke' }));
  await f.app.dispatchPending(); assert.equal(f.sent.length, 0);
  assert.equal((await f.rpc('events/list', {}, { token: tokens.access_token })).status, 401);
});

test('only-read OAuth grants receive a tool-level scope challenge and events HTTP 403 challenge', async t => {
  const f = await fixture(t), tokens = await authorize(f, 'glasses:read');
  const task = toolValue(await f.glasses('send_to_assistant', { message: '仅供读取的合成请求', request_id: 'readonly-task' }));
  assert.equal(toolValue(await f.dot(tokens.access_token, 'read_glasses_message', { task_id: task.id })).id, task.id);
  const denied = await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: task.id, reply_id: 'must-not-write', text: '不应保存' });
  assert.equal(denied.status, 200); assert.equal(denied.json.error, undefined); assert.equal(denied.json.result.isError, true);
  const challenge = denied.json.result._meta['mcp/www_authenticate'].join(' ');
  assert.match(challenge, /insufficient_scope/); assert.match(challenge, /glasses:reply/);
  assert.match(challenge, /resource_metadata=/); assert.match(challenge, /error_description=/);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: task.id })).reply, null);
  const events = await f.rpc('events/list', {}, { token: tokens.access_token });
  assert.equal(events.status, 403); assert.match(events.headers['www-authenticate'], /events:subscribe/);
});

test('expired tokens and swapped platform/OAuth credentials are rejected at the HTTP boundary', async t => {
  const f = await fixture(t), tokens = await authorize(f);
  const anonymous = await f.rpc('server/discover');
  assert.equal(anonymous.status, 401); assert.match(anonymous.headers['www-authenticate'], /oauth-protected-resource\/dots\/mcp/);
  assert.equal((await f.rpc('server/discover', {}, { token: f.config.platformToken })).status, 401);
  assert.equal((await f.rpc('tools/list', {}, { token: tokens.access_token, glasses: true })).status, 401);
  f.advance(900000);
  const expired = await f.rpc('tools/list', {}, { token: tokens.access_token });
  assert.equal(expired.status, 401); assert.match(expired.headers['www-authenticate'], /resource_metadata=/);
});

test('HTTP consent rejects missing cookies, swapped sessions, wrong CSRF and replays', async t => {
  const f = await fixture(t), first = await begin(f), second = await begin(f);
  const form = { interaction_id: first.interaction_id, csrf: first.csrf, pairing_code: OWNER_CODE, approved: 'yes' };
  const post = (headers, values = form) => f.request('/dots/authorize', { method: 'POST', form: values, headers: { Origin: new URL(BASE).origin, ...headers } });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ Cookie: second.cookie })).status, 400);
  assert.equal((await post({ Cookie: first.cookie }, { ...form, csrf: second.csrf })).status, 400);
  const granted = await post({ Cookie: first.cookie }); assert.equal(granted.status, 302);
  assert.equal((await post({ Cookie: first.cookie })).status, 400);
});

test('HTTP consent and transport enforce Host and Origin without allowing cross-site authorization', async t => {
  const f = await fixture(t), interaction = await begin(f);
  assert.equal((await f.request('/dots/health', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await f.request('/dots/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const form = { interaction_id: interaction.interaction_id, csrf: interaction.csrf, pairing_code: OWNER_CODE, approved: 'yes' };
  for (const Origin of ['null', 'https://evil.example', 'https://chatgpt.com', 'https://device.qianwen.com']) {
    assert.equal((await f.request('/dots/authorize', { method: 'POST', form, headers: { Cookie: interaction.cookie, Origin } })).status, 403);
  }
  assert.equal((await f.request('/dots/authorize', { method: 'POST', form, headers: { Cookie: interaction.cookie, Origin: new URL(BASE).origin } })).status, 302);
});

test('duplicate OAuth query and form parameters are rejected before a code can be issued', async t => {
  const f = await fixture(t), query = new URLSearchParams(authorizationParams()); query.append('resource', RESOURCE);
  assert.equal((await f.request('/dots/authorize?' + query)).status, 400);
  const interaction = await begin(f);
  const raw = new URLSearchParams({ interaction_id: interaction.interaction_id, csrf: interaction.csrf, pairing_code: OWNER_CODE, approved: 'yes' }).toString() + '&csrf=duplicate';
  assert.equal((await f.request('/dots/authorize', { method: 'POST', raw, headers: { Cookie: interaction.cookie, Origin: new URL(BASE).origin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
  const tokenForm = 'grant_type=authorization_code&client_id=' + encodeURIComponent(CHATGPT_CLIENT_ID) + '&code=one&code=two';
  assert.equal((await f.request('/dots/token', { method: 'POST', raw: tokenForm, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
});

test('bad JSON, invalid RPC envelopes and oversized bodies produce bounded HTTP errors', async t => {
  const f = await fixture(t), headers = { Authorization: 'Bearer ' + f.config.platformToken, 'Content-Type': 'application/json' };
  assert.equal((await f.request('/dots/glasses/mcp', { method: 'POST', raw: '{bad json', headers })).status, 400);
  assert.equal((await f.request('/dots/glasses/mcp', { method: 'POST', json: [], headers })).status, 400);
  assert.equal((await f.request('/dots/glasses/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: {}, method: 'tools/list' }, headers })).status, 400);
  assert.equal((await f.request('/dots/glasses/mcp', { method: 'POST', raw: 'x'.repeat(65537), headers })).status, 413);
  assert.equal((await f.request('/dots/health')).status, 200, 'oversized input must not break subsequent requests');
});

test('connected status follows real subscription TTL while proactive playback always remains disabled', async t => {
  const f = await fixture(t), tokens = await authorize(f);
  const before = toolValue(await f.glasses('assistant_bridge_status'));
  assert.equal(before.subscriptionConfigured, false); assert.equal(before.proactivePlaybackConfigured, false);
  await subscribe(f, tokens.access_token, { ttlMs: 1000 });
  const connected = toolValue(await f.glasses('assistant_bridge_status'));
  assert.equal(connected.subscriptionConfigured, true); assert.equal(connected.proactivePlaybackConfigured, false);
  const summaries = f.app.store.subscriptions('owner');
  assert.equal(summaries.length, 1); assert.equal(typeof summaries[0].grantId, 'string');
  assert.equal(summaries[0].secret, undefined); assert.equal(summaries[0].url, undefined);
  toolValue(await f.dot(tokens.access_token, 'notify_glasses', { notification_id: 'fixture-notice-1', text: '合成完成摘要', kind: 'completion' }));
  const notices = toolValue(await f.glasses('query_assistant_notifications'));
  assert.equal(notices.notifications.length, 1); assert.equal(notices.proactivePlaybackConfigured, false);
  assert.equal((await f.request('/dots/health')).json.proactivePlaybackConfigured, false);
  f.advance(1000);
  const expired = toolValue(await f.glasses('assistant_bridge_status'));
  assert.equal(expired.subscriptionConfigured, false); assert.equal(expired.proactivePlaybackConfigured, false);
});

test('subscription refresh is idempotent and unsubscribe cancels pending events', async t => {
  const f = await fixture(t), tokens = await authorize(f), first = await subscribe(f, tokens.access_token);
  const task = toolValue(await f.glasses('send_to_assistant', { message: '只应建立一个待投递事件', request_id: 'subscribe-idempotent' }));
  const refreshed = await subscribe(f, tokens.access_token, { ttlMs: null });
  assert.equal(refreshed.id, first.id); assert.equal(f.app.store.subscriptions('owner').length, 1);
  assert.equal(refreshed.refreshBefore,null);assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,null);
  assert.equal(f.app.store.outgoingDeliveries().length, 1);
  const stopped = await f.rpc('events/unsubscribe', { name: EVENT, arguments: { channel: 'n1pro' }, delivery: { mode: 'webhook', url: 'https://callbacks.example.org/mcp-events/http-fixture' } }, { token: tokens.access_token });
  assert.equal(stopped.status, 200); assert.ok(stopped.json.result);
  await f.app.dispatchPending(); assert.equal(f.sent.length, 0);
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured, false);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: task.id })).reply, null);
});

test('omitted leases use the current grant expiry while finite requests keep their cap and only explicit null grants no expiration',async t=>{
  const f=await fixture(t),tokens=await authorize(f);
  const grantExpiresAt=f.app.oauth.authenticate(tokens.access_token).grantExpiresAt;
  const first=await subscribe(f,tokens.access_token);
  assert.equal(first.refreshBefore,new Date(grantExpiresAt).toISOString());
  assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,grantExpiresAt);
  const finite=await subscribe(f,tokens.access_token,{ttlMs:2500});
  assert.equal(finite.id,first.id);assert.equal(finite.refreshBefore,new Date(f.now()+2500).toISOString());
  assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,f.now()+2500);
  const capped=await subscribe(f,tokens.access_token,{ttlMs:86400001});
  assert.equal(capped.refreshBefore,new Date(f.now()+86400000).toISOString());
  const unlimited=await subscribe(f,tokens.access_token,{ttlMs:null});
  assert.equal(unlimited.id,first.id);assert.equal(unlimited.refreshBefore,null);
  const saved=f.eventAudits.filter(row=>row.stage==='subscription_saved');
  assert.deepEqual(saved.map(row=>[row.requestedTtlMode,row.grantedTtlMode,row.grantedTtlMs,row.isRenewal]),[['omitted','finite',grantExpiresAt-f.now(),false],['finite','finite',2500,true],['finite','finite',86400000,true],['null','null',undefined,true]]);
  for(const ttlMs of [0,-1,1.5,'null']){
    rpcFailure(await f.rpc('events/subscribe',{name:EVENT,arguments:{channel:'n1pro'},delivery:{mode:'webhook'},ttlMs},{token:tokens.access_token}));
    assert.equal(f.eventAudits.filter(row=>row.stage==='subscribe_received').slice(-1)[0].requestedTtlMode,'invalid');
  }
  assert.doesNotMatch(JSON.stringify(f.eventAudits),/sub_|whsec_|callbacks\.example|http-fixture|access_token|grantId|subscriptionId/);
});

test('omitted native leases survive restart and access refresh but remain bounded by the same grant and revocation',async t=>{
  for(const channel of ['n1pro','weixin']){
    const f=await fixture(t,{onVerify:()=>f.advance(5000)});f.config.weixinIngressToken=randomBytes(32).toString('base64url');await f.restart();
    const tokens=await authorize(f),name=channel==='weixin'?'bridge.message.created':EVENT;
    const identity=f.app.oauth.authenticate(tokens.access_token),family=copy(f.app.oauth.state.families);
    const first=await subscribe(f,tokens.access_token,{name,arguments:{channel}});
    assert.equal(first.refreshBefore,new Date(identity.grantExpiresAt).toISOString());
    assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,identity.grantExpiresAt);
    f.advance(3600001);await f.restart();
    const task=f.app.store.enqueue({message:'原生省略租约，一个小时后仍可交办',channel});
    await f.app.dispatchPending();assert.equal(f.sent.length,1);assert.equal(f.app.store.view(task.id).state,'notified');
    const response=await f.request('/dots/token',{method:'POST',form:{grant_type:'refresh_token',client_id:CHATGPT_CLIENT_ID,refresh_token:tokens.refresh_token,resource:RESOURCE}});
    assert.equal(response.status,200);
    const refreshed=response.json,renewed=await subscribe(f,refreshed.access_token,{name,arguments:{channel}});
    assert.equal(renewed.id,first.id);assert.equal(renewed.refreshBefore,first.refreshBefore);
    assert.deepEqual(f.app.oauth.state.families,family);
    const audit=f.eventAudits.filter(row=>row.stage==='subscription_saved').slice(-1)[0];
    assert.equal(audit.requestedTtlMode,'omitted');assert.equal(audit.grantedTtlMode,'finite');assert.equal(audit.grantedTtlMs,identity.grantExpiresAt-f.now());assert.equal(audit.isRenewal,true);
    const tool=channel==='weixin'?'list_pending_messages':'list_pending_glasses_messages';
    assert.doesNotMatch(JSON.stringify(toolValue(await f.dot(refreshed.access_token,tool))),/grantExpiresAt|grantId|access_token/);
    f.app.store.enqueue({message:'授权撤销后不应继续交办',channel});
    const revoked=await f.request('/dots/revoke',{method:'POST',form:{client_id:CHATGPT_CLIENT_ID,token:refreshed.refresh_token}});
    assert.equal(revoked.status,200);await f.app.dispatchPending();assert.equal(f.sent.length,1);assert.equal(f.app.store.subscriptions('owner').length,0);
  }
  const f=await fixture(t),tokens=await authorize(f),identity=f.app.oauth.authenticate(tokens.access_token);
  await subscribe(f,tokens.access_token);f.advance(2592000000);
  f.app.store.enqueue({message:'有限租约及原授权到期后均应停止'});await f.app.dispatchPending();
  assert.equal(f.sent.length,0);assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,identity.grantExpiresAt);
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured,false);
});

test('grant revocation during callback verification prevents committing an omitted lease',async t=>{
  let refresh;
  const f=await fixture(t,{onVerify:app=>app.oauth.revoke({client_id:CHATGPT_CLIENT_ID,token:refresh})}),tokens=await authorize(f);refresh=tokens.refresh_token;
  const result=await f.rpc('events/subscribe',{name:EVENT,arguments:{channel:'n1pro'},delivery:{mode:'webhook',url:'https://callbacks.example.org/mcp-events/http-fixture',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}},{token:tokens.access_token});
  assert.equal(f.verified.length,1);assert.equal(result.status,401);assert.equal(result.json.error,'invalid_token');
  assert.deepEqual(f.app.store.subscriptions('owner'),[]);assert.equal(f.eventAudits.filter(row=>row.stage==='subscription_saved').length,0);
});

test('explicit null leases persist beyond one hour on both channels but never extend revoked or expired OAuth grants',async t=>{
  for(const channel of ['n1pro','weixin']){
    const f=await fixture(t);f.config.weixinIngressToken=randomBytes(32).toString('base64url');await f.restart();
    const tokens=await authorize(f),name=channel==='weixin'?'bridge.message.created':EVENT;
    const result=await subscribe(f,tokens.access_token,{name,arguments:{channel},ttlMs:null});
    const family=copy(f.app.oauth.state.families);
    assert.equal(result.refreshBefore,null);assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,null);
    const saved=f.eventAudits.filter(row=>row.stage==='subscription_saved').slice(-1)[0];
    assert.equal(saved.eventChannel,channel);assert.equal(saved.requestedTtlMode,'null');assert.equal(saved.grantedTtlMode,'null');assert.equal('grantedTtlMs' in saved,false);
    f.advance(3600001);await f.restart();
    assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,null);
    assert.deepEqual(f.app.oauth.state.families,family);
    const delivered=f.app.store.enqueue({message:'一个小时后仍按原订阅交办',channel});
    await f.app.dispatchPending();assert.equal(f.sent.length,1);assert.equal(f.app.store.view(delivered.id).state,'notified');
    f.app.store.enqueue({message:'撤销后不应投递',channel});
    const revoked=await f.request('/dots/revoke',{method:'POST',form:{client_id:CHATGPT_CLIENT_ID,token:tokens.refresh_token}});
    assert.equal(revoked.status,200);await f.app.dispatchPending();
    assert.equal(f.sent.length,1);assert.equal(f.app.store.subscriptions('owner').length,0);
  }
  const f=await fixture(t),tokens=await authorize(f);await subscribe(f,tokens.access_token,{ttlMs:null});
  f.advance(2592000000);
  f.app.store.enqueue({message:'原grant自然到期后不应继续投递'});
  await f.app.dispatchPending();assert.equal(f.sent.length,0);assert.equal(f.app.store.subscriptions('owner').length,0);
});

test('an expired finite lease is not migrated or revived until a verified null renewal succeeds',async t=>{
  const f=await fixture(t),tokens=await authorize(f),first=await subscribe(f,tokens.access_token,{ttlMs:1000});
  const expiredAt=f.app.store.subscriptions('owner')[0].expiresAt,families=copy(f.app.oauth.state.families);
  f.advance(1000);await f.restart();
  assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,expiredAt);
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured,false);
  f.failVerification(true);
  const denied=await f.rpc('events/subscribe',{name:EVENT,arguments:{channel:'n1pro'},ttlMs:null,delivery:{mode:'webhook',url:'https://callbacks.example.org/mcp-events/http-fixture',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}},{token:tokens.access_token});
  assert.equal(denied.json.error.code,-32015);
  assert.equal(f.app.store.subscriptions('owner')[0].expiresAt,expiredAt);assert.deepEqual(f.app.oauth.state.families,families);
  f.failVerification(false);const renewed=await subscribe(f,tokens.access_token,{ttlMs:null});
  assert.equal(renewed.id,first.id);assert.equal(renewed.refreshBefore,null);
  assert.deepEqual(f.app.oauth.state.families,families);
  assert.equal(f.eventAudits.filter(row=>row.stage==='subscription_saved').slice(-1)[0].isRenewal,true);
});

test('failed callback verification returns the protocol error without activating a subscription', async t => {
  const f = await fixture(t), tokens = await authorize(f); f.failVerification(true);
  const result = await f.rpc('events/subscribe', { name: EVENT, arguments: { channel: 'n1pro' }, delivery: {
    mode: 'webhook', url: 'https://callbacks.example.org/mcp-events/http-fixture', secret: 'whsec_' + Buffer.alloc(32, 3).toString('base64') } }, { token: tokens.access_token });
  assert.equal(result.status, 200); assert.equal(result.json.error.code, -32015);
  assert.equal(result.json.error.data.reason, 'challenge_failed');
  assert.equal(toolValue(await f.glasses('assistant_bridge_status')).subscriptionConfigured, false);
  assert.deepEqual(f.app.store.subscriptions('owner'), []);
});

test('pending requests are recovered explicitly without inventing replay or including replied and other-owner tasks', async t => {
  const f = await fixture(t);
  const pending = toolValue(await f.glasses('send_to_assistant', { message: '订阅前排队的合成请求', request_id: 'before-subscription-queued' }));
  const completed = toolValue(await f.glasses('send_to_assistant', { message: '已通过别的已授权交互答复', request_id: 'before-subscription-replied' }));
  const tokens = await authorize(f);
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: completed.id, reply_id: 'already-replied', text: '合成已回复' }));
  assert.equal(f.app.store.outgoingDeliveries().length, 0);
  await subscribe(f, tokens.access_token);
  f.app.store.enqueue({ message: '不属于当前授权用户', owner: 'other' });
  assert.equal(f.app.store.outgoingDeliveries().length, 0, 'subscription creation must not invent historical event replay');
  const pendingList = toolValue(await f.dot(tokens.access_token, 'list_pending_glasses_messages'));
  assert.deepEqual(pendingList.tasks.map(item => item.id), [pending.id]);
  assert.equal(pendingList.tasks[0].message, undefined, 'list is a bounded identifier summary');
  await subscribe(f, tokens.access_token);
  assert.equal(f.app.store.outgoingDeliveries().length, 0);
  await f.app.dispatchPending();
  assert.equal(f.sent.length, 0);
  const read = toolValue(await f.dot(tokens.access_token, 'read_glasses_message', { task_id: pending.id }));
  assert.equal(read.message, '订阅前排队的合成请求');
  toolValue(await f.dot(tokens.access_token, 'submit_glasses_reply', { task_id: pending.id, reply_id: 'recovered-explicitly', text: '明确恢复并回复' }));
  assert.deepEqual(toolValue(await f.dot(tokens.access_token, 'list_pending_glasses_messages')).tasks, []);
  assert.equal(toolValue(await f.glasses('query_assistant_result', { task_id: pending.id })).reply, '明确恢复并回复');
});
