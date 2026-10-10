import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackendJSON } from '../lib/backend-json.mjs';
import { metadataGateway, PRODUCTION_ORIGIN } from '../lib/metadata-gateway.mjs';
import worker from '../worker/index.mjs';
import { metadataURL, validateGatewayOrigin } from '../src/gateway.js';
import { createTimingFreshness, nextPollDelay } from '../src/timing-freshness.js';
import { spawnSync } from 'node:child_process';
const catalog={schemaVersion:1,version:'test-v1',updatedAt:'2026-09-01T00:00:00Z',live:{fixture:{url:'https://audio.example/live',allowedOrigins:['https://audio.example'],kind:'audio'}},archive:{checkedAt:'2026-09-01T00:00:00Z',schools:{}},discovery:{homestreamBase:'https://discovery.example',mediaOrigins:['https://audio.example']},archiveConfig:{dukePlayer:'https://player.example/',dukeFeedPath:'/previous.xml',replayRules:{}}};
const uuid = '410422f0-663f-4e3d-82e2-787d954ae29d';
const upstream = url => {
  if (url.includes('/summary?')) return {header:{id:new URL(url).searchParams.get('event'),uid:`s:20~l:23~e:${new URL(url).searchParams.get('event')}`,league:{id:'23',slug:'college-football'},season:{year:2026},competitions:[{id:new URL(url).searchParams.get('event'),competitors:[{team:{id:'150'}},{team:{id:'356'}}]}]},drives:{previous:[],current:{plays:[]}}};
  if (url.includes('/schedule?')) return {team:{id:'150'},season:{year:2026},events:[]};
  if (url.includes('/games/')) return {success:true,games:[]};
  if (url.includes('espn.com')) return {sports:[{leagues:[{teams:[{team:{id:'150',location:'Duke'}}]}]}]};
  return {success:true,teams:[{team_id:uuid,school_name:'Georgia Tech'}]};
};
const makeRequest = (target, options) => new Request(`https://gateway.example${target}`,options);
// SYNTHETIC Duke player page and live schedule feed (issue #32); the signed query must never leave the backend.
const LIVE_FEED = 'https://player.example/live.xml?expires=1&signature=SECRET-SIGNATURE';
const SCHEDULE_PAGE = `<script>var event_xml_urls = {live: "${LIVE_FEED}", previous: "https://player.example/previous.xml"};</script>`;
const SCHEDULE_XML = '<main><sports><sport><id>1</id><name>Football</name><is_show>0</is_show></sport></sports><events><current_ev/><upcoming_ev><event><id>e1</id><start_timestamp>1792260000</start_timestamp><end>2026-10-18 03:00:00</end><sport_id>1</sport_id><opponent>Visitor</opponent><url>https://media.example/live</url></event></upcoming_ev></events></main>';
const fetcher = async (url, init) => String(url) === 'https://player.example/' ? new Response(SCHEDULE_PAGE) : String(url) === LIVE_FEED ? new Response(SCHEDULE_XML, init?.dated ? {headers:{Date:init.dated}} : {}) : Response.json(upstream(String(url)));

