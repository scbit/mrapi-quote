import {readFileSync} from 'node:fs';
import {validateFreightRate} from './business-pricing.js';
export const routeCatalog=JSON.parse(readFileSync(new URL('./data/ffw-route-plans.json',import.meta.url)));
const fail=message=>{throw Object.assign(new Error(message),{status:422});};
// Route plans are editable, unpriced service templates. They are never read by
// selectFreightRate: completing one cannot silently enable customer quotations.
export function validateRoutePlan(value,base){
 if(base.liveRateId)fail('Esta ruta usa una tarifa activa. Editá la tarifa operativa.');
 const lines=value.lines;
 if(!Array.isArray(lines)||!lines.length||lines.length>40)fail('Se requieren entre 1 y 40 conceptos');
 const number=(v,max)=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);if(!Number.isFinite(n)||n<0||n>max)fail('Importe o IVA inválido');return n;};
 const normalized=lines.map(l=>{
  const description=String(l.description||'').trim();if(!description||description.length>200)fail('Concepto inválido');
  if(!['shipment','container','kg','cbm'].includes(l.basis)||!['pending','included','excluded'].includes(l.scope))fail('Unidad o alcance inválido');
  return {description,basis:l.basis,scope:l.scope,unitPrice:number(l.unitPrice,1e9),vatPct:number(l.vatPct,100)};
 });
 const ready=base.routeConfirmed&&normalized.every(l=>l.scope==='excluded'||l.scope==='included'&&l.unitPrice!==null&&l.vatPct!==null)&&normalized.some(l=>l.scope==='included');
 return {...base,lines:normalized,notes:String(value.notes||'').slice(0,2000),status:ready?'ready_for_review':'pending_tariff'};
}
export async function seedRoutePlans({db,now=new Date()}){
 const collection=db.collection('tenants').doc('sentire-ffw').collection('freightRoutePlans');let created=0;
 for(const route of routeCatalog.routes){const ref=collection.doc(route.id);created+=await db.runTransaction(async tx=>{const old=await tx.get(ref);if(old.exists)return 0;tx.create(ref,{...route,version:1,createdAt:now.toISOString(),updatedAt:now.toISOString(),catalogVersion:routeCatalog.version});return 1;});}
 return {created,count:routeCatalog.routes.length,catalogVersion:routeCatalog.version};
}
export function routePlanRate(plan){
 const base=routeCatalog.routes.find(r=>r.id===plan.id);if(!base||base.liveRateId)fail('Usá la tarifa operativa de esta ruta.');
 const checked=validateRoutePlan(plan,base);
 if(checked.status!=='ready_for_review')fail('Completá importe, IVA y alcance de todos los conceptos antes de generar el PDF o activar.');
 if(base.mode!=='FCL'||base.equipment!=='40HQ')fail('La activación del piloto está disponible para FCL 40HQ.');
 const excluded=checked.lines.filter(l=>l.scope==='excluded').map(l=>l.description);
 return validateFreightRate({...base,entryPort:base.entryPort,routePlanId:base.id,active:true,insurancePct:0,
  lines:checked.lines.filter(l=>l.scope==='included').map(({scope,...l})=>l),notes:[checked.notes,excluded.length?'No incluye: '+excluded.join('; ')+'.':''].filter(Boolean).join('\n')});
}
export async function activateRoutePlan({db,id,version,now=new Date()}){
 const tenant=db.collection('tenants').doc('sentire-ffw'),ref=tenant.collection('freightRoutePlans').doc(id),rateRef=tenant.collection('freightRates').doc(id);
 return db.runTransaction(async tx=>{
  const [snap,oldRate]=await Promise.all([tx.get(ref),tx.get(rateRef)]);if(!snap.exists)fail('Guardá la ruta antes de activarla.');
  const plan=snap.data();if(plan.version!==Number(version))throw Object.assign(new Error('La ruta cambió. Recargá antes de activar.'),{status:409});
  if(plan.liveRateId||oldRate.exists)throw Object.assign(new Error('La ruta ya tiene una tarifa. Recargá para editarla.'),{status:409});
  const rate={...routePlanRate(plan),id,version:1,createdAt:now.toISOString(),updatedAt:now.toISOString(),sourceRouteVersion:plan.version};
  const route={...plan,liveRateId:id,status:'active',version:plan.version+1,activatedAt:now.toISOString(),updatedAt:now.toISOString()};
  tx.create(rateRef,rate);tx.create(rateRef.collection('versions').doc('1'),rate);tx.update(ref,route);tx.create(ref.collection('versions').doc(String(route.version)),route);
  return {route,rate};
 });
}
