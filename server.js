import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 8080;
const databaseId = process.env.FIRESTORE_DATABASE_ID || 'mrapi-quote';
const bucketName = process.env.BUCKET_NAME || 'mrapi-quote';
const defaultTenant = process.env.DEFAULT_TENANT || 'sentire-customs-broker';
const firestore = new Firestore({ databaseId });
const storage = new Storage();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const tenantId = (req) => String(req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId || defaultTenant).trim();
const tdoc = (tid) => firestore.collection('tenants').doc(tid);
const col = (tid, name) => tdoc(tid).collection(name);
const now = () => FieldValue.serverTimestamp();
const id = (prefix='id') => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
const num = (v, d=0) => Number.isFinite(Number(v)) ? Number(v) : d;

function applyUseRules(profile={}, use='commercial') {
  const p={...profile};
  const u=String(use||'commercial').toLowerCase();
  if (u === 'capital_good' || u === 'bien_de_uso') {
    p.vatAdditional=0; p.earnings=0; p.iibb=0; p.statisticalFee=0;
  } else if (u === 'particular') {
    p.vatAdditional=0; p.earnings=11; p.iibb=0; p.statisticalFee=0;
  }
  return p;
}

function computeTaxesFromBase({fob, freight=0, insurance=0, agentCommission=0, profile={}, use='commercial'}) {
  const tax=applyUseRules(profile,use);
  const cif=num(fob)+num(agentCommission)+num(freight)+num(insurance);
  const statBase=cif;
  const statisticalFee=statBase*num(tax.statisticalFee)/100;
  const dutyBase=cif+statisticalFee;
  const duty=dutyBase*num(tax.duty)/100;
  const vatBase=dutyBase+duty;
  const vat=vatBase*num(tax.vat)/100;
  const vatAdditional=vatBase*num(tax.vatAdditional)/100;
  const earnings=vatBase*num(tax.earnings)/100;
  const iibb=vatBase*num(tax.iibb)/100;
  const taxesTotal=duty+vat+vatAdditional+earnings+iibb+statisticalFee;
  const recoverable=vat+vatAdditional+earnings+iibb;
  return {cif,statBase,dutyBase,vatBase,duty,vat,vatAdditional,earnings,iibb,statisticalFee,taxesTotal,recoverable};
}

