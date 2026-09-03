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
    const basis=line.basis||'fixed', unit=num(line.amount); let qty=1,netAmount=unit,formulaApplied=null;
    if(basis==='cbm'){qty=cbm;netAmount=unit*qty;}
    else if(basis==='kg'){qty=kg;netAmount=unit*qty;}
    else if(basis==='percent_fob'){qty=fob/100;netAmount=unit*qty;}
    else if(basis==='tiered_cbm'){
      qty=cbm; const tiers=Array.isArray(line.tiers)?line.tiers:[];
      const tier=tiers.find(t=>t.upTo==null||cbm<=num(t.upTo))||tiers[tiers.length-1];
      if(tier){const base=num(tier.base),included=num(tier.included),rate=num(tier.rate);netAmount=base+Math.max(0,cbm-included)*rate;formulaApplied={upTo:tier.upTo??null,base,included,rate};}else netAmount=0;
    }
    const vatTreatment=line.vatTreatment||'none';
    const vatRate=num(line.vatRate,21);
    let vatAmount=0,total=netAmount;
    if(vatTreatment==='plus_vat'){vatAmount=netAmount*vatRate/100;total=netAmount+vatAmount;}
    else if(vatTreatment==='included_vat'){vatAmount=netAmount-(netAmount/(1+vatRate/100));netAmount=netAmount-vatAmount;total=netAmount+vatAmount;}
    return {...line,qty,netAmount,vatTreatment,vatRate,vatAmount,total,formulaApplied};
  });
  const logisticsNet=computedLines.reduce((a,b)=>a+num(b.netAmount),0);
  const logisticsVat=computedLines.reduce((a,b)=>a+num(b.vatAmount),0);
  const logisticsTotal=computedLines.reduce((a,b)=>a+num(b.total),0);
  const internationalFreight=computedLines.filter(x=>{const code=String(x.code||'').toLowerCase(),name=String(x.name||'').toLowerCase();return code==='freight'||(!code&&['flete','flete internacional','flete marítimo','flete maritimo','flete aéreo','flete aereo'].includes(name));}).reduce((a,b)=>a+num(b.netAmount),0);

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
  const landedCost=fob+totalToPay;
  const customsRecoverable=totals.recoverable;
  const servicesVatRecoverable=logisticsVat;
  const totalRecoverable=customsRecoverable+servicesVatRecoverable;
  const netCost=landedCost-totalRecoverable;
  const logisticsAllInPerCbm=cbm>0?logisticsTotal/cbm:0;
  const itemLandedCosts=items.map(i=>{
    const qty=num(i.qty,1), itemFob=num(i.unitFob)*qty, itemCbm=num(i.unitCbm)*qty;
    const cbmShare=cbm>0?itemCbm/cbm:0, fobShare=fob>0?itemFob/fob:0;
    const itemTaxRec=(taxMode==='product'?itemTaxes.find(t=>t.productId===i.productId):null);
    const taxAmount=itemTaxRec?num(itemTaxRec.taxesTotal):totals.taxesTotal*fobShare;
    const recoverableAmount=itemTaxRec?num(itemTaxRec.recoverable):customsRecoverable*fobShare;
    const servicesVatShare=servicesVatRecoverable*cbmShare;
    const logisticsAmount=logisticsTotal*cbmShare;
    const honorariaAmount=honoraria*fobShare;
    const agentCommissionAmount=itemFob*(num(i.agentCommissionPct)/100);
    const grossArgentinaTotal=itemFob+agentCommissionAmount+logisticsAmount+taxAmount+honorariaAmount;
    const netArgentinaTotal=grossArgentinaTotal-recoverableAmount-servicesVatShare;
    return {productId:i.productId,sku:i.sku,name:i.name,qty,unitFob:num(i.unitFob),unitCbm:num(i.unitCbm),itemFob,itemCbm,cbmShare,agentCommissionPct:num(i.agentCommissionPct),agentCommissionAmount,logisticsAmount,logisticsPerCbm:logisticsAllInPerCbm,taxAmount,recoverableAmount,servicesVatShare,honorariaAmount,grossArgentinaTotal,netArgentinaTotal,netArgentinaUnit:qty>0?netArgentinaTotal/qty:0};
  });
  const containerCapacityCbm=num(log.capacityCbm, (String(log.type||'').toUpperCase()==='FCL'||String(log.unit||'').toLowerCase()==='container')?68:0);
  const containerType=log.containerType||((String(log.type||'').toUpperCase()==='FCL'||String(log.unit||'').toLowerCase()==='container')?'40HQ':'');
  const containersRequired=containerCapacityCbm>0&&cbm>0?Math.max(1,Math.ceil(cbm/containerCapacityCbm)):0;
  const totalContainerCapacity=containersRequired*containerCapacityCbm;
  const containerUtilizationPct=totalContainerCapacity>0?(cbm/totalContainerCapacity)*100:0;
  const containerRemainingCbm=totalContainerCapacity>0?Math.max(0,totalContainerCapacity-cbm):0;
  const exceedsSingleContainer=containerCapacityCbm>0&&cbm>containerCapacityCbm;
  return {fob,cbm,kg,insurance,agentCommissionTotal,cif,dutyBase,vatBase,...totals,customsRecoverable,servicesVatRecoverable,totalRecoverable,normalTaxesTotal,taxSavings,taxMode,itemTaxes,itemLandedCosts,honorariaApplies,honorariaBasePct,honorariaRatePct,honorariaTaxBase:taxSavings,honoraria,logisticsLines:computedLines,logisticsNet,logisticsVat,logisticsTotal,logisticsAllInPerCbm,containerType,containerCapacityCbm,containersRequired,totalContainerCapacity,containerUtilizationPct,containerRemainingCbm,exceedsSingleContainer,totalToPay,landedCost,netCost};
}

