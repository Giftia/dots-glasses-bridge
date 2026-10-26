import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../server.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

function fixture(){
  const calls=[];
  const app={server:{close(done){calls.push('server-close');done();}}};
  const transport={verifyCallback(){},sendEvent(){}};
  let proxyOptions,appOptions;
  return {calls,app,transport,get proxyOptions(){return proxyOptions;},get appOptions(){return appOptions;},
    dependencies:{makeApp(_config,options){calls.push('app-created');appOptions=options;return app;},
      async createProxy(options){calls.push('proxy-start');proxyOptions=options;return {transport,async stop(){calls.push('proxy-stop');}};},
      onFailure(){calls.push('failure');}}};
}
test('proxy remains opt-in and ordinary application dependencies remain unchanged',async()=>{
  const f=fixture(),mediaRequest=()=>{};
  f.dependencies.appDependencies={mediaRequest};
  const runtime=await createRuntime({},f.dependencies);
  assert.equal(runtime.managedProxyEnabled,false);assert.equal(f.appOptions.mediaRequest,mediaRequest);
  assert.equal(f.appOptions.transport,undefined);assert.deepEqual(f.calls,['app-created']);
  await runtime.stop();assert.deepEqual(f.calls,['app-created','server-close']);
  await assert.rejects(createRuntime({managedWebhookProxy:'true'},f.dependencies),/Invalid managed/);
});
test('only the webhook transport changes and the service owns one idempotent proxy lifecycle',async()=>{
  const f=fixture(),mediaRequest=()=>{};
  f.dependencies.appDependencies={mediaRequest,transport:{obsolete:true}};
  const runtime=await createRuntime({managedWebhookProxy:true},f.dependencies);
  assert.equal(runtime.app,f.app);assert.equal(runtime.managedProxyEnabled,true);
  assert.equal(f.appOptions.transport,f.transport);assert.equal(f.appOptions.mediaRequest,mediaRequest);
  assert.equal(f.proxyOptions.root,resolve(fileURLToPath(new URL('../',import.meta.url))));assert.deepEqual(f.calls,['proxy-start','app-created']);
  await Promise.all([runtime.stop(),runtime.stop()]);
  f.proxyOptions.onFailure();assert.deepEqual(f.calls,['proxy-start','app-created','proxy-stop','server-close']);
});
test('proxy creation failure cannot create or silently fall back to an application',async()=>{
  const f=fixture();f.dependencies.createProxy=async()=>{throw Error('private startup failure');};
  await assert.rejects(createRuntime({managedWebhookProxy:true},f.dependencies));
  assert.deepEqual(f.calls,[]);
});
test('application initialization failure stops its already owned proxy',async()=>{
  const f=fixture();f.dependencies.makeApp=()=>{throw Error('application initialization failure');};
  await assert.rejects(createRuntime({managedWebhookProxy:true},f.dependencies));
  assert.deepEqual(f.calls,['proxy-start','proxy-stop']);
});
test('unexpected proxy loss closes application once and notifies the host once',async()=>{
  const f=fixture(),runtime=await createRuntime({managedWebhookProxy:true},f.dependencies);
  f.proxyOptions.onFailure();f.proxyOptions.onFailure();await runtime.stop();
  assert.deepEqual(f.calls,['proxy-start','app-created','failure','proxy-stop','server-close']);
});
test('a proxy lost during startup never creates an application',async()=>{
  const f=fixture(),start=f.dependencies.createProxy;
  f.dependencies.createProxy=async options=>{const value=await start(options);options.onFailure();return value;};
  await assert.rejects(createRuntime({managedWebhookProxy:true},f.dependencies),/during startup/);
  assert.deepEqual(f.calls,['proxy-start','proxy-stop']);
});
test('failure reporter exceptions cannot prevent owned proxy and application cleanup',async()=>{
  const f=fixture();f.dependencies.onFailure=()=>{f.calls.push('failure');throw Error('reporter failure');};
  const runtime=await createRuntime({managedWebhookProxy:true},f.dependencies);
  assert.throws(()=>f.proxyOptions.onFailure(),/reporter failure/);
  await runtime.stop();
  assert.deepEqual(f.calls,['proxy-start','app-created','failure','proxy-stop','server-close']);
});