function calculateQuote(input) {
  const fob=num(input.fob), cbm=num(input.cbm), kg=num(input.kg);
  const tax=input.taxProfile||{};
  const log=input.logisticsProfile||{};
  const items=Array.isArray(input.items)?input.items:[];
  const itemAgentCommissionTotal=items.reduce((s,i)=>s+(num(i.unitFob)*num(i.qty,1)*(num(i.agentCommissionPct)/100)),0);
  const shipmentAgentCommissionPct=num(input.agentCommissionPct,0);
  const agentCommissionTotal=items.length?itemAgentCommissionTotal:(fob*shipmentAgentCommissionPct/100);
  const insurancePct=num(input.insurancePct,num(log.insurancePct,0));
  const insurance=input.insuranceAmount!=null?num(input.insuranceAmount):fob*insurancePct/100;

  const logisticsLines=Array.isArray(log.lines)?log.lines:[];
  const computedLines=logisticsLines.map(line=>{
    const basis=line.basis||'fixed', unit=num(line.amount); let qty=1,total=unit,formulaApplied=null;
    if(basis==='cbm'){qty=cbm;total=unit*qty;}
    else if(basis==='kg'){qty=kg;total=unit*qty;}
    else if(basis==='percent_fob'){qty=fob/100;total=unit*qty;}
    else if(basis==='tiered_cbm'){
      qty=cbm; const tiers=Array.isArray(line.tiers)?line.tiers:[];
      const tier=tiers.find(t=>t.upTo==null||cbm<=num(t.upTo))||tiers[tiers.length-1];
      if(tier){const base=num(tier.base),included=num(tier.included),rate=num(tier.rate);total=base+Math.max(0,cbm-included)*rate;formulaApplied={upTo:tier.upTo??null,base,included,rate};}else total=0;
    }
    return {...line,qty,total,formulaApplied};
  });
  const logisticsTotal=computedLines.reduce((a,b)=>a+num(b.total),0);
  const internationalFreight=computedLines.filter(x=>{const code=String(x.code||'').toLowerCase(),name=String(x.name||'').toLowerCase();return code==='freight'||(!code&&['flete','flete internacional','flete marítimo','flete maritimo','flete aéreo','flete aereo'].includes(name));}).reduce((a,b)=>a+num(b.total),0);

  const taxMode=input.taxMode==='product'?'product':'shipment';
  let itemTaxes=[];
  let totals={duty:0,vat:0,vatAdditional:0,earnings:0,iibb:0,statisticalFee:0,taxesTotal:0,recoverable:0};
  let cif=fob+agentCommissionTotal+internationalFreight+insurance, dutyBase=0, vatBase=0;

  if(taxMode==='product' && items.length){
    const totalItemFob=items.reduce((s,i)=>s+num(i.unitFob)*num(i.qty,1),0)||fob||1;
    itemTaxes=items.map(i=>{
      const itemFob=num(i.unitFob)*num(i.qty,1);
      const share=itemFob/totalItemFob;
      const r=computeTaxesFromBase({fob:itemFob,agentCommission:(num(i.unitFob)*num(i.qty,1)*(num(i.agentCommissionPct)/100)),freight:internationalFreight*share,insurance:insurance*share,profile:i.taxProfile||tax,use:i.productUse||'commercial'});
      Object.keys(totals).forEach(k=>totals[k]+=num(r[k]));
      return {productId:i.productId,sku:i.sku,name:i.name,productUse:i.productUse||'commercial',taxProfileId:i.taxProfileId||input.taxProfileId,agentCommissionPct:num(i.agentCommissionPct),agentCommissionAmount:(num(i.unitFob)*num(i.qty,1)*(num(i.agentCommissionPct)/100)),...r};
    });
    dutyBase=itemTaxes.reduce((s,x)=>s+x.dutyBase,0); vatBase=itemTaxes.reduce((s,x)=>s+x.vatBase,0);
  } else {
    const r=computeTaxesFromBase({fob,agentCommission:agentCommissionTotal,freight:internationalFreight,insurance,profile:tax,use:input.shipmentUse||'commercial'});
    totals={duty:r.duty,vat:r.vat,vatAdditional:r.vatAdditional,earnings:r.earnings,iibb:r.iibb,statisticalFee:r.statisticalFee,taxesTotal:r.taxesTotal,recoverable:r.recoverable};
    dutyBase=r.dutyBase; vatBase=r.vatBase;
  }

  // Honorarios del envío (v5): el esquema 50%/70% representa el porcentaje declarado.
  // Primero calculamos los impuestos normales al 100%. Si aplica el esquema, el impuesto
  // a pagar se reduce al porcentaje declarado y el honorario es 30% DEL AHORRO impositivo.
  // Ej.: impuestos normales USD 4.000, esquema 50% => impuestos a pagar USD 2.000,
  // ahorro USD 2.000, honorarios USD 600.
  const honorariaApplies=!!input.honorariaApplies;
  const honorariaBasePct=[50,70].includes(num(input.honorariaBasePct))?num(input.honorariaBasePct):50;
  const honorariaRatePct=num(input.honorariaRatePct,30);
  const declaredFactor=honorariaApplies?honorariaBasePct/100:1;

  const normalTaxes={...totals};
  const normalTaxesTotal=num(normalTaxes.taxesTotal);
  if(honorariaApplies){
    // Reducir TODOS los componentes del impuesto y el recupero en la misma proporción.
    ['duty','vat','vatAdditional','earnings','iibb','statisticalFee','taxesTotal','recoverable'].forEach(k=>{
      totals[k]=num(normalTaxes[k])*declaredFactor;
    });
    itemTaxes=itemTaxes.map(i=>({
      ...i,
      normalTaxesTotal:num(i.taxesTotal),
      duty:num(i.duty)*declaredFactor,
      vat:num(i.vat)*declaredFactor,
      vatAdditional:num(i.vatAdditional)*declaredFactor,
      earnings:num(i.earnings)*declaredFactor,
      iibb:num(i.iibb)*declaredFactor,
      statisticalFee:num(i.statisticalFee)*declaredFactor,
      recoverable:num(i.recoverable)*declaredFactor,
      taxesTotal:num(i.taxesTotal)*declaredFactor
    }));
  }
  const taxSavings=honorariaApplies?normalTaxesTotal-num(totals.taxesTotal):0;
  const honoraria=honorariaApplies?taxSavings*honorariaRatePct/100:0;
  const totalToPay=totals.taxesTotal+logisticsTotal+agentCommissionTotal+honoraria;
  const landedCost=fob+totalToPay, netCost=landedCost-totals.recoverable;
  return {fob,cbm,kg,insurance,agentCommissionTotal,cif,dutyBase,vatBase,...totals,normalTaxesTotal,taxSavings,taxMode,itemTaxes,honorariaApplies,honorariaBasePct,honorariaRatePct,honorariaTaxBase:taxSavings,honoraria,logisticsLines:computedLines,logisticsTotal,totalToPay,landedCost,netCost};
}

