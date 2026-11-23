import express from 'express';
import crypto from 'node:crypto';
import {ffwPdf,FFW_PDF_VERSION} from './business-ffw-pdf.js';
import {routeCatalog,validateRoutePlan,seedRoutePlans,routePlanRate,activateRoutePlan} from './business-route-plans.js';
import {marinePdf,MARINE_PDF_VERSION} from './business-marine-pdf.js';
import { businessConfig } from './businesses.js';
import { createDriveClient, userDriveConfigured, runtimeToken } from './business-drive.js';
import {createDriveOAuth,cookieValue} from './business-drive-oauth.js';
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
    createdAt:now.toISOString(),validUntil:tenantId==='sentire-ffw'?(calculation.validUntil||null):new Date(now.getTime()+7*86400000).toISOString().slice(0,10),
    input,calculation,readyToSend:false};
  if(calculation.validUntil&&(!draft.validUntil||calculation.validUntil<draft.validUntil))draft.validUntil=calculation.validUntil;
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
  if(quote.tenantId==='sentire-marine')return marinePdf(quote);
  return ffwPdf(quote);
}

export function createBusinessRouter({db,tenantId,secret=()=>process.env.QUOTES_BUSINESS_SECRET||process.env.AI_CORE_QUOTES_SECRET||'',drive=null,oauth=createDriveOAuth({db})}) {
  const router=express.Router();
  drive=drive||createDriveClient({tokenProvider:async tid=>await oauth.connected(tid)?oauth.token(tid):runtimeToken(),isUser:async tid=>await oauth.connected(tid)||userDriveConfigured()});
  function writeAuth(req,res,next){
    const expected=String(secret()),actual=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(expected.length<32)return res.status(503).json({error:'Acceso de escritura del cotizador pendiente de configurar'});
    const a=Buffer.from(expected),b=Buffer.from(actual);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Se requiere acceso autorizado'});
    next();
  }
  const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Error del cotizador',code:e.code||'business_error'});}};
  router.post('/drive/oauth/start',writeAuth,wrap(async(req,res)=>{const tid=tenantId(req);if(!businessConfig(tid))return res.status(404).json({error:'Negocio no disponible'});res.set('Cache-Control','no-store').json(await oauth.begin(tid));}));
  router.get('/drive/oauth/connect',wrap(async(req,res)=>{const result=await oauth.connect(req.query.ticket);res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':result.cookie}).redirect(303,result.url);}));
  router.get('/drive/oauth/callback',wrap(async(req,res)=>{const result=await oauth.callback(req.query,cookieValue(req.headers.cookie));res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':oauth.clearCookie}).type('html').send(result.ok?'<!doctype html><meta charset="utf-8"><h1>Drive conectado</h1><p>La carpeta de cotizaciones quedó autorizada. Podés cerrar esta pestaña.</p>':'<!doctype html><meta charset="utf-8"><h1>Conexión cancelada</h1><p>No se autorizó acceso a Drive.</p>');}));
  router.use((req,res,next)=>{const tid=tenantId(req);if(!businessConfig(tid))return res.status(404).json({error:'Negocio no disponible'});req.businessTenant=tid;next();});
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
    capabilities:{preview:true,draft:true,automaticSend:false,crm:false,drive:false,driveAdapter:true,driveUserConfigured:await oauth.connected(req.businessTenant)||userDriveConfigured()}})));
  router.get('/drive/status',writeAuth,wrap(async(req,res)=>res.json(await drive.folder(req.businessTenant))));
  router.post('/drafts/:id/drive',writeAuth,wrap(async(req,res)=>{
    if(!/^bq_[a-f0-9]{40}$/.test(req.params.id))throw new PricingError('Cotización inválida');
    const quoteRef=db.collection('tenants').doc(req.businessTenant).collection('quotes').doc(req.params.id);
    const snap=await quoteRef.get();if(!snap.exists)return res.status(404).json({error:'Cotización no encontrada'});
    const quote=snap.data();
    res.json(await drive.exportPdf({quote,quoteRef,db,pdf:await businessPdf(quote),pdfVersion:quote.tenantId==='sentire-marine'?MARINE_PDF_VERSION:FFW_PDF_VERSION}));
  }));
  router.get('/parts',wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-marine')return res.status(404).json({error:'Este negocio usa tarifas por ruta'});
    res.json({items:lookupMarine(String(req.query.q||'').slice(0,120)).map(({code,description,countryOfOrigin})=>({code,description,countryOfOrigin}))});
  }));
  router.post('/preview',wrap(async(req,res)=>res.json(await calculate(req))));
  router.post('/preview.pdf',wrap(async(req,res)=>{
    const calculation=await calculate(req),createdAt=new Date().toISOString();
    const pdf=await businessPdf({tenantId:req.businessTenant,quoteNo:'VISTA-PREVIA',createdAt,
      validUntil:createdAt.slice(0,10),input:{clientName:String(req.body.clientName||'').slice(0,180)},calculation});
    res.type('pdf').send(pdf);
  }));
  router.get('/rates',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Este negocio usa catálogo de repuestos'});
    const snap=await db.collection('tenants').doc(req.businessTenant).collection('freightRates').limit(501).get();
    res.json({items:snap.docs.slice(0,500).map(d=>({id:d.id,...d.data()})),partial:snap.size>500});
  }));
  router.get('/route-plans',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio no disponible'});
    const snap=await db.collection('tenants').doc(req.businessTenant).collection('freightRoutePlans').limit(200).get();
    const saved=new Map(snap.docs.map(d=>[d.id,d.data()]));
    res.json({catalogVersion:routeCatalog.version,items:routeCatalog.routes.map(r=>saved.get(r.id)||r)});
  }));
  router.post('/route-plans/seed',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio no disponible'});
    res.json(await seedRoutePlans({db}));
  }));
  router.post('/route-plans/:id/preview.pdf',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio no disponible'});
    const base=routeCatalog.routes.find(r=>r.id===req.params.id);if(!base)return res.status(404).json({error:'Ruta no encontrada'});
    const tenant=db.collection('tenants').doc(req.businessTenant),snap=await tenant.collection('freightRoutePlans').doc(base.id).get(),plan=snap.exists?snap.data():base;
    if(Number(req.body.version)!==plan.version)throw Object.assign(new Error('La ruta cambió. Recargá antes de generar el PDF.'),{status:409});
    let rate;if(plan.liveRateId){const active=await tenant.collection('freightRates').doc(plan.liveRateId).get();if(!active.exists)throw new PricingError('Tarifa no encontrada');rate=active.data();}else rate=routePlanRate(plan);
    const input={clientName:'Vista previa · No enviada al cliente',containers:1,currency:'USD'},calculation=calculateFreight(input,{...rate,id:plan.liveRateId||plan.id,version:rate.version||0});
    const pdf=await businessPdf({tenantId:req.businessTenant,quoteNo:'PRUEBA-FFW',createdAt:new Date().toISOString(),preview:true,input,calculation});
    res.set({'Cache-Control':'no-store','Content-Disposition':'attachment; filename="FFW-PRUEBA.pdf"'}).type('pdf').send(pdf);
  }));
  router.post('/route-plans/:id/activate',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio no disponible'});
    if(!routeCatalog.routes.some(r=>r.id===req.params.id))return res.status(404).json({error:'Ruta no encontrada'});
    res.json(await activateRoutePlan({db,id:req.params.id,version:req.body.version}));
  }));
  router.put('/route-plans/:id',writeAuth,wrap(async(req,res)=>{
    if(req.businessTenant!=='sentire-ffw')return res.status(404).json({error:'Negocio no disponible'});
    const base=routeCatalog.routes.find(r=>r.id===req.params.id);if(!base)return res.status(404).json({error:'Ruta no encontrada'});
    const input=validateRoutePlan(req.body,base),ref=db.collection('tenants').doc(req.businessTenant).collection('freightRoutePlans').doc(base.id);
    const result=await db.runTransaction(async tx=>{const snap=await tx.get(ref),old=snap.exists?snap.data():null;
      if(old?.liveRateId)throw Object.assign(new Error('La ruta ya está activa. Recargá para editar su tarifa.'),{status:409});
      if(Number(req.body.version)!==(old?.version||0))throw Object.assign(new Error('La ruta cambió. Recargá antes de guardar.'),{status:409});
      const record={...input,version:(old?.version||0)+1,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),catalogVersion:routeCatalog.version};
      tx.set(ref,record);tx.create(ref.collection('versions').doc(String(record.version)),record);return record;
    });res.json(result);
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
    const q=snap.data(),pdf=await businessPdf(q);res.set('x-quote-pdf-template',q.tenantId==='sentire-ffw'?FFW_PDF_VERSION:MARINE_PDF_VERSION).type('pdf').send(pdf);
  }));
  router.get('/drafts/:id',writeAuth,wrap(async(req,res)=>{
    if(!/^bq_[a-f0-9]{40}$/.test(req.params.id))throw new PricingError('Cotización inválida');
    const snap=await db.collection('tenants').doc(req.businessTenant).collection('quotes').doc(req.params.id).get();
    if(!snap.exists)return res.status(404).json({error:'Cotización no encontrada'});
    res.json(snap.data());
  }));
  return router;
}

