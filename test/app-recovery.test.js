// Listen owner (src/app.js) against the real index.html, session log, Now Playing and resolver modules.
// Player, catalog, timing tools and status labels are fakes: these are pure owner fixtures, not media proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PlaybackMemory } from '../src/playback-memory.js';
import { SessionLog } from '../src/session-log.js';
import { teams, getSources } from '../src/teams.js';
import { createNowPlaying, nowPlayingArtwork } from '../src/now-playing.js';
import { createScoreboard } from '../src/scoreboard.js';
import { metadataURL, configuredGatewayOrigin, gatewayOptions } from '../src/gateway.js';
import { listenTeams, resolveSources, officialLink } from '../src/listen-sources.js';
import { createListenSession, failureKind } from '../src/listen-session.js';
import { TIMELINE_NOTICE, FALLBACK_NOTICE } from '../src/hls-timeline.js';
import * as shell from '../src/ui-shell.js';
import { createBroadcastCountdown } from '../src/broadcast-countdown.js';
globalThis.__GATEWAY_ORIGIN__='https://gateway.example';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const settle=()=>new Promise(r=>setImmediate(r));
const flush=async()=>{for(let i=0;i<6;i++)await settle();};
const GAME={id:'g1',url:'https://gateway.example/media/game/2903e5f6-960e-4954-a3ec-f7754e78660f/g1',opponent:'Tulane',start:Date.now()};
// A fake catalog in a fixed pre-Play state; refresh reports a reload through onChange('refresh').
const gameCatalog=(status='ready',game=GAME)=>callbacks=>({ready:status==='ready'?game:null,status,callbacks,refreshes:0,stop(){},setEnabled(){},relabel(){},
 async refresh(){this.refreshes++;callbacks.onChange('refresh');callbacks.onReady();}});
const denied=()=>{const error=Error('blocked');error.name='NotAllowedError';return error;};
function harness(t, catalogFactory, extra={}) {
 const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
 t.after(()=>w.close());let player, catalog;
 // outcomes: one entry per start; an Error rejects, 'defer' leaves it pending in player.pending, anything else resolves.
 class FakePlayer {
  constructor(update,event){this.update=update;this.event=event;this.sequence=0;this.epoch=0;player=this;this.starts=[];this.outcomes=[];this.ts='none';this.target=null;this.seeks=[];}
  get sourceConnected(){return !!this.audio;}
  get sourcePaused(){return !!this.audio?.paused;}
  start(url,delay,options={}){this.starts.push({url,delay,mp3:!!options.mp3,hls:!!options.hls});this.context={state:'running'};this.audio={paused:false};
   if(this.failNext){this.failNext=false;return Promise.reject(Error('source-error'))}
   const outcome=this.outcomes.shift();
   if(outcome instanceof Error)return Promise.reject(outcome);
   if(outcome==='defer')return new Promise((resolve,reject)=>{this.pending={resolve,reject};});
   return Promise.resolve();}
  stop(){this.context=null;this.audio=null;}
  command(type,value){this.lastCommand={type,value};return Promise.resolve({result:'applied',before:{delay:35},after:{delay:35},contextSeconds:1});}
  resumeContext(){return Promise.resolve();}
  timestampState(){return this.ts;}
  liveTarget(){return this.target;}
  seek(position){this.seeks.push(position);return Promise.resolve({result:'applied'});}
  timing(){return {utc:NaN,position:NaN,ranges:[],spans:[]};}
  canMove(){return true;}
 }
 const fakeTiming={starts:[],stops:0,resets:0,start(game){this.starts.push(game.id);},stop(){this.stops++;},reset(){this.resets++;},invalidate(){},render(){}};
 // Records the committed-school and lifecycle calls; tests may inject the real controller through extra.
 const fakeCountdown={schools:[],suspends:0,resumes:0,ticks:0,setSchool(key){this.schools.push(key);},suspend(){this.suspends++;},resume(){this.resumes++;},tick(){this.ticks++;},stop(){}};
 Object.assign(w,{setupGameTiming:options=>{fakeTiming.options=options;return fakeTiming;},setupHomestream:callbacks=>(catalog=catalogFactory ? catalogFactory(callbacks) : {ready:null,status:'unavailable',stop(){},setEnabled(){},relabel(){},refresh(){}}),
  PlaybackMemory,SessionLog,teams,getSources,Player:FakePlayer,demoURL:()=> 'blob:demo',setupArchive:()=>{},listenTeams,resolveSources,officialLink,createListenSession,failureKind,TIMELINE_NOTICE,FALLBACK_NOTICE,
  createGameStatus:()=>({setGames(){},clear(){},suspend(){},resume(){},tick(){},stop(){}}),createBroadcastCountdown:options=>{fakeCountdown.options=options;return fakeCountdown;},
  createNowPlaying,nowPlayingArtwork,createScoreboard,metadataURL,configuredGatewayOrigin,gatewayOptions,readJSON:async()=>{throw Error('no metadata in recovery tests');},...shell,...extra});
 w.localStorage.setItem('homecall.position.live.duke-leanstream',JSON.stringify({version:1,value:35,savedAt:Date.now()-20000}));
 w.URL.revokeObjectURL=()=>{};w.eval(source);const $=id=>w.document.getElementById(id);
 return {w,player,timing:fakeTiming,countdown:fakeCountdown,get catalog(){return catalog},$,prompt:()=>$('confirm-dialog').hasAttribute('open'),proceed:()=>$('confirm-continue').click(),dismiss:()=>$('confirm-cancel').click(),
  log:()=>{$('preview').click();return JSON.parse($('export').value);}};
}
const tail=url=>url.split('/').at(-1);
test('reconnect and reload restore the saved source delay without replacing it with refill state',async t=>{
 const h=harness(t);h.$('connect').click();await settle();assert.equal(h.player.starts[0].delay,35);
 h.player.update({delay:0,available:0,paused:true,holding:false,ingesting:true,restoring:35});
 h.player.update({delay:10,available:10,paused:true,holding:false,ingesting:true,restoring:35});
 assert.equal(JSON.parse(h.w.localStorage.getItem('homecall.position.live.duke-leanstream')).value,35);
 assert.match(h.$('status').textContent,/25 s of audio/);
 h.$('connect').click();await settle();assert.equal(h.player.starts[1].delay,35);
 h.player.update({delay:35,available:40,paused:false,holding:false,ingesting:true,restoring:null});
 h.player.update({delay:37,available:45,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('connect').click();await settle();assert.equal(h.player.starts[2].delay,37);
});
test('source changes and demo cannot inherit or overwrite another live source delay',async t=>{
 const h=harness(t);h.$('demo').click();await settle();assert.equal(h.player.starts[0].delay,0);
 h.player.update({delay:5,available:10,paused:false,holding:false,ingesting:true,restoring:null});
 assert.equal(JSON.parse(h.w.localStorage.getItem('homecall.position.live.duke-leanstream')).value,35);
 h.$('team').value='miami';h.$('team').onchange();h.proceed();h.$('connect').click();await settle();assert.equal(h.player.starts[1].delay,0);
});
test('only the verified Duke primary MP3 is decoded; backups, other stations and the demo keep their media element',async t=>{
 const h=harness(t);h.$('connect').click();await settle();
 assert.deepEqual({mp3:h.player.starts[0].mp3,hls:h.player.starts[0].hls},{mp3:true,hls:false});
 h.$('stop').click();h.$('feed').value='duke-wtib';h.$('feed').onchange();h.$('connect').click();await settle();assert.equal(h.player.starts[1].mp3,false);
 h.$('stop').click();h.$('team').value='miami';h.$('team').onchange();h.$('connect').click();await settle();assert.equal(h.player.starts[2].mp3,false);
 h.$('stop').click();h.$('demo').click();await settle();assert.equal(h.player.starts[3].mp3,false);
});
test('an unavailable MP3 decoder is reported plainly instead of falling back to native playback',async t=>{
 const h=harness(t);const start=h.player.start.bind(h.player);
 h.player.start=(...args)=>{start(...args);return Promise.reject(Object.assign(Error('mp3-unsupported'),{kind:'local'}));};
 h.$('connect').click();await settle();
 assert.equal(h.player.starts.length,1);assert.match(h.$('notice').textContent,/radio audio decoder/);assert.equal(h.$('connect').hidden,false);
});
test('pause offers saved-delay default and retained-position alternative',async t=>{
 const h=harness(t);h.$('connect').click();await settle();
 h.player.update({delay:55,available:90,paused:true,holding:false,ingesting:true,restoring:null});
 assert.equal(h.$('resume-position').hidden,false);
 h.$('pause').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'restore',value:35});
 h.$('resume-position').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'pause',value:false});
});

