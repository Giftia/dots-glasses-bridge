import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { WeixinChannel, WeixinError, officialBase } from '../lib/weixin.mjs';

const root = path.resolve('work');
fs.mkdirSync(root, { recursive: true });
const owner = 'synthetic-owner@im.wechat', bot = 'synthetic-bot@im.bot';
const token = 'synthetic-private-bot-token', context = 'synthetic-private-owner-context';
const response = body => ({ statusCode: 200, body: JSON.stringify(body) });
function fixture(t, handler) {
  const stateDir = fs.mkdtempSync(path.join(root, 'weixin-test-'));
  t.after(() => {
    const resolved = path.resolve(stateDir);
    assert.ok(resolved.startsWith(root + path.sep) && path.basename(resolved).startsWith('weixin-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let now = 100000;
  const calls = [];
  const request = async options => {
    calls.push(options);
    const url = new URL(options.url);
    assert.ok(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'));
    assert.ok(options.timeoutMs <= 40000);
    assert.equal(options.maxResponseBytes, 1024 * 1024);
    if (handler) {
      const result = await handler(options, calls);
      if (result !== undefined) return result;
    }
    if (url.pathname.endsWith('/get_bot_qrcode')) return response({ qrcode: 'fixture-qr-code', qrcode_img_content: 'fixture-qr-content' });
    if (url.pathname.endsWith('/get_qrcode_status')) return response({ status: 'confirmed', bot_token: token, ilink_bot_id: bot, ilink_user_id: owner, baseurl: 'https://ilinkai.weixin.qq.com' });
    if (url.pathname.endsWith('/getupdates')) return response({ ret: 0, get_updates_buf: 'fixture-next-cursor', msgs: [{ from_user_id: owner, to_user_id: bot, message_type: 1, message_id: '18446744073709551600', context_token: context, item_list: [{ type: 1, text_item: { text: '合成用户授权消息' } }] }] });
    if (url.pathname.endsWith('/sendmessage')) return response({ ret: 0, message_id: '18446744073709551601' });
    throw new Error('unexpected request');
  };
  const channel = new WeixinChannel({ stateDir, request, now: () => now });
  return { channel, stateDir, request, calls, tick(ms) { now += ms; },
    async ready() { await channel.beginLogin(); await channel.pollLogin(); await channel.pollOwnerContext(); },
    restart() { return new WeixinChannel({ stateDir, request, now: () => now }); } };
}
function noPrivate(value) {
  const text = JSON.stringify(value);
  for (const secret of [owner, bot, token, context, 'unrelated-private-text', 'unrelated-private-context']) assert.equal(text.includes(secret), false, secret);
}
test('stale account lock is retained without recovery races or network sends',async t=>{
  const f=fixture(t),dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  const file=path.join(f.stateDir,'weixin-channel.lock'),before=JSON.stringify({pid:Number(dead.stdout),nonce:'old-worker-lock'});
  fs.writeFileSync(file,before);await assert.rejects(f.channel.status(),{code:'stale_lock'});
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(f.calls.length,0);
});

test('login HTTP and network diagnostics retain only safe status fields', async t => {
  const f = fixture(t, () => ({statusCode:403,body:token+' '+context}));
  await assert.rejects(f.channel.beginLogin(), error => {
    assert.equal(error.code,'http_error'); assert.deepEqual(error.diagnostics,{httpStatus:403}); noPrivate(error); return true;
  });
  const safe = new WeixinError('http_error',{httpStatus:503,networkCode:token,body:context,url:'https://example.test/'+owner});
  assert.deepEqual(safe.diagnostics,{httpStatus:503}); noPrivate(safe);
  const g = fixture(t, () => {const error=new Error(token);error.code='EAI_AGAIN';throw error;});
  await assert.rejects(g.channel.beginLogin(), error => {
    assert.equal(error.code,'network_error'); assert.deepEqual(error.diagnostics,{networkCode:'EAI_AGAIN'}); noPrivate(error); return true;
  });
});
test('complete official text request, private summary and persistent idempotency', async t => {
  const f = fixture(t);
  assert.equal((await f.channel.status()).state, 'not_bound');
  const qr = await f.channel.beginLogin();
  assert.equal(qr.qrContent, 'fixture-qr-content');
  assert.equal(qr.expiresAt, 400000);
  assert.equal((await f.channel.pollLogin()).state, 'waiting_for_owner_context');
  const wait = await f.channel.sendNotification({ notificationId: 'notice-1', text: '合成通知' });
  assert.equal(wait.state, 'waiting_for_owner_context');
  assert.equal(f.calls.filter(c => c.url.includes('sendmessage')).length, 0);
  await f.channel.pollOwnerContext();
  const sent = await f.channel.sendNotification({ notificationId: 'notice-1', text: '合成通知' });
  assert.equal(sent.state, 'accepted');
  const request = f.calls.find(c => c.url.includes('sendmessage'));
  const payload = JSON.parse(request.body);
  assert.deepEqual(payload, { msg: { from_user_id: '', to_user_id: owner, client_id: payload.msg.client_id,
    message_type: 2, message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text: '合成通知' } }] },
  base_info: { channel_version: '2.4.10', bot_agent: 'DotsGlassesBridge/0.1.0' } });
  assert.match(payload.msg.client_id, /^xdn-[0-9a-f]{32}$/);
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(request.headers['iLink-App-Id'], 'bot');
  assert.equal(request.headers['iLink-App-ClientVersion'], '132106');
  assert.ok(Number.isSafeInteger(Number(Buffer.from(request.headers['X-WECHAT-UIN'], 'base64').toString())));
  assert.equal(request.timeoutMs, 15000);
  const stored = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'weixin-channel.json'), 'utf8'));
  assert.equal(stored.notifications['notice-1'].state, 'accepted');
  assert.equal(JSON.stringify(stored.notifications).includes('合成通知'), false);
  assert.deepEqual(await f.restart().sendNotification({ notificationId: 'notice-1', text: '合成通知' }), sent);
  assert.equal(f.calls.filter(c => c.url.includes('sendmessage')).length, 1);
  await assert.rejects(f.channel.sendNotification({ notificationId: 'notice-1', text: '不同内容' }), { code: 'notification_conflict' });
  noPrivate(sent); noPrivate(await f.channel.status());
});
test('sendmessage accepts missing ret, continues with a second notification, and never resends the same ID', async t => {
  for (const body of ['{}', '{"errmsg":""}', '{"errcode":0}', '{"errmsg":"","errcode":0}']) {
    const f=fixture(t,options=>options.url.includes('sendmessage')?{statusCode:200,body}:undefined);
    await f.ready();
    const first=await f.channel.sendNotification({notificationId:'optional-ret-first',text:'合成第一条通知'});
    assert.equal(first.state,'accepted',body);
    const second=await f.channel.sendNotification({notificationId:'optional-ret-second',text:'合成第二条通知'});
    assert.equal(second.state,'accepted',body);
    assert.equal(f.calls.filter(call=>call.url.includes('sendmessage')).length,2);
    assert.deepEqual(await f.restart().sendNotification({notificationId:'optional-ret-first',text:'合成第一条通知'}),first);
    assert.deepEqual(await f.restart().sendNotification({notificationId:'optional-ret-second',text:'合成第二条通知'}),second);
    assert.equal(f.calls.filter(call=>call.url.includes('sendmessage')).length,2);
    assert.deepEqual((await f.restart().status()).notifications,{accepted:2});
    noPrivate(first);noPrivate(second);
  }
});