async function seedTenant(tid) {
  const ref = tdoc(tid);
  const snap = await ref.get();
  const isScb = tid === 'sentire-customs-broker';
  if (snap.exists) {
    // Lightweight schema migration for the early MVP. It upgrades only our seeded
    // SCB LCL profiles so formula-by-CBM works immediately on existing tenants.
    const data=snap.data()||{};
    if (isScb && num(data.schemaVersion,0) < 4) {
      await col(tid,'logisticsProfiles').doc('lcl-propio').set({
        name:'LCL Propio', type:'LCL', route:'China → Argentina', unit:'CBM', active:true,
        lines:[
          {code:'freight',name:'Flete internacional para base CIF',basis:'cbm',amount:90},
          {code:'destination_bundle',name:'Flete marítimo / Depósito fiscal / Canal rojo / Verificación',basis:'tiered_cbm',tiers:[
            {upTo:5,base:500,included:1,rate:400},
            {upTo:null,base:2100,included:5,rate:300}
          ]}
        ], updatedAt:now()
      },{merge:true});
      await col(tid,'logisticsProfiles').doc('lcl-fiscal').set({
        name:'LCL Fiscal', type:'LCL', route:'China → Argentina', unit:'CBM', active:true,
        lines:[
          {code:'freight',name:'Flete internacional',basis:'cbm',amount:90},
          {code:'fiscal',name:'Depósito fiscal',basis:'tiered_cbm',tiers:[
            {upTo:5,base:2500,included:0,rate:0},
            {upTo:10,base:4500,included:0,rate:0},
            {upTo:15,base:5500,included:0,rate:0},
            {upTo:null,base:6500,included:0,rate:0}
          ]},
          {code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800},
          {code:'clearance',name:'Honorarios despacho + IVA',basis:'fixed',amount:786.5}
        ], updatedAt:now()
      },{merge:true});
      await ref.set({schemaVersion:6,updatedAt:now()},{merge:true});
    }
    return;
  }
  await ref.set({
    name: isScb ? 'Sentire Customs Broker' : 'Shenzhen Sentire Trading',
    module: isScb ? 'logistics' : 'products',
    logo: isScb ? '/assets/scb-logo.jpeg' : '/assets/shenzhen-logo.png',
    createdAt: now(), schemaVersion:6
  });
  await col(tid,'taxProfiles').doc('general').set({
    name:'General', duty:18, vat:21, vatAdditional:20, earnings:6, iibb:3, statisticalFee:3,
    honorariaApplies:true, honorariaType:'fixed', honorariaValue:200, isDefault:true, active:true, updatedAt:now()
  });
  if (isScb) {
    const profiles = {
      'lcl-propio': { name:'LCL Propio', type:'LCL', route:'China → Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete internacional para base CIF',basis:'cbm',amount:90},
        {code:'destination_bundle',name:'Flete marítimo / Depósito fiscal / Canal rojo / Verificación',basis:'tiered_cbm',tiers:[{upTo:5,base:500,included:1,rate:400},{upTo:null,base:2100,included:5,rate:300}]}
      ]},
      'lcl-fiscal': { name:'LCL Fiscal', type:'LCL', route:'China → Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:90},
        {code:'fiscal',name:'Depósito fiscal',basis:'tiered_cbm',tiers:[{upTo:5,base:2500,included:0,rate:0},{upTo:10,base:4500,included:0,rate:0},{upTo:15,base:5500,included:0,rate:0},{upTo:null,base:6500,included:0,rate:0}]},
        {code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800},{code:'clearance',name:'Honorarios despacho + IVA',basis:'fixed',amount:786.5}
      ]},
      'fcl': { name:'FCL', type:'FCL', route:'China → Argentina', unit:'container', lines:[
        {code:'freight',name:'Flete marítimo contenedor completo',basis:'fixed',amount:8600},{code:'local',name:'Gastos locales',basis:'fixed',amount:790},{code:'terminal',name:'Terminal / canal rojo / verificación',basis:'fixed',amount:3100},{code:'delivery',name:'Flete interno',basis:'fixed',amount:1100},{code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800}
      ]},
      'carga-aerea': { name:'Carga Aérea', type:'AIR', route:'China → Argentina', unit:'KG', lines:[
        {code:'freight',name:'Flete aéreo',basis:'kg',amount:12},{code:'handling',name:'Handling fee',basis:'fixed',amount:1050},{code:'export',name:'Export fee',basis:'fixed',amount:110},{code:'delivery',name:'Entrega / corte de guía',basis:'fixed',amount:250},{code:'tca',name:'Almacenaje TCA',basis:'fixed',amount:990},{code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:650}
      ]},
      'courier-hk': { name:'Courier HK', type:'COURIER', route:'Hong Kong → Argentina', unit:'KG', lines:[
        {code:'freight',name:'Flete aéreo courier',basis:'kg',amount:18},{code:'handling',name:'Handling fee',basis:'fixed',amount:50},{code:'export',name:'Export fee',basis:'fixed',amount:110},{code:'clearance',name:'Honorario despacho simplificado',basis:'fixed',amount:120}
      ]},
      'solo-fiscal': { name:'Solo Fiscal', type:'FISCAL', route:'Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:150},{code:'decon',name:'Desconsolidación',basis:'cbm',amount:20},{code:'fiscal',name:'Depósito fiscal',basis:'fixed',amount:0},{code:'verify',name:'Verificación',basis:'fixed',amount:0}
      ]}
    };
    for (const [pid,p] of Object.entries(profiles)) await col(tid,'logisticsProfiles').doc(pid).set({...p,active:true,updatedAt:now()});
  } else {
    await col(tid,'logisticsProfiles').doc('china-lcl-argentina').set({name:'China LCL Argentina',type:'LCL',route:'China → Argentina',unit:'CBM',lines:[
      {code:'freight',name:'Flete internacional',basis:'cbm',amount:300},{code:'clearance',name:'Despacho',basis:'cbm',amount:90},{code:'terminal',name:'Terminal',basis:'cbm',amount:70},{code:'delivery',name:'Entrega final',basis:'cbm',amount:60}
    ],active:true,updatedAt:now()});
    await col(tid,'logisticsProfiles').doc('fcl-consolidado').set({name:'FCL + Consolidado',type:'FCL',route:'China → Argentina',unit:'container',lines:[
      {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},{code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},{code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},{code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95},{code:'fob_expenses',name:'Gastos a FOB (solo FCL + Consolidado)',basis:'fixed',amount:180}
    ],active:true,updatedAt:now()});
    await col(tid,'logisticsProfiles').doc('fcl-fob').set({name:'FCL FOB',type:'FCL',route:'China → Argentina',unit:'container',lines:[
      {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},{code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},{code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},{code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95}
    ],active:true,updatedAt:now()});
  }
}