test('the Pause action does not reconnect when audio has already recovered from a native pause',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.event('source-paused');h.player.event('source-playing');
 h.player.update({delay:35,resumeDelay:35,available:90,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('pause').click();await settle();assert.equal(h.player.starts.length,1);assert.deepEqual(h.player.lastCommand,{type:'pause',value:true});
});
test('a drained live buffer preserves its reconnect delay preference',async t=>{
 const h=harness(t);h.$('connect').click();await settle();
 h.player.update({delay:33,resumeDelay:35,available:90,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('connect').click();await settle();assert.equal(h.player.starts.at(-1).delay,35);
});

test('demo Resume uses its in-session delay while leaving live preferences untouched',async t=>{
 const h=harness(t);h.$('demo').click();await settle();
 h.player.update({delay:5,available:20,paused:false,holding:false,ingesting:true,restoring:null});
 h.player.update({delay:8,available:25,paused:true,holding:false,ingesting:true,restoring:null});
 h.$('pause').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'restore',value:5});
 assert.equal(JSON.parse(h.w.localStorage.getItem('homecall.position.live.duke-leanstream')).value,35);
});

test('recovered native pause does not force a later manual Resume to reconnect',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.event('source-paused');h.player.event('source-playing');
 h.player.update({delay:35,available:90,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('pause').click();await settle();h.player.update({delay:40,available:95,paused:true,holding:false,ingesting:true,restoring:null});
 h.$('pause').click();await settle();assert.equal(h.player.starts.length,1);assert.deepEqual(h.player.lastCommand,{type:'restore',value:35});
});

test('a stale playing snapshot cannot erase a native pause awaiting recovery',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.audio.paused=true;h.player.event('source-paused');
 h.player.update({delay:35,available:90,paused:false,holding:false,ingesting:true,restoring:null});
 h.player.update({delay:35,available:90,paused:true,holding:false,ingesting:false,restoring:null});
 h.player.audio.paused=false;h.$('pause').click();await settle();assert.equal(h.player.starts.length,2);
});

// Superseded (CP3-7): a failed GT start no longer refreshes the catalog in the background.
test('AC12 Georgia Tech: a failed game feed ends honestly with no invented network and no background catalog refresh',async t=>{
 const h=harness(t,gameCatalog());h.$('team').value='gt';h.$('team').onchange();
 assert.equal(h.$('feed-picker').hidden,true,'the game feed is the only source');
 h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,1);assert.equal(h.catalog.refreshes,0);
 assert.equal(h.$('notice').textContent,'Audio could not play. Press Retry to start again, or open the official player.');
 assert.equal(h.$('recover-official').href,'https://ramblinwreck.com/radio');assert.equal(h.$('recover-reconnect').textContent,'Retry');
 h.$('recover-reconnect').click();assert.deepEqual(h.player.starts[1],{url:GAME.url,delay:0,mp3:false,hls:true});await settle();
 h.player.update(PLAYING);assert.equal(h.$('hold').disabled,false,'GT keeps the PCM manual controls');
 h.$('hold').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'hold',value:undefined});
});
test('GT reconnect refreshes before Play and delay memory belongs to the selected game',async t=>{
 const game={id:'game-one',url:'https://gateway.example/media/game/team/game-one',opponent:'Tennessee'};let refreshed=0;
 const h=harness(t,callbacks=>({ready:game,stop(){},setEnabled(){},relabel(){},async refresh(){refreshed++;callbacks.onChange('refresh');callbacks.onReady()}}));
 h.$('team').value='gt';h.$('team').onchange();h.$('connect').click();await settle();assert.equal(h.player.starts[0].delay,0);
 h.player.update({delay:7,resumeDelay:7,available:10,paused:false,ingesting:true,holding:false,restoring:null});
 h.$('connect').click();assert.equal(h.prompt(),true,'reconnecting a game asks before its catalog refresh stops audio');
 h.proceed();await settle();assert.equal(refreshed,1);assert.equal(h.player.starts.length,1);
 h.$('connect').click();await settle();assert.equal(h.player.starts[1].delay,7);
 h.$('stop').click();h.catalog.ready={...game,id:'game-two'};h.$('connect').click();await settle();assert.equal(h.player.starts[2].delay,0);
});
test('choosing a backup stops playback, resets delay and logs the actual source',async t=>{
 const h=harness(t);h.$('connect').click();await settle();
 h.player.update({delay:35,available:40,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('feed').value='duke-varsity';h.$('feed').onchange();h.proceed();
 assert.equal(h.player.audio,null);assert.equal(h.$('pause').disabled,true);
 assert.equal(h.$('delay').textContent,'0.00');assert.match(h.$('notice').textContent,/Press Play/);
 assert.match(h.$('official').href,/thevarsitynetwork/);
 h.$('connect').click();await settle();
 assert.equal(h.player.starts.at(-1).url,'https://gateway.example/media/live/duke-varsity');
 assert.equal(h.player.starts.at(-1).delay,0);
 assert.equal(h.log().sourceId,'duke-varsity');
 h.player.update({delay:7,available:20,paused:false,holding:false,ingesting:true,restoring:null});
 h.$('connect').click();await settle();assert.equal(h.player.starts.at(-1).delay,7);
 assert.equal(JSON.parse(h.w.localStorage.getItem('homecall.position.live.duke-leanstream')).value,35);
});
test('returning to a previously delayed source starts fresh after an explicit source switch',async t=>{
 const h=harness(t);
 h.$('feed').value='duke-wsjs';h.$('feed').onchange();h.$('connect').click();await settle();
 h.$('feed').value='duke-leanstream';h.$('feed').onchange();h.proceed();
 h.$('connect').click();await settle();assert.equal(h.player.starts.at(-1).delay,0);
 assert.equal(JSON.parse(h.w.localStorage.getItem('homecall.position.live.duke-leanstream')).value,0);
});
test('a pending connection cannot overwrite the state of a newly selected affiliate',async t=>{
 const h=harness(t);let reject;
 h.player.start=()=>new Promise((_,r)=>{reject=r;});
 h.$('connect').click();assert.equal(h.$('connect').disabled,true);
 h.$('feed').value='duke-wccg';h.$('feed').onchange();h.proceed();
 reject(Error('old source failed'));await settle();
 assert.equal(h.$('connect').disabled,false);assert.match(h.$('notice').textContent,/Ready for WCCG/);
 assert.equal(h.$('status').textContent,'Stopped');
 assert.match(h.$('official').href,/WCCG/);
});
// Superseded: failure no longer suggests choosing another source; a manual choice falls back only downward.
test('a failed lowest-ranked manual choice ends without suggesting tried sources; Retry restarts that choice fresh',async t=>{
 const h=harness(t);
 h.w.localStorage.setItem('homecall.position.live.duke-wtib',JSON.stringify({version:1,value:20,savedAt:Date.now()}));
 h.$('feed').value='duke-wtib';h.$('feed').onchange();h.player.outcomes=[Error('network')];h.$('connect').click();await flush();
 assert.equal(h.$('notice').textContent,'Audio could not play. Press Retry to start again, or open the official player.');
 assert.doesNotMatch(h.$('notice').textContent,/choose|another source/i);
 assert.equal(h.$('feed').value,'duke-wtib');assert.equal(h.player.starts.length,1,'nothing ranked above a manual choice is tried');
 h.$('connect').click();await settle();assert.equal(h.player.starts.at(-1).delay,0);
 assert.equal(h.log().sourceId,'duke-wtib');
});
test('backup controls and official links reset when changing teams',async t=>{
 const h=harness(t);assert.equal(h.$('feed-picker').hidden,false);assert.equal(h.$('feed').options.length,7);
 h.$('feed').value='duke-wccg';h.$('feed').onchange();
 h.$('team').value='miami';h.$('team').onchange();assert.equal(h.$('feed-picker').hidden,true);
 h.$('connect').click();await settle();assert.equal(h.player.starts.at(-1).url,teams.miami.url);
 assert.equal(h.$('official').href,teams.miami.official);
 h.$('team').value='duke';h.$('team').onchange();h.proceed();assert.equal(h.$('feed').value,'auto');
});

test('fixed relay playback starts synchronously within the click gesture', t => {
 const h=harness(t);h.$('connect').click();
 assert.equal(h.player.starts.length,1);
 assert.equal(h.player.starts[0].url,'https://gateway.example/media/live/duke-leanstream');
});

// ---------- Compact shell: confirmations, primary state and the browsing owner strip ----------
const PLAYING={delay:35,available:90,paused:false,holding:false,ingesting:true,restoring:null};
const stored=(h,id='duke-leanstream')=>h.w.localStorage.getItem(`homecall.position.live.${id}`);
test('Cancel on team and source prompts leaves audio, buffer, log, stored delay and the committed choice untouched',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 const before={audio:h.player.audio,starts:h.player.starts.length,delay:stored(h),sessions:h.w.localStorage.length,status:h.$('status').textContent};
 h.$('team').value='miami';h.$('team').onchange();
 assert.equal(h.prompt(),true);assert.equal(h.$('team').value,'duke','the select keeps the committed team while asking');
 assert.equal(h.player.audio,before.audio,'nothing stops before Continue');
 h.dismiss();assert.equal(h.prompt(),false);
 h.$('feed').value='duke-wsjs';h.$('feed').onchange();assert.equal(h.$('feed').value,'auto');
 h.$('confirm-dialog').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(h.prompt(),false,'Escape is Cancel');
 assert.deepEqual({audio:h.player.audio,starts:h.player.starts.length,delay:stored(h),sessions:h.w.localStorage.length,status:h.$('status').textContent},before);
 assert.equal(h.$('team').value,'duke');assert.equal(h.$('feed').value,'auto');assert.match(h.$('official').href,/leanplayer/);
 assert.equal(h.log().status,'active-snapshot','the log session stays open');
});
test('Continue applies the original change synchronously inside its own click',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 h.$('team').value='miami';h.$('team').onchange();h.proceed();
 assert.equal(h.player.audio,null);assert.equal(h.$('team').value,'miami');assert.equal(h.$('status').textContent,'Stopped');
 h.$('connect').click();assert.equal(h.player.starts.at(-1).url,teams.miami.url,'Play still starts inside the click');
});
test('a terminal error or a newer prompt invalidates a pending change; a stale Continue does nothing',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 h.$('feed').value='duke-wsjs';h.$('feed').onchange();assert.equal(h.prompt(),true);
 h.player.event('source-reconnect-exhausted');assert.equal(h.prompt(),false,'terminal failure closes the prompt as Cancel');
 h.proceed();assert.equal(h.$('feed').value,'auto');assert.match(h.$('official').href,/leanplayer/);assert.equal(h.player.starts.length,1);
 h.player.event('source-reconnected');
 h.$('team').value='vt';h.$('team').onchange();h.$('feed').value='duke-wccg';h.$('feed').onchange();
 h.proceed();assert.equal(h.$('team').value,'duke','the superseded team prompt was canceled');assert.match(h.$('official').href,/WCCG/);
});
test('GT reconnect Cancel keeps the broadcast and never refreshes its catalog',async t=>{
 const game={id:'game-one',url:'https://gateway.example/media/game/team/game-one',opponent:'Tennessee'};let refreshed=0;
 const h=harness(t,callbacks=>({ready:game,stop(){},setEnabled(){},relabel(){},async refresh(){refreshed++;callbacks.onChange('refresh');callbacks.onReady()}}));
 h.$('team').value='gt';h.$('team').onchange();h.$('connect').click();await settle();h.player.update(PLAYING);
 h.$('menu-reconnect').click();assert.equal(h.prompt(),true);h.dismiss();await settle();
 assert.equal(refreshed,0);assert.notEqual(h.player.audio,null);assert.equal(h.player.starts.length,1);
});
// Superseded: Stop now stays usable for a source waiting on Play, and cancels that pending intent.
test('primary state follows actual output: restoring, connecting, interruption, hold, pause, playing and neutral Stopped',async t=>{
 const h=harness(t);assert.equal(h.$('status').textContent,'Stopped');assert.equal(h.$('connect').hidden,false);assert.equal(h.$('pause').hidden,true);
 h.$('connect').click();assert.equal(h.$('status').textContent,'Connecting…');await settle();
 h.player.update({...PLAYING,restoring:35,available:10});assert.match(h.$('status').textContent,/^Restoring 35\.0-second delay/);
 h.player.update(PLAYING);assert.equal(h.$('status').textContent,'Playing');assert.equal(h.$('connect').hidden,true);assert.equal(h.$('pause').textContent,'Pause');
 h.player.event('source-waiting');h.player.update({...PLAYING,ingesting:false});assert.equal(h.$('status').textContent,'Playing · check playback','input buffering alone is not a stop');
 h.player.event('source-playing');h.player.update({...PLAYING,holding:true});assert.equal(h.$('status').textContent,'Paused for TV');assert.equal(h.$('pause').textContent,'Paused');
 h.player.update({...PLAYING,paused:true});assert.equal(h.$('status').textContent,'Paused');assert.equal(h.$('pause').textContent,'Resume');
 h.player.context.state='suspended';h.player.event('context-interrupted');assert.equal(h.$('status').textContent,'Interrupted');
 h.player.event('source-reconnect-required');h.player.update(null);
 assert.equal(h.$('status').textContent,'Disconnected','a terminal error is not neutral idle');assert.match(h.$('notice').textContent,/Press Play to reconnect/);
 assert.equal(h.$('connect').hidden,false);assert.equal(h.$('recovery-actions').hidden,false);
 assert.equal(h.$('stop').disabled,false,'the source waiting on Play can be stopped');
 h.$('stop').click();assert.equal(h.$('status').textContent,'Stopped');assert.equal(h.$('notice').textContent,'');
 h.$('connect').click();assert.equal(h.player.starts.length,2,'a fresh intent starts after Stop');
});
test('Playing requires an actual audio element and context; buffered output without ingestion still counts',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);assert.equal(h.$('status').textContent,'Playing');
 const audio=h.player.audio;h.player.audio=null;h.player.update(PLAYING);assert.equal(h.$('status').textContent,'Check playback','missing output element is never Playing');
 h.player.audio=audio;const context=h.player.context;h.player.context=null;h.player.update(PLAYING);assert.equal(h.$('status').textContent,'Check playback');
 h.player.context=context;h.player.update({...PLAYING,ingesting:false});assert.equal(h.$('status').textContent,'Playing');
});
test('the main screen carries no generic idle or start advice; real results and the hold instruction stay where they belong',async t=>{
 const h=harness(t);assert.equal(h.$('notice').textContent,'');
 h.$('connect').click();assert.equal(h.$('notice').textContent,'');await settle();
 h.player.update({...PLAYING,restoring:35,available:10});assert.match(h.$('notice').textContent,/^Restoring your saved 35\.0-second delay/,'saved-delay restoration stays visible');
 h.player.update(PLAYING);h.$('hold').click();await settle();h.player.update({...PLAYING,holding:true});
 assert.equal(h.$('notice').textContent,'','the hold instruction appears only in Match my TV');assert.match(h.$('sync-help').textContent,/When the TV reaches/);
 h.$('stop').click();assert.equal(h.$('notice').textContent,'');
});
test('sources show concise labels after Automatic and the game feed, keeping every source ID and its full description',async t=>{
 const h=harness(t);const options=[...h.$('feed').options];
 assert.deepEqual(options.map(o=>o.textContent),['Automatic','Game feed · unavailable','Network','Network backup','WSJS backup','WCCG backup','WTIB backup']);
 assert.deepEqual(options.slice(2).map(o=>o.value),getSources('duke').map(s=>s.sourceId));
 assert.deepEqual(options.slice(2).map(o=>o.title),getSources('duke').map(s=>s.label));
 assert.equal(h.$('station').textContent,'Duke Sports Network');
});
test('hold opens matching, keeps its exits usable while restoring, and Close returns when the hold ends',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 assert.equal(h.$('matching').hidden,true);
 h.player.update({...PLAYING,holding:true,restoring:20});
 assert.equal(h.$('matching').hidden,false);assert.equal(h.$('match-close').hidden,true);
 assert.equal(h.$('hold').textContent,'Resume with this delay');assert.equal(h.$('hold').disabled,false);assert.equal(h.$('cancel').disabled,false);
 h.$('cancel').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'cancel',value:undefined});
 h.player.update(PLAYING);assert.equal(h.$('match-close').hidden,false);assert.equal(h.$('hold').textContent,'Pause to match TV');
});
test('direction groups keep production signs: Less delay sends negative nudges, More delay positive',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 const less=[...h.w.document.querySelectorAll('[aria-labelledby=less-delay] [data-nudge]')],more=[...h.w.document.querySelectorAll('[aria-labelledby=more-delay] [data-nudge]')];
 assert.deepEqual(less.map(b=>Number(b.dataset.nudge)),[-5,-1,-0.25]);assert.deepEqual(more.map(b=>Number(b.dataset.nudge)),[0.25,1,5]);
 for(const button of [...less,...more]){button.click();await settle();assert.deepEqual(h.player.lastCommand,{type:'nudge',value:Number(button.dataset.nudge)});
  assert.match(button.getAttribute('aria-label'),Number(button.dataset.nudge)<0?/^Reduce delay/:/^Add /);}
});
// Single-source team: exhausted recovery ends the intent (a multi-source team would fall back instead).
test('the owner strip keeps Listen state, its last error and Stop reachable while browsing; modals mirror the warning',async t=>{
 const h=harness(t);h.$('team').value='miami';h.$('team').onchange();h.$('connect').click();await settle();h.player.update(PLAYING);
 assert.equal(h.$('owner-strip').hidden,false);assert.equal(h.$('owner-state').textContent,'Playing');assert.equal(h.$('owner-name').textContent,'104.3 WQAM');
 h.player.event('source-reconnect-exhausted');h.player.update(null);await settle();
 assert.equal(h.$('owner-strip').hidden,false,'the error stays visible after the session ends');
 assert.match(h.w.document.querySelector('#owner-strip [data-warning-mirror]').textContent,/three attempts/);
 assert.match(h.w.document.querySelector('#logs-dialog [data-warning-mirror]').textContent,/three attempts/);
 assert.equal(h.player.starts.length,1,'no source exists below the only one');
 h.$('connect').click();await settle();h.player.update(PLAYING);await settle();
 assert.equal(h.w.document.querySelector('#logs-dialog [data-warning-mirror]').textContent,'','a recovered session clears the mirror');
 h.$('owner-stop').click();assert.equal(h.player.audio,null);assert.equal(h.$('owner-strip').hidden,true);
});
test('storage warnings stay global and are mirrored read-only into every tool dialog',async t=>{
 const h=harness(t);h.$('storage-warning').textContent='Log storage is unavailable. Keep this page open and share or download the log before leaving.';await settle();
 for(const id of ['confirm-dialog','help-dialog','context-dialog','logs-dialog','tone-dialog'])assert.match(h.w.document.querySelector(`#${id} [data-warning-mirror]`).textContent,/storage is unavailable/,id);
 assert.equal(h.$('storage-warning').closest('dialog'),null);
});
test('test tone leaves the current view through navigation before starting exactly one ordinary owner',async t=>{
 const order=[];let h;
 h=harness(t,undefined,{setupArchive:()=>({select:(mode,options)=>order.push(['select',mode,options?.force,h.player.starts.length])})});
 h.$('connect').click();await settle();h.player.update(PLAYING);
 h.$('demo').click();
 assert.deepEqual(order,[['select','live',true,1]],'navigation teardown happens before the demo starts');
 assert.equal(h.player.starts.length,2);assert.equal(h.player.starts[1].url,'blob:demo');assert.equal(h.$('station').textContent,'Timing demo · repeating tones');
});
test('test context locks TV service and output during a session while the reason stays editable',async t=>{
 const h=harness(t);h.$('connect').click();await settle();
 assert.equal(h.$('provider').disabled,true);assert.equal(h.$('output').disabled,true);assert.equal(h.$('reason').disabled,false);assert.equal(h.$('context-lock').hidden,false);
 h.$('stop').click();assert.equal(h.$('provider').disabled,false);assert.equal(h.$('context-lock').hidden,true);
});
test('log removal refuses during playback without claiming success',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.$('stop').click();
 h.$('connect').click();await settle();h.$('clear-confirm').hidden=false;h.$('clear-confirm').click();
 assert.doesNotMatch(h.$('share-status').textContent,/removed\./);assert.ok(h.w.localStorage.length>1);
 h.$('stop').click();h.$('clear').click();h.$('clear-confirm').click();assert.equal(h.$('share-status').textContent,'Saved logs removed.');
});