async function seedTenant(tid) {
  const ref = tdoc(tid);
  const snap = await ref.get();
  const isScb = tid === 'sentire-customs-broker';

  async function createIfMissing(collectionName, docId, payload) {
    const dref=col(tid,collectionName).doc(docId);
    const ds=await dref.get();
    if (!ds.exists) await dref.set({...payload,createdAt:now(),updatedAt:now()});
  }

  if (!snap.exists) {
    await ref.set({
      name: isScb ? 'Sentire Customs Broker' : 'Shenzhen Sentire Trading',
      module: isScb ? 'logistics' : 'products',
      logo: isScb ? '/assets/scb-logo.jpeg' : '/assets/shenzhen-logo.png',
      createdAt: now(), schemaVersion:11
    });
  }

  // IMPORTANT: seeds only create missing records. Never overwrite user-edited profiles.
  await createIfMissing('taxProfiles','general',{
    name:'General', duty:18, vat:21, vatAdditional:20, earnings:6, iibb:3, statisticalFee:3,
    isDefault:true, active:true
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
        {code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800},
        {code:'clearance',name:'Honorarios despacho + IVA',basis:'fixed',amount:786.5}
      ]},
      'fcl': { name:'FCL', type:'FCL', route:'China → Argentina', unit:'container', containerType:'40HQ', capacityCbm:68, lines:[
        {code:'freight',name:'Flete marítimo contenedor completo',basis:'fixed',amount:8600},
        {code:'local',name:'Gastos locales',basis:'fixed',amount:790},
        {code:'terminal',name:'Terminal / canal rojo / verificación',basis:'fixed',amount:3100},
        {code:'delivery',name:'Flete interno',basis:'fixed',amount:1100},
        {code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800}
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
    for (const [pid,p] of Object.entries(profiles)) await createIfMissing('logisticsProfiles',pid,{...p,active:true});
  } else {
    const profiles={
      'china-lcl-argentina': {name:'China LCL Argentina',type:'LCL',route:'China → Argentina',unit:'CBM',lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:300},{code:'clearance',name:'Despacho',basis:'cbm',amount:90},{code:'terminal',name:'Terminal',basis:'cbm',amount:70},{code:'delivery',name:'Entrega final',basis:'cbm',amount:60}
      ]},
      'fcl-consolidado': {name:'FCL + Consolidado',type:'FCL',route:'China → Argentina',unit:'container',containerType:'40HQ',capacityCbm:68,lines:[
        {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},
        {code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},
        {code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},
        {code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95},
        {code:'fob_expenses',name:'Gastos a FOB',basis:'fixed',amount:180}
      ]},
      'fcl-fob': {name:'FCL FOB',type:'FCL',route:'China → Argentina',unit:'container',containerType:'40HQ',capacityCbm:68,lines:[
        {code:'freight',name:'Flete internacional',basis:'fixed',amount:1150},
        {code:'terminal',name:'Terminal Puerto Zárate (incluye canal rojo, verificación y exhaustiva)',basis:'fixed',amount:185},
        {code:'clearance',name:'Despacho de aduana',basis:'fixed',amount:145},
        {code:'delivery',name:'Flete local hasta depósito',basis:'fixed',amount:95}
      ]}
    };
    for (const [pid,p] of Object.entries(profiles)) await createIfMissing('logisticsProfiles',pid,{...p,active:true});
    for (const pid of ['fcl-consolidado','fcl-fob']) {
      const pref=col(tid,'logisticsProfiles').doc(pid); const ps=await pref.get();
      if(ps.exists){ const pd=ps.data()||{}; const patch={}; if(!pd.containerType)patch.containerType='40HQ'; if(!num(pd.capacityCbm))patch.capacityCbm=68; if(Object.keys(patch).length)await pref.set({...patch,updatedAt:now()},{merge:true}); }
    }
  }

  // Keep the category catalog in sync with categories already used by legacy products.
  if(!isScb){
    const legacyProducts=await col(tid,'products').limit(500).get();
    for(const pd of legacyProducts.docs){
      const category=String(pd.data()?.category||'').trim();
      if(!category)continue;
      const catId=category.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||id('cat');
      const cref=col(tid,'categories').doc(catId); const cs=await cref.get();
      if(!cs.exists)await cref.set({name:category,active:true,createdAt:now(),updatedAt:now()});
    }
  }
  await ref.set({schemaVersion:20,updatedAt:now()},{merge:true});
}

