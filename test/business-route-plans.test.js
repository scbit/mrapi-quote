import test from 'node:test';
import assert from 'node:assert/strict';
import {routeCatalog,validateRoutePlan,seedRoutePlans} from '../business-route-plans.js';
import {selectFreightRate} from '../business-pricing.js';
test('campaign routes retain distinct entry ports and never become zero-priced active rates',()=>{
 assert.equal(new Set(routeCatalog.routes.map(r=>r.id)).size,21);
 for(const city of ['Córdoba','Rafaela','Mendoza']){const r=routeCatalog.routes.filter(r=>r.destination===city);assert(r.length>=2);assert.equal(new Set(r.map(r=>r.entryPort)).size,r.length);}
 for(const r of routeCatalog.routes.filter(r=>!r.liveRateId)){assert(r.lines.every(l=>l.unitPrice===null&&l.vatPct===null));assert.throws(()=>selectFreightRate([r],r));}
 const base=routeCatalog.routes.find(r=>r.id==='china-san-vicente-neuquen');const partial=validateRoutePlan({lines:base.lines},base);assert.equal(partial.status,'pending_tariff');
 const priced=validateRoutePlan({lines:base.lines.map(l=>({...l,unitPrice:100,vatPct:0,scope:'included'}))},base);assert.equal(priced.status,'ready_for_review');assert.equal(priced.active,undefined);assert.throws(()=>selectFreightRate([priced],priced));
 assert.throws(()=>validateRoutePlan({lines:[{description:'x',basis:'container',scope:'included',unitPrice:-1,vatPct:0}]},base));
 assert.throws(()=>validateRoutePlan({lines:[]},routeCatalog.routes.find(r=>r.liveRateId)));
});
test('catalog seeding preserves edited routes and never writes active freight rates',async()=>{
 const records=new Map(),paths=[];
 const collection=n=>{paths.push(n);return {doc:id=>({id,collection})};};
 const db={collection,async runTransaction(fn){return fn({get:async r=>({exists:records.has(r.id)}),create:(r,data)=>records.set(r.id,data)});}};
 let r=await seedRoutePlans({db});assert.equal(r.created,21);records.get('china-san-vicente-neuquen').notes='editada';r=await seedRoutePlans({db});assert.equal(r.created,0);assert.equal(records.get('china-san-vicente-neuquen').notes,'editada');assert(!paths.includes('freightRates'));
});