// ---------- Unified Listen acceptance (issue AC1-AC17; owner fixtures, not live or device proof) ----------
test('AC1 Duke with a ready game feed: Play starts it inside the click, Source shows it, overrides reach the network and backups',async t=>{
 const h=harness(t,gameCatalog());
 assert.deepEqual([...h.$('feed').options].map(o=>o.textContent),['Automatic','Game feed','Network','Network backup','WSJS backup','WCCG backup','WTIB backup']);
 assert.equal(h.$('feed').value,'auto');assert.equal(h.$('source-current').textContent,'Will play · Game feed · timestamps checked once it loads');
 assert.equal(h.$('station').textContent,'Duke vs Tulane');
 h.$('connect').click();assert.deepEqual(h.player.starts[0],{url:GAME.url,delay:0,mp3:false,hls:true});assert.deepEqual(h.timing.starts,['g1']);await settle();
 h.player.ts='available';h.player.update(PLAYING);
 assert.equal(h.$('source-current').textContent,'Playing · Game feed · broadcast timestamps');assert.equal(h.$('timing-tools').hidden,false,'timestamp tools are offered');
 h.$('feed').value='duke-leanstream';h.$('feed').onchange();h.proceed();assert.equal(h.$('timing-tools').hidden,true);
 h.$('connect').click();assert.deepEqual(h.player.starts.at(-1),{url:teams.duke.url,delay:0,mp3:true,hls:false},'an override starts at incoming audio');
 await settle();h.$('stop').click();h.$('feed').value='duke-wccg';h.$('feed').onchange();h.$('connect').click();assert.equal(tail(h.player.starts.at(-1).url),'duke-wccg');
});
test('AC2 a game feed unavailable before Play selects the network with manual alignment and no switch notice',async t=>{
 const h=harness(t,gameCatalog('unavailable'));
 assert.equal(h.$('source-current').textContent,'Will play · Network · manual alignment');
 const game=h.$('feed').querySelector('option[value="duke-game"]');assert.equal(game.textContent,'Game feed · unavailable');assert.equal(game.disabled,true);
 h.$('connect').click();await settle();assert.equal(h.player.starts[0].url,teams.duke.url);h.player.update(PLAYING);h.player.event('output-ready');
 assert.equal(h.$('switch-notice').hidden,true);assert.equal(h.$('source-current').textContent,'Playing · Network · manual alignment');
});
test('AC3 a playable feed without timestamps keeps the same audio and manual alignment, with its notice and no switch',async t=>{
 const h=harness(t,gameCatalog());h.$('connect').click();await settle();h.player.ts='missing';h.player.update({...PLAYING,delay:0});
 assert.equal(h.$('notice').textContent,TIMELINE_NOTICE.timestamps);assert.equal(h.player.starts.length,1);
 assert.equal(h.$('timing-tools').hidden,true);assert.equal(h.$('source-current').textContent,'Playing · Game feed · manual alignment · no broadcast timestamps');
 h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,true);
 for(const b of h.w.document.querySelectorAll('[data-nudge]'))assert.equal(b.disabled,false);
 assert.equal(h.$('hold').disabled,false);assert.equal(h.$('live').disabled,false);
});
test('AC4 a startup transport failure on the game feed moves once to the network; the notice waits for real output',async t=>{
 const h=harness(t,gameCatalog());h.player.outcomes=[Error('hls-error')];
 h.$('connect').click();await flush();
 assert.deepEqual(h.player.starts.map(s=>[tail(s.url),s.delay]),[['g1',0],['duke-leanstream',0]],'the replacement starts at 0 seconds, not the stored 35');
 assert.equal(JSON.parse(stored(h)).value,0,'the replacement source delay is reset explicitly');
 assert.equal(h.$('switch-notice').hidden,true,'no notice before output');assert.equal(h.timing.resets>0,true,'timestamp offset and calibration reset');
 h.player.update(PLAYING);assert.equal(h.$('switch-notice').hidden,true,'engine state alone is not output proof');
 h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,false);assert.match(h.$('switch-notice').textContent,/^Switched to Duke Sports Network\b.*check alignment with your TV/);
 assert.equal(h.$('station').textContent,'Duke Sports Network');assert.equal(h.$('source-current').textContent,'Playing · Network · manual alignment');
 const log=h.log();assert.deepEqual([log.sourceId,log.trigger,log.previousSourceId],['duke-leanstream','fallback','duke-game']);
 h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,false);
});
test('AC5 after same-source recovery is exhausted the next candidate plays at incoming audio; same-source recovery shows no notice',async t=>{
 const h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 h.player.event('source-reconnecting');h.player.event('source-reconnected');h.player.event('output-ready');
 assert.equal(h.player.starts.length,1,'same-source recovery is internal to the player');assert.equal(h.$('switch-notice').hidden,true,'same-source recovery is not a switch');
 h.player.event('source-reconnect-exhausted');h.player.update(null);
 assert.deepEqual(h.player.starts.at(-1),{url:'https://gateway.example/media/live/duke-varsity',delay:0,mp3:false,hls:false});assert.equal(h.$('switch-notice').hidden,true);
 await settle();h.player.update({...PLAYING,delay:0});h.player.event('output-ready');
 assert.match(h.$('switch-notice').textContent,/^Switched to Duke Sports Network · backup/);assert.equal(h.$('source-current').textContent,'Playing · Network backup · manual alignment');
});
test('AC6/AC9 each candidate is entered once; exhaustion offers Retry and the official player without naming tried sources; Retry starts a new intent',async t=>{
 const h=harness(t,gameCatalog());h.player.outcomes=Array.from({length:6},()=>Error('offline'));
 h.$('connect').click();await flush();await flush();
 assert.deepEqual(h.player.starts.map(s=>tail(s.url)),['g1','duke-leanstream','duke-varsity','duke-wsjs','duke-wccg','duke-wtib']);
 assert.equal(h.$('notice').textContent,'None of the available feeds could play. Press Retry to start again from the top, or open the official player.');
 assert.equal(h.$('switch-notice').hidden,true,'a failed replacement never shows a success notice');
 assert.equal(h.$('recover-reconnect').textContent,'Retry');assert.equal(h.$('recovery-actions').hidden,false);assert.match(h.$('recover-official').href,/leanplayer/);
 h.$('recover-reconnect').click();assert.equal(h.player.starts.at(-1).url,GAME.url,'Retry is a new Automatic intent from the top');
 await settle();assert.equal(h.log().trigger,'retry');
});
test('AC7 no automatic return to a recovered source; a manual choice falls back only to lower-ranked sources',async t=>{
 const h=harness(t,gameCatalog());h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();h.player.update(PLAYING);
 const starts=h.player.starts.length;h.catalog.callbacks.onReady();h.player.event('source-reconnected');await settle();
 assert.equal(h.player.starts.length,starts,'a recovered game feed is never resumed automatically');
 h.$('stop').click();h.$('feed').value='duke-varsity';h.$('feed').onchange();h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 assert.deepEqual(h.player.starts.slice(-2).map(s=>tail(s.url)),['duke-varsity','duke-wsjs']);
});
test('AC8 Stop, Pause, team, game and Source changes cancel a pending replacement; stale callbacks start nothing and show nothing',async t=>{
 const cases=[['stop',h=>h.$('stop').click()],['pause',h=>h.$('pause').click()],['team',h=>{h.$('team').value='miami';h.$('team').onchange();h.proceed();}],
  ['source',h=>{h.$('feed').value='duke-wsjs';h.$('feed').onchange();h.proceed();}],['game',h=>h.catalog.callbacks.onChange('game')]];
 for(const [name,cancel] of cases){
  const h=harness(t,gameCatalog());h.player.outcomes=[Error('offline'),'defer'];h.$('connect').click();await flush();
  assert.equal(h.player.starts.length,2,name);const replacement=h.player.pending;cancel(h);
  replacement.reject(Error('offline'));await flush();
  assert.equal(h.player.starts.length,2,`${name}: a stale failure starts no further candidate`);
  h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,true,`${name}: a stale output event shows no notice`);
  if(name==='game')assert.equal(h.$('feed').value,'auto');
 }
});
test('Pause during a reconnect or a pending replacement keeps that source; Play resumes it and the replacement notice follows output',async t=>{
 let h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);
 h.player.event('source-reconnecting');assert.equal(h.$('pause').disabled,false);h.$('pause').click();
 assert.equal(h.player.audio,null,'the pending retry is canceled');h.player.event('source-reconnected');assert.equal(h.$('status').textContent,'Paused');
 h.$('connect').click();assert.deepEqual(h.player.starts.at(-1),{url:teams.duke.url,delay:35,mp3:true,hls:false});
 h=harness(t,gameCatalog());h.player.outcomes=[Error('offline'),'defer'];h.$('connect').click();await flush();
 const stale=h.player.pending;h.$('pause').click();assert.match(h.$('notice').textContent,/^Paused\. Press Play to continue with Duke Sports Network\.$/);
 stale.resolve();await settle();assert.equal(h.$('status').textContent,'Paused','a stale resolution revives nothing');
 h.$('connect').click();assert.deepEqual(h.player.starts.at(-1),{url:teams.duke.url,delay:0,mp3:true,hls:false},'the replacement resumes at incoming audio');
 await settle();h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,false);
});
test('AC10 permission denial never advances: initial, retry and replacement wait on the same source for Play',async t=>{
 let h=harness(t,gameCatalog());h.player.outcomes=[denied()];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,1);assert.equal(h.$('connect').disabled,false);assert.equal(h.$('switch-notice').hidden,true);
 assert.equal(h.$('notice').textContent,'This browser needs a tap to start audio. Press Play to start Duke · Game feed.');
 assert.equal(h.$('source-current').textContent,'Waiting for Play · Game feed · timestamps checked once it loads');
 h.$('connect').click();assert.equal(h.player.starts[1].url,GAME.url);await settle();h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,true,'the initial source is not a switch');
 h=harness(t,gameCatalog());h.player.outcomes=[Error('offline'),denied()];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,2);assert.equal(h.$('switch-notice').hidden,true);
 h.$('connect').click();assert.deepEqual(h.player.starts[2],{url:teams.duke.url,delay:0,mp3:true,hls:false},'Play retries the same pending replacement');await settle();
 h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,false,'the switch notice appears once the replacement plays');
 h=harness(t);h.$('connect').click();await settle();h.player.update(PLAYING);h.player.event('source-reconnect-required',{reason:'permission'});h.player.update(null);
 assert.equal(h.player.starts.length,1,'a denied same-source retry advances nothing');h.$('connect').click();assert.equal(h.player.starts[1].url,teams.duke.url);
 for(const [name,cancel,expected] of [['stop',p=>p.$('stop').click(),'g1'],['team',p=>{p.$('team').value='duke';p.$('team').onchange();},'g1'],['source',p=>{p.$('feed').value='duke-varsity';p.$('feed').onchange();},'duke-varsity']]){
  const p=harness(t,gameCatalog());p.player.outcomes=[Error('offline'),denied()];p.$('connect').click();await flush();
  cancel(p);p.$('connect').click();assert.equal(tail(p.player.starts.at(-1).url),expected,`${name}: the canceled pending replacement does not resume`);
 }
});
test('local engine and unsupported-browser failures never cycle feeds',async t=>{
 const local=Object.assign(Error('worklet-unavailable'),{kind:'local'}),env=Object.assign(Error('unsupported'),{kind:'environment'});
 let h=harness(t,gameCatalog());h.player.outcomes=[local];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,1);assert.match(h.$('notice').textContent,/audio engine could not start/);h.$('connect').click();assert.equal(h.player.starts[1].url,GAME.url);
 h=harness(t,gameCatalog());h.player.outcomes=[env];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,1);assert.match(h.$('notice').textContent,/cannot run Homecall’s delayed audio/);
});
test('AC11 an unknown catalog state blocks Play and never starts a network placeholder',async t=>{
 const h=harness(t,gameCatalog('checking'));
 assert.equal(h.$('connect').disabled,true);h.$('connect').click();assert.equal(h.player.starts.length,0);
 assert.equal(h.$('source-current').textContent,'Checking the game feed before Play…');assert.equal(h.$('feed').querySelector('option[value="duke-game"]').textContent,'Game feed · checking');
 Object.assign(h.catalog,{status:'ready',ready:GAME});h.catalog.callbacks.onReady();assert.equal(h.player.starts.length,0,'resolution alone starts nothing');
 h.$('connect').click();assert.equal(h.player.starts[0].url,GAME.url);
});
test('AC13/AC14 catalog-only schools join by explicit ID with no fallback or invented link; Virginia Tech never resolves to Virginia',async t=>{
 const list=[{id:'b3c33c46-a9e4-4e3b-9d5a-4fefb625f14c',name:'Virginia'},{id:'ffacbef1-e8a5-4872-9401-eff97cdf2c9c',name:'Auburn'},{id:'2903e5f6-960e-4954-a3ec-f7754e78660f',name:'Duke'}];
 const reader=async url=>{if(url.pathname.endsWith('/homestream/teams'))return list;throw Error('unexpected');};
 let h=harness(t,gameCatalog('unavailable'),{readJSON:reader});await settle();
 assert.deepEqual([...h.$('team').options].map(o=>o.value),['duke','miami','vt','gt','uva','auburn']);
 h.$('team').value='uva';h.$('team').onchange();
 assert.equal(h.$('connect').disabled,true);assert.equal(h.$('source-current').textContent,'No feed is available for this game right now.');
 assert.equal(h.$('feed-picker').hidden,true);assert.equal(h.$('official').hidden,true);
 h.$('team').value='vt';h.$('team').onchange();h.$('connect').click();assert.equal(h.player.starts[0].url,teams.vt.url);
 h=harness(t,gameCatalog(),{readJSON:reader});await settle();h.$('team').value='uva';h.$('team').onchange();h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 assert.equal(h.player.starts.length,1);assert.equal(h.$('notice').textContent,'Audio could not play. Press Retry to start again.');
 assert.equal(h.$('recover-official').hidden,true);assert.equal(h.$('recover-note').hidden,false);assert.equal(h.$('recover-note').textContent,'No official player link is configured for Virginia.');
 assert.equal(h.log().team,'uva');
});
test('AC15 Source override: Automatic default; a manual choice survives Stop and Play and resets on Automatic, team or game change',async t=>{
 const h=harness(t,gameCatalog());assert.equal(h.$('feed').options[0].value,'auto');assert.equal(h.$('feed').value,'auto');
 h.$('feed').value='duke-wsjs';h.$('feed').onchange();h.$('connect').click();assert.equal(tail(h.player.starts[0].url),'duke-wsjs','the chosen source, not the top candidate');
 assert.match(h.$('source-current').textContent,/chosen in Source$/);
 await settle();h.$('stop').click();assert.equal(h.$('feed').value,'duke-wsjs');h.$('connect').click();assert.equal(tail(h.player.starts.at(-1).url),'duke-wsjs');
 await settle();h.$('stop').click();h.$('feed').value='auto';h.$('feed').onchange();h.$('connect').click();assert.equal(h.player.starts.at(-1).url,GAME.url);
 await settle();h.$('stop').click();h.$('feed').value='duke-wccg';h.$('feed').onchange();h.$('team').value='miami';h.$('team').onchange();h.$('team').value='duke';h.$('team').onchange();
 assert.equal(h.$('feed').value,'auto','a team change returns to Automatic');
 h.$('feed').value='duke-wccg';h.$('feed').onchange();h.catalog.callbacks.onChange('game');assert.equal(h.$('feed').value,'auto','a game change returns to Automatic');
 h.$('feed').value='duke-wccg';h.$('feed').onchange();h.catalog.callbacks.onChange('refresh');assert.equal(h.$('feed').value,'duke-wccg','a catalog reload keeps the chosen source');
 for(let i=0;i<h.w.localStorage.length;i++)assert.doesNotMatch(h.w.localStorage.key(i),/source|mode/,'the Source mode is never saved');
});
test('AC17 an affiliate fallback keeps the coverage caution in the notice, the Source line and help',async t=>{
 const h=harness(t);h.$('feed').value='duke-varsity';h.$('feed').onchange();h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 assert.equal(tail(h.player.starts.at(-1).url),'duke-wsjs');h.player.update({...PLAYING,delay:0});h.player.event('output-ready');
 assert.match(h.$('switch-notice').textContent,/Affiliate coverage can change; check that you hear the broadcast you want\.$/);
 assert.equal(h.$('source-current').textContent,'Playing · WSJS backup · affiliate · check coverage · manual alignment · chosen in Source');
 assert.match(h.$('source-note').textContent,/coverage can change/);
});
test('F1 a parked unconfirmed timestamp move keeps the same game feed for Play: no fallback, no switch notice',async t=>{
 const h=harness(t,gameCatalog());h.$('connect').click();await settle();h.player.update({...PLAYING,delay:0});
 h.player.event('source-reconnect-required',{reason:'seek'});h.player.update(null);
 assert.equal(h.player.starts.length,1,'no other source is entered');assert.equal(h.$('switch-notice').hidden,true);
 assert.equal(h.$('notice').textContent,'The timestamp move could not be confirmed and audio did not resume. Press Play to reconnect to the same source, then check alignment.');
 assert.equal(h.$('source-current').textContent,'Waiting for Play · Game feed · timestamps checked once it loads');
 h.$('connect').click();assert.equal(h.player.starts[1].url,GAME.url,'Play restarts the same candidate');
 await settle();h.player.event('output-ready');assert.equal(h.$('switch-notice').hidden,true);
});
test('F2 eligible output retires obsolete buffering and trying text; a replacement keeps a quiet alignment reminder after its notice',async t=>{
 let h=harness(t,gameCatalog());h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 assert.equal(h.$('notice').textContent,'Duke · Game feed could not play. Trying Duke Sports Network…','progress before output');
 h.player.event('source-waiting');assert.match(h.$('notice').textContent,/buffering/);
 h.player.event('source-playing');h.player.update({...PLAYING,delay:0});assert.match(h.$('notice').textContent,/buffering/,'media playing alone is not output proof');
 h.player.event('output-ready');
 assert.equal(h.$('notice').textContent,'Switched from Duke · Game feed. Check alignment with your TV.');assert.equal(h.$('switch-notice').hidden,false);
 assert.equal(h.$('notice').dataset.alert,'','the reminder is quiet, not a warning');assert.equal(h.$('source-current').textContent,'Playing · Network · manual alignment');
 h.player.event('source-waiting');h.player.event('source-playing');
 assert.equal(h.$('notice').textContent,'The source returned after buffering. Check alignment with your TV.','a mid-session resume keeps an alignment check, not a stale buffering claim');
 h=harness(t);h.$('connect').click();await settle();h.player.event('source-waiting');h.player.event('output-ready');
 assert.equal(h.$('notice').textContent,'','the initial source simply retires its buffering text');
});
test('F2 output never retires independent warnings: restoration, interruption, missing timestamps and affiliate caution stay',async t=>{
 let h=harness(t);h.$('connect').click();await settle();
 assert.match(h.$('notice').textContent,/^Restoring your saved 35\.0-second delay/);h.player.event('output-ready');assert.match(h.$('notice').textContent,/^Restoring your saved/);
 h.player.context.state='suspended';h.player.event('context-interrupted');h.player.context.state='running';h.player.event('context-restored');
 h.player.event('output-ready');assert.equal(h.$('notice').textContent,'Phone audio returned. Restoring playback; check alignment.');
 h=harness(t,gameCatalog());h.$('connect').click();await settle();h.player.ts='missing';h.player.update({...PLAYING,delay:0});h.player.event('output-ready');
 assert.equal(h.$('notice').textContent,TIMELINE_NOTICE.timestamps);
 h=harness(t);h.$('feed').value='duke-varsity';h.$('feed').onchange();h.player.outcomes=[Error('offline')];h.$('connect').click();await flush();
 h.player.event('source-stalled');h.player.update({...PLAYING,delay:0});h.player.event('output-ready');
 assert.equal(h.$('notice').textContent,'Switched from Duke Sports Network · backup. Check alignment with your TV.');
 assert.match(h.$('switch-notice').textContent,/Affiliate coverage can change/);assert.match(h.$('source-current').textContent,/affiliate · check coverage/);
});
test('catalog Incoming audio moves media only when the input is far behind; timeline restore outcomes are honest notices',async t=>{
 const h=harness(t,gameCatalog());h.$('connect').click();await settle();h.player.update({...PLAYING,delay:0});
 h.$('live').click();await settle();assert.deepEqual(h.player.lastCommand,{type:'live',value:undefined});assert.deepEqual(h.player.seeks,[]);
 h.player.target=200;h.$('live').click();await settle();assert.deepEqual(h.player.seeks,[200]);assert.equal(h.$('notice').textContent,'Moved to incoming audio. Check against your TV.');
 h.player.event('timeline-fallback',{reason:'no-sample',issued:false});assert.equal(h.$('notice').textContent,TIMELINE_NOTICE.incoming);
 h.player.event('timeline-fallback',{reason:'moved',issued:true});assert.equal(h.$('notice').textContent,TIMELINE_NOTICE.unconfirmed);
 h.player.event('timeline-restored');assert.equal(h.$('notice').textContent,TIMELINE_NOTICE.restored);assert.equal(h.player.starts.length,1,'timeline outcomes never change source');
});

