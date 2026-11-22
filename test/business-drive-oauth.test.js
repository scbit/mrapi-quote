import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveOAuth,driveFileScope,cookieValue} from '../business-drive-oauth.js';

function fixture({scope=driveFileScope}={}){
 const records=new Map();let serial=Promise.resolve(),clock=new Date('2026-11-22T20:00:00Z'),exchanges=0,refreshCredential;
 const ref=path=>({path,get:async()=>snap(path),create:async value=>{assert(!records.has(path));records.set(path,value);},update:async value=>records.set(path,{...records.get(path),...value})}),snap=path=>({exists:records.has(path),data:()=>records.get(path)});
 const db={collection:path=>({doc:id=>ref(path+'/'+id)}),runTransaction:fn=>{const p=serial.then(async()=>{const pending=[];const value=await fn({get:async r=>snap(r.path),set:(r,v)=>pending.push([r.path,v]),update:(r,v)=>pending.push([r.path,{...records.get(r.path),...v}])});for(const [path,v]of pending)records.set(path,v);return value;});serial=p.catch(()=>{});return p;}};
 const env={GOOGLE_DRIVE_OAUTH_ENABLED:'true',GOOGLE_DRIVE_CLIENT_ID:'TEST_CLIENT',GOOGLE_DRIVE_CLIENT_SECRET:'TEST_SECRET',GOOGLE_DRIVE_TOKEN_KEY:'a'.repeat(64)};
 const folderMap={marine:'folder_marine',ffw:'folder_ffw'};
 const clientFactory=()=>({generateAuthUrl:options=>'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({...options,scope:options.scope.join(' ')}),getToken:async opts=>{exchanges++;assert.equal(opts.code,'CODE');assert(opts.codeVerifier.length>=43);return {tokens:{access_token:'TEST_ACCESS',refresh_token:'TEST_REFRESH',scope}};},setCredentials:c=>{refreshCredential=c;},getAccessToken:async()=>({token:'TEST_ACCESS_REFRESHED'})});
 const oauth=createDriveOAuth({db,env,folderMap,now:()=>clock,clientFactory,fetchImpl:async(url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer TEST_ACCESS');return {ok:true,json:async()=>({id:url.includes('folder_ffw')?'folder_ffw':'folder_marine',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}})};}});
 async function started(){const begin=await oauth.begin('marine'),ticket=new URL(begin.url).searchParams.get('ticket'),connect=await oauth.connect(ticket);return {ticket,connect,browser:cookieValue(connect.cookie)};}
 return {oauth,records,env,started,exchanges:()=>exchanges,refresh:()=>refreshCredential,advance:minutes=>{clock=new Date(clock.getTime()+minutes*60000);}};
}
test('OAuth defaults off; unified picker requests only drive.file and exact folder with browser-bound one-use state',async()=>{
 const h=fixture();h.env.GOOGLE_DRIVE_OAUTH_ENABLED='false';await assert.rejects(h.oauth.begin('marine'),/not_configured/);h.env.GOOGLE_DRIVE_OAUTH_ENABLED='true';
 const {ticket,connect}=await h.started(),url=new URL(connect.url);
 assert.equal(url.searchParams.get('scope'),driveFileScope);assert.equal(url.searchParams.get('file_ids'),'folder_marine');assert.equal(url.searchParams.get('allow_multiple'),'false');assert.equal(url.searchParams.get('trigger_onepick'),'true');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.match(connect.cookie,/HttpOnly; Secure; SameSite=Lax/);
 await assert.rejects(h.oauth.connect(ticket),/expired_or_used/);assert.equal(h.exchanges(),0);
});
test('wrong browser, wrong selected folder and expired state cannot exchange credentials',async()=>{
 const h=fixture(),s=await h.started(),q={state:s.ticket,code:'CODE',picked_file_ids:'folder_marine'};
 await assert.rejects(h.oauth.callback(q,'b'.repeat(64)),/expired_or_used/);
 await assert.rejects(h.oauth.callback({...q,picked_file_ids:'other_folder'},s.browser),/expected_folder/);
 h.advance(16);await assert.rejects(h.oauth.callback(q,s.browser),/expired_or_used/);assert.equal(h.exchanges(),0);
});
test('successful consent stores encrypted tenant-bound token; callback replay and cross-tenant ciphertext fail',async()=>{
 const h=fixture(),s=await h.started(),q={state:s.ticket,code:'CODE',picked_file_ids:'folder_marine'};
 const result=await h.oauth.callback(q,s.browser);assert.equal(result.ok,true);assert(await h.oauth.connected('marine'));assert.equal(await h.oauth.connected('ffw'),false);
 assert(!JSON.stringify([...h.records]).includes('TEST_REFRESH'));assert(!JSON.stringify([...h.records]).includes('TEST_SECRET'));
 assert.equal(await h.oauth.token('marine'),'TEST_ACCESS_REFRESHED');assert.equal(h.refresh().refresh_token,'TEST_REFRESH');
 await assert.rejects(h.oauth.callback(q,s.browser),/expired_or_used/);assert.equal(h.exchanges(),1);
 const marine=h.records.get('business_drive_connections/marine');h.records.set('business_drive_connections/ffw',{...marine,tenant:'ffw',folderId:'folder_ffw'});await assert.rejects(h.oauth.token('ffw'),/credential_unavailable/);
});
test('denied consent creates no connection; broader scope is rejected and never persisted',async()=>{
 const h=fixture(),s=await h.started();const result=await h.oauth.callback({state:s.ticket,error:'access_denied'},s.browser);assert.equal(result.denied,true);assert.equal(h.exchanges(),0);assert(!await h.oauth.connected('marine'));
 const broad=fixture({scope:driveFileScope+' https://www.googleapis.com/auth/drive'}),b=await broad.started();await assert.rejects(broad.oauth.callback({state:b.ticket,code:'CODE',picked_file_ids:'folder_marine'},b.browser),/connection_failed/);assert(!await broad.oauth.connected('marine'));
});
