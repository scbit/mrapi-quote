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
    const data=snap.data()||{};
    if (isScb) {
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
    } else {
      // Always ensure these product/logistics profiles exist for Shenzhen Sentire Trading,
      // even on existing tenants created in earlier MVP versions.
      await col(tid,'logisticsProfiles').doc('china-lcl-argentina').set({name:'China LCL Argentina',type:'LCL',route:'China → Argentina',unit:'CBM',lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:300},
        {code:'clearance',name:'Despacho',basis:'cbm',amount:90},
        {code:'terminal',name:'Terminal',basis:'cbm',amount:70},
        {code:'delivery',name:'Entrega final',basis:'cbm',amount:60}
      ],active:true,updatedAt:now()},{merge:true});
      await col(tid,'logisticsProfiles').doc('fcl-consolidado').set({name:'FCL + Consolidado',type:'FCL',route:'China → Argentina',unit:'container',lines:[
        {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},
        {code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},
        {code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},
        {code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95},
        {code:'fob_expenses',name:'Gastos a FOB (solo FCL + Consolidado)',basis:'fixed',amount:180}
      ],active:true,updatedAt:now()},{merge:true});
      await col(tid,'logisticsProfiles').doc('fcl-fob').set({name:'FCL FOB',type:'FCL',route:'China → Argentina',unit:'container',lines:[
        {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},
        {code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},
        {code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},
        {code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95}
      ],active:true,updatedAt:now()},{merge:true});
    }
    await ref.set({schemaVersion:7,updatedAt:now()},{merge:true});
    return;
  }
  await ref.set({
    name: isScb ? 'Sentire Customs Broker' : 'Shenzhen Sentire Trading',
    module: isScb ? 'logistics' : 'products',
    logo: isScb ? '/assets/scb-logo.jpeg' : '/assets/shenzhen-logo.png',
    createdAt: now(), schemaVersion:7
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
  const logoPath=tenant.logo ? path.join(__dirname,'public',String(tenant.logo).replace(/^\//,'')) : null;

  const doc=new PDFDocument({margin:28,size:'A4'});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${q.quoteNo||req.params.id}.pdf"`);
  doc.pipe(res);

  const C={green:'#35a326',orange:'#f48a16',dark:'#2f3d4f',muted:'#6b7785',light:'#f3f5f7',border:'#dde3e8',bg:'#ffffff'};
  const left=doc.page.margins.left, top=doc.page.margins.top, pageW=doc.page.width-left-doc.page.margins.right;
  const rightColX=left+pageW-175;

  function moneyText(v){ return `USD ${num(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
  function rounded(x,y,w,h,color='#fff',stroke=C.border,r=12){ doc.save(); doc.roundedRect(x,y,w,h,r).fillAndStroke(color,stroke); doc.restore(); }
  function sectionTitle(x,y,color,icon,title){ doc.fillColor(color).font('Helvetica-Bold').fontSize(11).text(`${icon}  ${title}`,x,y); }
  function infoRow(x,y,label,value,opts={}){ doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(label,x,y,{width:100}); doc.fillColor(opts.valueColor||'#111').font(opts.bold?'Helvetica-Bold':'Helvetica').fontSize(10).text(value,x+102,y,{width:140,align:'right'}); doc.font('Helvetica'); }
  function valueList(x,y,w,title,color,rows,totalLabel,totalValue,totalColor=color){ rounded(x,y,w,170,'#fff',color+'44',14); sectionTitle(x+12,y+12,color,'●',title); let cy=y+36; rows.forEach(row=>{ doc.fillColor('#333').fontSize(8.8).text(row.label,x+12,cy,{width:w-120}); doc.fillColor(row.color||'#222').font(row.bold?'Helvetica-Bold':'Helvetica').text(moneyText(row.value),x+w-88,cy,{width:72,align:'right'}); doc.font('Helvetica'); cy+= row.height || 17; }); doc.strokeColor(color+'77').moveTo(x+12,y+138).lineTo(x+w-12,y+138).stroke(); doc.fillColor('#222').font('Helvetica-Bold').fontSize(9.4).text(totalLabel,x+12,y+146,{width:w-120}); doc.fillColor(totalColor).font('Helvetica-Bold').text(moneyText(totalValue),x+w-98,y+146,{width:82,align:'right'}); doc.font('Helvetica'); }

  // Header
  if(logoPath && fs.existsSync(logoPath)) { try { doc.image(logoPath,left,top+2,{fit:[220,90]}); } catch {} }
  doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(26).text(isProduct?'Cotización de Productos':'Cotización Logística',left,112);
  doc.fillColor(C.dark).font('Helvetica').fontSize(13).text(isProduct?'Estimación de importación y costos en Argentina':'Estimación logística y costos operativos',left,146);
  doc.lineWidth(4).strokeColor(C.green).moveTo(left,176).lineTo(left+42,176).stroke();
  doc.lineWidth(4).strokeColor(C.orange).moveTo(left+44,176).lineTo(left+70,176).stroke();

  rounded(rightColX,top+5,175,110,'#fff',C.border,12);
  infoRow(rightColX+10,top+20,'Cotización N°:',q.quoteNo||'-',{bold:true});
  infoRow(rightColX+10,top+39,'Fecha:',new Date().toLocaleDateString('es-AR'));
  infoRow(rightColX+10,top+58,'Validez:','7 días');
  infoRow(rightColX+10,top+77,'Comercial:',q.salesRep||'MRAPI Quotes');
  infoRow(rightColX+10,top+96,'Moneda:','USD',{bold:true});

  // Summary cards
  rounded(left,194,pageW,116,'#fff',C.border,14);
  infoRow(left+16,210,'Cliente:',q.clientName||'-',{bold:true});
  infoRow(left+16,232,'Contacto:',q.contactName||'-');
  infoRow(left+16,254,'Origen:',q.origin||'Shenzhen, China');
  rounded(left+14,274,210,28,'#f5fbf2',C.green+'66',10);
  doc.fillColor(C.muted).fontSize(9).text('Operación logística:',left+24,283);
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(10.5).text(logisticsProfileName || '-',left+110,282,{width:100});
  doc.font('Helvetica');

  const rx=left+pageW/2+10;
  infoRow(rx,210,'Destino:',q.destination||'Buenos Aires, Argentina',{bold:true});
  infoRow(rx,232,'Tipo de cálculo:',isProduct?'Productos':'Logística',{bold:true});
  infoRow(rx,254,'Perfil impositivo:',q.taxProfileSnapshot?.name || 'General',{bold:true});
  infoRow(rx,276,'Modalidad:',c.taxMode==='product'?'Por producto':'Por envío',{bold:true});

  if (String(logisticsProfileName).toLowerCase().includes('fcl fob')) {
    rounded(rx,286,185,18,'#f2f7ff','#9bb7e3',9);
    doc.fillColor('#295a9e').fontSize(8.2).text('En FCL FOB, Gastos a FOB = no aplica',rx+8,291,{width:170});
  } else if (String(logisticsProfileName).toLowerCase().includes('consolidado')) {
    rounded(rx,286,185,18,'#f6fbf3','#9fd18a',9);
    doc.fillColor('#2f7a1e').fontSize(8.2).text('En FCL + Consolidado se agregan Gastos a FOB',rx+8,291,{width:170});
  }

  let y=324;

  if (isProduct && (q.items||[]).length) {
    rounded(left,y,pageW,120,'#fff',C.border,14);
    doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(10).text('SKU',left+10,y+10,{width:48});
    doc.text('Producto',left+60,y+10,{width:150});
    doc.text('Uso',left+220,y+10,{width:62});
    doc.text('FOB Tot.',left+290,y+10,{width:60,align:'right'});
    doc.text('CBM Tot.',left+360,y+10,{width:60,align:'right'});
    doc.text('Comisión',left+428,y+10,{width:58,align:'right'});
    doc.text('Perfil',left+488,y+10,{width:55,align:'right'});
    let ry=y+28;
    (q.items||[]).slice(0,4).forEach(it=>{
      const fobTot=num(it.unitFob)*num(it.qty,1), cbmTot=num(it.unitCbm)*num(it.qty,1), comAmt=fobTot*(num(it.agentCommissionPct)/100);
      doc.font('Helvetica').fillColor('#444').fontSize(8.2).text(it.sku||'-',left+10,ry,{width:48});
      doc.text(`${it.name||'-'} x${num(it.qty,1)}`,left+60,ry,{width:150});
      doc.fillColor(C.dark).text(useLabelPdf(it.productUse),left+220,ry,{width:62});
      doc.fillColor('#222').text(moneyText(fobTot),left+290,ry,{width:60,align:'right'});
      doc.text(Number(cbmTot).toFixed(3),left+360,ry,{width:60,align:'right'});
      doc.text(moneyText(comAmt),left+428,ry,{width:58,align:'right'});
      doc.text(it.taxProfileId||'general',left+488,ry,{width:55,align:'right'});
      ry += 18;
    });
    doc.strokeColor(C.border).moveTo(left+10,y+100).lineTo(left+pageW-10,y+100).stroke();
    doc.fillColor(C.green).font('Helvetica-Bold').fontSize(10).text(`Total FOB: ${moneyText(c.fob)}`,left+16,y+106);
    doc.fillColor(C.orange).text(`Total CBM: ${Number(c.cbm||0).toFixed(3)}`,left+180,y+106);
    doc.fillColor(C.green).text(`Comisión compra total: ${moneyText(c.agentCommissionTotal)}`,left+320,y+106);
    y += 132;
  }

  const colGap=12;
  const colW=(pageW-colGap*2)/3;
  const baseRows=[
    {label:'FOB mercadería',value:c.fob},
    {label:'Comisión agente compra',value:c.agentCommissionTotal},
    ...(c.logisticsLines||[]).map(l=>({label:l.name,value:l.total,height:String(l.name).length>45?24:17})),
    {label:'Seguro internacional',value:c.insurance}
  ];
  const taxRows=[
    {label:'Derechos',value:c.duty},
    {label:'IVA',value:c.vat},
    {label:'IVA adicional',value:c.vatAdditional},
    {label:'Ganancia',value:c.earnings},
    {label:'IIBB',value:c.iibb},
    {label:'Tasa estadística',value:c.statisticalFee}
  ];
  const recRows=[
    {label:'Recupero IVA',value:c.vat,color:C.green},
    {label:'Recupero IVA adicional',value:c.vatAdditional,color:C.green},
    {label:'Recupero Ganancia',value:c.earnings,color:C.green},
    {label:'Recupero IIBB',value:c.iibb,color:C.green}
  ];
  valueList(left,y,colW,'Costos logísticos y base imponible',C.green,baseRows,'Base CIF',c.cif,C.green);
  valueList(left+colW+colGap,y,colW,'Derechos e impuestos',C.orange,taxRows,'Total impuestos',c.taxesTotal,C.orange);
  valueList(left+(colW+colGap)*2,y,colW,'Recupero de impuestos (detallado)',C.green,recRows,'Recupero total',c.recoverable,C.green);

  y += 184;
  if (c.honorariaApplies) {
    rounded(left,y,pageW,64,'#fff8f2',C.orange+'66',12);
    sectionTitle(left+12,y+12,C.orange,'●','Honorarios del envío');
    doc.fillColor('#333').fontSize(9).text(`Impuestos normales (100%): ${moneyText(c.normalTaxesTotal)}`,left+12,y+33);
    doc.text(`Impuestos declarados (${c.honorariaBasePct}%): ${moneyText(c.taxesTotal)}`,left+190,y+33);
    doc.fillColor(C.green).text(`Ahorro impositivo: ${moneyText(c.taxSavings)}`,left+12,y+47);
    doc.fillColor(C.orange).font('Helvetica-Bold').text(`Honorarios (${c.honorariaRatePct}% del ahorro): ${moneyText(c.honoraria)}`,left+310,y+47,{width:220,align:'right'});
    doc.font('Helvetica');
    y += 74;
  }

  rounded(left,y,pageW,70,'#fff',C.border,14);
  rounded(left+10,y+10,118,50,C.dark,C.dark,12);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11).text('Resumen final',left+26,y+24);
  doc.fillColor('#fff').fontSize(10).text('estimado',left+48,y+38);
  doc.fillColor('#333').font('Helvetica').fontSize(10).text(`Subtotal costos + impuestos`,left+145,y+18);
  doc.text(moneyText(c.landedCost),left+405,y+18,{width:110,align:'right'});
  doc.fillColor(C.green).text(`Recupero total`,left+145,y+34);
  doc.text(`- ${moneyText(c.recoverable)}`,left+405,y+34,{width:110,align:'right'});
  doc.strokeColor(C.border).moveTo(left+145,y+50).lineTo(left+515,y+50).stroke();
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(13).text('Total final estimado',left+145,y+54);
  doc.fillColor(C.green).fontSize(18).text(moneyText(c.netCost),left+365,y+52,{width:150,align:'right'});

  y += 86;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8.1).text('• En operaciones FCL + Consolidado se consideran Gastos a FOB. En FCL FOB, ese concepto no aplica.',left,y,{width:pageW});
  doc.text('• Los valores son estimados y pueden variar según tipo de cambio, normativas, flete, cubicaje y validación aduanera.',left,doc.y+3,{width:pageW});
  doc.text('• Cotización expresada en USD americanos.',left,doc.y+3,{width:pageW});
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(12).text(`Gracias por confiar en ${tenant.name||'MRAPI Quotes'}.`,left+300,doc.y+8,{width:220,align:'right'});
  doc.end();
}catch(e){next(e)}});

function useLabelPdf(u){ return u==='particular'?'PARTICULAR':(u==='capital_good'||u==='bien_de_uso')?'BIEN DE USO':'COMERCIAL'; }

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
