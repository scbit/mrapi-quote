import express from 'express';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { businessConfig } from './businesses.js';
import { calculateMarine, calculateFreight, marineCatalog, lookupMarine, selectFreightRate, validateFreightRate, PricingError } from './business-pricing.js';

const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const fingerprint=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export async function saveDraft({db,tenantId,requestId,input,calculation,now=new Date()}) {
  if(!businessConfig(tenantId))throw new PricingError('Negocio inválido');
  if(!/^[A-Za-z0-9_.:-]{8,160}$/.test(requestId||''))throw new PricingError('requestId inválido');
  const id='bq_'+fingerprint({tenantId,requestId}).slice(0,40);
  const ref=db.collection('tenants').doc(tenantId).collection('quotes').doc(id);
  const hash=fingerprint(input);
  const draft={id,tenantId,requestId,inputHash:hash,status:'draft',currency:'USD',
    quoteNo:`${tenantId==='sentire-marine'?'SM':'FFW'}-${now.getUTCFullYear()}-${id.slice(3,15).toUpperCase()}`,
    createdAt:now.toISOString(),validUntil:new Date(now.getTime()+7*86400000).toISOString().slice(0,10),
    input,calculation,readyToSend:false};
  if(calculation.validUntil&&calculation.validUntil<draft.validUntil)draft.validUntil=calculation.validUntil;
  return db.runTransaction(async tx=>{
    const old=await tx.get(ref);
    if(old.exists){
      if(old.data().inputHash!==hash)throw Object.assign(new Error('requestId ya usado con otros datos'),{status:409});
      return {...old.data(),id,reused:true};
    }
    tx.create(ref,draft);return {...draft,reused:false};
  });
}

export async function businessPdf(quote) {
  const doc=new PDFDocument({size:'A4',margin:42});
  const chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const c=quote.calculation,money=n=>`USD ${Number(n||0).toFixed(2)}`;
  const title=quote.tenantId==='sentire-marine'?'SENTIRE MARINE':'SENTIRE FFW';
  doc.fontSize(22).fillColor('#183d50').text(title);
  doc.fontSize(13).text('PRESUPUESTO · BORRADOR');
  doc.moveDown().fontSize(10).fillColor('#222').text(`Número: ${quote.quoteNo}`)
    .text(`Fecha: ${quote.createdAt.slice(0,10)} · Válido hasta: ${quote.validUntil}`)
    .text(`Cliente: ${quote.input.clientName||'A confirmar'}`);
  if(c.origin)doc.text(`Ruta: ${c.origin} → ${c.destination} · ${c.equipment}`);
  doc.moveDown();
  for(const line of c.lines){
    if(doc.y>690)doc.addPage();
    doc.font('Helvetica-Bold').text(`${line.code?line.code+' · ':''}${line.description}`);
    doc.font('Helvetica').text(`Cantidad: ${line.qty} · Unitario: ${money(line.unitPrice)} · Importe: ${money(line.amount??line.net)}`);
    if(line.vatPct!==undefined)doc.text(`IVA: ${line.vatPct}% · ${money(line.vat)}`);
    doc.moveDown(0.6);
  }
  if(doc.y>590)doc.addPage();
  doc.moveDown().text(`Subtotal: ${money(c.subtotal)}`);
  if(c.discountAmount)doc.text(`Descuento: ${money(c.discountAmount)}`);
  if(c.shipping!==undefined)doc.text(`Envío: ${money(c.shipping)}`);
  if(c.insurance!==undefined)doc.text(`Seguro: ${money(c.insurance)}`);
  if(c.vat!==undefined)doc.text(`IVA: ${money(c.vat)}`);
  doc.font('Helvetica-Bold').fontSize(14).text(`TOTAL: ${money(c.totalToPay)}`);
  doc.moveDown().font('Helvetica').fontSize(9);
  if(c.vatIncluded)doc.text('IVA incluido según fórmula comercial. Todos los importes están expresados en USD.');
  if(c.exclusions)doc.text(c.exclusions);
  doc.text('Borrador pendiente de validación comercial. No confirma stock, compatibilidad ni plazo de entrega.');
  doc.end();return done;
}

