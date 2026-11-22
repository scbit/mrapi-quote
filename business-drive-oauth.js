import crypto from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {businessFolders,DriveError} from './business-drive.js';

export const driveFileScope='https://www.googleapis.com/auth/drive.file';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(code,status=400)=>{throw new DriveError(code,status);};
const cookieName='__Host-mrapi-drive-connect';
export function cookieValue(header=''){
 const part=String(header).split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));
 return part?part.slice(cookieName.length+1):'';
}
export function createDriveOAuth({db,env=process.env,folderMap=businessFolders,now=()=>new Date(),fetchImpl=fetch,clientFactory=(id,secret,redirect)=>new OAuth2Client(id,secret,redirect)}){
 const clients=new Map();
 function configuration(){
  const id=env.GOOGLE_DRIVE_CLIENT_ID,secret=env.GOOGLE_DRIVE_CLIENT_SECRET,key=env.GOOGLE_DRIVE_TOKEN_KEY;
  const base=env.GOOGLE_DRIVE_OAUTH_BASE_URL||'https://mrapi-quote-604957912671.us-central1.run.app';
  if(env.GOOGLE_DRIVE_OAUTH_ENABLED!=='true'||!id||!secret||!/^\w{64}$/.test(key||'')||!/^[0-9a-f]{64}$/i.test(key)||base!=='https://mrapi-quote-604957912671.us-central1.run.app')fail('drive_oauth_not_configured',503);
  return {id,secret,key:Buffer.from(key,'hex'),base,redirect:base+'/api/business/drive/oauth/callback'};
 }
 function seal(value,aad){const {key}=configuration(),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const bytes=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv,c.getAuthTag(),bytes].map(b=>b.toString('base64url')).join('.');}
 function open(value,aad){try{const {key}=configuration(),[iv,tag,bytes]=value.split('.').map(s=>Buffer.from(s,'base64url'));const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from(aad));d.setAuthTag(tag);return Buffer.concat([d.update(bytes),d.final()]).toString();}catch{fail('drive_credential_unavailable',503);}}
 const states=()=>db.collection('business_drive_oauth_states');
 const connections=()=>db.collection('business_drive_connections');
 async function begin(tenant){
  const cfg=configuration();if(!folderMap[tenant])fail('drive_business_unknown');
  const ticket=crypto.randomBytes(32).toString('hex'),verifier=crypto.randomBytes(48).toString('base64url');
  await states().doc(sha(ticket)).create({tenant,phase:'NEW',expiresAt:new Date(now().getTime()+15*60000).toISOString(),verifier:seal(verifier,'pkce:'+tenant),createdAt:now().toISOString()});
  return {url:cfg.base+'/api/business/drive/oauth/connect?ticket='+ticket,scope:driveFileScope,folderId:folderMap[tenant]};
 }
 async function connect(ticket){
  const cfg=configuration();if(!/^[a-f0-9]{64}$/.test(ticket||''))fail('drive_oauth_invalid_ticket');
  const ref=states().doc(sha(ticket)),browser=crypto.randomBytes(32).toString('hex');
  const saved=await db.runTransaction(async tx=>{const snap=await tx.get(ref),s=snap.data();if(!snap.exists||s.phase!=='NEW'||s.expiresAt<=now().toISOString())fail('drive_oauth_expired_or_used');tx.update(ref,{phase:'OPEN',browserHash:sha(browser)});return s;});
  const verifier=open(saved.verifier,'pkce:'+saved.tenant),client=clientFactory(cfg.id,cfg.secret,cfg.redirect);
  const url=new URL(client.generateAuthUrl({access_type:'offline',scope:[driveFileScope],prompt:'consent select_account',include_granted_scopes:false,state:ticket,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}));
  // Google's unified OAuth Picker grants only the explicitly selected folder.
  url.searchParams.set('trigger_onepick','true');url.searchParams.set('allow_folder_selection','true');url.searchParams.set('allow_multiple','false');url.searchParams.set('file_ids',folderMap[saved.tenant]);url.searchParams.set('mimetypes','application/vnd.google-apps.folder');
  return {url:url.href,cookie:`${cookieName}=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`};
 }
 async function callback(query,browserCookie){
  const cfg=configuration(),ticket=query.state;
  if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket)||!/^[a-f0-9]{64}$/.test(browserCookie||''))fail('drive_oauth_invalid_state');
  const ref=states().doc(sha(ticket));
  const saved=await db.runTransaction(async tx=>{const snap=await tx.get(ref),s=snap.data();if(!snap.exists||s.phase!=='OPEN'||s.expiresAt<=now().toISOString()||s.browserHash!==sha(browserCookie))fail('drive_oauth_expired_or_used');if(query.error){tx.update(ref,{phase:'DENIED'});return {...s,denied:true};}if(typeof query.code!=='string'||query.code.length>4096||typeof query.picked_file_ids!=='string'||query.picked_file_ids!==folderMap[s.tenant])fail('drive_oauth_expected_folder_required');tx.update(ref,{phase:'EXCHANGING'});return s;});
  if(saved.denied)return {ok:false,denied:true};
  try{
   const client=clientFactory(cfg.id,cfg.secret,cfg.redirect),verifier=open(saved.verifier,'pkce:'+saved.tenant);
   const {tokens}=await client.getToken({code:query.code,codeVerifier:verifier,redirect_uri:cfg.redirect});
   if(!tokens.access_token||!tokens.refresh_token||tokens.scope!==driveFileScope)fail('drive_oauth_invalid_scope_or_token');
   const folderId=folderMap[saved.tenant],response=await fetchImpl(`https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true&fields=id,mimeType,capabilities(canAddChildren)`,{headers:{Authorization:'Bearer '+tokens.access_token},signal:AbortSignal.timeout(30000)});
   const folder=await response.json();if(!response.ok||folder.id!==folderId||folder.mimeType!=='application/vnd.google-apps.folder'||!folder.capabilities?.canAddChildren)fail('drive_selected_folder_not_writable');
   const record={tenant:saved.tenant,clientId:cfg.id,folderId,scope:driveFileScope,refreshToken:seal(tokens.refresh_token,'refresh:'+saved.tenant),connectedAt:now().toISOString(),active:true};
   await db.runTransaction(async tx=>{const state=await tx.get(ref);if(!state.exists||state.data().phase!=='EXCHANGING')fail('drive_oauth_state_changed');tx.set(connections().doc(saved.tenant),record);tx.update(ref,{phase:'COMPLETE',completedAt:now().toISOString(),verifier:null,browserHash:null});});
   clients.delete(saved.tenant);return {ok:true,tenant:saved.tenant,folderId};
  }catch(e){await ref.update({phase:'FAILED',verifier:null,browserHash:null}).catch(()=>{});throw new DriveError('drive_oauth_connection_failed',503);}
 }
 async function connected(tenant){
  if(env.GOOGLE_DRIVE_OAUTH_ENABLED!=='true'||!folderMap[tenant])return false;
  const snap=await connections().doc(tenant).get(),c=snap.data();return !!(snap.exists&&c.active&&c.folderId===folderMap[tenant]&&c.clientId===env.GOOGLE_DRIVE_CLIENT_ID&&c.scope===driveFileScope);
 }
 async function token(tenant){
  const cfg=configuration(),snap=await connections().doc(tenant).get(),c=snap.data();
  if(!snap.exists||!c.active||c.tenant!==tenant||c.folderId!==folderMap[tenant]||c.clientId!==cfg.id||c.scope!==driveFileScope)fail('drive_user_authorization_required',503);
  const version=sha(c.refreshToken),cached=clients.get(tenant);let client=cached?.version===version?cached.client:null;
  if(!client){client=clientFactory(cfg.id,cfg.secret,cfg.redirect);client.setCredentials({refresh_token:open(c.refreshToken,'refresh:'+tenant)});clients.set(tenant,{version,client});}
  try{const result=await client.getAccessToken();if(result.token)return result.token;}catch{}
  fail('drive_identity_unavailable',503);
 }
 return {begin,connect,callback,connected,token,clearCookie:`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`};
}