app.get('/api/health', (req,res)=>res.json({ok:true,service:'mrapi-quote',databaseId,bucketName}));
app.get('/api/bootstrap', async (req,res,next)=>{ try{ const tid=tenantId(req); await seedTenant(tid); const [tenant,tax,log,products,quotes,clients,categories,suppliers]=await Promise.all([
  tdoc(tid).get(), col(tid,'taxProfiles').get(), col(tid,'logisticsProfiles').get(), col(tid,'products').limit(300).get(), col(tid,'quotes').orderBy('createdAt','desc').limit(50).get(), col(tid,'clients').limit(100).get(), col(tid,'categories').limit(300).get(), col(tid,'suppliers').limit(300).get()
]); res.json({tenant:{id:tid,...tenant.data()},taxProfiles:tax.docs.map(d=>({id:d.id,...d.data()})),logisticsProfiles:log.docs.map(d=>({id:d.id,...d.data()})),products:products.docs.map(d=>({id:d.id,...d.data()})),quotes:quotes.docs.map(d=>({id:d.id,...d.data()})),clients:clients.docs.map(d=>({id:d.id,...d.data()})),categories:categories.docs.map(d=>({id:d.id,...d.data()})),suppliers:suppliers.docs.map(d=>({id:d.id,...d.data()}))}); }catch(e){next(e)} });

for (const entity of ['products','taxProfiles','logisticsProfiles','clients','users','categories','suppliers']) {
  app.get(`/api/${entity}`, async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const q=await col(tid,entity).limit(500).get();res.json(q.docs.map(d=>({id:d.id,...d.data()})));}catch(e){next(e)}});
  app.post(`/api/${entity}`, async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const ref=col(tid,entity).doc(req.body.id||id(entity.slice(0,3)));const payload={...req.body};delete payload.id;delete payload.tenantId;if(entity==='products')delete payload.logisticsProfileId;await ref.set({...payload,createdAt:now(),updatedAt:now(),...(entity==='products'?{logisticsProfileId:FieldValue.delete()}:{})},{merge:true});res.json({ok:true,id:ref.id});}catch(e){next(e)}});
  app.put(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);const payload={...req.body};delete payload.id;delete payload.tenantId;if(entity==='products')delete payload.logisticsProfileId;await col(tid,entity).doc(req.params.id).set({...payload,updatedAt:now(),...(entity==='products'?{logisticsProfileId:FieldValue.delete()}:{})},{merge:true});res.json({ok:true});}catch(e){next(e)}});
  app.delete(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);await col(tid,entity).doc(req.params.id).delete();res.json({ok:true});}catch(e){next(e)}});
}