app.get('/api/health', (req,res)=>res.json({ok:true,service:'mrapi-quote',databaseId,bucketName}));
app.get('/api/bootstrap', async (req,res,next)=>{ try{ const tid=tenantId(req); await seedTenant(tid); const [tenant,tax,log,products,quotes,clients]=await Promise.all([
  tdoc(tid).get(), col(tid,'taxProfiles').get(), col(tid,'logisticsProfiles').get(), col(tid,'products').limit(100).get(), col(tid,'quotes').orderBy('createdAt','desc').limit(50).get(), col(tid,'clients').limit(100).get()
]); res.json({tenant:{id:tid,...tenant.data()},taxProfiles:tax.docs.map(d=>({id:d.id,...d.data()})),logisticsProfiles:log.docs.map(d=>({id:d.id,...d.data()})),products:products.docs.map(d=>({id:d.id,...d.data()})),quotes:quotes.docs.map(d=>({id:d.id,...d.data()})),clients:clients.docs.map(d=>({id:d.id,...d.data()}))}); }catch(e){next(e)} });

for (const entity of ['products','taxProfiles','logisticsProfiles','clients','users']) {
  app.get(`/api/${entity}`, async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const q=await col(tid,entity).limit(500).get();res.json(q.docs.map(d=>({id:d.id,...d.data()})));}catch(e){next(e)}});
  app.post(`/api/${entity}`, async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const ref=col(tid,entity).doc(req.body.id||id(entity.slice(0,3)));const payload={...req.body};delete payload.id;delete payload.tenantId;await ref.set({...payload,createdAt:now(),updatedAt:now()},{merge:true});res.json({ok:true,id:ref.id});}catch(e){next(e)}});
  app.put(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);const payload={...req.body};delete payload.id;delete payload.tenantId;await col(tid,entity).doc(req.params.id).set({...payload,updatedAt:now()},{merge:true});res.json({ok:true});}catch(e){next(e)}});
  app.delete(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);await col(tid,entity).doc(req.params.id).delete();res.json({ok:true});}catch(e){next(e)}});
}