test('sendmessage still rejects explicit nonzero codes and keeps malformed success codes unknown without retry',async t=>{
  const cases=[
    ['{"ret":9}','rejected'],['{"errcode":9}','rejected'],['{"ret":0,"errcode":9}','rejected'],['{"ret":9,"errcode":0}','rejected'],
    ...['ret','errcode'].flatMap(key=>['"0"','true','null','0.0','0e0','1e-999','2147483649','-2147483649','{}','[]'].map(literal=>['{"'+key+'":'+literal+'}','unknown'])),
    ...['null','[]','""','0','true','not-json'].map(body=>[body,'unknown'])
  ];
  for(const [body,state]of cases){
    const f=fixture(t,options=>options.url.includes('sendmessage')?{statusCode:200,body}:undefined);
    await f.ready();const result=await f.channel.sendNotification({notificationId:'invalid-send',text:'合成异常响应通知'});
    assert.equal(result.state,state,body);assert.equal(result.reason,state==='rejected'?'remote_rejected':'invalid_response',body);
    assert.deepEqual(await f.restart().sendNotification({notificationId:'invalid-send',text:'合成异常响应通知'}),result);
    assert.equal(f.calls.filter(call=>call.url.includes('sendmessage')).length,1);noPrivate(result);
  }
});

test('accepting future missing-ret responses does not rewrite or resend a historical invalid_response unknown',async t=>{
  let body='not-json';
  const f=fixture(t,options=>options.url.includes('sendmessage')?{statusCode:200,body}:undefined);
  await f.ready();const previous=await f.channel.sendNotification({notificationId:'historical-unknown',text:'合成历史通知'});
  assert.equal(previous.state,'unknown');assert.equal(previous.reason,'invalid_response');
  body='{}';
  assert.deepEqual(await f.restart().sendNotification({notificationId:'historical-unknown',text:'合成历史通知'}),previous);
  assert.equal(f.calls.filter(call=>call.url.includes('sendmessage')).length,1);
  assert.equal((await f.restart().sendNotification({notificationId:'new-after-repair',text:'合成新通知'})).state,'accepted');
  assert.deepEqual((await f.restart().status()).notifications,{unknown:1,accepted:1});
});

