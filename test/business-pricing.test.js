import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMarine,marineCatalog,calculateFreight,selectFreightRate,validateFreightRate} from '../business-pricing.js';
import {saveDraft,businessPdf} from '../business-router.js';

test('catalog imports all unique codes and correct country column',()=>{
 const c=marineCatalog();assert.equal(c.products.length,39758);assert.equal(c.byCode.size,39758);
 assert.equal(c.byCode.get('876511').countryOfOrigin,'SK');
});
test('Marine reproduces workbook single and multi-item calculations without trusting supplied prices',()=>{
 const c=calculateMarine({items:[{code:'875751',qty:1,unitPrice:1}]});assert.equal(c.totalToPay,604.09);
 const m=calculateMarine({items:[{code:'876511',qty:4},{code:'876515',qty:4},{code:'876523',qty:1}]});
 assert.equal(m.lines.length,3);assert.equal(m.readyToSend,false);assert.equal(m.currency,'USD');
 assert.equal(m.totalToPay,1560.50); // Independently checked with Python Decimal: 1560.496000
});
test('Marine missing quantities, unknown codes, non-USD and bad catalog values fail closed',()=>{
 for(const input of [{items:[{code:'876511'}]},{items:[{code:'bad',qty:1}]},{currency:'EUR',items:[{code:'876511',qty:1}]},{items:[{code:'876511',qty:-1}]}])assert.throws(()=>calculateMarine(input));
 assert.throws(()=>calculateMarine({items:[{code:'x',qty:1}]},()=>({retailUsd:1,discount:null,weightKg:0})));
 const c=calculateMarine({items:[{code:'x',qty:1}]},()=>({retailUsd:250,discount:0,weightKg:0}));assert.equal(c.subtotal,638);assert.equal(c.shipping,0);
});
const rate=validateFreightRate({origin:'China',destination:'Rosario',mode:'FCL',equipment:'40HQ',validFrom:'2026-11-01',validUntil:'2026-11-30',active:true,insurancePct:1,lines:[{description:'Flete',basis:'container',unitPrice:4000,vatPct:0},{description:'Local',basis:'shipment',unitPrice:790,vatPct:21}]});
test('FFW matches exact route and validity; ambiguity/expiration never guesses a price',()=>{
 assert.equal(selectFreightRate([rate],{origin:' china ',destination:'ROSARIO',mode:'FCL',equipment:'40HQ'},'2026-11-22'),rate);
 assert.throws(()=>selectFreightRate([rate],{origin:'China',destination:'Buenos Aires',mode:'FCL',equipment:'40HQ'},'2026-11-22'));
 assert.throws(()=>selectFreightRate([rate,rate],rate,'2026-11-22'));
 assert.throws(()=>selectFreightRate([rate],rate,'2026-12-01'));
 assert.throws(()=>validateFreightRate({...rate,validUntil:'2026-02-30'}));
});
test('FFW sums services, per-line VAT and insurance; FOB is excluded from total',()=>{
 const c=calculateFreight({containers:1,fob:10000,registeredTaxpayer:true},rate);
 assert.equal(c.totalToPay,5055.90);assert.equal(c.potentiallyRecoverableVat,165.90);
 assert.equal(c.insurance,100);assert.equal(c.readyToSend,false);
});
function fakeDb(){const records=new Map();const ref=(path)=>({id:path.split('/').at(-1),collection:n=>({doc:id=>ref(path+'/'+n+'/'+id)}),path});return {records,collection:n=>({doc:id=>ref(n+'/'+id)}),runTransaction:async fn=>fn({get:async r=>({exists:records.has(r.path),data:()=>records.get(r.path)}),create:(r,d)=>{assert(!records.has(r.path));records.set(r.path,d);}})};}
test('draft retries reuse original quote, date and snapshot; conflicts and other tenants are isolated',async()=>{
 const db=fakeDb(),input={clientName:'Prueba',items:[{code:'876511',qty:1}]},calculation=calculateMarine(input);
 const args={db,tenantId:'sentire-marine',requestId:'test-0001',input,calculation};
 const a=await saveDraft({...args,now:new Date('2026-11-22T00:00:00Z')});
 const b=await saveDraft({...args,now:new Date('2026-11-23T00:00:00Z'),calculation:{totalToPay:1}});
 assert.equal(b.reused,true);assert.equal(a.createdAt,b.createdAt);assert.equal(b.calculation.totalToPay,a.calculation.totalToPay);
 await assert.rejects(saveDraft({...args,input:{...input,clientName:'Otro'}}),/otros datos/);
 assert.equal(db.records.size,1);
 await saveDraft({...args,tenantId:'sentire-ffw'});assert.equal(db.records.size,2);
 const pdf=await businessPdf(a);assert.equal(pdf.subarray(0,4).toString(),'%PDF');
});