app.post('/api/products/import', upload.single('file'), async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); if(!req.file) return res.status(400).json({error:'Archivo requerido'});
  const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
  let ok=0; const errors=[]; const batchSize=400;
  for(let start=0;start<rows.length;start+=batchSize){ const batch=firestore.batch(); for(const [i,row] of rows.slice(start,start+batchSize).entries()){
    const sku=String(row.SKU||row.sku||row.Codigo||row.Código||'').trim(); const name=String(row.Producto||row.producto||row.Nombre||row.nombre||'').trim();
    if(!sku||!name){errors.push({row:start+i+2,error:'SKU y Producto son obligatorios'});continue;}
    const ref=col(tid,'products').doc(sku.replace(/[\\/#?]/g,'-')); batch.set(ref,{sku,name,description:row.Descripcion||row.Descripción||'',category:row.Categoria||row.Categoría||'',fob:num(row.FOB||row['FOB (USD)']),cbm:num(row.CBM),kg:num(row.KG||row.Peso),moq:num(row.MOQ),agentCommissionPct:num(row.ComisionAgenteCompra||row['Comisión agente compra']||row['Comision agente compra']||row.AgentCommissionPct||row['Comisión compra']||0),taxProfileId:row.PerfilImpositivo||row['Perfil impositivo']||'general',productUse:String(row.Uso||row['Tipo uso']||row.TipoUso||'commercial').toLowerCase().replace(/ /g,'_'),logisticsProfileId:row.PerfilLogistico||row['Perfil logístico']||'',imageUrl:row.Imagen||row.Image||row.image_url||'',active:String(row.Estado||'Activo').toLowerCase()!=='inactivo',updatedAt:now()},{merge:true});ok++; }
    await batch.commit();
  }
  res.json({ok:true,processed:rows.length,imported:ok,errors});
}catch(e){next(e)}});

app.post('/api/products/:id/image', upload.single('image'), async (req,res,next)=>{try{
  const tid=tenantId(req); if(!req.file) return res.status(400).json({error:'Imagen requerida'}); const ext=path.extname(req.file.originalname)||'.jpg'; const object=`tenants/${tid}/products/${req.params.id}/${Date.now()}${ext}`; const bucket=storage.bucket(bucketName); const file=bucket.file(object); await file.save(req.file.buffer,{contentType:req.file.mimetype,resumable:false}); const imageUrl=`https://storage.googleapis.com/${bucketName}/${object}`; await col(tid,'products').doc(req.params.id).set({imageUrl,updatedAt:now()},{merge:true}); res.json({ok:true,imageUrl});
}catch(e){next(e)}});

app.post('/api/calculate', async (req,res,next)=>{try{
  const tid=tenantId(req); const body={...req.body};
  if(body.taxMode==='product' && Array.isArray(body.items)){
    const ids=[...new Set(body.items.map(i=>i.taxProfileId).filter(Boolean))]; const map={};
    await Promise.all(ids.map(async pid=>{const s=await col(tid,'taxProfiles').doc(pid).get();if(s.exists)map[pid]=s.data();}));
    body.items=body.items.map(i=>({...i,taxProfile:map[i.taxProfileId]||body.taxProfile||{}}));
  }
  res.json(calculateQuote(body));
}catch(e){next(e)}});
app.post('/api/quotes', async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); const body={...req.body}; const taxSnap=body.taxProfileId?await col(tid,'taxProfiles').doc(body.taxProfileId).get():null; const logSnap=body.logisticsProfileId?await col(tid,'logisticsProfiles').doc(body.logisticsProfileId).get():null; body.taxProfile=taxSnap?.exists?taxSnap.data():(body.taxProfile||{}); body.logisticsProfile=logSnap?.exists?logSnap.data():(body.logisticsProfile||{});
  if(body.taxMode==='product'&&Array.isArray(body.items)){const ids=[...new Set(body.items.map(i=>i.taxProfileId).filter(Boolean))],map={};await Promise.all(ids.map(async pid=>{const s=await col(tid,'taxProfiles').doc(pid).get();if(s.exists)map[pid]=s.data();}));body.items=body.items.map(i=>({...i,taxProfile:map[i.taxProfileId]||body.taxProfile||{}}));}
  const calc=calculateQuote(body); const ref=col(tid,'quotes').doc(body.id||id('q')); const quoteNo=body.quoteNo||`MRQ-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`; await ref.set({...body,quoteNo,calculation:calc,taxProfileSnapshot:body.taxProfile,logisticsProfileSnapshot:body.logisticsProfile,status:body.status||'draft',createdAt:now(),updatedAt:now()}); res.json({ok:true,id:ref.id,quoteNo,calculation:calc});
}catch(e){next(e)}});
app.put('/api/quotes/:id', async (req,res,next)=>{try{const tid=tenantId(req);await col(tid,'quotes').doc(req.params.id).set({...req.body,updatedAt:now()},{merge:true});res.json({ok:true});}catch(e){next(e)}});
app.get('/api/quotes', async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const q=await col(tid,'quotes').orderBy('createdAt','desc').limit(200).get();res.json(q.docs.map(d=>({id:d.id,...d.data()})));}catch(e){next(e)}});
app.get('/api/quotes/:id/pdf', async (req,res,next)=>{try{
  const tid=tenantId(req);
  const snap=await col(tid,'quotes').doc(req.params.id).get();
  if(!snap.exists) return res.status(404).send('No encontrada');
  const q=snap.data();
  const tenant=(await tdoc(tid).get()).data()||{};
  const c=q.calculation||calculateQuote(q);
  const isProduct=(q.mode||'product')==='product' || (q.items||[]).length>0 || tenant.module==='products';
  const logisticsProfileName=q.logisticsProfileSnapshot?.name || q.logisticsProfile?.name || '';

  const doc=new PDFDocument({margin:36,size:'A4'});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${q.quoteNo||req.params.id}.pdf"`);
  doc.pipe(res);

  const green='#208b2e', dark='#243341', orange='#f28c18', light='#f3f5f7';
  const pageW=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const rightX=doc.page.width-doc.page.margins.right-180;

  function boxTitle(title,color=dark){doc.moveDown(0.2); doc.fillColor(color).fontSize(13).text(title); doc.moveDown(0.25);}
  function moneyText(v){return `USD ${num(v).toFixed(2)}`}
  function kv(label,value,{bold=false,color='#111',labelColor='#666'}={}){doc.fillColor(labelColor).fontSize(10).text(label,{continued:true}); doc.fillColor(color).font(bold?'Helvetica-Bold':'Helvetica').text(` ${value}`); doc.font('Helvetica');}
  function lineItem(label,val,color='#111'){doc.fillColor('#333').fontSize(10).text(label,36,doc.y,{continued:true,width:380}); doc.fillColor(color).text(moneyText(val),430,doc.y-10,{align:'right',width:110});}
  function hr(){doc.moveDown(0.15); const y=doc.y; doc.strokeColor('#d7dde3').lineWidth(1).moveTo(36,y).lineTo(559,y).stroke(); doc.moveDown(0.2);}

  doc.fillColor(dark).font('Helvetica-Bold').fontSize(24).text(tenant.name||'MRAPI Quotes');
  doc.fontSize(10).fillColor('#667281').text(isProduct?'Cotización de Productos':'Cotización Logística');
  doc.roundedRect(rightX,36,180,92,10).lineWidth(1).strokeColor('#d7dde3').stroke();
  doc.font('Helvetica').fontSize(9).fillColor('#666').text('Cotización N°:',rightX+12,48).fillColor('#111').text(q.quoteNo||'-',rightX+95,48,{width:70,align:'right'});
  doc.fillColor('#666').text('Fecha:',rightX+12,65).fillColor('#111').text(new Date().toLocaleDateString('es-AR'),rightX+95,65,{width:70,align:'right'});
  doc.fillColor('#666').text('Cliente:',rightX+12,82).fillColor('#111').text(q.clientName||'-',rightX+95,82,{width:70,align:'right'});
  doc.fillColor('#666').text('Moneda:',rightX+12,99).fillColor('#111').text('USD',rightX+95,99,{width:70,align:'right'});
  doc.moveDown(2.1);

  boxTitle('Datos generales',green);
  kv('Cliente:',q.clientName||'-',{bold:true});
  kv('Descripción:',q.description||'-');
  kv('FOB mercadería:',moneyText(c.fob));
  kv('CBM total:',Number(c.cbm||0).toFixed(3));
  kv('KG total:',Number(c.kg||0).toFixed(2));
  if(logisticsProfileName) kv('Operación logística:',logisticsProfileName,{bold:true,color:green});
  if(logisticsProfileName.toLowerCase().includes('fcl + consolidado')||logisticsProfileName.toLowerCase().includes('fcl+consolidado')) kv('Aclaración:','Incluye Gastos a FOB',{color:orange});
  if(logisticsProfileName.toLowerCase().includes('fcl fob')) kv('Aclaración:','Gastos a FOB no aplica',{color:orange});
  hr();

  if(isProduct && (q.items||[]).length){
    boxTitle('Productos cotizados',green);
    q.items.forEach((it,idx)=>{
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(`${idx+1}. ${it.name||it.sku||'Producto'}`);
      doc.font('Helvetica').fillColor('#555').text(`${it.sku||'-'} · Cantidad ${num(it.qty,1)} · Uso ${String(it.productUse||'commercial').replaceAll('_',' ').toUpperCase()} · Comisión compra ${num(it.agentCommissionPct).toFixed(2)}%`);
      doc.text(`FOB unit. ${moneyText(it.unitFob)} · FOB total ${moneyText(num(it.unitFob)*num(it.qty,1))} · CBM total ${Number(num(it.unitCbm)*num(it.qty,1)).toFixed(3)}`);
      doc.moveDown(0.2);
    });
    hr();
  }

  boxTitle('Costos logísticos y base imponible',green);
  lineItem('FOB mercadería',c.fob);
  lineItem('Comisión agente compra',c.agentCommissionTotal);
  (c.logisticsLines||[]).forEach(l=>lineItem(l.name,l.total));
  lineItem('Seguro internacional',c.insurance);
  hr();
  lineItem('Base CIF',c.cif,green);
  lineItem('Total costos logísticos',c.logisticsTotal,green);
  hr();

  boxTitle('Derechos e impuestos',orange);
  lineItem('Derechos',c.duty);
  lineItem('IVA',c.vat);
  lineItem('IVA adicional',c.vatAdditional);
  lineItem('Ganancia',c.earnings);
  lineItem('IIBB',c.iibb);
  lineItem('Tasa estadística',c.statisticalFee);
  hr();
  lineItem('Total impuestos',c.taxesTotal,orange);
  if(c.honorariaApplies){
    hr();
    lineItem(`Impuestos normales (100%)`,c.normalTaxesTotal);
    lineItem(`Impuestos declarados (${c.honorariaBasePct}%)`,c.taxesTotal);
    lineItem('Ahorro impositivo',c.taxSavings,green);
    lineItem(`Honorarios (${c.honorariaRatePct}% del ahorro)`,c.honoraria,orange);
  }
  hr();

  boxTitle('Recupero de impuestos (detallado)',green);
  lineItem('Recupero IVA',c.vat,green);
  lineItem('Recupero IVA adicional',c.vatAdditional,green);
  lineItem('Recupero Ganancia',c.earnings,green);
  lineItem('Recupero IIBB',c.iibb,green);
  hr();
  lineItem('Recupero total',c.recoverable,green);
  hr();

  doc.roundedRect(36,doc.y+8,pageW,58,12).fillAndStroke(light,'#d7dde3');
  doc.fillColor(dark).font('Helvetica-Bold').fontSize(11).text('Resumen final estimado',48,doc.y+20);
  doc.fontSize(10).font('Helvetica').fillColor('#333').text(`Subtotal costos + impuestos: ${moneyText(c.landedCost)}`,230,doc.y-2,{width:280,align:'right'});
  doc.fillColor(green).text(`Recupero total: - ${moneyText(c.recoverable)}`,230,doc.y+14,{width:280,align:'right'});
  doc.fillColor(green).font('Helvetica-Bold').fontSize(17).text(`Total final estimado: ${moneyText(c.netCost)}`,230,doc.y+28,{width:280,align:'right'});

  doc.moveDown(4.5);
  doc.fillColor('#667281').fontSize(8).text('Cotización estimativa. Valores sujetos a validación, cubicaje, normativas y gastos al momento de la operación.',36,doc.y,{width:520});
  doc.text('El recupero de impuestos se informa en forma detallada para productos cotizados por Shenzhen Sentire Trading.',36,doc.y+2,{width:520});
  doc.end();
}catch(e){next(e)}});

// SPA fallback compatible with Express 5. Avoid app.get('*'), which crashes
// at startup because path-to-regexp v8 requires named wildcards.
app.use((req,res,next)=>{
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname,'public','index.html'));
  }
  next();
});

// JSON 404 for unknown API routes.
app.use('/api', (req,res)=>res.status(404).json({error:'Endpoint no encontrado'}));

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:err.message||'Error interno'});});
app.listen(PORT,()=>console.log(`MRAPI Quotes listening on ${PORT} db=${databaseId} bucket=${bucketName}`));