test('isolated runtime send path accepts optional codes and retains strict error types and dedupe',t=>{
  const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url));
  const f=fixture(t),node16=(process.env.DOTS_COMPAT_NODE || process.execPath);
  const moduleUrl=new URL('../lib/weixin.mjs',import.meta.url).href;
  const code=`import{WeixinChannel}from ${JSON.stringify(moduleUrl)};
  let body='{}',sends=0;
  const request=async options=>{
    const endpoint=new URL(options.url).pathname;let value;
    if(endpoint.endsWith('/get_bot_qrcode'))value={qrcode:'synthetic-qr',qrcode_img_content:'synthetic-qr-content'};
    else if(endpoint.endsWith('/get_qrcode_status'))value={status:'confirmed',bot_token:'synthetic-token',ilink_bot_id:'synthetic-bot',ilink_user_id:'synthetic-owner'};
    else if(endpoint.endsWith('/getupdates'))value={msgs:[{from_user_id:'synthetic-owner',message_type:1,message_id:'1',context_token:'synthetic-context',item_list:[{type:1,text_item:{text:'synthetic'}}]}]};
    else if(endpoint.endsWith('/sendmessage')){sends++;return{statusCode:200,body};}else throw Error('Unexpected synthetic endpoint');
    return{statusCode:200,body:JSON.stringify(value)};
  };
  const channel=new WeixinChannel({stateDir:${JSON.stringify(f.stateDir)},request});
  await channel.beginLogin();await channel.pollLogin();await channel.pollOwnerContext();
  const cases=[['{}','accepted'],['{"errmsg":""}','accepted'],['{"ret":0}','accepted'],['{"errcode":0}','accepted'],['{"ret":7}','rejected'],['{"errcode":7}','rejected'],['{"ret":"0"}','unknown'],['{"ret":0.0}','unknown'],['{"errcode":0e0}','unknown'],['[]','unknown'],['null','unknown'],['{bad','unknown']];
  for(let n=0;n<cases.length;n++){body=cases[n][0];const input={notificationId:'node16-'+n,text:'synthetic notification'};const result=await channel.sendNotification(input);if(result.state!==cases[n][1])throw Error('Unexpected result at '+n);await channel.sendNotification(input);}
  console.log(JSON.stringify({passed:cases.length,sendRequests:sends,states:(await channel.status()).notifications}));`;
  const result=spawnSync(node16,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{passed:12,sendRequests:12,states:{accepted:4,rejected:2,unknown:6}});
});

