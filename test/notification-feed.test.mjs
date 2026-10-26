import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationFeed} from '../lib/notification-feed.mjs';
import {EventStore} from '../lib/store.mjs';
import fs from 'node:fs';
import path from 'node:path';
const fixture=()=>({tasks:[{id:'one',owner:'owner',message:'private original instruction',images:[{data:'secret photo'}],replies:[{replyId:'r1',text:'看到了照片。',createdAt:100},{replyId:'r2',text:'补充内容。',createdAt:100}]}],notifications:[]});
test('feed paginates same-time replies without losing or repeating them',()=>{
  const state=fixture();
  const a=notificationFeed(state,{limit:1}),b=notificationFeed(state,{limit:1,after:a.items[0].cursor});
  assert.equal(a.hasMore,true);assert.equal(b.hasMore,false);assert.notEqual(a.items[0].id,b.items[0].id);
  assert.equal(notificationFeed(state,{after:b.items[0].cursor}).items.length,0);
  assert.equal(notificationFeed(state,{since:101}).items.length,0);
});
test('feed exposes only owner committed reply text and stable ids',()=>{
  const s=fixture();s.tasks.push({...structuredClone(s.tasks[0]),owner:'other'});s.tasks.push({id:'pending',owner:'owner',replies:[]});
  const a=notificationFeed(s);assert.equal(a.items.length,2);assert.doesNotMatch(JSON.stringify(a),/secret|private|images|replyId/);
  assert.deepEqual(a,notificationFeed(s));assert.equal(a.items[0].text.startsWith('Dots 回复了：'),true);
});
test('notices and replies are included in chronological order',()=>{
  const s=fixture();s.notifications=[{owner:'owner',notificationId:'decision',text:'请选择处理方案',kind:'decision',createdAt:99},{owner:'other',notificationId:'x',text:'hidden',createdAt:99}];
  assert.equal(notificationFeed(s).items[0].kind,'decision');
});
test('feed rejects malformed cursors and limits and bounds long text',()=>{
  const state=fixture();
  for(const after of ['../x','e30',Buffer.from('[1,"bad"]').toString('base64url')])assert.throws(()=>notificationFeed(state,{after}));
  for(const limit of [0,21,1.1])assert.throws(()=>notificationFeed(state,{limit}));
  assert.throws(()=>notificationFeed(state,{since:NaN}));
  const s=fixture();s.tasks[0].replies[0].text='文'.repeat(32000);assert.equal(notificationFeed(s).items.find(x=>x.text.includes('…')).text.length,4000);
});
test('later commits in the same millisecond and clock rollback retain higher cursors across restart',t=>{
  const root=path.resolve('work/dots-notification-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'seq-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(root+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  let now=100;let store=new EventStore(dir,{now:()=>now});const task=store.enqueue({message:'same-clock'});
  store.submitReply({taskId:task.id,replyId:'r0',text:'first'});const first=notificationFeed(store.read()).items[0];
  store.submitReply({taskId:task.id,replyId:'r1',text:'same millisecond'});let next=notificationFeed(store.read(),{after:first.cursor});assert.equal(next.items.length,1);assert.match(next.items[0].text,/same millisecond/);
  now=50;store=new EventStore(dir,{now:()=>now});store.createNotification({notificationId:'rollback-clock',text:'new decision',kind:'decision'});
  next=notificationFeed(store.read(),{after:next.items[0].cursor,since:100});assert.equal(next.items.length,1);assert.match(next.items[0].text,/new decision/);
  assert.equal(notificationFeed(store.read(),{after:'MA',since:1000}).items.length,3,'zero cursor must override wall-clock filter even on first request');
});
