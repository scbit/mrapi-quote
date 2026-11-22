import crypto from 'node:crypto';
import {GoogleAuth,OAuth2Client} from 'google-auth-library';

export const businessFolders=Object.freeze({
 'sentire-marine':'1BxQbzmltsYnmjjbqyZWMPsSHL0SMW50u',
 'sentire-ffw':'1H_pGCbDbFUjqvBqTPR0kmezw0n9lcOAV',
});
export class DriveError extends Error {constructor(code,status=503){super(code);this.code=code;this.status=status;}}
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/drive.file']});
export function userDriveConfigured(env=process.env){return !!(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_CLIENT_SECRET&&env.GOOGLE_DRIVE_REFRESH_TOKEN);}
export async function runtimeToken(){
 try{
  if(userDriveConfigured()){
   const client=new OAuth2Client(process.env.GOOGLE_DRIVE_CLIENT_ID,process.env.GOOGLE_DRIVE_CLIENT_SECRET);
   client.setCredentials({refresh_token:process.env.GOOGLE_DRIVE_REFRESH_TOKEN});
   const result=await client.getAccessToken();if(result.token)return result.token;
  }else{const token=await auth.getAccessToken();if(token)return token;}
 }catch{}
 throw new DriveError('drive_identity_unavailable');
}
export function createDriveClient({fetchImpl=fetch,tokenProvider=runtimeToken,isUser=userDriveConfigured,folderMap=businessFolders}={}){
 async function request(path,{method='GET',body,headers={},tenantId}={}){
  const token=await tokenProvider(tenantId);
  const response=await fetchImpl('https://www.googleapis.com/'+path,{method,body,headers:{...headers,Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new DriveError('drive_http_'+response.status,response.status===404?404:503);
  return value;
 }
 async function folder(tenantId){
  const folderId=folderMap[tenantId];if(!folderId)throw new DriveError('drive_business_unknown');
  const value=await request(`drive/v3/files/${folderId}?supportsAllDrives=true&fields=id,mimeType,driveId,capabilities(canAddChildren)`,{tenantId});
  if(value.mimeType!=='application/vnd.google-apps.folder'||value.id!==folderId)throw new DriveError('drive_folder_invalid');
  if(!value.capabilities?.canAddChildren)throw new DriveError('drive_folder_write_not_authorized');
  // Service accounts cannot own files in My Drive. Never ask for broad folder
  // sharing as a workaround: this requires user OAuth or an actual shared drive.
  const user=await isUser(tenantId);
  if(!value.driveId&&!user)throw new DriveError('drive_user_authorization_required');
  return {folderId,authorization:user?'user_oauth':'shared_drive'};
 }
 async function file(fileId,tenantId){return request(`drive/v3/files/${fileId}?supportsAllDrives=true&fields=id,webViewLink,mimeType,parents,appProperties`,{tenantId});}
 function verify(value,quote,folderId){
  if(value.mimeType!=='application/pdf'||!value.parents?.includes(folderId)||value.appProperties?.quoteId!==quote.id||value.appProperties?.businessId!==quote.tenantId||!/^https:\/\/drive\.google\.com\//.test(value.webViewLink||''))throw new DriveError('drive_file_identity_mismatch');
  return {fileId:value.id,url:value.webViewLink,folderId};
 }
 async function exportPdf({quote,quoteRef,db,pdf,pdfVersion=null}){
  const {folderId}=await folder(quote.tenantId);
  let fileId=quote.driveFileId;
  if(!fileId){
   const ids=await request('drive/v3/files/generateIds?count=1&space=drive&type=files',{tenantId:quote.tenantId});
   const candidate=ids.ids?.[0];if(!/^[A-Za-z0-9_-]{5,200}$/.test(candidate||''))throw new DriveError('drive_id_invalid');
   fileId=await db.runTransaction(async tx=>{const snap=await tx.get(quoteRef);if(!snap.exists||snap.data().inputHash!==quote.inputHash)throw new DriveError('drive_quote_changed',409);if(snap.data().driveFileId)return snap.data().driveFileId;tx.update(quoteRef,{driveFileId:candidate,driveStatus:'reserved',driveFolderId:folderId});return candidate;});
  }
  async function persist(value){
    const result=verify(value,quote,folderId);
    if(result.fileId!==fileId)throw new DriveError('drive_file_identity_mismatch');
    await db.runTransaction(async tx=>{const snap=await tx.get(quoteRef);if(!snap.exists||snap.data().driveFileId!==fileId)throw new DriveError('drive_quote_changed',409);tx.update(quoteRef,{driveStatus:'saved',driveUrl:result.url,driveSavedAt:new Date().toISOString(),...(pdfVersion?{drivePdfTemplateVersion:pdfVersion}:{})});});
    return result;
  }
  let existing=null;
  try{
   existing=await file(fileId,quote.tenantId);verify(existing,quote,folderId);
   if(!pdfVersion||existing.appProperties?.pdfTemplateVersion===pdfVersion)return await persist(existing);
  }catch(e){if(e.code!=='drive_http_404')throw e;}
  if(!Buffer.isBuffer(pdf)||pdf.length>5*1024*1024||pdf.subarray(0,4).toString()!=='%PDF')throw new DriveError('drive_pdf_invalid',422);
  const boundary='mrapi_'+crypto.randomUUID();
  const properties={quoteId:quote.id,businessId:quote.tenantId,inputHash:quote.inputHash,...(pdfVersion?{pdfTemplateVersion:pdfVersion}:{})};
  const metadata=existing?{appProperties:{...existing.appProperties,...properties}}:{id:fileId,name:String(quote.quoteNo||quote.id).replace(/[^A-Za-z0-9_-]/g,'_')+'.pdf',mimeType:'application/pdf',parents:[folderId],appProperties:properties};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),pdf,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  let created;
  try{created=await request('upload/drive/v3/files'+(existing?'/'+fileId:'')+'?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink,mimeType,parents,appProperties',{method:existing?'PATCH':'POST',body,tenantId:quote.tenantId,headers:{'Content-Type':'multipart/related; boundary='+boundary}});}
  catch(e){if(!['drive_http_409','drive_http_503'].includes(e.code))throw e;created=await file(fileId,quote.tenantId);}
  return persist(created);
 }
 return {folder,exportPdf};
}