app.post('/api/products/import', upload.single('file'), async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); if(!req.file) return res.status(400).json({error:'Archivo requerido'});
  const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
  let ok=0; const errors=[]; const batchSize=400;
  for(let start=0;start<rows.length;start+=batchSize){ const batch=firestore.batch(); for(const [i,row] of rows.slice(start,start+batchSize).entries()){
    const sku=String(row.SKU||row.sku||row.Codigo||row.Código||'').trim(); const name=String(row.Producto||row.producto||row.Nombre||row.nombre||'').trim();
    if(!sku||!name){errors.push({row:start+i+2,error:'SKU y Producto son obligatorios'});continue;}
    const ref=col(tid,'products').doc(sku.replace(/[\\/#?]/g,'-')); batch.set(ref,{sku,name,description:row.Descripcion||row.Descripción||'',category:row.Categoria||row.Categoría||'',fob:num(row.FOB||row['FOB (USD)']),cbm:num(row.CBM),kg:num(row.KG||row.Peso),moq:num(row.MOQ),agentCommissionPct:num(row.ComisionAgenteCompra||row['Comisión agente compra']||row['Comision agente compra']||row.AgentCommissionPct||row['Comisión compra']||0),taxProfileId:row.PerfilImpositivo||row['Perfil impositivo']||'general',productUse:String(row.Uso||row['Tipo uso']||row.TipoUso||'commercial').toLowerCase().replace(/ /g,'_'),imageUrl:row.Imagen||row.Image||row.image_url||'',logisticsProfileId:FieldValue.delete(),active:String(row.Estado||'Activo').toLowerCase()!=='inactivo',updatedAt:now()},{merge:true});ok++; }
    await batch.commit();
  }
  res.json({ok:true,processed:rows.length,imported:ok,errors});
}catch(e){next(e)}});

app.get('/api/products/:id/image', async (req,res,next)=>{try{
  const tid=tenantId(req); const ps=await col(tid,'products').doc(req.params.id).get(); if(!ps.exists)return res.status(404).end(); const object=ps.data()?.imageObject; if(!object)return res.status(404).end(); const file=storage.bucket(bucketName).file(object); const [meta]=await file.getMetadata(); res.setHeader('Content-Type',meta.contentType||'image/jpeg'); res.setHeader('Cache-Control','public, max-age=3600'); file.createReadStream().on('error',next).pipe(res);
}catch(e){next(e)}});
app.post('/api/products/:id/image', upload.single('image'), async (req,res,next)=>{try{
  const tid=tenantId(req); if(!req.file) return res.status(400).json({error:'Imagen requerida'}); const ext=path.extname(req.file.originalname)||'.jpg'; const object=`tenants/${tid}/products/${req.params.id}/${Date.now()}${ext}`; const bucket=storage.bucket(bucketName); const file=bucket.file(object); await file.save(req.file.buffer,{contentType:req.file.mimetype,resumable:false}); const imageUrl=`/api/products/${encodeURIComponent(req.params.id)}/image?tenantId=${encodeURIComponent(tid)}`; await col(tid,'products').doc(req.params.id).set({imageUrl,imageObject:object,updatedAt:now()},{merge:true}); res.json({ok:true,imageUrl});
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

  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${q.quoteNo||req.params.id}.pdf"`);
  const doc=new PDFDocument({margin:30,size:'A4'});
  doc.pipe(res);

  const C={green:'#38A425',greenDark:'#238018',orange:'#F28A18',dark:'#213246',muted:'#687B8E',line:'#D8E2E9',soft:'#F7F9FB',row:'#FBFCFD',greenSoft:'#F2FBEF',orangeSoft:'#FFF6EC',header:'#1F3347'};
  const L=30, T=30, R=doc.page.width-30, B=doc.page.height-34, W=R-L;
  const money=v=>`USD ${num(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const safe=(v,f='-')=>String(v??'').trim()||f;
  const useLabel=u=>u==='particular'?'PARTICULAR':(u==='capital_good'||u==='bien_de_uso')?'BIEN DE USO':'COMERCIAL';
  const box=(x,y,w,h,fill='#fff',stroke=C.line,r=12)=>{doc.save(); doc.lineWidth(1).roundedRect(x,y,w,h,r).fillAndStroke(fill,stroke); doc.restore();};
  const line=(x1,y,x2,color=C.line,width=0.8)=>{doc.save(); doc.strokeColor(color).lineWidth(width).moveTo(x1,y).lineTo(x2,y).stroke(); doc.restore();};
  const tag=(x,y,text,color=C.green,bg=C.greenSoft,w=null)=>{const tw=Math.ceil(doc.widthOfString(text,{fontSize:8.4}))+18; const ww=w||tw; box(x,y,ww,20,bg,color,10); doc.fillColor(color).font('Helvetica-Bold').fontSize(8.4).text(text,x+8,y+6,{width:ww-16,align:'center'});};
  const kv=(x,y,label,value,{labelW=78,valueW=150,bold=false,valueColor='#111',fs=9.2,align='right'}={})=>{doc.fillColor(C.muted).font('Helvetica').fontSize(fs-0.3).text(label,x,y,{width:labelW}); doc.fillColor(valueColor).font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs).text(value,x+labelW+4,y,{width:valueW,align}); doc.font('Helvetica');};
  const amountRow=(x,y,w,label,val,{color='#111',fs=9,bold=false,valPrefix=''}={})=>{const labelW=w-108; const h=Math.max(16,doc.heightOfString(label,{width:labelW,fontSize:fs})+2); doc.fillColor('#33414e').font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs).text(label,x,y,{width:labelW}); doc.fillColor(color).font('Helvetica-Bold').text(`${valPrefix}${money(val)}`,x+labelW+8,y,{width:100,align:'right'}); doc.font('Helvetica'); return h;};
  const newPage=()=>{doc.addPage({size:'A4',margin:30}); return drawHeader();};
  const ensure=(y,needed)=> y+needed>B ? newPage() : y;

  function drawHeader(){
    if(logoPath && fs.existsSync(logoPath)) { try { doc.image(logoPath,L,T-2,{fit:[265,86]}); } catch {} }
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(20).text(isProduct?'Cotización de Productos':'Cotización Logística',L,116);
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(isProduct?'Estimación de importación y costo puesto en Argentina':'Estimación logística y costos operativos',L,141);
    line(L,162,L+44,C.green,3); line(L+48,162,L+76,C.orange,3);

    const hx=R-205, hy=T+4, hw=205, hh=124;
    box(hx,hy,hw,hh,'#fff',C.line,14);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(10.2).text('Detalle de cotización',hx+14,hy+12);
    line(hx+14,hy+29,hx+hw-14,C.line);
    kv(hx+14,hy+39,'Cotización N°',safe(q.quoteNo),{labelW:76,valueW:100,bold:true,valueColor:C.header,fs:8.6});
    kv(hx+14,hy+57,'Fecha',new Date().toLocaleDateString('es-AR'),{labelW:76,valueW:100,bold:true,fs:8.6});
    kv(hx+14,hy+75,'Validez','7 días',{labelW:76,valueW:100,bold:true,fs:8.6,valueColor:C.header});
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.3).text('Comercial',hx+14,hy+93,{width:76});
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.1).text(safe(q.salesRep||tenant.name||'MRAPI Quotes'),hx+90,hy+92,{width:101,align:'right'});
    kv(hx+14,hy+108,'Moneda','USD',{labelW:76,valueW:100,bold:true,fs:8.6,valueColor:C.header});
    doc.font('Helvetica');
    return 178;
  }

  let y=drawHeader();

  const lowerLogName = String(logisticsProfileName).toLowerCase();
  const hasConsolidadoBadge = lowerLogName.includes('consolidado');
  const hasFobBadge = lowerLogName.includes('fcl fob');
  const generalH = (hasConsolidadoBadge || hasFobBadge) ? 146 : 126;
  box(L,y,W,generalH,'#fff',C.line,14);
  tag(L+14,y+12,'DATOS GENERALES',C.green,C.greenSoft,112);
  kv(L+16,y+38,'Cliente',safe(q.clientName),{labelW:66,valueW:165,fs:8.9,bold:true,valueColor:C.header,align:'left'});
  kv(L+16,y+56,'Contacto',safe(q.contactName),{labelW:66,valueW:165,fs:8.9,align:'left'});
  kv(L+16,y+74,'Origen',safe(q.origin,'Shenzhen, China'),{labelW:66,valueW:165,fs:8.9,align:'left'});
  kv(L+274,y+38,'Destino',safe(q.destination,'Buenos Aires, Argentina'),{labelW:62,valueW:170,fs:8.9,bold:true,valueColor:C.header,align:'left'});
  kv(L+274,y+56,'Cálculo',isProduct?'Productos':'Logística',{labelW:62,valueW:170,fs:8.9,bold:true,align:'left'});
  kv(L+274,y+74,'Perfil imp.',safe(q.taxProfileSnapshot?.name,'General'),{labelW:62,valueW:170,fs:8.9,align:'left'});
  tag(L+14,y+98,`Operación: ${safe(logisticsProfileName)}`,C.green,C.greenSoft,250);
  tag(L+276,y+98,`Modalidad: ${c.taxMode==='product'?'Por producto':'Por envío'}`,C.orange,C.orangeSoft,170);
  if(hasConsolidadoBadge) tag(L + Math.round((W-160)/2),y+122,'Incluye Gastos a FOB',C.green,C.greenSoft,160);
  if(hasFobBadge) tag(L + Math.round((W-160)/2),y+122,'FOB sin gastos a FOB',C.orange,C.orangeSoft,160);
  y += generalH + 10;

  if(isProduct && (q.items||[]).length){
    y=ensure(y,96);
    tag(L,y,'PRODUCTOS COTIZADOS',C.header,C.soft,138); y+=28;
    const cols=[58,166,78,84,55,94];
    const heads=['SKU','Producto','Uso','FOB total','CBM','Comisión'];
    box(L,y,W,24,C.header,C.header,8); let cx=L;
    heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.1).text(h,cx+7,y+8,{width:cols[i]-14,align:i>=3?'right':'left'}); cx+=cols[i];});
    y += 26;
    (q.items||[]).forEach((it,idx)=>{
      const rowH=24; y=ensure(y,rowH+8);
      if(idx%2===0) box(L,y,W,rowH,C.row,'#ECF1F4',6);
      const qty=num(it.qty,1), fobTot=num(it.unitFob)*qty, cbmTot=num(it.unitCbm)*qty, com=fobTot*num(it.agentCommissionPct)/100;
      const vals=[safe(it.sku),`${safe(it.name)} x${qty}`,useLabel(it.productUse),money(fobTot),Number(cbmTot).toFixed(3),`${num(it.agentCommissionPct).toFixed(1)}% · ${money(com)}`];
      cx=L;
      vals.forEach((v,i)=>{doc.fillColor(i===1?C.header:'#243341').font(i===1?'Helvetica-Bold':'Helvetica').fontSize(8).text(v,cx+7,y+8,{width:cols[i]-14,align:i>=3?'right':'left'}); cx+=cols[i];});
      y += rowH+2;
    });
    box(L,y,W,28,C.greenSoft,'#AFD8A4',8);
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(9).text(`FOB total: ${money(c.fob)}`,L+12,y+9);
    doc.fillColor(C.orange).text(`CBM total: ${Number(c.cbm||0).toFixed(3)}`,L+195,y+9);
    doc.fillColor(C.greenDark).text(`Comisión de compra: ${money(c.agentCommissionTotal)}`,L+338,y+9);
    y += 38;
  }

  y=ensure(y,430);
  box(L,y,W,28,C.greenSoft,'#AFD8A4',10);
  doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.8).text('Costos logísticos y base imponible',L+12,y+9);
  y += 36;
  const costRows=[
    {label:'FOB mercadería',net:c.fob,total:c.fob},
    {label:'Comisión agente de compra',net:c.agentCommissionTotal,total:c.agentCommissionTotal},
    ...(c.logisticsLines||[]).map(l=>({
      label:`${l.name}${l.vatTreatment==='plus_vat'?' (+ IVA 21%)':l.vatTreatment==='included_vat'?' (IVA incluido)':''}`,
      net:num(l.netAmount),
      total:num(l.total)
    })),
    {label:'Seguro internacional',net:c.insurance,total:c.insurance}
  ];
  const conceptW=W-226, netW=96, totalW=102;
  let costH=52;
  for(const r of costRows){ costH += Math.max(18, doc.heightOfString(r.label,{width:conceptW-8,fontSize:8.7})+2) + 6; }
  costH += 72 + (c.containerCapacityCbm?50:0);
  box(L,y,W,costH,'#fff',C.line,12);
  let cy=y+12;
  box(L+14,cy,W-28,24,C.soft,'#E9EFF4',8);
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.8).text('Concepto',L+22,cy+8,{width:conceptW-12});
  doc.text('Neto sin IVA',L+14+conceptW,cy+8,{width:netW,align:'right'});
  doc.text('Total c/ IVA',L+14+conceptW+netW+10,cy+8,{width:totalW,align:'right'});
  cy += 30;
  for(const r of costRows){
    const rh=Math.max(18, doc.heightOfString(r.label,{width:conceptW-8,fontSize:8.8})+2);
    doc.fillColor('#33414e').font('Helvetica').fontSize(8.8).text(r.label,L+18,cy,{width:conceptW-8});
    doc.fillColor(C.header).font('Helvetica-Bold').text(money(r.net),L+14+conceptW,cy,{width:netW,align:'right'});
    doc.fillColor(C.header).font('Helvetica-Bold').text(money(r.total),L+14+conceptW+netW+10,cy,{width:totalW,align:'right'});
    cy += rh + 6;
  }
  line(L+14,cy,R-14,C.green); cy += 9;
  cy += amountRow(L+14,cy,W-28,'Base CIF',c.cif,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'Logística neta (sin IVA)',c.logisticsNet,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'IVA servicios logísticos',c.logisticsVat,{color:C.orange,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'Total costos logísticos (con IVA)',c.logisticsTotal,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'Logística all-in real por m³',c.logisticsAllInPerCbm,{color:C.greenDark,fs:9.2,bold:true})+5;
  if(c.containerCapacityCbm){
    box(L+14,cy,W-28,40,C.greenSoft,'#AFD8A4',10);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(9.1).text(`${safe(c.containerType,'Contenedor')} · ${Number(c.cbm||0).toFixed(2)} / ${Number(c.totalContainerCapacity||c.containerCapacityCbm).toFixed(2)} m³`,L+24,cy+10);
    doc.fillColor(C.greenDark).text(`${Number(c.containerUtilizationPct||0).toFixed(1)}% ocupado`,R-144,cy+10,{width:112,align:'right'});
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.2).text(c.containersRequired>1?`${c.containersRequired} contenedores requeridos`:`Espacio disponible: ${Number(c.containerRemainingCbm||0).toFixed(2)} m³`,L+24,cy+24);
    cy += 48;
  }
  y += costH + 10;

  y=ensure(y,190);
  const gap=12, half=(W-gap)/2;
  box(L,y,half,166,C.orangeSoft,'#F2C48A',12);
  box(L+half+gap,y,half,166,C.greenSoft,'#AFD8A4',12);
  doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text('Derechos e impuestos',L+12,y+12);
  doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.8).text('Recupero de impuestos (detallado)',L+half+gap+12,y+12);
  let ty=y+36;
  [['Derechos',c.duty],['IVA',c.vat],['IVA adicional',c.vatAdditional],['Ganancia',c.earnings],['IIBB',c.iibb],['Tasa estadística',c.statisticalFee]].forEach(([lab,val])=>{ ty += amountRow(L+12,ty,half-24,lab,val,{fs:8.7})+1; });
  line(L+12,y+141,L+half-12,C.orange); amountRow(L+12,y+146,half-24,'Total impuestos',c.taxesTotal,{color:C.orange,fs:9.2,bold:true});
  let ry=y+36;
  [['Recupero IVA',c.vat],['Recupero IVA adicional',c.vatAdditional],['Recupero Ganancia',c.earnings],['Recupero IIBB',c.iibb],['Recupero IVA servicios',c.servicesVatRecoverable]].forEach(([lab,val])=>{ ry += amountRow(L+half+gap+12,ry,half-24,lab,val,{fs:8.7,color:C.greenDark})+1; });
  line(L+half+gap+12,y+141,R-12,C.green); amountRow(L+half+gap+12,y+146,half-24,'Recupero total',c.totalRecoverable,{color:C.greenDark,fs:9.2,bold:true});
  y += 178;

  // v22: clearer landed cost cards focused on gross total vs net after recoveries.
  if(isProduct && (c.itemLandedCosts||[]).length){
    const shown=(c.itemLandedCosts||[]).slice(0,4);
    const cardH=112;
    const blockH=104 + shown.length*cardH + 34;
    y=ensure(y,blockH+8);

    box(L,y,W,blockH,'#fff',C.line,14);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(11.5).text('Costo final por producto puesto en Argentina',L+14,y+14);
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.1).text(
      'Primero se muestra cuánto dinero total debe desembolsar el cliente por cada ítem. Luego se descuentan los recuperos para estimar el costo neto final.',
      L+14,y+32,{width:W-28}
    );

    const innerX=L+14, innerW=W-28;
    const tableY=y+60;
    const widths=[118,78,70,72,82,87]; // total 507
    const labels=['Producto','Costo prod.','Logística','Impuestos','Bruto total','Recuperos'];
    const colors=[C.muted,C.muted,C.muted,C.muted,C.orange,C.greenDark];

    box(innerX,tableY,innerW,26,C.soft,'#E9EFF4',8);
    let hx=innerX;
    labels.forEach((label,i)=>{doc.fillColor(colors[i]).font('Helvetica-Bold').fontSize(7.3).text(label,hx+6,tableY+9,{width:widths[i]-12,align:i===0?'left':'right'}); hx += widths[i];});

    let py=tableY+32;
    let grossSubtotal=0, recoveriesSubtotal=0, netSubtotal=0;

    shown.forEach((it)=>{
      py=ensure(py,cardH+22);
      const qty=Math.max(1,num(it.qty,1));
      const productCost=num(it.itemFob)+num(it.agentCommissionAmount)+num(it.honorariaAmount);
      const deduction=num(it.recoverableAmount)+num(it.servicesVatShare);
      const grossUnit=num(it.grossArgentinaTotal)/qty;
      const netUnit=num(it.netArgentinaTotal)/qty;
      grossSubtotal += num(it.grossArgentinaTotal);
      recoveriesSubtotal += deduction;
      netSubtotal += num(it.netArgentinaTotal);

      box(innerX,py,innerW,cardH,'#fff','#E5EDF2',10);
      let cx=innerX;
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.5).text(safe(it.name||it.sku),cx+8,py+10,{width:widths[0]-16});
      doc.fillColor(C.muted).font('Helvetica').fontSize(7.1).text(`${Number(it.itemCbm||0).toFixed(3)} m³ · x${qty}`,cx+8,py+27,{width:widths[0]-16});
      cx += widths[0];
      doc.fillColor('#243341').font('Helvetica').fontSize(8.0).text(money(productCost),cx+4,py+12,{width:widths[1]-8,align:'right'}); cx += widths[1];
      doc.text(money(it.logisticsAmount),cx+4,py+12,{width:widths[2]-8,align:'right'}); cx += widths[2];
      doc.text(money(it.taxAmount),cx+4,py+12,{width:widths[3]-8,align:'right'}); cx += widths[3];
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(8.4).text(money(it.grossArgentinaTotal),cx+4,py+10,{width:widths[4]-8,align:'right'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(6.9).text(`Total del ítem`,cx+4,py+26,{width:widths[4]-8,align:'right'}); cx += widths[4];
      doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(8.1).text(`- ${money(deduction)}`,cx+4,py+12,{width:widths[5]-8,align:'right'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(6.9).text(`Descuentos`,cx+4,py+26,{width:widths[5]-8,align:'right'});

      const strip1Y=py+40;
      box(innerX+8,strip1Y,innerW-16,25,C.orangeSoft,'#F2C48A',9);
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.6).text('COSTO TOTAL DEL ÍTEM',innerX+18,strip1Y+8,{width:130});
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(12.8).text(money(it.grossArgentinaTotal),innerX+162,strip1Y+5,{width:145,align:'left'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(7.1).text('Unitario bruto',innerX+336,strip1Y+8,{width:72,align:'right'});
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text(money(grossUnit),innerX+416,strip1Y+5,{width:74,align:'right'});

      const strip2Y=py+70;
      const stripX=innerX+8, stripW=innerW-16;
      box(stripX,strip2Y,stripW,28,C.greenSoft,'#B9DFAE',9);
      const seg1=150, seg2=160, seg3=stripW-seg1-seg2;
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.2).text('RECUPEROS ESTIMADOS',stripX+10,strip2Y+10,{width:85});
      doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(9.8).text(`- ${money(deduction)}`,stripX+90,strip2Y+8,{width:seg1-100,align:'right'});

      const midX = stripX + seg1;
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.2).text('COSTO NETO DEL ÍTEM',midX+10,strip2Y+10,{width:90});
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(9.6).text(money(it.netArgentinaTotal),midX+95,strip2Y+8,{width:seg2-105,align:'right'});

      const rightX = midX + seg2;
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.0).text('NETO / UNIDAD',rightX+10,strip2Y+10,{width:65});
      doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(12.0).text(money(netUnit),rightX+74,strip2Y+6,{width:seg3-84,align:'right'});

      py += cardH+8;
    });

    box(innerX,py+4,innerW,50,C.soft,'#D9E3EA',10);
    const footY = py + 10;
    const f1=168, f2=168, f3=innerW-f1-f2;
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.8).text('Subtotal bruto total',innerX+12,footY+4,{width:90});
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(10.4).text(money(grossSubtotal),innerX+90,footY+2,{width:f1-102,align:'right'});

    const fx2 = innerX + f1;
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(8.8).text('Recuperos totales',fx2+12,footY+4,{width:88});
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.4).text(`- ${money(recoveriesSubtotal)}`,fx2+98,footY+2,{width:f2-110,align:'right'});

    const fx3 = fx2 + f2;
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.8).text('Subtotal neto final',fx3+12,footY+4,{width:90});
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(12.4).text(money(netSubtotal),fx3+98,footY,{width:f3-110,align:'right'});

    doc.fillColor(C.muted).font('Helvetica').fontSize(7.8).text(`Logística all-in distribuida proporcionalmente por m³: ${money(c.logisticsAllInPerCbm)} / m³.`,innerX,py+62,{width:innerW});

    y = py + 76;
  }

  if(c.honorariaApplies){
    y=ensure(y,82);
    box(L,y,W,70,C.orangeSoft,'#F2C48A',12);
    doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text('Honorarios del envío',L+12,y+12);
    doc.fillColor('#36424f').font('Helvetica').fontSize(8.8).text(`Impuestos normales (100%): ${money(c.normalTaxesTotal)}`,L+12,y+35);
    doc.text(`Impuestos declarados (${c.honorariaBasePct}%): ${money(c.taxesTotal)}`,L+210,y+35);
    doc.fillColor(C.greenDark).text(`Ahorro impositivo: ${money(c.taxSavings)}`,L+12,y+52);
    doc.fillColor(C.orange).font('Helvetica-Bold').text(`Honorarios: ${money(c.honoraria)}`,R-170,y+52,{width:140,align:'right'});
    y += 82;
  }

  y=ensure(y,94);
  box(L,y,W,82,'#fff',C.line,14);
  box(L+12,y+11,124,58,C.header,C.header,12);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11.5).text('Resumen final',L+28,y+28);
  doc.fillColor('#fff').font('Helvetica').fontSize(9.5).text('estimado',L+49,y+44);
  doc.fillColor('#36424f').font('Helvetica').fontSize(9.2).text('Subtotal costos + impuestos',L+154,y+18);
  doc.text(money(c.landedCost),R-160,y+18,{width:130,align:'right'});
  doc.fillColor(C.greenDark).text('Recupero total',L+154,y+36);
  doc.text(`- ${money(c.totalRecoverable)}`,R-160,y+36,{width:130,align:'right'});
  line(L+154,y+51,R-18,C.line);
  doc.fillColor(C.header).font('Helvetica-Bold').fontSize(12).text('Total final estimado',L+154,y+56);
  doc.fillColor(C.greenDark).fontSize(17).text(money(c.netCost),R-184,y+52,{width:154,align:'right'});
  y += 92;

  doc.fillColor(C.muted).font('Helvetica').fontSize(7.7).text('• En operaciones FCL + Consolidado se consideran Gastos a FOB. En FCL FOB, ese concepto no aplica.',L,y,{width:W});
  doc.text('• Los valores son estimados y pueden variar según tipo de cambio, normativas, flete, cubicaje, fiscalización y validación aduanera.',L,doc.y+3,{width:W});
  doc.text('• Cotización expresada en USD americanos.',L,doc.y+3,{width:W});
  doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.5).text(`Gracias por confiar en ${tenant.name||'MRAPI Quotes'}.`,L+275,doc.y+6,{width:250,align:'right'});
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
