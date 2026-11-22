import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveClient} from '../business-drive.js';

test('service account cannot create files in My Drive and unauthorized folders stay blocked',async()=>{
 let writes=0;const client=createDriveClient({folderMap:{marine:'folder_1'},isUser:()=>false,tokenProvider:async()=> 'TEST',fetchImpl:async(u,o)=>{if(o.method!=='GET')writes++;return {ok:true,json:async()=>({id:'folder_1',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}})};}});
 await assert.rejects(client.folder('marine'),/drive_user_authorization_required/);assert.equal(writes,0);
 await assert.rejects(client.folder('ffw'),/drive_business_unknown/);
});
test('retries reuse preallocated Drive ID and repair persisted URL after an interrupted save',async()=>{
 const record={id:'quote_1',tenantId:'marine',quoteNo:'SM-1',inputHash:'HASH'};let uploaded=null,creates=0;
 const client=createDriveClient({folderMap:{marine:'folder_1'},isUser:()=>true,tokenProvider:async()=> 'TEST',fetchImpl:async(url,opt)=>{
  let status=200,data;
  if(url.includes('generateIds'))data={ids:['file_123']};
  else if(url.includes('/upload/')){creates++;uploaded={id:'file_123',mimeType:'application/pdf',parents:['folder_1'],appProperties:{quoteId:'quote_1',businessId:'marine'},webViewLink:'https://drive.google.com/file/d/file_123/view'};data=uploaded;}
  else if(url.includes('/files/folder_1'))data={id:'folder_1',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};
  else if(uploaded)data=uploaded;else{status=404;data={};}
  return {ok:status===200,status,json:async()=>data};
 }});
 const ref={id:'quote_1'},db={runTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>record}),update:(r,patch)=>Object.assign(record,patch)})};
 let r=await client.exportPdf({quote:{...record},quoteRef:ref,db,pdf:Buffer.from('%PDF TEST')});assert.equal(r.fileId,'file_123');assert.equal(record.driveStatus,'saved');assert.equal(creates,1);
 delete record.driveUrl;record.driveStatus='reserved';
 r=await client.exportPdf({quote:{...record},quoteRef:ref,db,pdf:Buffer.from('%PDF TEST')});assert.equal(r.fileId,'file_123');assert.equal(creates,1);assert.equal(record.driveStatus,'saved');assert.equal(record.driveUrl,r.url);
});