test('F3 local constructor and graph setup failures hold the same candidate without spending feed retries',async t=>{
 for(const message of ['contextError','nodeError','graphError']){
  const h=harness(t,gameCatalog());h.player.outcomes=[Object.assign(Error(message),{kind:'local'})];
  h.$('connect').click();await flush();assert.equal(h.player.starts.length,1,message);
  assert.equal(h.$('switch-notice').hidden,true);assert.match(h.$('notice').textContent,/same source/);
  h.$('connect').click();await flush();assert.equal(h.player.starts.length,2);
  assert.equal(h.player.starts[1].url,GAME.url,message);assert.equal(h.player.starts[1].hls,true);
 }
});

// Next-broadcast countdown (issue #32): school-level, lifecycle-only wiring that never touches Listen.
const visibility=(h,value)=>{Object.defineProperty(h.w.document,'visibilityState',{value,configurable:true});h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));};
test('the countdown follows only the committed school, keeps pending confirmations and ignores source-only changes',async t=>{
 const h=harness(t);assert.deepEqual(h.countdown.schools,['duke']);assert.equal(h.countdown.options.el,h.$('broadcast-next'));
 h.$('team').value='miami';h.$('team').onchange();assert.deepEqual(h.countdown.schools,['duke','miami']);
 h.$('team').value='duke';h.$('team').onchange();h.$('connect').click();await settle();
 h.$('team').value='vt';h.$('team').onchange();assert.equal(h.prompt(),true);h.dismiss();
 assert.deepEqual(h.countdown.schools,['duke','miami','duke'],'a declined team change keeps the committed school');assert.equal(h.$('team').value,'duke');
 h.$('team').value='vt';h.$('team').onchange();h.proceed();assert.deepEqual(h.countdown.schools.at(-1),'vt');
 h.$('team').value='duke';h.$('team').onchange();const count=h.countdown.schools.length;
 h.$('feed').value='duke-wtib';h.$('feed').onchange();assert.equal(h.countdown.schools.length,count,'a source change is not a school change');
 visibility(h,'hidden');assert.equal(h.countdown.suspends,1);visibility(h,'visible');assert.equal(h.countdown.resumes,1);
});
test('countdown ticks, polls, zero crossing and errors never change playback, delay, notices or Source',async t=>{
 let controller,wall=Date.now(),mono=0;const reads=[],answers=[];
 const read=path=>{reads.push(path);const answer=answers.shift();return answer instanceof Error?Promise.reject(answer):Promise.resolve(answer);};
 const schedule=start=>({schemaVersion:1,school:'duke',state:'upcoming',event:{id:'e1',label:'Football: Visitor',kind:'game',broadcastStart:start},checkedAt:wall,ageMs:0});
 answers.push(schedule(wall+3000));
 const h=harness(t,undefined,{createBroadcastCountdown:options=>(controller=createBroadcastCountdown({...options,read,now:()=>wall,mono:()=>mono,setTimer:()=>0,clearTimer(){},formatTime:()=>'soon'}))});
 await flush();assert.match(h.$('broadcast-next').textContent,/^Duke network · Next broadcast starts in 3 s/);assert.equal(h.$('broadcast-next').hidden,false);
 h.$('connect').click();await settle();
 h.player.update({delay:35,available:40,paused:false,holding:false,ingesting:true,restoring:null});
 const snapshot=()=>({starts:h.player.starts.length,command:h.player.lastCommand,status:h.$('status').textContent,notice:h.$('notice').textContent,source:h.$('source-current').textContent,
  station:h.$('station').textContent,feed:h.$('feed').value,team:h.$('team').value,delay:h.w.localStorage.getItem('homecall.position.live.duke-leanstream'),prompt:h.prompt(),refreshes:h.catalog.refreshes});
 const before=snapshot();
 answers.push(schedule(wall+3000),Error('502'));
 for(let i=0;i<5;i++){wall+=1000;mono+=1000;controller.tick();await settle();}
 assert.match(h.$('broadcast-next').textContent,/start time reached for Football: Visitor\. This does not confirm audio or game status\./);
 controller.suspend();controller.resume();await flush();
 assert.equal(h.$('broadcast-next').textContent,'Duke network · Next broadcast time unknown.');
 assert.deepEqual(reads,['broadcast/schedule/duke','broadcast/schedule/duke','broadcast/schedule/duke']);
 assert.deepEqual(snapshot(),before);assert.equal(h.$('status').textContent,'Playing');
 h.$('team').value='miami';h.$('team').onchange();h.proceed();assert.equal(h.$('broadcast-next').hidden,true);assert.equal(reads.length,3);
});
