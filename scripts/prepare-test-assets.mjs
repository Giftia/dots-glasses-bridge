import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MANAGED_PROXY_BINARY_SHA256} from '../lib/managed-webhook-proxy.mjs';

export const TEST_ASSET_URL='https://github.com/HyNetworks/hysteria/releases/download/app/v2.13.0/hysteria-linux-amd64';
export const TEST_ASSET_PATH=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.test-assets/hysteria-linux-amd64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareTestAsset(){
 const directory=path.dirname(TEST_ASSET_PATH);
 if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw Error('Unsafe test asset directory');
 if(fs.existsSync(TEST_ASSET_PATH)){
  const stat=fs.lstatSync(TEST_ASSET_PATH);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024||stat.nlink!==1||hash(fs.readFileSync(TEST_ASSET_PATH))!==MANAGED_PROXY_BINARY_SHA256)throw Error('Test asset failed verification; existing file preserved');
  return {cached:true,sha256:MANAGED_PROXY_BINARY_SHA256};
 }
 const allowed=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
 const deadline=Date.now()+120000;
 async function get(url,redirects=0){
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||target.port||!allowed.has(target.hostname)||redirects>4)throw Error('Untrusted official release redirect');
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{req.destroy();reject(Error('Official test asset download timed out'));},Math.max(1,deadline-Date.now()));
   const req=https.get(target,{headers:{'User-Agent':'dots-glasses-bridge-tests'},agent:false},res=>{
    if([301,302,303,307,308].includes(res.statusCode)){res.resume();clearTimeout(timer);if(!res.headers.location)return reject(Error('Invalid release redirect'));get(new URL(res.headers.location,target),redirects+1).then(resolve,reject);return;}
    if(res.statusCode!==200){res.resume();clearTimeout(timer);return reject(Error('Official test asset download failed'));}
    const chunks=[];let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024){res.destroy();req.destroy();reject(Error('Official test asset exceeds size limit'));}else chunks.push(chunk);});
    res.on('error',()=>{clearTimeout(timer);reject(Error('Official test asset response interrupted'));});
    res.on('end',()=>{clearTimeout(timer);resolve(Buffer.concat(chunks));});
   });
   req.on('error',()=>{clearTimeout(timer);reject(Error('Official test asset network error'));});
  });
 }
 const bytes=await get(TEST_ASSET_URL);
 if(hash(bytes)!==MANAGED_PROXY_BINARY_SHA256)throw Error('Official test asset hash mismatch');
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
 const temporary=path.join(directory,'.download-'+randomBytes(12).toString('hex'));
 fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});
 // Exclusive install never overwrites an existing cache or a concurrent file.
 fs.linkSync(temporary,TEST_ASSET_PATH);fs.unlinkSync(temporary);
 return {cached:false,sha256:MANAGED_PROXY_BINARY_SHA256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 prepareTestAsset().then(result=>console.log(JSON.stringify({testAsset:'official-hysteria-2.13.0',...result}))).catch(()=>{console.error('Could not prepare the hash-pinned public test fixture. No proxy credentials or private files are used.');process.exitCode=1;});
}
