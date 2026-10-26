import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../server.mjs';
import { MediaStore } from '../lib/media.mjs';
import { hashOwnerCode, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../lib/oauth.mjs';

const ROOT = resolve(tmpdir(), 'dots-public-weixin-backend-tests');
const BASE = 'https://dots.example.com/dots';
const OWNER = 'synthetic-weixin-owner-code_0123456789';
const VERIFIER = 'synthetic-weixin-pkce_'.repeat(3);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2sAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([255,216,255,224,0,16,255,217]);
const WEBP = Buffer.from('RIFF\x04\0\0\0WEBP', 'binary');
const oldScopes = 'glasses:read glasses:reply glasses:notify events:subscribe';
const newScopes = 'messages:read messages:reply events:subscribe';
const idFor = text => 'weixin-' + createHash('sha256').update(text).digest('hex');
const image = (bytes=PNG,mime_type='image/png') => ({ mime_type, base64: bytes.toString('base64') });

async function fixture(t, { enabled=true } = {}) {
  mkdirSync(ROOT,{recursive:true});const dir=mkdtempSync(join(ROOT,'case-'));
  let app,port,rpcId=0,clock=1790000000000;
  const audits=[],deliveries=[],verified=[],mediaRequests=[];
  const config={publicBaseUrl:BASE,dataDir:dir,listenHost:'127.0.0.1',port:17326,platformToken:randomBytes(32).toString('base64url'),weixinRelayToken:randomBytes(32).toString('base64url'),ownerCodeHash:hashOwnerCode(OWNER)};
  if(enabled)config.weixinIngressToken=randomBytes(32).toString('base64url');
  const mediaRequest=(options,callback)=>{
    const request=new EventEmitter();request.destroy=()=>{};
    request.end=()=>setImmediate(()=>{
      mediaRequests.push(options);
      const bytes=options.path.includes('second')?JPEG:PNG;
      const response=Readable.from([bytes]);response.statusCode=200;
      response.headers={'content-type':options.path.includes('second')?'image/jpeg':'image/png'};callback(response);
    });return request;
  };
  const dependencies={now:()=>clock,eventAudit:row=>audits.push(row),transport:{verifyCallback:async sub=>{verified.push(sub);return{verified:true,status:200};},sendEvent:async(sub,event)=>{deliveries.push({sub,event});return{accepted:true,status:202};}}};
  async function open(){
    dependencies.media=new MediaStore(dir,{now:()=>clock,lookup:async()=>[{address:'8.8.8.8',family:4}],request:mediaRequest});
    app=createApp(config,dependencies);
    await new Promise((done,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',done);});port=app.server.address().port;
  }
  async function close(){if(app?.server.listening)await new Promise(done=>app.server.close(done));}
  t.after(async()=>{await close();assert.ok(resolve(dir).startsWith(resolve(ROOT)));rmSync(dir,{recursive:true,force:true});});
  await open();
  function request(path,{method='GET',json,raw,token,headers={},chunked=false}={}){
    const body=json===undefined?raw:JSON.stringify(json);
    return new Promise((done,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path,method,agent:false,headers:{Host:'dots.example.com',...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{...(chunked?{'Transfer-Encoding':'chunked'}:{'Content-Length':Buffer.byteLength(body)}),'Content-Type':'application/json'}:{}),...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');let value;try{value=JSON.parse(text);}catch{}done({status:res.statusCode,headers:res.headers,text,bytes,json:value});});
      });req.setTimeout(8000,()=>req.destroy(Error('local fixture timeout')));req.on('error',reject);req.end(body);
    });
  }
  const rpc=(method,params,token,glasses=false)=>request(glasses?'/dots/glasses/mcp':'/dots/mcp',{method:'POST',json:{jsonrpc:'2.0',id:++rpcId,method,params},token});
  const tool=(name,args,token)=>rpc('tools/call',{name,arguments:args},token);
  const glasses=(name,args={})=>rpc('tools/call',{name,arguments:args},config.platformToken,true);
  const inbox=(body,token=config.weixinIngressToken)=>request('/dots/weixin/inbox',{method:'POST',json:body,token});
  const auth=scope=>{
    const pending=app.oauth.beginAuthorization({client_id:CHATGPT_CLIENT_ID,redirect_uri:CHATGPT_REDIRECT_URI,resource:BASE+'/mcp',response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(VERIFIER).digest('base64url'),state:'fixture-weixin-state',scope});
    const completed=app.oauth.completeAuthorization({interactionId:pending.interactionId,sessionToken:pending.sessionToken,csrfToken:pending.csrfToken,pairingCode:OWNER,approved:true});
    return app.oauth.token({grant_type:'authorization_code',client_id:CHATGPT_CLIENT_ID,redirect_uri:CHATGPT_REDIRECT_URI,resource:BASE+'/mcp',code:new URL(completed.redirectUrl).searchParams.get('code'),code_verifier:VERIFIER});
  };
  return{config,dir,request,rpc,tool,glasses,inbox,auth,audits,deliveries,verified,mediaRequests,get app(){return app;},restart:async()=>{await close();await open();},advance:ms=>{clock+=ms;}};
}
function value(response){assert.equal(response.status,200);assert.equal(response.json.error,undefined);assert.equal(response.json.result.isError,false);return response.json.result.structuredContent;}
function denied(response,scope){assert.equal(response.status,200);assert.equal(response.json.result.isError,true);assert.match(response.json.result._meta['mcp/www_authenticate'][0],new RegExp('scope="'+scope+'"'));}
function subscription(name,channel){return{name,arguments:{channel},delivery:{mode:'webhook',url:'https://callback.example/synthetic',secret:'whsec_'+Buffer.alloc(32,3).toString('base64')}};}

test('full transcript outbox preserves long original replies only for the distinct duplex capability',async t=>{
  const f=await fixture(t),token=f.auth(newScopes).access_token,text='完整回复😀\n'.repeat(1000);
  value(await f.tool('publish_weixin_message',{message_id:'long-reply',text,kind:'reply'},token));
  for(const badToken of [f.config.weixinRelayToken,f.config.platformToken])assert.equal((await f.request('/dots/weixin/outbox?format=full-v1&after=MA',{token:badToken})).status,401);
  const full=await f.request('/dots/weixin/outbox?format=full-v1&after=MA',{token:f.config.weixinIngressToken});
  assert.equal(full.status,200);assert.equal(full.json.format,'dots-weixin-outbox-v2');assert.equal(full.json.items[0].text,'Dots 回复了：\n'+text);
  assert.equal((await f.request('/dots/weixin/outbox?format=full-v1&after=MA&since=0',{token:f.config.weixinIngressToken})).status,400);
  const legacy=await f.request('/dots/weixin/outbox?after=MA',{token:f.config.weixinRelayToken});assert.equal(legacy.status,200);assert.equal(legacy.json.items[0].text.length,4000);
});

test('ingress is opt-in with a distinct credential and does not grant OAuth, platform or legacy relay authority',async t=>{
  const disabled=await fixture(t,{enabled:false});
  assert.equal((await disabled.inbox({request_id:idFor('disabled'),message:'synthetic'})).status,404);
  const f=await fixture(t);
  for(const token of [undefined,f.config.platformToken,f.config.weixinRelayToken])assert.equal((await f.request('/dots/weixin/inbox',{method:'POST',token,json:{request_id:idFor('wrong'),message:'synthetic'}})).status,401);
  assert.equal((await f.rpc('initialize',{},f.config.weixinIngressToken)).status,401);
  assert.equal((await f.rpc('initialize',{},f.config.weixinIngressToken,true)).status,401);
  assert.equal((await f.request('/dots/weixin/result?task_id=QG-none',{token:f.config.weixinRelayToken})).status,401);
  for(const token of [f.config.platformToken,f.config.weixinRelayToken,'bad!'])assert.throws(()=>createApp({...f.config,weixinIngressToken:token}),/独立/);
  const old=f.auth(oldScopes);
  denied(await f.tool('list_pending_messages',{},old.access_token),'messages:read events:subscribe');
  const list=await f.rpc('tools/list',{},old.access_token);
  assert.equal(list.json.result.tools.find(tool=>tool.name==='read_message').securitySchemes[0].scopes[0],'messages:read');
});

test('text and original photo reach the original owner as a distinct WeChat event with persistent exact-byte idempotency',async t=>{
  const f=await fixture(t),tokens=f.auth(newScopes),original='  请看照片里的颜色和位置，不要只读文字。\n';
  const body={request_id:idFor('original-photo'),message:original,image:image()};
  const first=await f.inbox(body);assert.equal(first.status,200);assert.equal(first.json.deduplicated,false);
  const concurrent=await Promise.all(Array.from({length:4},()=>f.inbox(body)));
  assert.ok(concurrent.every(response=>response.json.task_id===first.json.task_id&&response.json.deduplicated===true));
  const task=f.app.store.view(first.json.task_id,'owner');assert.equal(task.channel,'weixin');assert.equal(task.message,original);
  assert.equal(task.images[0].sha256,createHash('sha256').update(PNG).digest('hex'));
  const read=await f.tool('read_message',{task_id:task.id},tokens.access_token);
  assert.equal(value(read).message,original);
  const actual=read.json.result.content.find(item=>item.type==='image');assert.deepEqual(Buffer.from(actual.data,'base64'),PNG);
  const event=f.app.store.read().events[0];assert.equal(event.name,'bridge.message.created');assert.deepEqual(event.data,{task_id:task.id,channel:'weixin'});
  assert.doesNotMatch(JSON.stringify(event),/base64|CDN|AES|颜色和位置/);
  assert.equal((await f.inbox(body)).json.task_id,task.id);assert.equal(f.app.media.readManifest().assets.length,1);
  await f.restart();
  const duplicate=await f.inbox(body);assert.equal(duplicate.json.task_id,task.id);assert.equal(duplicate.json.deduplicated,true);
  assert.equal(f.app.media.readManifest().assets.length,1);assert.equal(f.app.store.read().events.length,1);
  assert.equal(value(await f.tool('read_message',{task_id:task.id},tokens.access_token)).channel,'weixin');
  for(const conflict of [{...body,message:original+'其他'}, {...body,image:image(JPEG,'image/jpeg')}, {...body,image:undefined}])assert.equal((await f.inbox(conflict)).status,409);
  assert.equal(f.app.media.readManifest().assets.length,1);
});

test('unavailable WeChat attachment is a durable readable warning task with exact original text and strict wire validation',async t=>{
  const f=await fixture(t),tokens=f.auth(newScopes),message='  '+'原'.repeat(11996)+'\n ';
  const body={request_id:idFor('unavailable-photo'),message,input_error:'unavailable_attachment'};
  const first=await f.inbox(body);assert.equal(first.status,200);assert.equal(first.json.deduplicated,false);
  assert.equal(f.app.store.read().tasks[0].inputError,'unavailable_attachment');
  const read=await f.tool('read_message',{task_id:first.json.task_id},tokens.access_token);
  assert.equal(value(read).message,message);assert.equal(value(read).message.length,12000);
  assert.match(value(read).inputWarning,/未能取得可识别的原图/);assert.ok(!read.json.result.content.some(block=>block.type==='image'));
  assert.equal(f.app.media.readManifest().assets.length,0);
  await f.restart();
  const duplicate=await f.inbox(body);assert.equal(duplicate.status,200);assert.equal(duplicate.json.task_id,first.json.task_id);assert.equal(duplicate.json.deduplicated,true);
  assert.equal(f.app.store.read().events.length,1);
  for(const invalid of [{...body,input_error:'private_raw_error'},{...body,input_error:null},{...body,image:image()},{...body,input_error:{reason:'unavailable_attachment'}}])assert.equal((await f.inbox(invalid)).status,400);
  for(const conflict of [{...body,message:message.slice(1)},{request_id:body.request_id,message},{request_id:body.request_id,message,image:image()}])assert.equal((await f.inbox(conflict)).status,409);
  assert.equal(f.app.store.read().events.length,1);assert.equal(f.app.media.readManifest().assets.length,0);
});

test('lost photo receipt followed by expired attachment deduplicates to the original committed image and event',async t=>{
  const f=await fixture(t),tokens=f.auth(newScopes),body={request_id:idFor('photo-receipt-lost'),message:' 原始照片原话\n',image:image()};
  const first=await f.inbox(body);assert.equal(first.status,200);
  const original=f.app.store.view(first.json.task_id),before=readFileSync(f.app.store.path);
  await f.restart();
  const fallback={request_id:body.request_id,message:body.message,input_error:'unavailable_attachment'};
  const retry=await f.inbox(fallback);assert.equal(retry.status,200);assert.equal(retry.json.task_id,original.id);assert.equal(retry.json.deduplicated,true);
  assert.deepEqual(readFileSync(f.app.store.path),before);assert.deepEqual(f.app.store.view(original.id).images,original.images);
  assert.equal(f.app.store.view(original.id).inputWarning,undefined);assert.equal(f.app.store.read().events.length,1);assert.equal(f.app.media.readManifest().assets.length,1);
  const read=await f.tool('read_message',{task_id:original.id},tokens.access_token);
  assert.deepEqual(Buffer.from(read.json.result.content.find(block=>block.type==='image').data,'base64'),PNG);
  assert.equal((await f.inbox({...fallback,message:body.message.trim()})).status,409);
  const glasses=value(await f.glasses('send_to_assistant',{message:body.message,request_id:idFor('old-glasses-id')}));
  assert.equal((await f.inbox({...fallback,request_id:idFor('old-glasses-id'),message:glasses.message})).status,409);
});

test('legacy glasses and new message grants cannot cross channels or expose new WeChat notices',async t=>{
  const f=await fixture(t),old=f.auth(oldScopes),fresh=f.auth(newScopes);
  const weixin=(await f.inbox({request_id:idFor('isolation'),message:'微信私有消息',image:image()})).json.task_id;
  const glasses=value(await f.glasses('send_to_assistant',{message:'眼镜私有消息',request_id:'glasses-isolation'})).id;
  const pendingOld=value(await f.tool('list_pending_glasses_messages',{},old.access_token));assert.deepEqual(pendingOld.tasks.map(task=>task.id),[glasses]);
  const pendingNew=value(await f.tool('list_pending_messages',{},fresh.access_token));assert.deepEqual(pendingNew.tasks.map(task=>task.id),[weixin]);
  assert.ok((await f.tool('read_glasses_message',{task_id:weixin},old.access_token)).json.error);
  assert.ok((await f.tool('submit_glasses_reply',{task_id:weixin,reply_id:'cross-channel',text:'不应写入'},old.access_token)).json.error);
  assert.ok((await f.tool('read_message',{task_id:glasses},fresh.access_token)).json.error);
  assert.ok((await f.tool('submit_message_reply',{task_id:glasses,reply_id:'cross-channel-new',text:'不应写入'},fresh.access_token)).json.error);
  assert.ok((await f.glasses('query_assistant_result',{task_id:weixin})).json.error);
  assert.ok((await f.glasses('send_to_assistant',{message:'不应引用微信照片',source_task_id:weixin})).json.error);
  denied(await f.tool('submit_message_reply',{task_id:weixin,reply_id:'old-token',text:'不应写入'},old.access_token),'messages:reply');
  value(await f.tool('publish_weixin_message',{message_id:'synthetic-notice',text:'微信完整主动通知',kind:'decision'},fresh.access_token));
  assert.deepEqual(value(await f.glasses('query_assistant_notifications')).notifications,[]);
  assert.equal(f.app.store.listNotifications('owner','weixin').length,1);
  assert.equal(f.app.store.view(weixin).reply,null);assert.equal(f.app.store.view(glasses).reply,null);
});

test('new event subscriptions require the added read scope and never mix the old event filter',async t=>{
  const f=await fixture(t),old=f.auth(oldScopes),fresh=f.auth(newScopes),readOnly=f.auth('messages:read');
  const legacy=subscription('glasses.message.created','n1pro'),weixin=subscription('bridge.message.created','weixin');
  const forbidden=await f.rpc('events/subscribe',weixin,old.access_token);assert.equal(forbidden.status,403);assert.match(forbidden.headers['www-authenticate'],/messages:read/);
  assert.equal((await f.rpc('events/subscribe',weixin,readOnly.access_token)).status,403);
  assert.ok((await f.rpc('events/subscribe',{...weixin,arguments:{channel:'n1pro'}},fresh.access_token)).json.error);
  assert.ok((await f.rpc('events/subscribe',weixin,fresh.access_token)).json.result.id);
  assert.ok((await f.rpc('events/subscribe',legacy,old.access_token)).json.result.id);
  assert.equal(f.verified.length,2);
  const wx=(await f.inbox({request_id:idFor('event-one'),message:'微信合成消息'})).json.task_id;
  const eye=value(await f.glasses('send_to_assistant',{message:'眼镜合成消息'})).id;
  await f.app.dispatchPending();assert.equal(f.deliveries.length,2);
  assert.deepEqual(f.deliveries.map(row=>[row.event.name,row.event.data.task_id]),[['bridge.message.created',wx],['glasses.message.created',eye]]);
  assert.ok(f.deliveries.every(row=>row.sub.arguments.channel===row.event.data.channel));
  await f.inbox({request_id:idFor('event-revoked'),message:'撤销后不应送达'});
  f.app.oauth.revoke({token:fresh.refresh_token,client_id:CHATGPT_CLIENT_ID});
  await f.app.dispatchPending();assert.equal(f.deliveries.length,2);
  assert.equal(f.app.store.outgoingDeliveries().length,0);
});

test('WeChat background preparation declares and enforces joint scopes without creating a subscription or widening read tools',async t=>{
  const f=await fixture(t),read=f.auth('messages:read'),events=f.auth('events:subscribe'),joint=f.auth(newScopes),old=f.auth(oldScopes);
  const task=(await f.inbox({request_id:idFor('background-preparation'),message:'微信准备检查原话'})).json.task_id;
  const tools=(await f.rpc('tools/list',{},read.access_token)).json.result.tools;
  const preparation=tools.find(tool=>tool.name==='list_pending_messages');
  assert.deepEqual(preparation.securitySchemes,[{type:'oauth2',scopes:['messages:read','events:subscribe']}]);
  assert.equal(preparation.annotations.readOnlyHint,true);assert.match(preparation.description,/后台查收准备/);
  const union=[...new Set(tools.flatMap(tool=>tool.securitySchemes.flatMap(scheme=>scheme.scopes)))].sort();
  assert.deepEqual(union,['events:subscribe','glasses:notify','glasses:read','glasses:reply','messages:read','messages:reply']);
  assert.deepEqual(tools.find(tool=>tool.name==='read_message').securitySchemes[0].scopes,['messages:read']);
  assert.deepEqual(tools.find(tool=>tool.name==='submit_message_reply').securitySchemes[0].scopes,['messages:reply']);
  for(const token of [read.access_token,events.access_token,old.access_token])denied(await f.tool('list_pending_messages',{},token),'messages:read events:subscribe');
  const before=f.app.store.read();
  assert.deepEqual(value(await f.tool('list_pending_messages',{},joint.access_token)).tasks.map(entry=>entry.id),[task]);
  const after=f.app.store.read();assert.deepEqual(after,before);assert.equal(f.verified.length,0);
  assert.equal(value(await f.tool('read_message',{task_id:task},read.access_token)).message,'微信准备检查原话');
  const write=f.auth('messages:reply');
  assert.equal(value(await f.tool('submit_message_reply',{task_id:task,reply_id:'reply-without-events',text:'独立微信回复权限仍可回传'},write.access_token)).state,'replied');
  const eye=subscription('glasses.message.created','n1pro');
  assert.ok((await f.rpc('events/subscribe',eye,old.access_token)).json.result.id);
  const oldSubscription=f.app.store.read().subscriptions[0];
  assert.ok((await f.rpc('events/subscribe',subscription('bridge.message.created','weixin'),joint.access_token)).json.result.id);
  const subscriptions=f.app.store.read().subscriptions;assert.equal(subscriptions.length,2);
  assert.deepEqual(subscriptions.find(entry=>entry.name==='glasses.message.created'),oldSubscription);
  assert.deepEqual(subscriptions.find(entry=>entry.name==='bridge.message.created').arguments,{channel:'weixin'});
  assert.equal((await f.rpc('initialize',{},old.access_token)).status,200);
});

test('replies and full notices persist once, retaining old grant isolation across a restart',async t=>{
  const f=await fixture(t),tokens=f.auth(newScopes),old=f.auth(oldScopes);
  const task=(await f.inbox({request_id:idFor('reply-once'),message:'请处理微信消息'})).json.task_id;
  const args={task_id:task,reply_id:'weixin-reply-stable',text:'完整回复：'+ '原文内容。'.repeat(1200),summary:'已给出完整建议'};
  const first=value(await f.tool('submit_message_reply',args,tokens.access_token));assert.equal(first.deduplicated,false);
  assert.equal(value(await f.tool('submit_message_reply',args,tokens.access_token)).deduplicated,true);
  assert.equal(f.app.store.read().tasks[0].replies.length,1);
  const notice={message_id:'stable-notice-123',text:'  完整通知：'+'请确认处置方案。'.repeat(1000)+'\n',kind:'decision'};
  assert.equal(value(await f.tool('publish_weixin_message',notice,tokens.access_token)).deduplicated,false);
  assert.equal(value(await f.tool('publish_weixin_message',notice,tokens.access_token)).deduplicated,true);
  assert.ok((await f.tool('publish_weixin_message',{...notice,text:'冲突'},tokens.access_token)).json.error);
  assert.ok((await f.tool('publish_weixin_message',{...notice,text:notice.text.trim()},tokens.access_token)).json.error);
  await f.restart();
  assert.equal(value(await f.tool('submit_message_reply',args,tokens.access_token)).deduplicated,true);
  assert.equal(value(await f.tool('publish_weixin_message',notice,tokens.access_token)).deduplicated,true);
  const state=f.app.store.read();assert.equal(state.notifications.length,1);assert.equal(state.notifications[0].text,notice.text);assert.equal(state.tasks[0].reply,args.text);
  assert.equal(state.notifications[0].notificationId,'weixin-'+notice.message_id);
  assert.equal(state.notifications[0].channel,'weixin');
  denied(await f.tool('read_message',{task_id:task},old.access_token),'messages:read');
  assert.doesNotMatch(JSON.stringify(f.audits),/完整通知|原文内容|synthetic-weixin-owner|weixinIngressToken/);
});

test('result access returns only signed attachment metadata for the exact owner task and reply',async t=>{
  const f=await fixture(t),tokens=f.auth(newScopes);
  const task=(await f.inbox({request_id:idFor('result-photo'),message:'不要在结果端点泄露这条原话'})).json.task_id;
  const firstArgs={task_id:task,reply_id:'first-reply',text:'第一条私有完整回复',summary:'第一条摘要',files:[{file_id:'fixture-image-first',download_url:'https://files.example/first.png',mime_type:'image/png',file_name:'first.png'}]};
  value(await f.tool('submit_message_reply',firstArgs,tokens.access_token));
  const secondArgs={task_id:task,reply_id:'second-reply',text:'第二条私有完整回复',files:[{file_id:'fixture-image-second',download_url:'https://files.example/second.jpg',mime_type:'image/jpeg',file_name:'second.jpg'}]};
  value(await f.tool('submit_message_reply',secondArgs,tokens.access_token));
  const result=await f.request('/dots/weixin/result?task_id='+task+'&reply_id=first-reply',{token:f.config.weixinIngressToken});
  assert.equal(result.status,200);assert.equal(result.json.reply_id,'first-reply');assert.equal(result.json.attachments[0].fileName,'first.png');
  assert.doesNotMatch(result.text,/私有完整回复|不要在结果|platformToken|weixinIngressToken|\/private\//);
  assert.ok(result.json.resultUrl.startsWith(BASE+'/results/'));
  const page=await f.request(new URL(result.json.resultUrl).pathname+new URL(result.json.resultUrl).search);
  assert.match(page.text,/第一条私有完整回复/);assert.doesNotMatch(page.text,/第二条私有完整回复/);
  const picture=await f.request(new URL(result.json.attachments[0].url).pathname+new URL(result.json.attachments[0].url).search);assert.deepEqual(picture.bytes,PNG);
  const latest=await f.request('/dots/weixin/result?task_id='+task,{token:f.config.weixinIngressToken});assert.equal(latest.json.attachments[0].fileName,'second.jpg');
  const eye=f.app.store.enqueue({message:'眼镜原话',owner:'owner'});const meta=f.app.media.importBuffer({bytes:PNG,mimeType:'image/png'});
  f.app.store.submitReply({taskId:eye.id,replyId:'eye-attachments',text:'眼镜完整回复',files:[meta]});
  assert.equal((await f.request('/dots/weixin/result?task_id='+eye.id,{token:f.config.weixinIngressToken})).json.attachments.length,1);
  const other=f.app.store.enqueue({message:'other-owner-message',owner:'other',channel:'weixin'});
  assert.equal((await f.request('/dots/weixin/result?task_id='+other.id,{token:f.config.weixinIngressToken})).status,404);
  for(const query of ['','?task_id=latest','?task_id='+task+'&task_id='+task,'?task_id='+task+'&extra=1','?task_id='+task+'&reply_id=none','?task_id='+task+'&reply_id=first-reply&reply_id=second-reply']){
    assert.ok([400,404].includes((await f.request('/dots/weixin/result'+query,{token:f.config.weixinIngressToken})).status));
  }
});

test('photo bodies remain bounded, strict-base64 typed, one-image only, with no side effects on rejected input',async t=>{
  const f=await fixture(t),base={request_id:idFor('invalid'),message:'合成照片输入'};
  const invalid=[{...base,request_id:'weixin-short'}, {...base,image:{...image(),aes_key:'must-not-enter'}}, {...base,image:[image()]}, {...base,image:image(PNG,'image/jpeg')}, {...base,image:image(Buffer.from('not a picture'))}, {...base,image:{mime_type:'image/png',base64:'%%%not-base64'}}, {...base,image:{mime_type:'image/png',base64:'a==='}}, {...base,message:''}, {...base,message:'a'.repeat(12001)}, {...base,cdn_url:'must-not-enter'}];
  for(const body of invalid)assert.equal((await f.inbox(body)).status,400);
  const tooBig=Buffer.alloc(4*1024*1024+1,1);PNG.copy(tooBig);
  assert.equal((await f.inbox({...base,image:image(tooBig)})).status,413);
  assert.equal((await f.request('/dots/weixin/inbox',{method:'POST',raw:'x'.repeat(6*1024*1024+1),token:f.config.weixinIngressToken})).status,413);
  assert.equal((await f.request('/dots/weixin/inbox',{method:'POST',raw:'x'.repeat(6*1024*1024+1),chunked:true,token:f.config.weixinIngressToken})).status,413);
  assert.equal((await f.request('/dots/mcp',{method:'POST',raw:'x'.repeat(65537),token:f.auth(newScopes).access_token})).status,413);
  assert.equal(f.app.store.read().tasks.length,0);assert.equal(f.app.media.readManifest().assets.length,0);
  assert.equal((await f.request('/dots/weixin/inbox',{token:f.config.weixinIngressToken})).status,405);
  for(const [index,bytes,mime] of [[1,PNG,'image/png'],[2,JPEG,'image/jpeg'],[3,WEBP,'image/webp']])assert.equal((await f.inbox({request_id:idFor('type-'+index),message:'图片',image:image(bytes,mime)})).status,200);
});

test('failed task persistence compensates only the current imported photo and preserves old assets',async t=>{
  const f=await fixture(t);
  const old=(await f.inbox({request_id:idFor('old-asset'),message:'原先任务',image:image()})).json.task_id;
  const meta=f.app.store.view(old).images[0],oldBytes=readFileSync(join(f.app.media.dir,meta.id+'.bin'));
  const original=f.app.store.enqueue.bind(f.app.store);
  f.app.store.enqueue=()=>{throw Object.assign(Error('synthetic write failure'),{status:429});};
  const next={request_id:idFor('new-failing-asset'),message:'新任务',image:image(JPEG,'image/jpeg')};
  assert.equal((await f.inbox(next)).status,429);
  f.app.store.enqueue=original;
  assert.equal(f.app.media.readManifest().assets.length,1);assert.deepEqual(readFileSync(join(f.app.media.dir,meta.id+'.bin')),oldBytes);
  assert.equal(readdirSync(f.app.media.dir).filter(name=>name.endsWith('.bin')).length,1);
  assert.equal((await f.inbox(next)).status,200);assert.equal(f.app.media.readManifest().assets.length,2);
});

test('raw-buffer import validates quota and content and persists exact bytes through a restart',async t=>{
  const f=await fixture(t);const meta=f.app.media.importBuffer({bytes:PNG,mimeType:'image/png',owner:'alice',fileName:'微信原图.png'});
  assert.deepEqual(Buffer.from(f.app.media.readImage(meta.id,'alice').data,'base64'),PNG);
  assert.throws(()=>f.app.media.readImage(meta.id,'owner'));
  assert.throws(()=>f.app.media.importBuffer({bytes:PNG,mimeType:'image/jpeg'}),{reason:'type_mismatch'});
  assert.throws(()=>f.app.media.importBuffer({bytes:Buffer.alloc(4*1024*1024+1),mimeType:'image/png'}),{reason:'image_too_large'});
  await f.restart();assert.deepEqual(Buffer.from(f.app.media.readImage(meta.id,'alice').data,'base64'),PNG);
  const usage=f.app.media.usage.bind(f.app.media);f.app.media.usage=()=>64*1024*1024;
  assert.throws(()=>f.app.media.importBuffer({bytes:PNG,mimeType:'image/png'}),{reason:'quota_exceeded'});f.app.media.usage=usage;
  assert.equal(f.app.media.readManifest().assets.length,1);
});

test('consent names only requested WeChat purposes while legacy OAuth grants remain intact',async t=>{
  const f=await fixture(t),old=f.auth(oldScopes);
  const params=scope=>new URLSearchParams({client_id:CHATGPT_CLIENT_ID,redirect_uri:CHATGPT_REDIRECT_URI,resource:BASE+'/mcp',response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(VERIFIER).digest('base64url'),state:'consent-weixin-synthetic',scope});
  const read=await f.request('/dots/authorize?'+params('messages:read'));
  assert.match(read.text,/<title>连接 Dots 消息通道<\/title>/);assert.match(read.text,/<h1>连接原来的 Dot<\/h1>/);
  assert.match(read.text,/读取你通过微信交办的原话和照片/);assert.doesNotMatch(read.text,/回传微信任务的完整图文回复|后台事件订阅|眼镜通道权限/);
  const write=await f.request('/dots/authorize?'+params('messages:reply'));
  assert.match(write.text,/回传微信任务的完整图文回复/);
  const background=await f.request('/dots/authorize?'+params('messages:read events:subscribe'));
  assert.match(background.text,/后台事件订阅/);assert.match(background.text,/本次授权不会自动创建订阅/);
  const glasses=await f.request('/dots/authorize?'+params('glasses:read'));
  assert.match(glasses.text,/读取你通过眼镜交办的原话和照片/);assert.doesNotMatch(glasses.text,/微信通道权限|回传眼镜任务的完整图文回复|保存眼镜待通知摘要|后台事件订阅/);
  assert.equal(f.app.store.read().subscriptions.length,0);
  assert.equal((await f.rpc('initialize',{},old.access_token)).status,200);
  await f.restart();assert.equal((await f.rpc('initialize',{},old.access_token)).status,200);
  assert.equal(f.app.oauth.authenticate(old.access_token).scopes.includes('messages:read'),false);
  const metadata=(await f.request('/.well-known/oauth-authorization-server/dots')).json;
  assert.ok(metadata.scopes_supported.includes('messages:read'));assert.ok(metadata.scopes_supported.includes('messages:reply'));
});