test('shared router serves exactly seven minimized route families and timing age in both deliveries', async () => {
  for (const target of ['/api/homestream/teams',`/api/homestream/games/${uuid}`,'/api/sync/teams','/api/sync/schedule/150/2026','/api/sync/plays/401856671','/api/sync/status/150/2026','/api/broadcast/schedule/duke']) {
    let wall = 100000;
    const response = await metadataGateway(makeRequest(target), {fetcher, catalog, now:()=>wall++});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    const data = await response.json();
    if (target.includes('/plays/')) { assert.ok(data.checkedAt >= 100000); assert.equal(data.ageMs,null); assert.equal(data.schemaVersion,2); assert.equal(data.eventId,'401856671'); }
    else if (target.includes('/broadcast/')) { assert.deepEqual(data,{schemaVersion:1,school:'duke',state:'upcoming',event:{id:'e1',label:'Football: Visitor',kind:'game',broadcastStart:1792260000000},checkedAt:data.checkedAt,ageMs:null}); assert.ok(data.checkedAt >= 100000); }
    else if (target.includes('/status/')) { assert.deepEqual(data,{schemaVersion:1,teamId:'150',season:2026,checkedAt:data.checkedAt,ageMs:null,events:[]}); assert.ok(data.checkedAt >= 100000); }
    else assert.ok(Array.isArray(data));
  }
});
test('status route admits only the four verified provider teams and exact season paths, before upstream', async () => {
  let calls = 0;
  const counting = async url => { calls++; return fetcher(url); };
  for (const target of ['/api/sync/status/356/2026','/api/sync/status/1500/2026','/api/sync/status/0150/2026','/api/sync/status/15/2026','/api/sync/status/150/1999','/api/sync/status/150/20261','/api/sync/status/150','/api/sync/status/150/2026/','/api/sync/status/150/2026?x=1','/api/sync/status/%31%35%30/2026','/api/sync/status/150/%32026']) {
    assert.equal((await metadataGateway(makeRequest(target),{fetcher:counting})).status,404,target);
  }
  assert.equal(calls,0);
  for (const id of ['150','59','258','2']) assert.equal((await metadataGateway(makeRequest(`/api/sync/status/${id}/2026`),{fetcher:async url=>{calls++;return Response.json({...upstream(String(url)),team:{id}});}})).status,200,id);
  assert.equal(calls,4);
});
test('status cache lives ten seconds, recomputes age per delivery, keeps unknown age unknown, and never serves expired data after failure',async()=>{
  let now=1_000_000_000_000,calls=0,stored,dated=true;const pending=[];
  const cache={match:async()=>stored?.clone(),put:async(key,response)=>{assert.match(key.url,/__metadata_cache_v2\/api\/sync\/status\//);stored=response;}};
  const options={cache,ctx:{waitUntil:p=>pending.push(p)},now:()=>now,fetcher:async url=>{calls++;return Response.json(upstream(String(url)),{headers:dated?{Date:new Date(now-10000).toUTCString()}:{}});}};
  const first=await (await metadataGateway(makeRequest('/api/sync/status/150/2026',{headers:{Origin:PRODUCTION_ORIGIN}}),options)).json();
  assert.equal(first.ageMs,11000);await Promise.all(pending);
  now+=9999;
  const hit=await metadataGateway(makeRequest('/api/sync/status/150/2026'),options);const data=await hit.json();
  assert.equal(calls,1);assert.equal(data.checkedAt,first.checkedAt);assert.equal(data.ageMs,20999);assert.equal(hit.headers.get('Access-Control-Allow-Origin'),null);
  now+=1;
  assert.equal((await metadataGateway(makeRequest('/api/sync/status/150/2026'),{...options,fetcher:async()=>{throw Error();}})).status,502,'expired entry is never a stale fallback');
  dated=false;stored=undefined;
  const unknown=await (await metadataGateway(makeRequest('/api/sync/status/150/2026'),options)).json();
  assert.equal(unknown.ageMs,null);await Promise.all(pending);now+=5000;
  assert.equal((await (await metadataGateway(makeRequest('/api/sync/status/150/2026'),{...options,fetcher:async()=>{throw Error('cache should avoid upstream');}})).json()).ageMs,null);
});
test('Worker HTTP boundary rejects full queries, encoding, media, hosts, invalid IDs and methods before upstream', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('unexpected fetch'); };
  try {
    for (const target of ['/api/sync/teams?host=evil','/api/sync/teams?','/api/sync/%74eams','/api/sync/plays/1?event=2','/api/sync/plays/https://evil.test','/api/sync/plays/1234567890123',`/api/homestream/games/${'-'.repeat(36)}`,`/api/homestream/games/${uuid}?url=https://evil.test`,'/api/duke','/media/a.m3u8','/api/sync/teams/','/api/sync/status/356/2026','/api/sync/status/150/2026?season=2025','/api/broadcast/schedule/duke/','/api/broadcast/schedule/vt','/api/broadcast/schedule/miami','/api/broadcast/schedule/duke?x=1','/api/broadcast/schedule/%64uke','/api/broadcast/schedule','/api/broadcast/schedule/DUKE','/api/broadcast/next/duke']) {
      const response = await worker.fetch(makeRequest(target),{ALLOWED_ORIGINS:JSON.stringify([PRODUCTION_ORIGIN])},{});
      assert.equal(response.status,404,target);
    }
    for (const method of ['HEAD','POST','PUT','DELETE']) assert.equal((await worker.fetch(makeRequest('/api/sync/teams',{method}),{ALLOWED_ORIGINS:JSON.stringify([PRODUCTION_ORIGIN])},{})).status,405);
    assert.equal(calls,0);
  } finally { globalThis.fetch = originalFetch; }
});
test('Worker diagnostics name the status route family without exposing the target', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn, records = [];
  globalThis.fetch = async () => { throw Error('private upstream detail'); };
  console.warn = line => records.push(JSON.parse(line));
  try {
    const response = await worker.fetch(makeRequest('/api/sync/status/150/2026'),{ALLOWED_ORIGINS:JSON.stringify([PRODUCTION_ORIGIN])},{});
    assert.equal(response.status,502);
    assert.ok(records.length > 0);
    assert.ok(records.every(record => record.event === 'metadata-failure' && record.route === 'api/sync/status'));
    assert.ok(!JSON.stringify(records).includes('private') && !JSON.stringify(records).includes('/150/'));
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});
test('CORS exact origins and restricted preflight are checked without credential forwarding', async () => {
  let calls=0;
  const options={fetcher:async(url, init)=>{
    calls++; assert.equal(init.credentials,'omit'); assert.equal(init.cache,'no-store'); assert.equal(init.redirect,'manual');
    assert.deepEqual(init.headers,{Accept:'application/json'});return fetcher(url);
  }};
  for (const origin of ['null','https://michaeltorbert.github.io.evil.test','https://evil.test','']) assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026',{headers:{Origin:origin}}),options)).status,403);
  assert.equal(calls,0);
  const headers={Origin:PRODUCTION_ORIGIN,Authorization:'Bearer private',Cookie:'private=1'};
  const response=await metadataGateway(makeRequest('/api/sync/schedule/150/2026',{headers}),options);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),PRODUCTION_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(calls,1);
  assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026'),options)).headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026',{method:'OPTIONS',headers:{Origin:PRODUCTION_ORIGIN,'Access-Control-Request-Method':'GET'}}),options)).status,204);
  for (const extra of [{'Access-Control-Request-Method':'POST'},{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'}]) assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026',{method:'OPTIONS',headers:{Origin:PRODUCTION_ORIGIN,...extra}}),options)).status,403);
  assert.equal(calls,2);
});
test('optional cache preserves original check time, recomputes age and CORS, and never serves expired data after failure',async()=>{
  let now=100000,calls=0,stored; const pending=[];
  const cache={match:async()=>stored?.clone(),put:async(key,response)=>{assert.match(key.url,/__metadata_cache_v2/);stored=response;}};
  const options={cache,ctx:{waitUntil:p=>pending.push(p)},now:()=>now,fetcher:async url=>{calls++;return Response.json(upstream(String(url)),{headers:{Date:new Date(now-2000).toUTCString(),Age:'3'}});}};
  const first=await metadataGateway(makeRequest('/api/sync/plays/1',{headers:{Origin:PRODUCTION_ORIGIN}}),options);
  assert.equal((await first.json()).ageMs,4000);await Promise.all(pending);
  assert.equal(stored.headers.get('Access-Control-Allow-Origin'),null);
  now+=5000;
  const hit=await metadataGateway(makeRequest('/api/sync/plays/1'),options);const data=await hit.json();
  assert.equal(data.checkedAt,100000);assert.equal(data.ageMs,9000);assert.equal(calls,1);assert.equal(hit.headers.get('Access-Control-Allow-Origin'),null);
  now+=5000;
  const failure=await metadataGateway(makeRequest('/api/sync/plays/1'),{...options,fetcher:async()=>{throw Error();}});
  assert.equal(failure.status,502);
  const broken={match:async()=>{throw Error();},put:async()=>{throw Error();}};
  assert.equal((await metadataGateway(makeRequest('/api/sync/teams'),{...options,cache:broken})).status,200);await Promise.all(pending);
  now=90000; assert.equal((await metadataGateway(makeRequest('/api/sync/plays/1'),{...options,fetcher:async()=>{throw Error();}})).status,502);
});
test('backend JSON bounds decoded bytes, cancels streams, rejects HTML/schema/redirect errors',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('123456'));},cancel(){cancelled=true;}});
  await assert.rejects(readBackendJSON('https://upstream.test',{fetcher:async()=>new Response(stream,{headers:{'Content-Type':'application/json'}}),maxBytes:5}),/too-large/);
  assert.equal(cancelled,true);
  for (const response of [new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}}),new Response('{broken',{headers:{'Content-Type':'application/json'}}),Response.redirect('https://other.test')]) await assert.rejects(readBackendJSON('https://upstream.test',{fetcher:async()=>response}));
  assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026'),{fetcher:async()=>Response.json({html:'not schedule'})})).status,502);
  await assert.rejects(readBackendJSON('https://upstream.test',{fetcher:async()=>{throw TypeError('redirect rejected');}}),/redirect rejected/);
  const chunks=['{"name":"','é','"}'].map(s=>new TextEncoder().encode(s));
  assert.deepEqual(await readBackendJSON('https://upstream.test',{fetcher:async()=>new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}}),{headers:{'Content-Type':'application/json'}})}),{name:'é'});
});
test('backend deadline covers headers and a hanging body, and caller abort cancels body',async()=>{
  const keepAlive=setTimeout(()=>{},1000);
  try {
    await assert.rejects(readBackendJSON('https://upstream.test',{fetcher:()=>new Promise(()=>{}),timeoutMs:15}),{name:'TimeoutError'});
    let cancelled=false;
    const response=()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});
    await assert.rejects(readBackendJSON('https://upstream.test',{fetcher:async()=>response(),timeoutMs:15}),{name:'TimeoutError'});assert.equal(cancelled,true);
    cancelled=false;const controller=new AbortController();const reading=readBackendJSON('https://upstream.test',{fetcher:async()=>response(),signal:controller.signal});
    await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(reading,{name:'AbortError'});assert.equal(cancelled,true);
  } finally {clearTimeout(keepAlive);}
});
test('gateway origin validation and resolution reject explicit invalid configuration, preserving local and Pages paths',()=>{
  const base='https://michaeltorbert.github.io/homecall/';
  assert.equal(metadataURL('sync/teams',base).href,base+'api/sync/teams');
  assert.ok(metadataURL('sync/teams',base) instanceof URL);
  assert.equal(metadataURL('homestream/teams',base,'https://gateway.example').href,'https://gateway.example/api/homestream/teams');
  for(const value of ['http://example.test','https://x.test/','https://x.test/a','https://u:p@x.test','https://x.test?','https://x.test#','https://x.test?x=1','https://x.test#x',' https://x.test','garbage','null'])assert.throws(()=>validateGatewayOrigin(value));
  assert.throws(()=>validateGatewayOrigin('',{required:true}));
  assert.throws(()=>validateGatewayOrigin('http://localhost:8787'));
  assert.equal(validateGatewayOrigin('http://127.0.0.1:8787',{allowLocal:true}),'http://127.0.0.1:8787');
  assert.equal(validateGatewayOrigin('http://[::1]:8787',{allowLocal:true}),'http://[::1]:8787');
});
test('publishing config fails before archive network work for missing or invalid gateway',()=>{
  for (const value of ['', 'https://invalid.example/path']) {
    const result=spawnSync(process.execPath,['scripts/check-gateway.mjs'],{encoding:'utf8',env:{...process.env,REQUIRE_GATEWAY:'true',VITE_GATEWAY_ORIGIN:value}});
    assert.notEqual(result.status,0);assert.match(result.stderr,/VITE_GATEWAY_ORIGIN/);
  }
  const result=spawnSync(process.execPath,['scripts/check-gateway.mjs'],{encoding:'utf8',env:{...process.env,REQUIRE_GATEWAY:'false',VITE_GATEWAY_ORIGIN:''}});assert.equal(result.status,0);
});
test('freshness counts server age, request time and elapsed time without comparing remote clocks',()=>{
  let wall=10000,mono=100;const clock=()=>({wall,mono});const f=createTimingFreshness({clock});
  const start=f.start();wall+=2000;mono+=2000;f.receive({schemaVersion:2,checkedAt:999999999,ageMs:5000},start);
  assert.equal(f.fresh(),true);wall+=37999;mono+=37999;assert.equal(f.fresh(),true);wall++;mono++;assert.equal(f.fresh(),false);
  for (const data of [{checkedAt:1},{checkedAt:1,ageMs:-1},{checkedAt:1,ageMs:Infinity},{ageMs:0},{checkedAt:1,ageMs:1.5}]) {f.receive({schemaVersion:2,...data},f.start());assert.equal(f.fresh(),false);}
  f.receive({schemaVersion:2,checkedAt:1,ageMs:0},f.start());wall+=500;mono+=500;assert.equal(f.fresh(),true);wall-=1;mono+=1;assert.equal(f.fresh(),false);
  f.receive({schemaVersion:2,checkedAt:1,ageMs:0},f.start());wall+=2000;assert.equal(f.fresh(),false);
  f.receive({schemaVersion:2,checkedAt:1,ageMs:0},f.start());f.invalidate();assert.equal(f.fresh(),false);
  assert.deepEqual([nextPollDelay(15000,false),nextPollDelay(30000,false),nextPollDelay(60000,false),nextPollDelay(120000,false),nextPollDelay(120000,true)],[30000,60000,120000,120000,15000]);
});
test('shared gateway distinguishes the full upstream deadline from invalid provider data',async()=>{
 const timeout=new DOMException('Deadline','TimeoutError');
 assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026'),{fetcher:async()=>{throw timeout;}})).status,504);
 assert.equal((await metadataGateway(makeRequest('/api/sync/schedule/150/2026'),{fetcher:async()=>Response.json({})})).status,502);
});
test('cached timing with unknown upstream age never becomes fresh on cache delivery',async()=>{
 let wall=100000,stored;const pending=[];
 const options={now:()=>wall,fetcher,cache:{match:async()=>stored?.clone(),put:async(key,response)=>{assert.match(key.url,/__metadata_cache_v2/);stored=response;}},ctx:{waitUntil:p=>pending.push(p)}};
 const first=await metadataGateway(makeRequest('/api/sync/plays/1'),options);
 assert.equal((await first.json()).ageMs,null);await Promise.all(pending);wall+=5000;
 const hit=await metadataGateway(makeRequest('/api/sync/plays/1'),{...options,fetcher:async()=>{throw Error('cache should avoid upstream');}});
 assert.equal(hit.status,200);assert.equal((await hit.json()).ageMs,null);
});
test('Duke broadcast schedule: one-minute sanitized cache, age added per delivery, unknown age kept, no stale fallback or leak',async()=>{
  let now=1_800_000_000_000,calls=0,stored;const pending=[],records=[];
  const cache={match:async()=>stored?.clone(),put:async(key,response)=>{assert.match(key.url,/__metadata_cache_v2\/api\/broadcast\/schedule\/duke$/);stored=response;}};
  const options={cache,catalog,ctx:{waitUntil:p=>pending.push(p)},now:()=>now,diagnostic:record=>records.push(record),fetcher:async(url,init)=>{calls++;return fetcher(url,{...init,dated:new Date(now-2000).toUTCString()});}};
  const response=await metadataGateway(makeRequest('/api/broadcast/schedule/duke',{headers:{Origin:PRODUCTION_ORIGIN}}),options);
  const first=await response.json();assert.equal(response.headers.get('Access-Control-Allow-Origin'),PRODUCTION_ORIGIN);
  assert.deepEqual([first.state,first.checkedAt,first.ageMs,calls],['upcoming',now,3000,2]);await Promise.all(pending);
  const cachedText=await stored.clone().text();
  for(const leaked of ['player.example','SECRET','signature','expires','media.example','previous.xml'])assert.ok(!cachedText.includes(leaked)&&!JSON.stringify(first).includes(leaked),leaked);
  now+=59_999;
  const hit=await (await metadataGateway(makeRequest('/api/broadcast/schedule/duke'),options)).json();
  assert.deepEqual([hit.checkedAt,hit.ageMs,calls],[first.checkedAt,62_999,2],'a cache hit adds residence and makes no provider request');
  now+=1;
  assert.equal((await metadataGateway(makeRequest('/api/broadcast/schedule/duke'),{...options,fetcher:async()=>{throw Error(`failed ${LIVE_FEED}`);}})).status,502,'an expired entry is never a stale fallback');
  stored=undefined;
  const undated=await (await metadataGateway(makeRequest('/api/broadcast/schedule/duke'),{...options,fetcher})).json();await Promise.all(pending);now+=5000;
  assert.equal(undated.ageMs,null);
  assert.equal((await (await metadataGateway(makeRequest('/api/broadcast/schedule/duke'),{...options,fetcher:async()=>{throw Error('cache should avoid upstream');}})).json()).ageMs,null);
  assert.equal((await metadataGateway(makeRequest('/api/broadcast/schedule/duke'),{fetcher})).status,502,'a missing private catalog is unavailable, never an empty listing');
  // The caller leaves while the provider request is in flight; no timer is involved.
  const caller=new AbortController();let providerSignal;
  const leaving=(url,init)=>{providerSignal=init.signal;queueMicrotask(()=>caller.abort(Error('caller left')));return new Promise(()=>{});};
  assert.equal((await metadataGateway(makeRequest('/api/broadcast/schedule/duke',{signal:caller.signal}),{fetcher:leaving,catalog})).status,502,'caller abort covers the provider requests');
  assert.equal(providerSignal.aborted,true,'the in-flight provider request is cancelled');
  assert.ok(!JSON.stringify(records).includes('player.example')&&!JSON.stringify(records).includes('SECRET'));
});
test('Worker loads the private catalog for the exact Duke schedule route and reports only its family',async()=>{
  const originalFetch=globalThis.fetch,originalWarn=console.warn,records=[];let reads=0;
  globalThis.fetch=async()=>{throw Error(`private upstream ${LIVE_FEED}`);};
  console.warn=line=>records.push(JSON.parse(line));
  const env={ALLOWED_ORIGINS:JSON.stringify([PRODUCTION_ORIGIN]),STREAM_CATALOG:{get:async()=>{reads++;return JSON.stringify(catalog);}}};
  try {
    const response=await worker.fetch(makeRequest('/api/broadcast/schedule/duke'),env,{});
    assert.equal(response.status,502);assert.ok(reads>=1);
    assert.ok(records.length>0&&records.every(record=>record.event==='metadata-failure'&&record.route==='api/broadcast/schedule'));
    const text=JSON.stringify(records)+await response.text();
    for(const leaked of ['player.example','SECRET','signature','/duke'])assert.ok(!text.includes(leaked),leaked);
    reads=0;assert.equal((await worker.fetch(makeRequest('/api/broadcast/schedule/vt'),env,{})).status,404);assert.equal(reads,0);
  } finally { globalThis.fetch=originalFetch; console.warn=originalWarn; }
});
test('client metadata paths admit the broadcast namespace without widening other paths',()=>{
  assert.equal(metadataURL('broadcast/schedule/duke','https://michaeltorbert.github.io/homecall/','https://gateway.example').href,'https://gateway.example/api/broadcast/schedule/duke');
  for(const path of ['broadcast/schedule/duke?x=1','broadcast/../media','broadcasts/schedule/duke','media/live/x','broadcast/schedule/%64uke'])assert.throws(()=>metadataURL(path,'https://example.test/'),path);
});