test('other senders cannot bind context or alter the QR-bound owner', async t => {
  let outsiderOnly = true;
  const f = fixture(t, options => options.url.includes('getupdates') && outsiderOnly ? response({ ret: 0, msgs: [
    { from_user_id: 'other@im.wechat', message_type: 1, message_id: '1', context_token: 'unrelated-private-context', item_list: [{ type: 1, text_item: { text: 'unrelated-private-text' } }] },
    { from_user_id: owner, message_type: 2, message_id: '2', context_token: context, item_list: [{ type: 1, text_item: { text: '合成机器人消息' } }] }
  ], get_updates_buf: 'private-cursor' }) : undefined);
  await f.channel.beginLogin(); await f.channel.pollLogin();
  assert.equal((await f.channel.pollOwnerContext()).state, 'waiting_for_owner_context');
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'weixin-channel.json'), 'utf8').includes('unrelated-private'), false);
  outsiderOnly = false;
  assert.equal((await f.channel.pollOwnerContext()).state, 'ready');
  await assert.rejects(f.channel.beginLogin(), { code: 'already_bound' });
  noPrivate(await f.channel.status());
});

test('local QR wait limit cannot override official confirmation; bound login is not rechecked', async t => {
  const f = fixture(t);
  await f.channel.beginLogin(); f.tick(300001);
  const result = await f.channel.pollLogin();
  assert.equal(result.state, 'waiting_for_owner_context');
  assert.equal(result.ownerBound, true);
  const polls = f.calls.filter(c => c.url.includes('get_qrcode_status'));
  assert.equal(polls.length, 1);
  assert.ok(polls[0].url.includes('fixture-qr-code'));
  assert.equal(f.calls.filter(c => c.url.includes('get_bot_qrcode')).length, 1);
  const before = f.calls.length;
  assert.deepEqual(await f.restart().pollLogin(), result);
  assert.equal(f.calls.length, before);
  noPrivate(result);
  assert.equal(JSON.stringify(result).includes('fixture-qr-code'), false);
});

test('official expired result is checked once after local wait and does not bind or refresh', async t => {
  const f = fixture(t, options => options.url.includes('get_qrcode_status') ? response({status:'expired'}) : undefined);
  await f.channel.beginLogin(); f.tick(300001);
  assert.deepEqual(await f.channel.pollLogin(), {state:'login_expired'});
  assert.equal(f.calls.filter(c => c.url.includes('get_qrcode_status')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('get_bot_qrcode')).length, 1);
  assert.equal((await f.channel.status()).ownerBound, false);
});

test('official pending states remain pending after local wait without a refresh', async t => {
  for (const status of ['wait', 'scaned']) {
    const f = fixture(t, options => options.url.includes('get_qrcode_status') ? response({status}) : undefined);
    await f.channel.beginLogin(); f.tick(300001);
    const result = await f.channel.pollLogin();
    assert.deepEqual(result, {state:'waiting_for_scan'});
    assert.equal(f.calls.filter(c => c.url.includes('get_qrcode_status')).length, 1);
    assert.equal(f.calls.filter(c => c.url.includes('get_bot_qrcode')).length, 1);
    assert.equal((await f.channel.status()).ownerBound, false);
    noPrivate(result);
  }
});

