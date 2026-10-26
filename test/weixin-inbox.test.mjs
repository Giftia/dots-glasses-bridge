import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createCipheriv} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WeixinChannel} from '../lib/weixin.mjs';
import {downloadWeixinImage} from '../lib/weixin-media.mjs';

const owner='synthetic-owner',bot='synthetic-bot',token='synthetic-token';
const image={aeskey:'11'.repeat(16),media:{encrypt_query_param:'synthetic-query',aes_key:Buffer.alloc(16,2).toString('base64'),encrypt_type:0},thumb_media:{full_url:'private-thumbnail'},extra:'not-persisted'};
const message=(id,items=[{type:1,text_item:{text:'原始文字\n第二行'}}],extra={})=>({message_id:id,from_user_id:owner,to_user_id:bot,message_type:1,create_time_ms:2000,context_token:'synthetic-context-'+id,item_list:items,...extra});
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weixin-inbox-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let response={msgs:[],get_updates_buf:'new-cursor'};const calls=[];
  const request=async options=>{calls.push(options);return {statusCode:200,body:JSON.stringify(response)};};
  const file=path.join(directory,'weixin-channel.json');
  fs.writeFileSync(file,JSON.stringify({version:1,binding:{ownerId:owner,botId:bot,token,baseUrl:'https://ilinkai.weixin.qq.com'},login:null,context:null,cursor:'old-cursor',seenOwnerIds:[],notifications:{}}));
  const channel=new WeixinChannel({stateDir:directory,request,now:()=>3000});
  return {directory,file,channel,calls,set(value){response=value;},state:()=>JSON.parse(fs.readFileSync(file,'utf8')),restart:()=>new WeixinChannel({stateDir:directory,request,now:()=>4000})};
}
test('owner text and original photo commit atomically, survive restart, and expose no account credentials',async t=>{
  const f=fixture(t),id='18446744073709551615';
  f.set({msgs:[message(id,[{type:1,text_item:{text:'看看这张照片\n原话保留'}},{type:2,image_item:image}])],get_updates_buf:'committed'});
  assert.deepEqual(await f.channel.pollOwnerMessages({notBeforeMs:1500}),{state:'pending',pendingCount:1,skippedHistoricalCount:0});
  const [entry]=await f.restart().peekOwnerMessages();
  assert.deepEqual(entry,{messageId:id,requestId:'weixin-'+createHash('sha256').update(JSON.stringify([bot,owner,id])).digest('hex'),text:'看看这张照片\n原话保留',receivedAt:3000,createdAt:2000,image:{media:{encrypt_query_param:image.media.encrypt_query_param,aes_key:image.media.aes_key,encrypt_type:0},aeskey:image.aeskey}});
  assert.equal(f.state().cursor,'committed');assert.equal(f.state().context.messageId,id);
  const status=JSON.stringify(await f.restart().status());for(const value of [owner,bot,token,id,'看看这张照片'])assert.ok(!status.includes(value));
});
test('official empty optional photo fields normalize through durable inbox and actual streaming download',async t=>{
  const key=Buffer.alloc(16,17),plain=Buffer.from([137,80,78,71,13,10,26,10]),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const photos=[
    {aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic-query',full_url:''}},
    {aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic-query',aes_key:''}},
    {aeskey:'',media:{encrypt_query_param:'synthetic-query',aes_key:key.toString('base64')}},
    {aeskey:key.toString('hex'),media:{encrypt_query_param:'',full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=synthetic-query'}},
    {aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic-query',aes_key:'nonempty-secondary-ignored-with-valid-primary'}},
  ];
  for(const photo of photos){
    const f=fixture(t);f.set({msgs:[message('1',[{type:2,image_item:photo}])],get_updates_buf:'photo-normalized'});
    await f.channel.pollOwnerMessages();const [entry]=await f.restart().peekOwnerMessages();
    assert.equal(entry.error,undefined);assert.ok(entry.image);assert.ok(!Object.values(entry.image.media).includes(''));assert.notEqual(entry.image.aeskey,'');
    let requests=0;const request=(options,callback)=>{requests++;assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'novac2c.cdn.weixin.qq.com');const req=new EventEmitter();req.destroy=()=>req;req.end=()=>queueMicrotask(()=>{const stream=Readable.from([encrypted]);stream.statusCode=200;stream.headers={};callback(stream);});return req;};
    const result=await downloadWeixinImage(entry.image,{directory:f.directory,request,lookup:async()=>[{address:'8.8.8.8',family:4}]});
    assert.equal(requests,1);assert.deepEqual(fs.readFileSync(result.path),plain);result.cleanup();
    assert.equal(f.state().cursor,'photo-normalized');assert.deepEqual(f.state().inbox[0].image,entry.image);
  }
});
test('empty optional normalization does not admit null or wrong types, malformed nonempty URLs or bad primary keys',async t=>{
  for(const photo of [
    {aeskey:'11'.repeat(16),media:{encrypt_query_param:'synthetic',full_url:null}},
    {aeskey:'11'.repeat(16),media:{encrypt_query_param:'synthetic',aes_key:0}},
    {aeskey:null,media:{encrypt_query_param:'synthetic'}},
    {aeskey:'',media:{encrypt_query_param:'',full_url:'',aes_key:''}},
  ]){
    const f=fixture(t);f.set({msgs:[message('1',[{type:2,image_item:photo}])],get_updates_buf:'invalid-photo'});await f.channel.pollOwnerMessages();
    assert.equal((await f.channel.peekOwnerMessages())[0].error,'invalid_image');
  }
  for(const [photo,code]of [
    [{aeskey:'11'.repeat(16),media:{full_url:'https://other.invalid/c2c/download?encrypted_query_param=synthetic'}},'invalid_url'],
    [{aeskey:'zz'.repeat(16),media:{encrypt_query_param:'synthetic'}},'invalid_key'],
    [{aeskey:'11'.repeat(16),media:{full_url:' '}},'invalid_url'],
  ]){
    const f=fixture(t);f.set({msgs:[message('1',[{type:2,image_item:photo}])],get_updates_buf:'malformed-photo'});await f.channel.pollOwnerMessages();const [entry]=await f.channel.peekOwnerMessages();
    await assert.rejects(downloadWeixinImage(entry.image,{directory:f.directory,request:()=>assert.fail('unsafe photo must not start HTTP')}),{code});
  }
});
test('duplicate pages and acknowledged IDs cannot create a second inbox item',async t=>{
  const f=fixture(t);f.set({msgs:[message('12'),message('12')],get_updates_buf:'cursor1'});
  await f.channel.pollOwnerMessages();assert.equal((await f.channel.peekOwnerMessages()).length,1);
  await f.restart().pollOwnerMessages();assert.equal((await f.channel.peekOwnerMessages()).length,1);
  assert.equal((await f.channel.ackOwnerMessage({messageId:'unrelated'})).state,'not_pending');
  assert.equal((await f.channel.ackOwnerMessage({messageId:'12'})).state,'acknowledged');
  assert.ok(f.state().seenOwnerIds.includes('12'));await f.restart().pollOwnerMessages();assert.deepEqual(await f.channel.peekOwnerMessages(),[]);
});
test('only bound-owner direct user messages can enter inbox or change context',async t=>{
  const f=fixture(t);f.set({msgs:[message('1',undefined,{from_user_id:'outsider'}),message('2',undefined,{group_id:'group'}),message('3',undefined,{to_user_id:'other-bot'}),message('4',undefined,{message_type:2}),message('5',undefined,{message_type:3})],get_updates_buf:'filtered'});
  assert.equal((await f.channel.pollOwnerMessages()).pendingCount,0);assert.equal(f.state().context,null);assert.equal(f.state().cursor,'filtered');
});
test('official empty polls may omit msgs but malformed lists do not advance the cursor',async t=>{
  const f=fixture(t);f.set({get_updates_buf:'empty-poll'});
  assert.deepEqual(await f.channel.pollOwnerMessages(),{state:'idle',pendingCount:0,skippedHistoricalCount:0});assert.equal(f.state().cursor,'empty-poll');
  for(const msgs of [null,{},'invalid']){f.set({msgs,get_updates_buf:'invalid-poll'});await assert.rejects(f.channel.pollOwnerMessages(),{code:'invalid_response'});assert.equal(f.state().cursor,'empty-poll');}
});
test('cutover timestamp skips historical test messages and quarantines missing time instead of executing it',async t=>{
  const f=fixture(t);f.set({msgs:[message('1',[{type:1,text_item:{text:'测试'}}],{create_time_ms:1000}),message('2',undefined,{create_time_ms:undefined}),message('3',undefined,{create_time_ms:2000})],get_updates_buf:'after-history'});
  assert.deepEqual(await f.channel.pollOwnerMessages({notBeforeMs:1500}),{state:'pending',pendingCount:2,skippedHistoricalCount:1});
  const items=await f.channel.peekOwnerMessages({limit:64});assert.deepEqual(items.map(x=>[x.messageId,x.error]),[['2','missing_message_time'],['3',undefined]]);
  assert.ok(!JSON.stringify(items).includes('测试'));assert.equal(f.state().cursor,'after-history');
});
test('photo-only owner message refreshes context while unsupported and missing-ID messages are explicit error entries',async t=>{
  const f=fixture(t);f.set({msgs:[message('1',[{type:2,image_item:image}]),message('2',[{type:4,file_item:{name:'unsupported'}}]),message(undefined),message('4',[{type:2,image_item:image},{type:2,image_item:image}]),message('5',[{type:1,text_item:{text:'x'.repeat(12001)}}])],get_updates_buf:'errors-durable'});
  await f.channel.pollOwnerMessages();const items=await f.channel.peekOwnerMessages({limit:64});
  assert.equal(items[0].text,'');assert.ok(items[0].image);assert.equal(items[1].error,'unsupported_message');
  assert.equal(items[2].error,'missing_message_id');assert.equal(items[2].requestId,null);assert.match(items[2].messageId,/^invalid-[a-f0-9]{64}$/);
  assert.equal(items[3].error,'too_many_images');assert.equal(items[4].error,'invalid_text');
  assert.equal(f.state().context.messageId,'5');
});
test('save failure never acknowledges cursor or retains only half an inbox batch',async t=>{
  const f=fixture(t);f.set({msgs:[message('1')],get_updates_buf:'must-not-commit'});
  const original=f.channel._save.bind(f.channel);let saves=0;
  f.channel._save=data=>{if(++saves===2)throw Object.assign(new Error('injected storage failure'),{code:'storage_error'});return original(data);};
  await assert.rejects(f.channel.pollOwnerMessages(),{code:'storage_error'});
  assert.equal(f.state().cursor,'old-cursor');assert.deepEqual(f.state().inbox,[]);
  await f.restart().pollOwnerMessages();assert.equal(f.state().inbox.length,1);assert.equal(f.state().cursor,'must-not-commit');
});
test('process exit before the replacement preserves the old cursor and leaves an explicit stale lock',t=>{
  const f=fixture(t),code=`import{WeixinChannel}from ${JSON.stringify(new URL('../lib/weixin.mjs',import.meta.url).href)};const c=new WeixinChannel({stateDir:process.argv[1],request:async()=>({statusCode:200,body:${JSON.stringify(JSON.stringify({msgs:[message('1')],get_updates_buf:'not-committed'}))}})});let n=0;const save=c._save.bind(c);c._save=data=>{if(++n===2)process.exit(23);return save(data);};await c.pollOwnerMessages();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.directory],{encoding:'utf8'});assert.equal(child.status,23,child.stderr);
  assert.equal(f.state().cursor,'old-cursor');assert.deepEqual(f.state().inbox,[]);assert.ok(fs.existsSync(path.join(f.directory,'weixin-channel.lock')));
});
test('inbox capacity and conflict fail closed without cursor or context changes',async t=>{
  const f=fixture(t);f.set({msgs:Array.from({length:65},(_,i)=>message(String(i))),get_updates_buf:'overflow'});
  await assert.rejects(f.channel.pollOwnerMessages(),{code:'capacity_exceeded'});assert.equal(f.state().cursor,'old-cursor');assert.equal(f.state().inbox.length,0);
  f.set({msgs:[message('1')],get_updates_buf:'first'});await f.channel.pollOwnerMessages();
  f.set({msgs:[message('1',[{type:1,text_item:{text:'changed'}}])],get_updates_buf:'conflict'});
  await assert.rejects(f.channel.pollOwnerMessages(),{code:'inbox_conflict'});assert.equal(f.state().cursor,'first');
});
test('whole state budget failure retains the previously committed cursor',async t=>{
  const f=fixture(t),before=f.state();before.padding='x'.repeat(4*1024*1024-Buffer.byteLength(JSON.stringify(before))-180);fs.writeFileSync(f.file,JSON.stringify(before));
  f.set({msgs:[message('1',[{type:1,text_item:{text:'x'.repeat(1000)}}])],get_updates_buf:'overflow-state'});
  await assert.rejects(f.channel.pollOwnerMessages(),{code:'capacity_exceeded'});assert.equal(f.state().cursor,'old-cursor');
});
test('isolated runtime persists and reopens owner inbox with exact uint64 IDs',t=>{
  const f=fixture(t),root=fileURLToPath(new URL('../../../',import.meta.url));
  const node16=(process.env.DOTS_COMPAT_NODE || process.execPath);
  const code=`import {WeixinChannel} from ${JSON.stringify(new URL('../lib/weixin.mjs',import.meta.url).href)};import assert from 'node:assert/strict';const c=new WeixinChannel({stateDir:process.argv[1],request:async()=>({statusCode:200,body:'{"msgs":[{"message_id":18446744073709551615,"from_user_id":"${owner}","message_type":1,"create_time_ms":2000,"item_list":[{"type":1,"text_item":{"text":"Node16"}}]}],"get_updates_buf":"node16"}'})});await c.pollOwnerMessages({notBeforeMs:1500});const [m]=await c.peekOwnerMessages();assert.equal(m.messageId,'18446744073709551615');await c.ackOwnerMessage({messageId:m.messageId});assert.equal((await c.peekOwnerMessages()).length,0);`;
  const result=spawnSync(node16,['--input-type=module','-e',code,f.directory],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('isolated runtime normalizes all three optional-empty photo fixtures before streaming decryption',t=>{
  const f=fixture(t),root=fileURLToPath(new URL('../../../',import.meta.url)),key=Buffer.alloc(16,17),plain=Buffer.from([137,80,78,71,13,10,26,10]);
  const cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const photos=[{aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic',full_url:''}},{aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic',aes_key:''}},{aeskey:'',media:{encrypt_query_param:'synthetic',aes_key:key.toString('base64')}}];
  const response=JSON.stringify({msgs:photos.map((photo,i)=>message(String(i+1),[{type:2,image_item:photo}])),get_updates_buf:'normalized-node16'});
  const code=`import{WeixinChannel}from ${JSON.stringify(new URL('../lib/weixin.mjs',import.meta.url).href)};import{downloadWeixinImage}from ${JSON.stringify(new URL('../lib/weixin-media.mjs',import.meta.url).href)};import{Readable}from'node:stream';import{EventEmitter}from'node:events';import fs from'node:fs';import assert from'node:assert/strict';const c=new WeixinChannel({stateDir:process.argv[1],request:async()=>({statusCode:200,body:${JSON.stringify(response)}})});await c.pollOwnerMessages();const items=await c.peekOwnerMessages({limit:64});assert.equal(items.length,3);let requests=0;const request=(o,cb)=>{requests++;assert.equal(o.rejectUnauthorized,true);const r=new EventEmitter();r.destroy=()=>r;r.end=()=>queueMicrotask(()=>{const s=Readable.from([Buffer.from(${JSON.stringify(encrypted.toString('base64'))},'base64')]);s.statusCode=200;s.headers={};cb(s);});return r;};for(const item of items){assert.equal(item.error,undefined);assert.ok(!Object.values(item.image.media).includes(''));const r=await downloadWeixinImage(item.image,{directory:process.argv[1],request,lookup:async()=>[{address:'8.8.8.8',family:4}]});assert.equal(r.mimeType,'image/png');assert.equal(fs.readFileSync(r.path).length,8);r.cleanup();}assert.equal(requests,3);`;
  const result=spawnSync((process.env.DOTS_COMPAT_NODE || process.execPath),['--input-type=module','-e',code,f.directory],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
