import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {status} from '../tools/status-weixin.mjs';
test('live status reads safe fields without locks, mutations, payloads, identifiers or credentials',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dots-status-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const relay=path.join(root,'relay'),channel=path.join(root,'channel');fs.mkdirSync(relay);fs.mkdirSync(channel);
 const files=[[relay,'receipt.json',{checkedAt:'2026-01-01T00:00:00.000Z',state:'outbound_blocked',secret:'must-not-display'}],[relay,'outbound-plan.json',{parts:['private-chat'],blocked:{state:'rejected',reason:'remote_rejected',diagnostics:{ret:-2,body:'private-response'}}}],[channel,'weixin-channel.json',{binding:{token:'private-token',ownerId:'private-id'},context:{token:'private-context',receivedAt:123},notifications:{one:{state:'rejected'}}}]];
 for(const [directory,name,value] of files)fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
 const before=files.map(([directory,name])=>fs.readFileSync(path.join(directory,name),'utf8'));
 const result=status(relay,channel),text=JSON.stringify(result);assert.equal(result.outboundBlocked,true);assert.equal(result.contextUpdatedAt,123);assert.equal(result.readOnly,true);assert.deepEqual(result.block.diagnostics,{ret:-2});assert.doesNotMatch(text,/private-|must-not-display/);
 assert.deepEqual(files.map(([directory,name])=>fs.readFileSync(path.join(directory,name),'utf8')),before);assert.deepEqual(fs.readdirSync(relay).sort(),['outbound-plan.json','receipt.json']);assert.deepEqual(fs.readdirSync(channel),['weixin-channel.json']);
});
