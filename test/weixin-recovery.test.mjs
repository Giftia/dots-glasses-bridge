import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectRejectedPart,retryRejectedPart} from '../lib/weixin-recovery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WeixinChannel} from '../lib/weixin.mjs';
import {main as recoveryMain} from '../tools/recover-weixin.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){const sourceId='dots-'+'a'.repeat(64),text='synthetic unreceived reply',now=2000,updatedAt=1000;
 const plan={format:'dots-weixin-outbound-plan-v1',sourceId,sourceCursor:'MQ',parts:[text],contentHash:hash(text),nextPart:0,completed:false,blocked:{state:'rejected',reason:'remote_rejected',diagnostics:{ret:-2}}};
 const native={state:'rejected',reason:'remote_rejected',diagnostics:{ret:-2},textHash:hash(text),updatedAt};
 return {sourceId,now,updatedAt,plan,account:{binding:{ownerId:'synthetic-only'},context:{receivedAt:1500},notifications:{[sourceId+'-p1']:native}}};}
test('read-only recovery inspection does not send, save or claim delivery',async()=>{const f=fixture(),r=await retryRejectedPart({...f,operations:new Proxy({},{get(){throw Error('unexpected mutation');}})});assert.equal(r.status,'ready-for-one-explicit-retry');assert.equal(r.networkSendRequested,false);assert.equal(f.plan.blocked.state,'rejected');});
test('unknown, changed text, old context, wrong source, active send and an already attempted recovery are refused',()=>{
 for(const mutate of [f=>f.plan.blocked.state='unknown',f=>f.account.notifications[f.sourceId+'-p1'].state='unknown',f=>f.plan.parts[0]='changed',f=>f.account.context.receivedAt=999,f=>f.sourceId='dots-'+'b'.repeat(64),f=>f.account.notifications.other={state:'sending'},f=>f.account.notifications[f.sourceId+'-p1-recover1']={state:'accepted'},f=>f.now=700000]){const f=fixture();mutate(f);assert.throws(()=>inspectRejectedPart(f));}
});
test('explicit acknowledgement is required before any backup or send',async()=>{await assert.rejects(retryRejectedPart({...fixture(),apply:true}),{code:'EXPLICIT_RETRY_ACKNOWLEDGEMENT_REQUIRED'});});
test('one accepted new attempt retains original receipt, advances only that part, and never writes cursor',async()=>{
 const f=fixture(),old=structuredClone(f.account),calls=[];let saved;
 const operations={reserve:async()=>calls.push('reserve'),backup:async()=>calls.push('backup'),verifyUnchanged:async()=>calls.push('verify'),saveTransaction:async value=>calls.push(value.committed?'commit':'intent'),send:async value=>{calls.push('send');assert.equal(value.notificationId,f.sourceId+'-p1-recover1');return {state:'accepted'};},savePlan:async value=>{calls.push('plan');saved=value;}};
 const r=await retryRejectedPart({...f,apply:true,allowRetryRejected:true,operations});assert.deepEqual(calls,['reserve','backup','verify','intent','send','verify','plan','commit']);assert.deepEqual(f.account,old);assert.equal(saved.nextPart,1);assert.equal(saved.blocked,undefined);assert.equal(saved.completed,false);assert.equal(r.cursorChanged,false);assert.equal(r.taskRestarted,false);
});
test('another rejection or unknown preserves outbound pause without an additional send',async()=>{
 for(const state of ['rejected','unknown']){const f=fixture();let sends=0;const operations={reserve:async()=>{},backup:async()=>{},verifyUnchanged:async()=>{},saveTransaction:async()=>{},send:async()=>{sends++;return {state};},savePlan:async()=>assert.fail('must not unblock')};const r=await retryRejectedPart({...f,apply:true,allowRetryRejected:true,operations});assert.equal(sends,1);assert.equal(r.retryState,state);assert.equal(f.plan.blocked.state,'rejected');}
});
test('backup failure or plan change prevents a network request',async()=>{
 for(const stage of ['backup','verifyUnchanged']){let sends=0;const operations={reserve:async()=>{},backup:async()=>{},verifyUnchanged:async()=>{},saveTransaction:async()=>{},send:async()=>{sends++;return {state:'accepted'};}};operations[stage]=async()=>{throw Error('synthetic interruption');};await assert.rejects(retryRejectedPart({...fixture(),apply:true,allowRetryRejected:true,operations}));assert.equal(sends,0);}
});
test('recovery uses real native persistence and preserves the original rejection for accepted, rejected and unknown replies',async t=>{
 for(const [body,state] of [['{}','accepted'],['{"ret":-2}','rejected'],['malformed','unknown']]){
  const f=fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dots-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const oldId=f.sourceId+'-p1';
  const original={...f.account.notifications[oldId],clientId:'xdn-'+'a'.repeat(32),createdAt:900};
  const account={version:1,binding:{token:'synthetic-token',ownerId:'synthetic-owner',botId:'synthetic-bot',baseUrl:'https://ilinkai.weixin.qq.com'},login:null,context:{token:'synthetic-context',receivedAt:1500,messageId:'1'},cursor:'',seenOwnerIds:[],inbox:[],notifications:{[oldId]:original}};
  const file=path.join(directory,'weixin-channel.json');fs.writeFileSync(file,JSON.stringify(account));let requests=0,saved;
  const channel=new WeixinChannel({stateDir:directory,now:()=>2000,request:async request=>{requests++;const msg=JSON.parse(request.body).msg;assert.equal(msg.to_user_id,'synthetic-owner');assert.equal(msg.context_token,'synthetic-context');assert.equal(msg.item_list[0].text_item.text,f.plan.parts[0]);return {statusCode:200,body};}});
  const operations={reserve:async()=>{},backup:async()=>{},verifyUnchanged:async()=>{},saveTransaction:async()=>{},send:value=>channel.sendNotification(value),savePlan:async value=>saved=value};
  const result=await retryRejectedPart({...f,account,apply:true,allowRetryRejected:true,operations});
  const current=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(current.notifications[oldId],original);assert.equal(current.notifications[oldId+'-recover1'].state,state);assert.equal(requests,1);assert.equal(result.retryState,state);assert.equal(saved?.nextPart,state==='accepted'?1:undefined);
  if(state!=='accepted')assert.throws(()=>inspectRejectedPart({...f,account:current}),{code:'RECOVERY_ALREADY_ATTEMPTED'});
 }
});
test('recovery CLI filesystem transaction is read-only by default and commits one backed-up part without restarting or changing cursor',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dots-recovery-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const relay=path.join(root,'relay'),channel=path.join(root,'channel'),runtime=path.join(root,'runtime');for(const directory of [relay,channel,runtime,path.join(runtime,'lib')])fs.mkdirSync(directory);
 const f=fixture();f.updatedAt=Date.now()-2000;f.account.context.receivedAt=Date.now()-1000;f.account.notifications[f.sourceId+'-p1'].updatedAt=f.updatedAt;
 const planFile=path.join(relay,'outbound-plan.json'),accountFile=path.join(channel,'weixin-channel.json'),cursorFile=path.join(relay,'cursor.json');
 fs.writeFileSync(planFile,JSON.stringify(f.plan));fs.writeFileSync(accountFile,JSON.stringify(f.account));fs.writeFileSync(cursorFile,'unchanged-cursor');
 // The filesystem orchestration test does not contact WeChat. The preceding
 // integration test separately exercises the real native channel persistence.
 fs.writeFileSync(path.join(runtime,'lib/weixin.mjs'),`import fs from 'node:fs';import path from 'node:path';export class WeixinChannel{constructor({stateDir}){this.file=path.join(stateDir,'weixin-channel.json');}async sendNotification(value){const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(data.notifications[value.notificationId])throw Error('unexpected duplicate');data.notifications[value.notificationId]={state:'accepted'};fs.writeFileSync(this.file,JSON.stringify(data));return {state:'accepted'};}}`);
 const args=['--relay-dir',relay,'--channel-dir',channel,'--runtime-root',runtime,'--source-id',f.sourceId,'--updated-at',String(f.updatedAt)];
 assert.equal((await recoveryMain(args)).status,'ready-for-one-explicit-retry');assert.deepEqual(fs.readdirSync(relay).sort(),['cursor.json','outbound-plan.json']);
 const result=await recoveryMain([...args,'--apply','--allow-retry-rejected']);assert.equal(result.status,'one-part-accepted-forwarder-unblocked');
 const backup=path.dirname(result.backupManifest);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup,'outbound-plan.before.json'),'utf8')),f.plan);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup,'rejected-native.before.json'),'utf8')),f.account.notifications[f.sourceId+'-p1']);
 const transaction=JSON.parse(fs.readFileSync(path.join(backup,'RECOVERY-RECEIPT.json'),'utf8'));assert.equal(transaction.committed,true);assert.equal(transaction.sendReserved,true);assert.equal(fs.readFileSync(cursorFile,'utf8'),'unchanged-cursor');assert.equal(fs.existsSync(path.join(relay,'recovery.lock')),false);
 const next=JSON.parse(fs.readFileSync(planFile,'utf8'));assert.equal(next.nextPart,1);assert.equal(next.blocked,undefined);await assert.rejects(recoveryMain([...args,'--apply','--allow-retry-rejected']),{code:'EXACT_REJECTED_PLAN_REQUIRED'});
});