export function createBusinessRouter({db,tenantId,secret=()=>process.env.QUOTES_BUSINESS_SECRET||process.env.AI_CORE_QUOTES_SECRET||''}) {
  const router=express.Router();
  router.use((req,res,next)=>{
    const tid=tenantId(req);if(!businessConfig(tid))return res.status(404).json({error:'Negocio no disponible'});
    req.businessTenant=tid;next();
  });
  function writeAuth(req,res,next){
    const expected=String(secret()),actual=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(expected.length<32)return res.status(503).json({error:'Acceso de escritura del cotizador pendiente de configurar'});
    const a=Buffer.from(expected),b=Buffer.from(actual);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Se requiere acceso autorizado'});
    next();
  }
  const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Error del cotizador',code:e.code||'business_error'});}};
  async function calculate(req){
    const tid=req.businessTenant,input=req.body;
    if(tid==='sentire-marine')return {...calculateMarine(input),catalogVersion:marineCatalog().version,sourceSha256:marineCatalog().sourceSha256};
    const snap=await db.collection('tenants').doc(tid).collection('freightRates').where('active','==',true).limit(501).get();
    if(snap.size>500)throw new PricingError('Usar búsqueda de tarifa más específica: catálogo excede el límite');
    const rate=selectFreightRate(snap.docs.map(d=>({id:d.id,...d.data()})),input);
    return calculateFreight(input,rate);
  }
  router.get('/status',wrap(async(req,res)=>res.json({business:businessConfig(req.businessTenant),
    catalog:req.businessTenant==='sentire-marine'?{count:marineCatalog().products.length,version:marineCatalog().version,sourceLabel:marineCatalog().sourceLabel}:null,
    capabilities:{preview:true,draft:true,automaticSend:false,crm:false,drive:false}})));
  router.get('/parts',wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-marine')return res.status(404).json({error:'Este negocio usa tarifas por ruta'});
    res.json({items:lookupMarine(String(req.query.q||'').slice(0,120))});
  }));
  router.post('/preview',wrap(async(req,res)=>res.json(await calculate(req))));
  router.post('/preview.pdf',wrap(async(req,res)=>{
    const calculation=await calculate(req),createdAt=new Date().toISOString();
    const pdf=await businessPdf({tenantId:req.businessTenant,quoteNo:'VISTA-PREVIA',createdAt,
      validUntil:createdAt.slice(0,10),input:{clientName:String(req.body.clientName||'').slice(0,180)},calculation});
    res.type('pdf').send(pdf);
  }));
  router.get('/rates',wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Este negocio usa catálogo de repuestos'});
    const snap=await db.collection('tenants').doc(req.businessTenant).collection('freightRates').limit(501).get();
    res.json({items:snap.docs.slice(0,500).map(d=>({id:d.id,...d.data()})),partial:snap.size>500});
  }));
  router.put('/rates/:id',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio inválido para tarifas'});
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.id))throw new PricingError('ID de tarifa inválido');
    const rate=validateFreightRate(req.body);
    const ref=db.collection('tenants').doc(req.businessTenant).collection('freightRates').doc(req.params.id);
    const result=await db.runTransaction(async tx=>{
      const snap=await tx.get(ref),old=snap.exists?snap.data():null;
      if(old&&Number(req.body.version)!==old.version)throw Object.assign(new Error('La tarifa cambió: recargar antes de guardar'),{status:409});
      const version=(old?.version||0)+1,updatedAt=new Date().toISOString();
      const record={...rate,version,updatedAt,createdAt:old?.createdAt||updatedAt};
      // Keep every revision used by a quote available for later audit.
      tx.set(ref,record);tx.create(ref.collection('versions').doc(String(version)),record);
      return {id:ref.id,...record};
    });
    res.json(result);
  }));
  router.post('/drafts',writeAuth,wrap(async(req,res)=>{
    const {requestId,...input}=req.body;
    const calculation=await calculate({...req,body:input});
    res.json(await saveDraft({db,tenantId:req.businessTenant,requestId,input,calculation}));
  }));
  router.get('/drafts/:id/pdf',writeAuth,wrap(async(req,res)=>{
    if(!/^bq_[a-f0-9]{40}$/.test(req.params.id))throw new PricingError('Cotización inválida');
    const snap=await db.collection('tenants').doc(req.businessTenant).collection('quotes').doc(req.params.id).get();
    if(!snap.exists)return res.status(404).json({error:'Cotización no encontrada'});
    const pdf=await businessPdf(snap.data());res.type('pdf').send(pdf);
  }));
  return router;
}
