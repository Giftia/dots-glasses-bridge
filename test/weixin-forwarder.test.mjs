import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardBatch,validateConnection} from '../lib/weixin-forwarder.mjs';
const connection={format:'dots-weixin-relay-connection-v1',baseUrl:'https://dots.example.com/dots',since:1,token:'test'.repeat(12),after:'MA'};
const item=n=>({id:'dots-'+String(n).padStart(64,'0'),text:'真实回复 '+n,cursor:'cursor'+n,createdAt:n});
function fixture(items=[item(1),item(2)]){
  const sends=[],cursors=[];
  return {connection,fetch:async()=>({format:'dots-weixin-outbox-v1',items,hasMore:false}),channel:{status:async()=>({ownerBound:true,contextReady:true}),sendNotification:async value=>{sends.push(value);return {state:'accepted'};}},saveCursor:async value=>{cursors.push(value);},sends,cursors};
}
test('real reply text forwarded; cursor commits only after accepted',async()=>{const f=fixture();assert.equal((await forwardBatch(f)).accepted,2);assert.deepEqual(f.cursors,['cursor1','cursor2']);assert.equal(f.sends[0].text,'真实回复 1');});
test('unknown outcome stops without advancing or attempting next',async()=>{const f=fixture();f.channel.sendNotification=async()=>({state:'unknown'});assert.equal((await forwardBatch(f)).state,'unknown');assert.deepEqual(f.cursors,[]);});
test('missing owner context never sends',async()=>{const f=fixture();f.channel.status=async()=>({ownerBound:true,contextReady:false});assert.equal((await forwardBatch(f)).state,'waiting_for_owner_context');assert.equal(f.sends.length,0);});
test('invalid later item fails entire batch before any send',async()=>{const f=fixture([item(1),{...item(2),text:'x'.repeat(4001)}]);await assert.rejects(forwardBatch(f),/INVALID_FEED/);assert.equal(f.sends.length,0);});
test('bounded budget prevents starting a send and duplicate ids refused',async()=>{const f=fixture();f.budgetRemaining=()=>15000;assert.equal((await forwardBatch(f)).state,'budget_exhausted');assert.equal(f.sends.length,0);await assert.rejects(forwardBatch(fixture([item(1),item(1)])),/INVALID_FEED/);});
test('connection requires HTTPS dedicated token and no query credentials',()=>{for(const baseUrl of ['http://dots.example.com/dots','https://user:secret@dots.example.com/dots','https://dots.example.com/dots?token=x','https://dots.example.com/dots/'])assert.throws(()=>validateConnection({...connection,baseUrl}));assert.throws(()=>validateConnection({...connection,token:''}));});
test('crash after accepted send before cursor cannot duplicate delivery',async()=>{
  const f=fixture([item(1)]),ledger=new Map();let deliveries=0;
  f.channel.sendNotification=async value=>{if(!ledger.has(value.notificationId)){ledger.set(value.notificationId,value.text);deliveries++;}return {state:'accepted'};};
  f.saveCursor=async()=>{throw Error('synthetic disk failure');};await assert.rejects(forwardBatch(f),/disk failure/);
  f.saveCursor=async value=>f.cursors.push(value);await forwardBatch(f);assert.equal(deliveries,1);assert.equal(f.cursors.length,1);
});