test('raw uint64 IDs retain exact adjacent decimals through owner correlation, dedupe and send receipt', async t => {
  const first = '18446744073709551600', second = '18446744073709551601', foreign = '18446744073709551599', reply = '18446744073709551615';
  const item = (from, id, contextValue) => '{"from_user_id":'+JSON.stringify(from)+',"to_user_id":'+JSON.stringify(bot)+',"message_type":1,"message_id":'+id+',"context_token":'+JSON.stringify(contextValue)+',"item_list":[{"type":1,"text_item":{"text":"unrelated-private-text"}}]}';
  const raw = '{"ret":0,"msgs":['+item('other@im.wechat',foreign,'unrelated-private-context')+','+item(owner,first,'first-owner-context')+','+item(owner,second,context)+'],"get_updates_buf":"uint64-cursor"}';
  const f = fixture(t, options => options.url.includes('getupdates') ? {statusCode:200,body:Buffer.from(raw)} : options.url.includes('sendmessage') ? {statusCode:200,body:'{"ret":0,"message_id":'+reply+'}'} : undefined);
  let parsedReply;
  const originalCall = f.channel._call.bind(f.channel);
  f.channel._call = async (...args) => {const result=await originalCall(...args);if(args[1]==='ilink/bot/sendmessage')parsedReply=result.message_id;return result;};
  await f.ready();
  const file = path.join(f.stateDir,'weixin-channel.json');
  const stored = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(stored.context.messageId, second);
  assert.deepEqual(stored.seenOwnerIds, [first, second]);
  assert.equal(stored.context.token, context);
  assert.equal(JSON.stringify(stored).includes(foreign),false);
  assert.equal(JSON.stringify(stored).includes('unrelated-private'),false);
  const sent = await f.channel.sendNotification({notificationId:'uint64-notice',text:'合成精确编号测试'});
  assert.equal(sent.state,'accepted');assert.equal(parsedReply,reply);
  const calls = f.calls.length;
  assert.deepEqual(await f.restart().sendNotification({notificationId:'uint64-notice',text:'合成精确编号测试'}),sent);
  assert.equal(f.calls.length,calls);
  f.tick(1000);await f.restart().pollOwnerContext();
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).context.receivedAt,stored.context.receivedAt);
  assert.equal(f.calls.filter(c=>c.url.includes('sendmessage')).length,1);
  noPrivate(sent);
});

test('escaped message ID keys are recognized while similar strings are preserved byte-for-byte', async t => {
  const id = '18446744073709551600';
  const text = 'text "message_id":18446744073709551601 and {"message_id":1e20} with \\ and escaped quote "';
  const raw = '{"ret":0,"msgs":[{"from_user_id":'+JSON.stringify(owner)+',"message_type":1,"message\\u005fid":'+id+',"context_token":'+JSON.stringify(context)+',"item_list":[{"type":1,"text_item":{"text":'+JSON.stringify(text)+'}}]}]}';
  const f = fixture(t,options=>options.url.includes('getupdates')?{statusCode:200,body:raw}:undefined);
  const originalCall = f.channel._call.bind(f.channel);let parsed;
  f.channel._call = async (...args) => {const result=await originalCall(...args);if(args[1]==='ilink/bot/getupdates')parsed=result;return result;};
  await f.ready();
  assert.equal(parsed.msgs[0].message_id,id);
  assert.equal(parsed.msgs[0].item_list[0].text_item.text,text);
  assert.equal(parsed.ret,0);assert.equal(typeof parsed.ret,'number');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'weixin-channel.json'),'utf8')).context.messageId,id);
});

