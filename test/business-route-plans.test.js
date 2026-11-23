import test from 'node:test';
import assert from 'node:assert/strict';
import {routeCatalog,validateRoutePlan,seedRoutePlans,routePlanRate,activateRoutePlan} from '../business-route-plans.js';
import {selectFreightRate,calculateFreight} from '../business-pricing.js';
test('campaign routes retain distinct entry ports and never become zero-priced active rates',()=>{
 assert.equal(new Set(routeCatalog.routes.map(r=>r.id)).size,21);
 for(const city of ['Córdoba','Rafaela','Mendoza']){const r=routeCatalog.routes.filter(r=>r.destination===city);assert(r.length>=2);assert.equal(new Set(r.map(r=>r.entryPort)).size,r.length);}
 for(const r of routeCatalog.routes.filter(r=>!r.liveRateId)){assert(r.lines.every(l=>l.unitPrice===null&&l.vatPct===null));assert.throws(()=>selectFreightRate([r],r));}
 const base=routeCatalog.routes.find(r=>r.id==='china-san-vicente-neuquen');const partial=validateRoutePlan({lines:base.lines},base);assert.equal(partial.status,'pending_tariff');
 const priced=validateRoutePlan({lines:base.lines.map(l=>({...l,unitPrice:100,vatPct:0,scope:'included'}))},base);assert.equal(priced.status,'ready_for_review');assert.equal(priced.active,undefined);assert.throws(()=>selectFreightRate([priced],priced));
 assert.throws(()=>validateRoutePlan({lines:[{description:'x',basis:'container',scope:'included',unitPrice:-1,vatPct:0}]},base));
 assert.throws(()=>validateRoutePlan({lines:[]},routeCatalog.routes.find(r=>r.liveRateId)));
});
test('activation requires complete reviewed FCL lines and preserves distinct entry-port alternatives',()=>{
 const base=routeCatalog.routes.find(r=>r.id==='china-san-vicente-neuquen');assert.throws(()=>routePlanRate(base));
 const plan={...base,lines:base.lines.map(l=>({...l,scope:'included',unitPrice:100,vatPct:0}))};plan.lines[4]={...plan.lines[4],scope:'excluded',unitPrice:null,vatPct:null};
 const rate=routePlanRate(plan);assert.equal(rate.lines.length,4);assert.match(rate.notes,/No incluye: Depósito fiscal Neuquén/);assert.equal(calculateFreight({containers:1},rate).entryPort,'San Vicente');
 const a={...rate,id:'mvd',destination:'Córdoba',entryPort:'Montevideo'},b={...rate,id:'sa',destination:'Córdoba',entryPort:'San Antonio'},input={origin:'China',destination:'Cordoba',mode:'FCL',equipment:'40HQ'};
 assert.throws(()=>selectFreightRate([a,b],input),e=>e.code==='ambiguous_rate');assert.equal(selectFreightRate([a,b],{...input,entryPort:'San Antonio'}).id,'sa');assert.equal(selectFreightRate([a,b],{...input,routeId:'mvd'}).id,'mvd');assert.throws(()=>selectFreightRate([a,b],{...input,entryPort:'Zárate'}));
});
test('activation is atomic, version checked and never overwrites an existing tariff',async()=>{
 const base=routeCatalog.routes.find(r=>r.id==='china-san-vicente-neuquen'),records=new Map(),root='tenants/sentire-ffw';
 const ref=path=>({path,collection:n=>collection(path+'/'+n)}),collection=path=>({doc:id=>ref(path+'/'+id)});let chain=Promise.resolve();
 const db={collection,runTransaction(fn){const p=chain.then(async()=>{const ops=[];const result=await fn({get:async r=>({exists:records.has(r.path),data:()=>records.get(r.path)}),create:(r,d)=>{assert(!records.has(r.path));ops.push([r.path,d]);},update:(r,d)=>ops.push([r.path,{...records.get(r.path),...d}])});ops.forEach(([p,d])=>records.set(p,d));return result;});chain=p.catch(()=>{});return p;}};
 records.set(root+'/freightRoutePlans/'+base.id,{...base,version:5,lines:base.lines.map(l=>({...l,scope:'included',unitPrice:100,vatPct:0}))});
 const results=await Promise.allSettled([activateRoutePlan({db,id:base.id,version:5}),activateRoutePlan({db,id:base.id,version:5})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(records.get(root+'/freightRates/'+base.id).version,1);assert.equal(records.get(root+'/freightRoutePlans/'+base.id).liveRateId,base.id);
});
test('catalog seeding preserves edited routes and never writes active freight rates',async()=>{
 const records=new Map(),paths=[];
 const collection=n=>{paths.push(n);return {doc:id=>({id,collection})};};
 const db={collection,async runTransaction(fn){return fn({get:async r=>({exists:records.has(r.id)}),create:(r,data)=>records.set(r.id,data)});}};
 let r=await seedRoutePlans({db});assert.equal(r.created,21);records.get('china-san-vicente-neuquen').notes='editada';r=await seedRoutePlans({db});assert.equal(r.created,0);assert.equal(records.get('china-san-vicente-neuquen').notes,'editada');assert(!paths.includes('freightRates'));
});
