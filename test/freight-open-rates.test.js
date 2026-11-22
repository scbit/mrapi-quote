import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFreightRate,selectFreightRate,calculateFreight} from '../business-pricing.js';
const rate=price=>validateFreightRate({origin:'China',destination:'Buenos Aires',mode:'FCL',equipment:'40HQ',active:true,notes:'Flete y locales. Terminal y camión no incluidos.',lines:[{description:'Flete marítimo',basis:'container',unitPrice:price,vatPct:0},{description:'Locales naviera',basis:'container',unitPrice:790,vatPct:21}]});
test('active tariff without dates remains until edited or disabled; dated legacy tariffs still expire',()=>{
 const r=rate(3500);assert.equal(r.validUntil,null);assert.equal(selectFreightRate([r],r,'2030-01-01'),r);
 assert.throws(()=>selectFreightRate([{...r,active:false}],r));
 assert.throws(()=>selectFreightRate([r,rate(3800)],r));
 assert.throws(()=>selectFreightRate([{...r,validUntil:'2026-11-30'}],r,'2026-12-01'));
 assert.throws(()=>validateFreightRate({...r,validFrom:'2026-02-30'}));
});
test('confirmed new prices use exempt freight and 21 percent VAT only on local fees, per container',()=>{
 for(const [price,total] of [[3500,4455.90],[3800,4755.90]]){
  const c=calculateFreight({containers:1},rate(price));assert.equal(c.totalToPay,total);assert.equal(c.vat,165.90);assert.equal(c.validUntil,null);assert.equal(c.lines[0].vat,0);
  assert.equal(calculateFreight({containers:2},rate(price)).totalToPay,total*2);
 }
});