test('fractional, exponent, overflowing and malformed message IDs fail without mutating owner context', async t => {
  for (const literal of ['1.5','1e20','1e0','0.0','-1','-0','18446744073709551616','9007199254740992.0','01','NaN','Infinity','true','null','{}','[]','""']) {
    const raw = '{"ret":0,"msgs":[{"from_user_id":'+JSON.stringify(owner)+',"message_type":1,"message_id":'+literal+',"context_token":'+JSON.stringify(context)+',"item_list":[{"type":1,"text_item":{"text":"unrelated-private-text"}}]}]}';
    const f = fixture(t,options=>options.url.includes('getupdates')?{statusCode:200,body:raw}:undefined);
    await f.channel.beginLogin();await f.channel.pollLogin();
    const file=path.join(f.stateDir,'weixin-channel.json'),before=fs.readFileSync(file,'utf8');
    await assert.rejects(f.channel.pollOwnerContext(),error=>{assert.ok(['unsafe_message_id','invalid_response'].includes(error.code));noPrivate(error);return true;});
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
});

test('ret and errcode require exact bounded integer numbers instead of coerced or rounded success', async t => {
  for (const key of ['ret','errcode']) for (const literal of ['"0"','true','null','0.0','0e0','1e-999','9007199254740993','2147483649','-2147483649','{}','[]']) {
    const f=fixture(t,options=>options.url.includes('getupdates')?{statusCode:200,body:'{"'+key+'":'+literal+',"msgs":[]}'}:undefined);
    await f.channel.beginLogin();await f.channel.pollLogin();
    await assert.rejects(f.channel.pollOwnerContext(),error=>{assert.equal(error.code,'invalid_response');noPrivate(error);return true;});
    assert.equal((await f.channel.status()).contextReady,false);
  }
});
test('untrusted redirects and confirmed API origins fail closed; verification never submits guesses', async t => {
  for (const host of ['evil.example.test', 'ilinkai.weixin.qq.com.evil.test', 'evil.weixin.qq.com', 'user@ilinkai.weixin.qq.com', 'ilinkai.weixin.qq.com:444', 'ilinkai.weixin.qq.com/extra']) {
    const f = fixture(t, options => options.url.includes('get_qrcode_status') ? response({ status: 'scaned_but_redirect', redirect_host: host }) : undefined);
    await f.channel.beginLogin();
    await assert.rejects(f.channel.pollLogin(), { code: 'untrusted_host' });
    assert.equal(f.calls.length, 2);
  }
  const f = fixture(t, options => options.url.includes('get_qrcode_status') ? response({ status: 'need_verifycode' }) : undefined);
  await f.channel.beginLogin();
  assert.deepEqual(await f.channel.pollLogin(), { state: 'user_intervention_required', reason: 'need_verifycode' });
  assert.equal(f.calls.some(c => c.url.includes('verify_code=')), false);
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://a:b@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com?q=1']) assert.throws(() => officialBase(url), { code: 'untrusted_host' });
  assert.equal(officialBase('https://region.ilinkai.weixin.qq.com:443/'), 'https://region.ilinkai.weixin.qq.com');
});
test('intent exists before request; timeout is unknown and restart never resends', async t => {
  let stateDir;
  const f = fixture(t, options => {
    if (!options.url.includes('sendmessage')) return undefined;
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, 'weixin-channel.json'), 'utf8'));
    assert.equal(data.notifications['notice-timeout'].state, 'sending');
    assert.equal(data.notifications['notice-timeout'].clientId, JSON.parse(options.body).msg.client_id);
    throw new WeixinError('timeout');
  });
  stateDir = f.stateDir;
  await f.ready();
  const result = await f.channel.sendNotification({ notificationId: 'notice-timeout', text: '合成超时通知' });
  assert.deepEqual(result, { notificationId: 'notice-timeout', state: 'unknown', reason: 'timeout' });
  assert.deepEqual(await f.restart().sendNotification({ notificationId: 'notice-timeout', text: '合成超时通知' }), result);
  assert.equal(f.calls.filter(c => c.url.includes('sendmessage')).length, 1);
});
test('interrupted persisted sending recovers to unknown without a network request', async t => {
  const f = fixture(t);
  await f.ready();
  await f.channel.sendNotification({ notificationId: 'interrupted', text: '合成中断通知' });
  const file = path.join(f.stateDir, 'weixin-channel.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.notifications.interrupted.state = 'sending'; delete data.notifications.interrupted.acceptedAt;
  fs.writeFileSync(file, JSON.stringify(data));
  const before = f.calls.length;
  const result = await f.restart().sendNotification({ notificationId: 'interrupted', text: '合成中断通知' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'interrupted');
  assert.equal(f.calls.length, before);
});
test('errors, oversized replies and fractional message IDs stay redacted and do not claim acceptance', async t => {
  for (const kind of ['network', 'parse', 'oversized', 'fractional-id', 'ret-error', 'redirect']) {
    const f = fixture(t, options => {
      if (!options.url.includes('sendmessage')) return undefined;
      if (kind === 'network') throw new Error(`${token} ${owner} unrelated-private-text`);
      if (kind === 'parse') return { statusCode: 200, body: `${token} unrelated-private-text` };
      if (kind === 'oversized') return { statusCode: 200, body: 'x'.repeat(1024 * 1024 + 1) };
      if (kind === 'fractional-id') return { statusCode: 200, body: '{"ret":0,"message_id":1.5}' };
      if (kind === 'ret-error') return response({ ret: 9, errmsg: `${token} ${owner}` });
      return { statusCode: 302, body: 'unrelated-private-text' };
    });
    await f.ready();
    const result = await f.channel.sendNotification({ notificationId: `failure-${kind}`, text: '合成失败通知' });
    assert.equal(result.state, kind === 'ret-error' ? 'rejected' : 'unknown');
    noPrivate(result); noPrivate(await f.channel.status());
  }
});
test('relative, legacy bridge, public and symlink data directories are rejected', async t => {
  assert.throws(() => new WeixinChannel({ stateDir: 'relative' }), { code: 'invalid_state_dir' });
  assert.throws(() => new WeixinChannel({ stateDir: path.parse(root).root }), { code: 'invalid_state_dir' });
  for (const segment of ['.public', 'qianwen-dot-bridge', 'qianwen-dot-bridge-node16']) assert.throws(() => new WeixinChannel({ stateDir: path.join(root, segment, 'data') }), { code: 'invalid_state_dir' });
  const f = fixture(t);
  const target = path.join(f.stateDir, 'real'); fs.mkdirSync(target);
  const link = path.join(f.stateDir, 'linked'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new WeixinChannel({ stateDir: path.join(link, 'child') }), { code: 'unsafe_path' });
});
test('legacy marker files block an otherwise innocently named directory and its descendants', async t => {
  for (const marker of ['bridge.sqlite', 'credentials.json', 'pairing.json']) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.stateDir, marker), 'synthetic legacy material, never read');
    assert.throws(() => new WeixinChannel({ stateDir: f.stateDir }), { code: 'legacy_state_dir' });
    assert.throws(() => new WeixinChannel({ stateDir: path.join(f.stateDir, 'child') }), { code: 'legacy_state_dir' });
    assert.equal(fs.existsSync(path.join(f.stateDir, 'child')), false);
  }
});
test('capacity is checked before write and before HTTP; original state remains readable', async t => {
  const f = fixture(t);
  await f.ready();
  await f.channel.sendNotification({ notificationId: 'seed', text: '合成容量测试' });
  const file = path.join(f.stateDir, 'weixin-channel.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = state.notifications.seed;
  state.notifications = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`n-${i}`, record]));
  f.channel._save(state);
  const before = fs.readFileSync(file, 'utf8'), calls = f.calls.length;
  await assert.rejects(f.channel.sendNotification({ notificationId: 'one-too-many', text: '合成额外通知' }), { code: 'capacity_exceeded' });
  assert.equal(f.calls.length, calls);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => f.channel._save({ ...state, padding: 'x'.repeat(4 * 1024 * 1024) }), { code: 'capacity_exceeded' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await f.restart().status()).notifications.accepted, 10000);
});
test('private-looking corrupted state fields fail closed instead of reaching summaries', async t => {
  const f = fixture(t);
  await f.ready();
  const file = path.join(f.stateDir, 'weixin-channel.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.context.receivedAt = token;
  fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(f.restart().status(), error => { assert.equal(error.code, 'invalid_state'); noPrivate(error.message); return true; });
});
