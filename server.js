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

  await ref.set({schemaVersion:11,updatedAt:now()},{merge:true});
}

app.get('/api/health', (req,res)=>res.json({ok:true,service:'mrapi-quote',databaseId,bucketName}));
app.get('/api/bootstrap', async (req,res,next)=>{ try{ const tid=tenantId(req); await seedTenant(tid); const [tenant,tax,log,products,quotes,clients]=await Promise.all([
  tdoc(tid).get(), col(tid,'taxProfiles').get(), col(tid,'logisticsProfiles').get(), col(tid,'products').limit(100).get(), col(tid,'quotes').orderBy('createdAt','desc').limit(50).get(), col(tid,'clients').limit(100).get()
]); res.json({tenant:{id:tid,...tenant.data()},taxProfiles:tax.docs.map(d=>({id:d.id,...d.data()})),logisticsProfiles:log.docs.map(d=>({id:d.id,...d.data()})),products:products.docs.map(d=>({id:d.id,...d.data()})),quotes:quotes.docs.map(d=>({id:d.id,...d.data()})),clients:clients.docs.map(d=>({id:d.id,...d.data()}))}); }catch(e){next(e)} });

for (const entity of ['products','taxProfiles','logisticsProfiles','clients','users']) {
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

  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${q.quoteNo||req.params.id}.pdf"`);
  const doc=new PDFDocument({margin:32,size:'A4',bufferPages:true});
  doc.pipe(res);

  const C={green:'#35a326',orange:'#f48a16',dark:'#344252',muted:'#6b7785',line:'#dce3e8',pale:'#f7f9fa',greenPale:'#f5fbf3',orangePale:'#fff8f1'};
  const L=32, R=doc.page.width-32, W=R-L;
  const money=v=>`USD ${num(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const useLabel=u=>u==='particular'?'PARTICULAR':(u==='capital_good'||u==='bien_de_uso')?'BIEN DE USO':'COMERCIAL';
  const box=(x,y,w,h,fill='#fff',stroke=C.line,r=10)=>{doc.save().roundedRect(x,y,w,h,r).fillAndStroke(fill,stroke).restore();};
  const hline=(x1,x2,y,color=C.line)=>doc.save().strokeColor(color).lineWidth(0.8).moveTo(x1,y).lineTo(x2,y).stroke().restore();
  const pair=(x,y,label,value,w=235)=>{doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(label,x,y,{width:90});doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.5).text(value,x+92,y,{width:w-92,align:'right'});};
  const row=(x,y,w,label,value,color='#111',fs=9)=>{doc.fillColor('#333').font('Helvetica').fontSize(fs).text(label,x,y,{width:w-110});doc.fillColor(color).font('Helvetica-Bold').fontSize(fs).text(money(value),x+w-100,y,{width:100,align:'right'});};
  const title=(x,y,t,color=C.dark)=>doc.fillColor(color).font('Helvetica-Bold').fontSize(11.5).text(t,x,y);
  function addPageHeader(){
    if(logoPath&&fs.existsSync(logoPath)){try{doc.image(logoPath,L,26,{fit:[190,66]});}catch{}}
    doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(23).text(isProduct?'Cotización de Productos':'Cotización Logística',L,99);
    doc.fillColor(C.dark).font('Helvetica').fontSize(11.5).text(isProduct?'Estimación de importación y costos en Argentina':'Estimación logística y costos operativos',L,130);
    doc.save().strokeColor(C.green).lineWidth(3).moveTo(L,151).lineTo(L+38,151).stroke().strokeColor(C.orange).moveTo(L+41,151).lineTo(L+67,151).stroke().restore();
    const mx=R-175; box(mx,25,175,102);
    pair(mx+10,38,'Cotización N°:',q.quoteNo||'-',155); pair(mx+10,56,'Fecha:',new Date().toLocaleDateString('es-AR'),155); pair(mx+10,74,'Validez:','7 días',155); pair(mx+10,92,'Comercial:',q.salesRep||'MRAPI Quotes',155); pair(mx+10,110,'Moneda:','USD',155);
  }
  function newPage(){doc.addPage({size:'A4',margin:32});addPageHeader();return 170;}
  function ensure(y,needed){return y+needed>doc.page.height-60?newPage():y;}

  addPageHeader();
  let y=170;

  box(L,y,W,108);
  pair(L+14,y+16,'Cliente:',q.clientName||'-',230); pair(L+14,y+38,'Contacto:',q.contactName||'-',230); pair(L+14,y+60,'Origen:',q.origin||'Shenzhen, China',230);
  pair(L+W/2+5,y+16,'Destino:',q.destination||'Buenos Aires, Argentina',235); pair(L+W/2+5,y+38,'Tipo de cálculo:',isProduct?'Productos':'Logística',235); pair(L+W/2+5,y+60,'Perfil impositivo:',q.taxProfileSnapshot?.name||'General',235);
  box(L+14,y+79,220,22,C.greenPale,'#9bcf8b',8);doc.fillColor(C.muted).font('Helvetica').fontSize(8.7).text('Operación logística:',L+23,y+86);doc.fillColor(C.green).font('Helvetica-Bold').text(logisticsProfileName||'-',L+108,y+86,{width:118});
  doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(9).text(`Modalidad: ${c.taxMode==='product'?'Por producto':'Por envío'}`,L+W/2+5,y+84);
  if(String(logisticsProfileName).toLowerCase().includes('fcl fob')) doc.fillColor('#2d62a4').font('Helvetica').fontSize(8.2).text('FCL FOB: Gastos a FOB no aplica.',L+W/2+5,y+96);
  if(String(logisticsProfileName).toLowerCase().includes('consolidado')) doc.fillColor(C.green).font('Helvetica').fontSize(8.2).text('FCL + Consolidado: incluye Gastos a FOB.',L+W/2+5,y+96);
  y+=122;

  if(isProduct && (q.items||[]).length){
    y=ensure(y,80); title(L,y,'Productos cotizados',C.dark); y+=18;
    const cols=[50,195,68,75,62,85]; const heads=['SKU','Producto','Uso','FOB total','CBM total','Comisión'];
    doc.save().rect(L,y,W,24).fill(C.dark).restore(); let cx=L;
    heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5).text(h,cx+5,y+8,{width:cols[i]-10,align:i>=3?'right':'left'});cx+=cols[i];});
    y+=24;
    for(const it of q.items){
      y=ensure(y,30);
      const fobTot=num(it.unitFob)*num(it.qty,1), cbmTot=num(it.unitCbm)*num(it.qty,1), com=fobTot*num(it.agentCommissionPct)/100;
      cx=L; const vals=[it.sku||'-',`${it.name||'-'} x${num(it.qty,1)}`,useLabel(it.productUse),money(fobTot),Number(cbmTot).toFixed(3),`${num(it.agentCommissionPct).toFixed(1)}% / ${money(com)}`];
      vals.forEach((v,i)=>{doc.fillColor('#222').font(i===1?'Helvetica-Bold':'Helvetica').fontSize(8.2).text(v,cx+5,y+7,{width:cols[i]-10,align:i>=3?'right':'left'});cx+=cols[i];});
      hline(L,R,y+26); y+=27;
    }
    box(L,y,W,31,C.pale,C.line,7);doc.fillColor(C.green).font('Helvetica-Bold').fontSize(9.5).text(`Total FOB: ${money(c.fob)}`,L+10,y+10);doc.fillColor(C.orange).text(`Total CBM: ${Number(c.cbm||0).toFixed(3)}`,L+190,y+10);doc.fillColor(C.green).text(`Comisión compra: ${money(c.agentCommissionTotal)}`,L+335,y+10);
    y+=44;
  }

  y=ensure(y,170); box(L,y,W,22,C.greenPale,'#abd49e',8);title(L+10,y+6,'Costos logísticos y base imponible',C.green);y+=31;
  const costs=[{label:'FOB mercadería',value:c.fob},{label:'Comisión agente de compra',value:c.agentCommissionTotal},...(c.logisticsLines||[]).map(l=>({label:`${l.name}${l.vatTreatment==='plus_vat'?' (+ IVA 21%)':l.vatTreatment==='included_vat'?' (IVA incluido)':''}`,value:l.total})),{label:'Seguro internacional',value:c.insurance}];
  for(const r of costs){y=ensure(y,24); const h=doc.heightOfString(r.label,{width:W-125,fontSize:9})>12?24:18; row(L+10,y,W-20,r.label,r.value,'#222',9);y+=h;}
  hline(L+10,R-10,y,C.green);y+=8;row(L+10,y,W-20,'Base CIF',c.cif,C.green,10);y+=19;row(L+10,y,W-20,'Logística neta',c.logisticsNet,C.green,10);y+=19;row(L+10,y,W-20,'IVA servicios logísticos',c.logisticsVat,C.orange,10);y+=19;row(L+10,y,W-20,'Total costos logísticos',c.logisticsTotal,C.green,10);y+=19;row(L+10,y,W-20,'Logística all-in por CBM',c.logisticsAllInPerCbm,C.green,10);y+=22;
  if(c.containerCapacityCbm){y=ensure(y,48);box(L+10,y,W-20,38,C.greenPale,'#a8d69a',8);doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(9.5).text(`${c.containerType||'Contenedor'} · ${Number(c.cbm||0).toFixed(2)} / ${Number(c.totalContainerCapacity||c.containerCapacityCbm).toFixed(2)} m³`,L+20,y+8);doc.fillColor(C.green).text(`${Number(c.containerUtilizationPct||0).toFixed(1)}% ocupado`,R-145,y+8,{width:115,align:'right'});doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(c.containersRequired>1?`${c.containersRequired} contenedores requeridos`:`Espacio disponible: ${Number(c.containerRemainingCbm||0).toFixed(2)} m³`,L+20,y+23);y+=48;}
  y+=10;

  y=ensure(y,180); const gap=12, half=(W-gap)/2;
  box(L,y,half,164,C.orangePale,'#f3c48d',10); title(L+12,y+11,'Derechos e impuestos',C.orange);
  const taxRows=[['Derechos',c.duty],['IVA',c.vat],['IVA adicional',c.vatAdditional],['Ganancia',c.earnings],['IIBB',c.iibb],['Tasa estadística',c.statisticalFee]]; let ty=y+36;
  taxRows.forEach(([lab,val])=>{row(L+12,ty,half-24,lab,val);ty+=18;});hline(L+12,L+half-12,y+137,C.orange);row(L+12,y+145,half-24,'Total impuestos',c.taxesTotal,C.orange,9.5);
  const rx=L+half+gap;box(rx,y,half,164,C.greenPale,'#a8d69a',10);title(rx+12,y+11,'Recupero de impuestos (detallado)',C.green);
  const recRows=[['Recupero IVA',c.vat],['Recupero IVA adicional',c.vatAdditional],['Recupero Ganancia',c.earnings],['Recupero IIBB',c.iibb],['Recupero IVA servicios',c.servicesVatRecoverable]]; let ry=y+36;
  recRows.forEach(([lab,val])=>{row(rx+12,ry,half-24,lab,val,C.green);ry+=18;});hline(rx+12,R-12,y+137,C.green);row(rx+12,y+145,half-24,'Recupero total',c.totalRecoverable,C.green,9.5);
  y+=178;

  if(isProduct && (c.itemLandedCosts||[]).length){
    y=ensure(y,118); box(L,y,W,108,'#fff',C.line,10); title(L+12,y+10,'Costo real por producto puesto Argentina',C.dark);
    const heads=['Producto','CBM','Logística prop.','Impuestos','Recuperos','Neto/unit']; const xs=[L+12,L+190,L+240,L+326,L+400,L+482]; const ws=[168,42,78,70,70,58];
    heads.forEach((h,i)=>doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(h,xs[i],y+30,{width:ws[i],align:i?'right':'left'}));
    let py=y+45;
    (c.itemLandedCosts||[]).slice(0,4).forEach(it=>{
      doc.fillColor('#222').font('Helvetica').fontSize(8).text(it.name||it.sku||'-',xs[0],py,{width:ws[0]});
      doc.text(Number(it.itemCbm||0).toFixed(3),xs[1],py,{width:ws[1],align:'right'});
      doc.text(money(it.logisticsAmount),xs[2],py,{width:ws[2],align:'right'});
      doc.text(money(it.taxAmount),xs[3],py,{width:ws[3],align:'right'});
      doc.fillColor(C.green).text(`-${money(num(it.recoverableAmount)+num(it.servicesVatShare))}`,xs[4],py,{width:ws[4],align:'right'});
      doc.fillColor(C.dark).font('Helvetica-Bold').text(money(it.netArgentinaUnit),xs[5],py,{width:ws[5],align:'right'}); doc.font('Helvetica');
      py+=15;
    });
    doc.fillColor(C.muted).fontSize(8).text(`La logística se distribuye por m³: ${money(c.logisticsAllInPerCbm)} / m³.`,L+12,y+91,{width:W-24});
    y+=120;
  }

  if(c.honorariaApplies){y=ensure(y,80);box(L,y,W,68,C.orangePale,'#f3c48d',10);title(L+12,y+10,'Honorarios del envío',C.orange);doc.fillColor('#333').font('Helvetica').fontSize(9).text(`Impuestos normales (100%): ${money(c.normalTaxesTotal)}`,L+12,y+32);doc.text(`Impuestos declarados (${c.honorariaBasePct}%): ${money(c.taxesTotal)}`,L+230,y+32);doc.fillColor(C.green).text(`Ahorro impositivo: ${money(c.taxSavings)}`,L+12,y+49);doc.fillColor(C.orange).font('Helvetica-Bold').text(`Honorarios: ${money(c.honoraria)}`,L+365,y+49,{width:155,align:'right'});y+=80;}

  y=ensure(y,85);box(L,y,W,76,'#fff',C.line,12);box(L+10,y+10,128,56,C.dark,C.dark,11);doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12).text('Resumen final',L+28,y+24);doc.fontSize(10.5).text('estimado',L+48,y+42);doc.fillColor('#333').font('Helvetica').fontSize(9.5).text('Subtotal costos + impuestos',L+155,y+16);doc.text(money(c.landedCost),R-140,y+16,{width:125,align:'right'});doc.fillColor(C.green).text('Recupero total',L+155,y+34);doc.text(`- ${money(c.totalRecoverable)}`,R-140,y+34,{width:125,align:'right'});hline(L+155,R-15,y+50);doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text('Total final estimado',L+155,y+56);doc.fillColor(C.green).fontSize(17).text(money(c.netCost),R-175,y+53,{width:160,align:'right'});y+=90;

  y=ensure(y,50);doc.fillColor(C.muted).font('Helvetica').fontSize(8).text('En operaciones FCL + Consolidado se consideran Gastos a FOB. En FCL FOB, ese concepto no aplica.',L,y,{width:W});doc.text('Los valores son estimados y pueden variar según tipo de cambio, normativas, flete, cubicaje y validación aduanera.',L,doc.y+3,{width:W});doc.text('Cotización expresada en USD americanos.',L,doc.y+3,{width:W});doc.fillColor(C.green).font('Helvetica-Bold').fontSize(11).text(`Gracias por confiar en ${tenant.name||'MRAPI Quotes'}.`,L+260,doc.y+8,{width:260,align:'right'});
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
