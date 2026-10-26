import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {splitWeixinText,forwardFullBatch,submitOwnerInbox,runDuplexLoop} from '../lib/weixin-duplex.mjs';
import {fullNotificationFeed} from '../lib/notification-feed.mjs';
const connection={format:'dots-weixin-inbound-v1',baseUrl:'https://dots.example.test/dots',token:'synthetic-only-'.repeat(4),activatedAt:100};
const clone=value=>JSON.parse(JSON.stringify(value));
const item=(sequence=1,text='full reply')=>({id:'dots-'+String(sequence).repeat(64),sequence,cursor:Buffer.from(JSON.stringify(sequence)).toString('base64url'),text,kind:'reply',createdAt:100,taskId:'QG-123456abcdef',replyId:'reply'+sequence,hasFiles:false});
function fixture(items=[item()]){
 let plan=null,cursor='MA';const sends=[],network=[],saved=[];const receipts=new Map();
 const f={connection,channel:{async sendNotification(value){sends.push(value);if(!receipts.has(value.notificationId)){network.push(value);receipts.set(value.notificationId,{state:'accepted'});}return receipts.get(value.notificationId);}},
 request:async()=>({format:'dots-weixin-outbox-v2',items:items.filter(value=>value.sequence>JSON.parse(Buffer.from(cursor,'base64url').toString())),hasMore:false}),
 loadPlan:()=>clone(plan),savePlan:value=>{plan=clone(value);},saveCursor:value=>{saved.push(value);cursor=value;},sends,network,saved,receipts,get plan(){return plan;},get cursor(){return cursor;}};
 return f;
}
test('full feed retains long text and specific attachment reply identity, excluding source photos and other owners',()=>{
 const text='正文😀\n'.repeat(5000),state={tasks:[{owner:'owner',id:'QG-123456abcdef',images:[{data:'PRIVATE INPUT'}],replies:[{replyId:'r1',text,createdAt:1,files:[{id:'old-file'}]}]},{owner:'other',replies:[]}],notifications:[]};
 const feed=fullNotificationFeed(state,{after:'MA'});
 assert.equal(feed.items[0].text,'Dots 回复了：\n'+text);assert.equal(feed.items[0].replyId,'r1');assert.equal(feed.items[0].hasFiles,true);
 assert.doesNotMatch(JSON.stringify(feed),/PRIVATE INPUT|images|old-file/);
 assert.throws(()=>fullNotificationFeed(state,{after:''}));
});
test('Unicode paragraphs split without dropping, changing or bisecting surrogate pairs',()=>{
 const text='甲'.repeat(3999)+'😀\n'+'乙'.repeat(7000)+'\n结束';
 const parts=splitWeixinText(text);assert.equal(parts.join(''),text);assert.ok(parts.every(part=>part.length<=4000));
 for(const part of parts){assert.ok(!/[\uD800-\uDBFF]$/.test(part));assert.ok(!/^[\uDC00-\uDFFF]/.test(part));}
});
test('all long reply parts must be accepted before advancing one source cursor',async()=>{
 const text='full '.repeat(1800),f=fixture([item(1,text)]);
 const result=await forwardFullBatch({...f,cursor:f.cursor});
 assert.equal(result.state,'forwarded');assert.equal(f.network.map(x=>x.text).join(''),text);assert.ok(f.network.length>1);assert.deepEqual(f.saved,['MQ']);assert.equal(f.plan.completed,true);
});
test('a crash after accepted send before saving plan reuses the same native id without a duplicate send',async()=>{
 const f=fixture([item(1,'a'.repeat(6000))]);let writes=0;
 await assert.rejects(forwardFullBatch({...f,cursor:f.cursor,savePlan:value=>{if(++writes===2)throw Error('disk error');return f.savePlan(value);}}));
 assert.equal(f.cursor,'MA');assert.equal(f.network.length,1);
 await forwardFullBatch({...f,cursor:f.cursor});assert.equal(f.network.length,2);assert.equal(f.cursor,'MQ');
 assert.equal(f.network[0].notificationId,f.sends[1].notificationId);
});
test('a crash after cursor commit finalizes the old plan before processing a new source',async()=>{
 const f=fixture([item(1)]);let failed=false;
 await assert.rejects(forwardFullBatch({...f,cursor:f.cursor,savePlan:value=>{if(value.completed&&!failed){failed=true;throw Error('disk error');}return f.savePlan(value);}}));
 assert.equal(f.cursor,'MQ');assert.equal(f.plan.completed,false);
 await forwardFullBatch({...f,cursor:f.cursor,request:async()=>({format:'dots-weixin-outbox-v2',items:[item(2)],hasMore:false})});
 assert.equal(f.cursor,'Mg');assert.equal(f.network.length,2);
});
test('unknown part stops and cannot advance cursor or send a later part',async()=>{
 const f=fixture([item(1,'a'.repeat(9000))]);f.channel.sendNotification=async value=>{f.sends.push(value);return {state:'unknown'};};
 const result=await forwardFullBatch({...f,cursor:f.cursor});assert.equal(result.state,'unknown');assert.equal(f.sends.length,1);assert.equal(f.cursor,'MA');assert.equal(f.plan.nextPart,0);
});
test('rejected and unknown outbound plans pause durably while the next owner text is submitted once',async()=>{
 for(const nativeState of ['rejected','unknown']){
  const signals=new EventEmitter(),receipts=[],parts=[],requests=[],cursorWrites=[];
  let plan=null,pending=[],polls=0,acks=0;
  const channel={
   peekOwnerMessages:async()=>clone(pending),
   pollOwnerMessages:async()=>{polls++;if(polls===2)pending=[{messageId:'2',requestId:'weixin-'+'b'.repeat(64),text:'自然追问，不需要触发词'}];return {state:pending.length?'pending':'idle',pendingCount:pending.length};},
   ackOwnerMessage:async()=>{acks++;pending=[];},
   sendNotification:async value=>{parts.push(value);return {state:nativeState,reason:'remote_rejected',diagnostics:{ret:-14,httpStatus:200,body:'private-response',networkCode:'private-network'},url:'private-url'};},
  };
  const options={connection,channel,cursor:'MA',signals,loadPlan:()=>clone(plan),savePlan:value=>{plan=clone(value);},saveCursor:value=>cursorWrites.push(value),saveReceipt:value=>receipts.push(value),downloadImage:()=>{},
   request:async(_cfg,target,options)=>{requests.push(target);if(target==='/weixin/inbox'){assert.equal(options.body.message,'自然追问，不需要触发词');return {task_id:'QG-123456abcdef',state:'queued',deduplicated:false};}return {format:'dots-weixin-outbox-v2',items:[item()],hasMore:false};},
   wait:async()=>{if(polls>=3)signals.emit('SIGTERM');},
  };
  assert.equal((await runDuplexLoop(options)).state,'stopped');
  assert.equal(parts.length,1);assert.equal(acks,1);assert.equal(requests.filter(x=>x==='/weixin/inbox').length,1);assert.equal(requests.filter(x=>x.startsWith('/weixin/outbox')).length,1);assert.deepEqual(cursorWrites,[]);
  assert.equal(plan.nextPart,0);assert.deepEqual(plan.blocked,{state:nativeState,reason:'remote_rejected',diagnostics:{httpStatus:200,ret:-14}});
  const blocked=receipts.filter(x=>x.state==='outbound_blocked');assert.equal(blocked.length,3);assert.ok(blocked.some(x=>x.inboundSubmitted===1));
  for(const value of blocked){assert.equal(value.nativeState,nativeState);assert.equal(value.nativeReason,'remote_rejected');assert.deepEqual(value.nativeDiagnostics,{httpStatus:200,ret:-14});}
  assert.doesNotMatch(JSON.stringify(receipts),/private-response|private-network|private-url|自然追问/);
  // A restart respects the durable pause before fetching or sending an outbox.
  let restartPolls=0;const restartSignals=new EventEmitter();
  await runDuplexLoop({...options,signals:restartSignals,channel:{...channel,pollOwnerMessages:async()=>{restartPolls++;return {state:'idle',pendingCount:0};}},wait:async()=>restartSignals.emit('SIGTERM')});
  assert.equal(restartPolls,1);assert.equal(parts.length,1);assert.equal(acks,1);assert.deepEqual(cursorWrites,[]);
 }
});
test('a crash before saving blocked plan reuses native receipt without repeating its network delivery',async()=>{
 const f=fixture([item()]),native=new Map();let attempts=0,network=0,failSave=true;
 f.channel.sendNotification=async value=>{attempts++;if(!native.has(value.notificationId)){network++;native.set(value.notificationId,{state:'unknown',reason:'timeout'});}return native.get(value.notificationId);};
 const save=value=>{if(value.blocked&&failSave){failSave=false;throw Error('disk failure before blocked commit');}f.savePlan(value);};
 await assert.rejects(forwardFullBatch({...f,cursor:f.cursor,savePlan:save}),/disk failure/);assert.equal(f.cursor,'MA');assert.equal(network,1);
 assert.equal((await forwardFullBatch({...f,cursor:f.cursor,savePlan:save})).state,'unknown');assert.equal(network,1);assert.equal(attempts,2);assert.deepEqual(f.saved,[]);
 assert.equal((await forwardFullBatch({...f,cursor:f.cursor})).outboundBlocked,true);assert.equal(attempts,2);assert.equal(network,1);assert.deepEqual(f.saved,[]);
});
test('attachment link is resolved for exact reply and persisted before any send, never regenerated on recovery',async()=>{
 const value={...item(),hasFiles:true},f=fixture([value]);let lookups=0;
 f.request=async(_connection,target)=>{
  if(target.startsWith('/weixin/result')){lookups++;assert.match(target,/reply_id=reply1/);return {task_id:value.taskId,reply_id:value.replyId,state:'replied',resultExpiresAt:200000,resultUrl:'https://dots.example.test/dots/results/'+value.taskId+'?task='+value.taskId+'&reply='+value.replyId+'&expires=200000&sig='+'a'.repeat(43)};}
  return {format:'dots-weixin-outbox-v2',items:[value],hasMore:false};
 };
 f.channel.sendNotification=async()=>({state:'unknown'});
 await forwardFullBatch({...f,cursor:f.cursor});await forwardFullBatch({...f,cursor:f.cursor});assert.equal(lookups,1);assert.match(f.plan.parts.join(''),/查看完整图文/);
});
test('a mismatched result reply or task capability cannot be sent to owner WeChat',async()=>{
 const value={...item(),hasFiles:true},f=fixture([value]);
 f.request=async(_config,target)=>target.startsWith('/weixin/result')?{task_id:value.taskId,reply_id:'wrong-reply',state:'replied',resultUrl:'https://dots.example.test/dots/results/QG-fedcba654321'}:{format:'dots-weixin-outbox-v2',items:[value],hasMore:false};
 await assert.rejects(forwardFullBatch({...f,cursor:f.cursor}),{code:'INVALID_RESULT_REFERENCE'});assert.equal(f.network.length,0);
});
test('older or reordered source sequence cannot replay historical replies',async()=>{
 const f=fixture();await assert.rejects(forwardFullBatch({...f,cursor:'Mg',request:async()=>({format:'dots-weixin-outbox-v2',items:[item(1)],hasMore:false})}),{code:'INVALID_OUTBOUND_CURSOR'});assert.equal(f.network.length,0);
});
test('owner original text and actual image bytes form one idempotent backend request, ack only after receipt',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dots-duplex-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'image.tmp'),bytes=Buffer.from([137,80,78,71]);fs.writeFileSync(file,bytes);
 const events=[],entry={messageId:'owner-message',requestId:'weixin-'+'a'.repeat(64),text:'  原话\n',image:{}};
 const channel={peekOwnerMessages:async()=>[entry],ackOwnerMessage:async()=>events.push('ack')};
 const downloadImage=async()=>({path:file,mimeType:'image/png',cleanup:()=>events.push('cleanup')});
 await submitOwnerInbox({connection,channel,downloadImage,request:async(_cfg,target,options)=>{assert.equal(target,'/weixin/inbox');assert.equal(options.body.message,'  原话\n');assert.equal(options.body.image.base64,bytes.toString('base64'));events.push('commit');return {task_id:'QG-123456abcdef',state:'queued',deduplicated:false};}});
 assert.deepEqual(events,['commit','ack','cleanup']);
 events.length=0;await assert.rejects(submitOwnerInbox({connection,channel,downloadImage,request:async()=>{throw Error('lost response');}}));assert.deepEqual(events,['cleanup']);
});
test('duplex retries only actual network read/idempotent-submit failures, not a same-named storage failure',async()=>{
 const make=()=>{
  const signals=new EventEmitter(),receipts=[],waits=[];
  return {connection,cursor:'MA',signals,channel:{peekOwnerMessages:async()=>[],pollOwnerMessages:async()=>({state:'idle',pendingCount:0})},loadPlan:()=>null,savePlan:()=>{},saveCursor:()=>{},saveReceipt:value=>receipts.push(value),downloadImage:()=>{},request:async()=>({format:'dots-weixin-outbox-v2',items:[],hasMore:false}),wait:async delay=>{waits.push(delay);signals.emit('SIGTERM');},receipts,waits};
 };
 const f=make();f.request=async()=>{throw Object.assign(Error('private details'),{code:'BRIDGE_NETWORK_ERROR'});};
 assert.equal((await runDuplexLoop(f)).state,'stopped');assert.deepEqual(f.waits,[15000]);assert.doesNotMatch(JSON.stringify(f.receipts),/private details|synthetic-only|https:/);
 const g=make();g.saveReceipt=()=>{throw Object.assign(Error('disk error'),{code:'BRIDGE_NETWORK_ERROR'});};
 await assert.rejects(runDuplexLoop(g),/disk error/);assert.deepEqual(g.waits,[]);
});
test('expired owner photo is persisted as an explicit backend failure task before ack, without native error sends',async()=>{
 const signals=new EventEmitter(),sent=[],receipts=[],committed=[],events=[];let pending=[{messageId:'1',requestId:'weixin-'+'a'.repeat(64),text:'看照片',image:{}}],plan=null;
 const channel={peekOwnerMessages:async()=>pending,ackOwnerMessage:async()=>{events.push('ack');pending=[];},pollOwnerMessages:async()=>({state:'idle',pendingCount:0}),sendNotification:async value=>{sent.push(value);return {state:'accepted'};}};
 const result=await runDuplexLoop({connection,channel,cursor:'MA',signals,loadPlan:()=>clone(plan),savePlan:value=>{plan=clone(value);},saveCursor:()=>{},saveReceipt:value=>receipts.push(value),downloadImage:async()=>{throw Object.assign(Error('private media URL'),{code:'media_expired'});},request:async(_cfg,target,options)=>{if(target==='/weixin/inbox'){committed.push(options.body);events.push('commit');return {task_id:'QG-123456abcdef',state:'queued',deduplicated:false};}return {format:'dots-weixin-outbox-v2',items:[item()],hasMore:false};},wait:async()=>signals.emit('SIGTERM')});
 assert.equal(result.state,'stopped');assert.equal(pending.length,0);assert.equal(sent.length,1);assert.equal(sent[0].text,'full reply');assert.deepEqual(committed,[{request_id:'weixin-'+'a'.repeat(64),message:'看照片',input_error:'unavailable_attachment'}]);assert.deepEqual(events,['commit','ack']);assert.doesNotMatch(JSON.stringify(receipts),/private media/);
});
test('blocked outbound still commits expired photo, unsupported item and complete 12000-character text without a native side channel',async()=>{
 const signals=new EventEmitter(),committed=[],sends=[],cursorWrites=[],receipts=[],complete='原话😀'.repeat(3000);assert.equal(complete.length,12000);
 const queue=[{messageId:'1',requestId:'weixin-'+'a'.repeat(64),text:complete,image:{}},{messageId:'2',requestId:'weixin-'+'b'.repeat(64),text:'这是我的完整原话',error:'unsupported_message'},{messageId:'3',requestId:'weixin-'+'c'.repeat(64),text:'继续正常追问'}];
 let pending=[],polls=0,plan=null;
 const channel={peekOwnerMessages:async()=>clone(pending),pollOwnerMessages:async()=>{polls++;if(polls>=2&&polls<=4)pending=[queue[polls-2]];return {state:pending.length?'pending':'idle',pendingCount:pending.length};},ackOwnerMessage:async()=>{assert.equal(committed.length,polls-1);pending=[];},sendNotification:async value=>{sends.push(value);return {state:'rejected',reason:'remote_rejected',diagnostics:{errcode:-14}};}};
 const result=await runDuplexLoop({connection,channel,cursor:'MA',signals,loadPlan:()=>clone(plan),savePlan:value=>{plan=clone(value);},saveCursor:value=>cursorWrites.push(value),saveReceipt:value=>receipts.push(value),downloadImage:async()=>{throw Object.assign(Error('private CDN detail'),{code:'media_expired'});},request:async(_cfg,target,options)=>{if(target==='/weixin/inbox'){committed.push(clone(options.body));return {task_id:'QG-'+String(committed.length).padStart(12,'0'),state:'queued',deduplicated:false};}return {format:'dots-weixin-outbox-v2',items:[item()],hasMore:false};},wait:async()=>{if(polls>=5)signals.emit('SIGTERM');}});
 assert.equal(result.state,'stopped');assert.equal(sends.length,1);assert.deepEqual(cursorWrites,[]);assert.equal(committed.length,3);
 assert.deepEqual(committed[0],{request_id:queue[0].requestId,message:complete,input_error:'unavailable_attachment'});
 assert.deepEqual(committed[1],{request_id:queue[1].requestId,message:queue[1].text,input_error:'unavailable_attachment'});
 assert.deepEqual(committed[2],{request_id:queue[2].requestId,message:queue[2].text});
 assert.equal(receipts.filter(x=>x.inboundSubmitted===1).length,3);assert.doesNotMatch(JSON.stringify(receipts),/private CDN|完整原话|继续正常追问/);
});
test('unknown error-task submission is never acknowledged and retries the exact same ID and full body',async()=>{
 const original='字'.repeat(12000),entry={messageId:'1',requestId:'weixin-'+'a'.repeat(64),text:original,error:'unsupported_message'},requests=[];let acks=0,first=true;
 const channel={peekOwnerMessages:async()=>[entry],ackOwnerMessage:async()=>{acks++;},sendNotification:()=>assert.fail('native error notification must never run')};
 const request=async(_cfg,target,options)=>{assert.equal(target,'/weixin/inbox');requests.push(clone(options.body));if(first){first=false;throw Object.assign(Error('response lost'),{code:'BRIDGE_TIMEOUT'});}return {task_id:'QG-123456abcdef',state:'queued',deduplicated:true};};
 await assert.rejects(submitOwnerInbox({connection,channel,request}),{code:'BRIDGE_TIMEOUT'});assert.equal(acks,0);
 await submitOwnerInbox({connection,channel,request});assert.equal(acks,1);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].message,original);assert.equal(requests[0].input_error,'unavailable_attachment');
});
test('photo-only commit with lost response and then expired CDN retains the same message for backend dedupe',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dots-photo-retry-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'original.tmp');fs.writeFileSync(file,Buffer.from([137,80,78,71]));
 const entry={messageId:'1',requestId:'weixin-'+'a'.repeat(64),text:'',image:{}},requests=[];let downloads=0,commits=0,acks=0;
 const channel={peekOwnerMessages:async()=>[entry],ackOwnerMessage:async()=>{acks++;},sendNotification:()=>assert.fail('native error report must not run')};
 const downloadImage=async()=>{if(++downloads===2)throw Object.assign(Error('expired'),{code:'media_expired'});return {path:file,mimeType:'image/png',cleanup:()=>fs.unlinkSync(file)};};
 const request=async(_cfg,_url,options)=>{
  requests.push(clone(options.body));
  if(requests.length===1){commits++;throw Object.assign(Error('committed but response lost'),{code:'BRIDGE_TIMEOUT'});}
  assert.equal(options.body.request_id,requests[0].request_id);assert.equal(options.body.message,requests[0].message);assert.equal(options.body.input_error,'unavailable_attachment');assert.equal(options.body.image,undefined);
  return {task_id:'QG-123456abcdef',state:'queued',deduplicated:true};
 };
 await assert.rejects(submitOwnerInbox({connection,channel,request,downloadImage}),{code:'BRIDGE_TIMEOUT'});assert.equal(acks,0);assert.equal(fs.existsSync(file),false);
 await submitOwnerInbox({connection,channel,request,downloadImage});assert.equal(acks,1);assert.equal(commits,1);assert.equal(requests[0].message,'我从微信发来一张照片，请结合我们的会话查看；如果用途不明确，请先问我。');assert.ok(requests[0].image);
});
test('missing original IDs use a deterministic error request and never submit the unverified payload',async()=>{
 const entry={messageId:'invalid-'+'d'.repeat(64),requestId:null,text:'unverified-private-instruction',error:'missing_message_id'},requests=[];let acks=0;
 const channel={peekOwnerMessages:async()=>[entry],ackOwnerMessage:async()=>{acks++;},sendNotification:()=>assert.fail('no native error report')};
 const request=async(_cfg,_target,options)=>{requests.push(clone(options.body));return {task_id:'QG-123456abcdef',state:'queued',deduplicated:requests.length>1};};
 await submitOwnerInbox({connection,channel,request});await submitOwnerInbox({connection,channel,request});
 assert.equal(acks,2);assert.match(requests[0].request_id,/^weixin-[a-f0-9]{64}$/);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].input_error,'unavailable_attachment');assert.doesNotMatch(requests[0].message,/unverified-private-instruction/);assert.match(requests[0].message,/未获得可识别原图/);
});
