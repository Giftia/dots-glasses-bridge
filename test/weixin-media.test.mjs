import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createCipheriv,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {downloadWeixinImage} from '../lib/weixin-media.mjs';

const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic-test-image')]);
const key=Buffer.alloc(16,17),hex=key.toString('hex'),query='synthetic-private-download-query';
const image={aeskey:hex,media:{encrypt_query_param:query}};
const encrypt=bytes=>{const cipher=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([cipher.update(bytes),cipher.final()]);};
function fixture(t,bytes=encrypt(png),{status=200,headers={},networkError=false}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weixin-media-'));fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const calls=[];
  const lookup=async hostname=>{assert.equal(hostname,'novac2c.cdn.weixin.qq.com');return [{address:'8.8.8.8',family:4}];};
  const request=(options,callback)=>{
    calls.push(options);const req=new EventEmitter();let destroyed=false;
    req.destroy=()=>{destroyed=true;return req;};
    req.end=()=>queueMicrotask(()=>{
      if(destroyed)return;
      if(networkError){req.emit('error',Object.assign(new Error('synthetic-private-network-detail'),{code:'CERT_HAS_EXPIRED'}));return;}
      const chunks=[];for(let i=0;i<bytes.length;i+=1021)chunks.push(bytes.subarray(i,i+1021));
      const response=Readable.from(chunks);response.statusCode=status;response.headers=headers;callback(response);
    });return req;
  };
  return {directory,lookup,request,calls,files:()=>fs.readdirSync(directory)};
}
test('original image streams through AES, pins public DNS and TLS, and returns only private temp metadata',async t=>{
  const f=fixture(t),result=await downloadWeixinImage(image,f);
  assert.equal(result.mimeType,'image/png');assert.equal(result.size,png.length);assert.equal(result.sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual(fs.readFileSync(result.path),png);
  const [options]=f.calls;assert.equal(options.hostname,'novac2c.cdn.weixin.qq.com');assert.equal(options.servername,options.hostname);assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(options.port,443);
  assert.equal(new URL('https://'+options.hostname+options.path).searchParams.get('encrypted_query_param'),query);
  assert.ok(!JSON.stringify(options.headers).includes('Authorization'));let pinned;options.lookup(options.hostname,{},(...args)=>{pinned=args;});assert.deepEqual(pinned,[null,'8.8.8.8',4]);
  result.cleanup();result.cleanup();assert.deepEqual(f.files(),[]);
});
test('official full URL takes precedence and preserves opaque signed search bytes without guessing parameter names',async t=>{
  for(const search of ['?encrypted_query_param=synthetic%2F%2b%3D&opaque_a=A+B%20C&opaque_a=%2f&opaque_b=%26%3d','?opaque_b=%2f%2B%3D&opaque_a=H+I%20J','?encrypted_query_param=a&encrypted_query_param=b&opaque_a=1']){
    const f=fixture(t),full_url='https://novac2c.cdn.weixin.qq.com/c2c/download'+search;
    let result;
    try{result=await downloadWeixinImage({aeskey:hex,media:{full_url,encrypt_query_param:'fallback-must-not-be-used'}},f);}
    catch(error){assert.equal(f.calls.length,0,'red fixture rejects the official full URL before any HTTP');throw error;}
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/c2c/download'+search);assert.equal(f.calls[0].rejectUnauthorized,true);assert.equal(f.calls[0].servername,'novac2c.cdn.weixin.qq.com');assert.ok(!JSON.stringify(f.calls[0].headers).includes('Authorization'));
    assert.deepEqual(fs.readFileSync(result.path),png);result.cleanup();assert.deepEqual(f.files(),[]);
  }
});
test('fallback construction still carries exactly one encoded download parameter',async t=>{
  const f=fixture(t),raw='synthetic&opaque=extra+%2f',result=await downloadWeixinImage({aeskey:hex,media:{encrypt_query_param:raw}},f);
  const url=new URL('https://novac2c.cdn.weixin.qq.com'+f.calls[0].path);assert.deepEqual([...url.searchParams.keys()],['encrypted_query_param']);assert.equal(url.searchParams.get('encrypted_query_param'),raw);result.cleanup();
});
test('raw and hex-text base64 AES keys, hex priority, plaintext, JPEG and WebP are supported',async t=>{
  for(const encoded of [key.toString('base64'),Buffer.from(hex,'ascii').toString('base64')]){
    const f=fixture(t),result=await downloadWeixinImage({media:{encrypt_query_param:query,aes_key:encoded}},f);assert.deepEqual(fs.readFileSync(result.path),png);result.cleanup();
  }
  const priority=fixture(t),p=await downloadWeixinImage({aeskey:hex,media:{encrypt_query_param:query,aes_key:'bad-key-ignored-because-hex-present'}},priority);p.cleanup();
  for(const [bytes,mimeType]of [[png,'image/png'],[Buffer.from([255,216,255,0,1]),'image/jpeg'],[Buffer.from('RIFF0000WEBPsynthetic'),'image/webp']]){
    const f=fixture(t,bytes),r=await downloadWeixinImage({media:{full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=test'}},f);assert.equal(r.mimeType,mimeType);r.cleanup();
  }
});
test('unsafe URL authorities, paths, fragments, absent search and invalid keys never start a request',async t=>{
  const f=fixture(t);
  for(const full_url of ['http://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x','https://evil.example/c2c/download?encrypted_query_param=x','https://novac2c.cdn.weixin.qq.com.evil.example/c2c/download?opaque=x','https://novac2c.cdn.weixin.qq.com/other?encrypted_query_param=x','https://novac2c.cdn.weixin.qq.com:8443/c2c/download?opaque=x','https://user:secret@novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x','https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x#secret','https://novac2c.cdn.weixin.qq.com/c2c/download','https://novac2c.cdn.weixin.qq.com/c2c/download?','https://novac2c.cdn.weixin.qq.com/c2c/download?opaque=raw space','https://novac2c.cdn.weixin.qq.com/c2c/download?opaque=raw\nnewline'])await assert.rejects(downloadWeixinImage({media:{full_url}},f),{code:'invalid_url'});
  for(const aeskey of ['00',hex+'11','zz'.repeat(16),null])await assert.rejects(downloadWeixinImage({aeskey,media:{encrypt_query_param:query}},f),{code:'invalid_key'});
  for(const aes_key of ['AA==','!',Buffer.alloc(15).toString('base64'),Buffer.from('z'.repeat(32)).toString('base64')])await assert.rejects(downloadWeixinImage({media:{encrypt_query_param:query,aes_key}},f),{code:'invalid_key'});
  assert.equal(f.calls.length,0);assert.deepEqual(f.files(),[]);
});
test('private, mixed public/private, mapped and invalid DNS answers cannot reach CDN',async t=>{
  const f=fixture(t);
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.2',family:4}],[{address:'::ffff:8.8.8.8',family:6}],[{address:'2001:db8::1',family:6}],[{address:'8.8.8.8',family:6}],[]])await assert.rejects(downloadWeixinImage(image,{...f,lookup:async()=>addresses}),{code:'non_public_address'});
  assert.equal(f.calls.length,0);assert.deepEqual(f.files(),[]);
});
test('DNS elapsed time is included in the absolute deadline, with no late outbound request',async t=>{
  const f=fixture(t);let clock=0;
  await assert.rejects(downloadWeixinImage(image,{...f,now:()=>clock,lookup:async()=>{clock=10001;return [{address:'8.8.8.8',family:4}];}}),{code:'timeout'});
  assert.equal(f.calls.length,0);assert.deepEqual(f.files(),[]);
});
test('stalled response stream hits the absolute deadline and leaves no plaintext file',async t=>{
  const f=fixture(t);let response;
  const request=(_options,callback)=>{const req=new EventEmitter();req.destroy=()=>req;req.end=()=>queueMicrotask(()=>{response=new Readable({read(){}});response.statusCode=200;response.headers={};callback(response);response.push(encrypt(png).subarray(0,16));});return req;};
  await assert.rejects(downloadWeixinImage(image,{...f,request}),{code:'timeout'});assert.equal(response.destroyed,true);assert.deepEqual(f.files(),[]);
});
test('redirects, compressed bodies, TLS errors and invalid content clean up their own temporary file',async t=>{
  for(const settings of [{status:302},{status:403},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'not-a-number'}},{networkError:true}]){
    const f=fixture(t,encrypt(png),settings);await assert.rejects(downloadWeixinImage(image,f),error=>{assert.ok(!error.message.includes(query));assert.ok(!error.message.includes(hex));return true;});assert.deepEqual(f.files(),[]);
  }
  for(const bytes of [Buffer.from('not an image'),Buffer.alloc(0)]){const f=fixture(t,encrypt(bytes));await assert.rejects(downloadWeixinImage(image,f),{code:'invalid_content'});assert.deepEqual(f.files(),[]);}
  for(const bytes of [Buffer.alloc(16),Buffer.alloc(17)]){
    const padding=fixture(t,bytes);await assert.rejects(downloadWeixinImage(image,padding),{code:'decrypt_failed'});assert.deepEqual(padding.files(),[]);
  }
  const network=fixture(t,encrypt(png),{networkError:true});await assert.rejects(downloadWeixinImage(image,network),{code:'download_failed'});assert.deepEqual(network.files(),[]);
});
test('expired and rejected media are terminal while throttling and server errors are safely retryable',async t=>{
  for(const [status,code]of [[404,'media_expired'],[410,'media_expired'],[400,'media_rejected'],[403,'media_rejected'],[429,'http_retryable'],[500,'http_retryable'],[503,'http_retryable']]){
    const f=fixture(t,Buffer.from('private-response-body'),{status});
    await assert.rejects(downloadWeixinImage(image,f),error=>{
      assert.equal(error.code,code);assert.equal(error.httpStatus,status);
      const safe=JSON.stringify(error);for(const secret of [query,hex,'private-response-body'])assert.ok(!safe.includes(secret));
      return true;
    });assert.deepEqual(f.files(),[]);
  }
});
test('cipher and plaintext limits are independently enforced without buffering whole responses',async t=>{
  const max=4*1024*1024;
  const header=fixture(t,encrypt(png),{headers:{'content-length':String(max+17)}});await assert.rejects(downloadWeixinImage(image,header),{code:'too_large'});assert.deepEqual(header.files(),[]);
  const cipher=fixture(t,Buffer.alloc(max+17));await assert.rejects(downloadWeixinImage(image,cipher),{code:'too_large'});assert.deepEqual(cipher.files(),[]);
  const plaintext=Buffer.alloc(max+1);png.copy(plaintext);const plain=fixture(t,encrypt(plaintext));await assert.rejects(downloadWeixinImage(image,plain),{code:'too_large'});assert.deepEqual(plain.files(),[]);
  const exact=Buffer.alloc(max);png.copy(exact);const f=fixture(t,encrypt(exact)),result=await downloadWeixinImage(image,f);assert.equal(result.size,max);result.cleanup();
});
test('cleanup never deletes a replacement file or any other file in the directory',async t=>{
  const f=fixture(t),r=await downloadWeixinImage(image,f),other=path.join(f.directory,'keep.txt');fs.writeFileSync(other,'keep');
  const moved=r.path+'.original';fs.renameSync(r.path,moved);fs.writeFileSync(r.path,'replacement');r.cleanup();assert.equal(fs.readFileSync(r.path,'utf8'),'replacement');assert.equal(fs.readFileSync(other,'utf8'),'keep');
});
test('isolated runtime downloads and decrypts through the streaming public-DNS pinned injection',t=>{
  const f=fixture(t),root=fileURLToPath(new URL('../../../',import.meta.url));
  const code=`import {downloadWeixinImage} from ${JSON.stringify(new URL('../lib/weixin-media.mjs',import.meta.url).href)};import{Readable}from'node:stream';import{EventEmitter}from'node:events';import fs from'node:fs';import assert from'node:assert/strict';let bytes=Buffer.from(process.argv[2],'base64');const request=(o,cb)=>{assert.equal(o.rejectUnauthorized,true);const r=new EventEmitter();r.destroy=()=>r;r.end=()=>queueMicrotask(()=>{const s=Readable.from([bytes]);s.statusCode=200;s.headers={};cb(s);});return r;};const options={directory:process.argv[1],request,lookup:async()=>[{address:'8.8.8.8',family:4}]};const r=await downloadWeixinImage(${JSON.stringify(image)},options);assert.equal(r.mimeType,'image/png');assert.equal(fs.readFileSync(r.path).length,${png.length});r.cleanup();for(const size of[16,17]){bytes=Buffer.alloc(size);await assert.rejects(downloadWeixinImage(${JSON.stringify(image)},options),{code:'decrypt_failed'});}assert.deepEqual(fs.readdirSync(process.argv[1]),[]);`;
  const result=spawnSync((process.env.DOTS_COMPAT_NODE || process.execPath),['--input-type=module','-e',code,f.directory,encrypt(png).toString('base64')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(f.files(),[]);
});
test('isolated runtime preserves signed full URL search and uses primary AES without the fallback parameter name',t=>{
  const f=fixture(t),root=fileURLToPath(new URL('../../../',import.meta.url)),search='?opaque_b=%2f%2B%3D&opaque_a=H+I%20J&opaque_a=%26%3d';
  const source={aeskey:hex,media:{full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download'+search,encrypt_query_param:'fallback-must-not-be-used'}};
  const code=`import{downloadWeixinImage}from ${JSON.stringify(new URL('../lib/weixin-media.mjs',import.meta.url).href)};import{Readable}from'node:stream';import{EventEmitter}from'node:events';import assert from'node:assert/strict';let calls=0;const request=(options,callback)=>{calls++;assert.equal(options.path,${JSON.stringify('/c2c/download'+search)});assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'novac2c.cdn.weixin.qq.com');let pinned;options.lookup('novac2c.cdn.weixin.qq.com',{},(...args)=>pinned=args);assert.deepEqual(pinned,[null,'8.8.8.8',4]);const r=new EventEmitter();r.destroy=()=>r;r.end=()=>queueMicrotask(()=>{const s=Readable.from([Buffer.from(process.argv[2],'base64')]);s.statusCode=200;s.headers={};callback(s);});return r;};const r=await downloadWeixinImage(${JSON.stringify(source)},{directory:process.argv[1],request,lookup:async()=>[{address:'8.8.8.8',family:4}]});assert.equal(r.mimeType,'image/png');assert.equal(calls,1);r.cleanup();`;
  const result=spawnSync((process.env.DOTS_COMPAT_NODE || process.execPath),['--input-type=module','-e',code,f.directory,encrypt(png).toString('base64')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(f.files(),[]);
});
