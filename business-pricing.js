import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export class PricingError extends Error {
  constructor(message, code='invalid_quote') { super(message); this.code=code; this.status=422; }
}
const fail=(message,code)=>{throw new PricingError(message,code);};
export function amount(value, name, {min=0,max=1e12}={}) {
  if(value===null || value==='' || typeof value==='boolean' || !['number','string'].includes(typeof value)) fail(`Falta ${name}`);
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max) fail(`${name} inválido`);
  return n;
}
const cents=n=>Math.round((n+Number.EPSILON)*100)/100;
let catalog;
export function marineCatalog() {
  if(!catalog) {
    const data=JSON.parse(gunzipSync(readFileSync(new URL('./data/marine-catalog.json.gz',import.meta.url))));
    catalog={...data,byCode:new Map(data.products.map(p=>[p.code,p]))};
  }
  return catalog;
}
export function lookupMarine(query, limit=20) {
  const c=marineCatalog(),q=String(query||'').trim().toUpperCase();
  if(!q) return [];
  const found=c.byCode.get(q);
  return found?[found]:c.products.filter(p=>p.code.includes(q)||String(p.description).toUpperCase().includes(q)).slice(0,limit);
}
export function calculateMarine(input, lookup=code=>marineCatalog().byCode.get(code)) {
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100) fail('Se requieren entre 1 y 100 repuestos');
  if(input.currency&&input.currency!=='USD') fail('Marine cotiza únicamente en USD');
  const lines=input.items.map(item=>{
    const code=String(item.code||'').trim(),p=lookup(code);
    if(!p) fail(`Código ${code} no encontrado`,'part_not_found');
    const qty=amount(item.qty,'cantidad',{min:1,max:100000});
    if(!Number.isInteger(qty)) fail('La cantidad de repuestos debe ser entera');
    const retail=amount(p.retailUsd,'precio de catálogo');
    const discount=amount(p.discount,'descuento de catálogo',{max:1});
    const kg=amount(p.weightKg,'peso del repuesto');
    const net=retail*(1-discount),adjusted=net*1.16,weightFreight=kg*14;
    // Hoja 1!H22, preserving full intermediate precision from the workbook.
    const rawUnit=adjusted+weightFreight+adjusted/2+(adjusted+weightFreight)*0.7;
    return {code,description:String(p.description||code),qty,unitPrice:cents(rawUnit),
      amount:cents(rawUnit*qty),rawAmount:rawUnit*qty,countryOfOrigin:p.countryOfOrigin||null,
      compatibilityStatus:'not_verified',leadTimeStatus:'not_verified'};
  });
  const subtotal=lines.reduce((s,l)=>s+l.rawAmount,0);
  const discountPct=amount(input.discountPct??0,'descuento',{max:100});
  const shipping=subtotal>550?0:100; // Hoja 1!I33: exactly 550 still pays shipping.
  return {currency:'USD',formulaVersion:'marine-excel-v1',lines:lines.map(({rawAmount,...l})=>l),
    subtotal:cents(subtotal),discountPct,discountAmount:cents(subtotal*discountPct/100),
    shipping,totalToPay:cents(subtotal*(1-discountPct/100)+shipping),vatIncluded:true,
    warnings:['Compatibilidad, reemplazos y plazo pendientes de verificación'],
    readyToSend:false};
}

