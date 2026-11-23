import {readFileSync} from 'node:fs';
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
