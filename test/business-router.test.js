import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createBusinessRouter} from '../business-router.js';

test('HTTP preview/PDF work without writes; invalid tenant, quotes and unauthorized persistence fail',async()=>{
 let writes=0;const db={collection(){writes++;throw Error('Unexpected database access');}};
 const app=express();app.use(express.json());app.use('/api/business',createBusinessRouter({db,tenantId:r=>r.headers['x-tenant-id'],secret:()=> 'x'.repeat(40)}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const url=`http://127.0.0.1:${server.address().port}/api/business`;
 const request=(path,body,tenant='sentire-marine',method='POST')=>fetch(url+path,{method,headers:{'content-type':'application/json','x-tenant-id':tenant},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 try{
  let res=await request('/preview',{items:[{code:'875751',qty:1}]});assert.equal(res.status,200);assert.equal((await res.json()).totalToPay,604.09);
  res=await request('/preview.pdf',{items:[{code:'876511',qty:1}]});assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'application/pdf');assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  res=await request('/preview',{items:[{code:'no-such-part',qty:1}]});assert.equal(res.status,422);
  res=await request('/preview',{items:[{code:'876511',qty:1}]},'sentire-customs-broker');assert.equal(res.status,404);
  res=await request('/drafts',{requestId:'test-0001',items:[{code:'876511',qty:1}]});assert.equal(res.status,401);
  res=await request('/rates/test',{active:true},'sentire-ffw','PUT');assert.equal(res.status,401);
  res=await request('/rates',null,'sentire-ffw','GET');assert.equal(res.status,401);
  res=await request('/parts?q=876511',null,'sentire-marine','GET');const part=(await res.json()).items[0];assert.equal(part.code,'876511');assert.equal(part.discount,undefined);assert.equal(part.retailUsd,undefined);
  assert.equal(writes,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