const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase().replace(/\s+/g,' ');
export function validateFreightRate(value) {
  const rate={};
  for(const key of ['origin','destination','mode','equipment']) {
    rate[key]=String(value[key]||'').trim().slice(0,160);
    if(!rate[key])fail(`Falta ${key}`);
  }
  for(const key of ['validFrom','validUntil']) {
    rate[key]=value[key]?String(value[key]):null;
    if(rate[key]!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(rate[key])||!Number.isFinite(Date.parse(rate[key]))||new Date(rate[key]).toISOString().slice(0,10)!==rate[key]))fail(`${key} inválida`);
  }
  if(rate.validFrom&&rate.validUntil&&rate.validUntil<rate.validFrom)fail('La fecha final debe ser posterior a la inicial');
  if(!Array.isArray(value.lines)||!value.lines.length||value.lines.length>100)fail('Se requieren conceptos de tarifa');
  rate.lines=value.lines.map(line=>{
    if(!['shipment','container','kg','cbm'].includes(line.basis))fail('Unidad de tarifa no soportada');
    const description=String(line.description||'').trim().slice(0,200);
    if(!description)fail('Falta descripción del concepto');
    return {description,basis:line.basis,unitPrice:amount(line.unitPrice,'tarifa'),vatPct:amount(line.vatPct,'IVA',{max:100})};
  });
  rate.currency='USD';rate.insurancePct=amount(value.insurancePct??0,'seguro',{max:100});
  rate.entryPort=value.entryPort?String(value.entryPort).trim().slice(0,160):null;
  rate.routePlanId=value.routePlanId?String(value.routePlanId).trim().slice(0,100):null;
  rate.active=value.active===true;
  rate.notes=String(value.notes||'').slice(0,2000);
  return rate;
}
export function selectFreightRate(rates, input, today=new Date().toISOString().slice(0,10)) {
  for(const key of ['origin','destination','mode','equipment']) if(!normalize(input[key])) fail(`Falta ${key}`);
  const found=rates.filter(r=>r.active===true && ['origin','destination','mode','equipment'].every(k=>normalize(r[k])===normalize(input[k]))
    && (!input.routeId||r.id===input.routeId||r.routePlanId===input.routeId)
    && (!input.entryPort||normalize(r.entryPort||r.destination)===normalize(input.entryPort))
    && (!r.validFrom||(/^\d{4}-\d{2}-\d{2}$/.test(r.validFrom)&&r.validFrom<=today))
    && (!r.validUntil||(/^\d{4}-\d{2}-\d{2}$/.test(r.validUntil)&&r.validUntil>=today)));
  if(found.length!==1) fail(found.length?'Hay varias tarifas vigentes: requiere selección':'No hay tarifa vigente para esta ruta',found.length?'ambiguous_rate':'rate_not_found');
  return found[0];
}
export function calculateFreight(input, rate) {
  if(rate.currency!=='USD'||(input.currency&&input.currency!=='USD')) fail('FFW cotiza únicamente en USD');
  if(!Array.isArray(rate.lines)||!rate.lines.length||rate.lines.length>100) fail('La tarifa no tiene conceptos válidos');
  const lines=rate.lines.map(line=>{
    let qty;
    if(line.basis==='shipment')qty=1;
    else if(line.basis==='container')qty=amount(input.containers,'contenedores',{min:1,max:10000});
    else if(line.basis==='kg')qty=amount(input.chargeableKg,'peso cobrable',{min:0.001});
    else if(line.basis==='cbm')qty=amount(input.cbm,'volumen',{min:0.001});
    else fail('Unidad de tarifa no soportada');
    if(line.basis==='container'&&!Number.isInteger(qty))fail('Contenedores debe ser entero');
    const unit=amount(line.unitPrice,'tarifa');
    const vatPct=amount(line.vatPct,'IVA del concepto',{max:100});
    const rawNet=unit*qty,rawVat=rawNet*vatPct/100;
    return {description:String(line.description||''),qty,unitPrice:unit,vatPct,net:cents(rawNet),vat:cents(rawVat),rawNet,rawVat};
  });
  const insurancePct=amount(rate.insurancePct??0,'seguro',{max:100});
  const insurance=insurancePct?amount(input.fob,'FOB para seguro')*insurancePct/100:0;
  const net=lines.reduce((s,l)=>s+l.rawNet,0),vat=lines.reduce((s,l)=>s+l.rawVat,0);
  return {currency:'USD',formulaVersion:'ffw-services-v1',rateId:rate.id,rateVersion:rate.version,
    origin:rate.origin,destination:rate.destination,mode:rate.mode,equipment:rate.equipment,entryPort:rate.entryPort||null,
    lines:lines.map(({rawNet,rawVat,...l})=>l),subtotal:cents(net),insurance:cents(insurance),vat:cents(vat),
    potentiallyRecoverableVat:input.registeredTaxpayer===true?cents(vat):0,
    totalToPay:cents(net+vat+insurance),validUntil:rate.validUntil||null,conditions:rate.notes||'',
    exclusions:'No incluye impuestos, derechos ni honorarios de despacho aduanero.',readyToSend:false};
}

