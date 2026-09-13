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
const safeDocId = (value, prefix='id') => {
  const raw=String(value??'').trim();
  if(!raw || raw==='.' || raw==='..' || raw.includes('/') || raw.includes('\\')) return id(prefix);
  return raw;
};
const num = (v, d=0) => Number.isFinite(Number(v)) ? Number(v) : d;
const isManualTaxId = v => v === 'manual' || v === '__manual__';

function applyUseRules(profile={}, use='commercial') {
  const p={...profile};
  if (p.manual === true || p.isManual === true) return p;
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
  const volumetricKg=Math.max(0,num(input.volumetricKg,0));
  const weightDivisor=Math.max(0,num(input.weightDivisor,0));
  const chargeableKg=Math.max(0,num(input.chargeableKg,0)) || kg;
  const tax=input.taxProfile||{};
  const log=input.logisticsProfile||{};
  const items=Array.isArray(input.items)?input.items:[];
  const itemAgentCommissionTotal=items.reduce((s,i)=>s+(num(i.unitFob)*num(i.qty,1)*(num(i.agentCommissionPct)/100)),0);
  const shipmentAgentCommissionPct=num(input.agentCommissionPct,0);
  const agentCommissionTotal=items.length?itemAgentCommissionTotal:(fob*shipmentAgentCommissionPct/100);
  const insurancePct=num(input.insurancePct,num(log.insurancePct,0));
  const insurance=input.insuranceAmount!=null?num(input.insuranceAmount):fob*insurancePct/100;

  const logisticsLines=Array.isArray(log.lines)?log.lines:[];
  const disabledLogisticsLines=new Set(Array.isArray(input.disabledLogisticsLines)?input.disabledLogisticsLines.map(String):[]);
  const computedLines=logisticsLines.map((line,lineIndex)=>{
    const lineKey=String(line.code||`line_${lineIndex}`);
    if(disabledLogisticsLines.has(lineKey)) return null;
    const basis=line.basis||'fixed', unit=num(line.amount); let qty=1,netAmount=unit,formulaApplied=null;
    if(basis==='cbm'){qty=cbm;netAmount=unit*qty;}
    else if(basis==='kg'||basis==='conditional_kg'){qty=chargeableKg;netAmount=unit*qty;}
    else if(basis==='base_plus_kg'){qty=chargeableKg;const base=num(line.baseAmount,line.amount);const rate=num(line.ratePerKg);netAmount=base+(rate*qty);formulaApplied={base,ratePerKg:rate,kg:qty};}
    else if(basis==='percent_fob'){qty=fob/100;netAmount=unit*qty;}
    else if(basis==='tiered_cbm'){
      qty=cbm; const tiers=Array.isArray(line.tiers)?line.tiers:[];
      // New simple tiers are cumulative (same logic as the UI preview):
      // 0-1 fixed 500, 1-5 +500/m3, 5-68 +400/m3 => 10 m3 = 4500.
      if(tiers.some(t=>t && t.mode)){
        let total=0;
        for(const t of tiers){
          const from=num(t.from);
          const up=t.upTo==null?Infinity:num(t.upTo);
          if(cbm<=from) continue;
          if(t.mode==='fixed') total+=num(t.amount);
          else total+=Math.max(0,Math.min(cbm,up)-from)*num(t.rate);
          if(cbm<=up) break;
        }
        netAmount=total;
        formulaApplied={mode:'simple_tiers',tiers};
      }else{
        // Backward compatibility for old profiles that still use base/included/rate tiers.
        const tier=tiers.find(t=>t.upTo==null||cbm<=num(t.upTo))||tiers[tiers.length-1];
        if(tier){const base=num(tier.base),included=num(tier.included),rate=num(tier.rate);netAmount=base+Math.max(0,cbm-included)*rate;formulaApplied={upTo:tier.upTo??null,base,included,rate};}else netAmount=0;
      }
    }
    const vatTreatment=line.vatTreatment||'none';
    const vatRate=num(line.vatRate,21);
    let vatAmount=0,total=netAmount;
    if(vatTreatment==='plus_vat'){vatAmount=netAmount*vatRate/100;total=netAmount+vatAmount;}
    else if(vatTreatment==='included_vat'){vatAmount=netAmount-(netAmount/(1+vatRate/100));netAmount=netAmount-vatAmount;total=netAmount+vatAmount;}
    return {...line,lineKey,qty,netAmount,vatTreatment,vatRate,vatAmount,total,formulaApplied};
  }).filter(Boolean);
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

  // Honorarios del envío (v30): 50% / 70% significa porcentaje de FOB declarado.
  // IMPORTANTE: NO se toma el impuesto normal y se multiplica por 50%/70%.
  // Se vuelve a ejecutar la fórmula impositiva usando el FOB declarado reducido.
  // El flete internacional queda al 100% porque es un costo real de la operación;
  // seguro y comisión, cuando son proporcionales al FOB, se reducen con la misma base.
  const honorariaApplies=!!input.honorariaApplies;
  const honorariaBasePct=[50,70].includes(num(input.honorariaBasePct))?num(input.honorariaBasePct):50;
  const honorariaRatePct=num(input.honorariaRatePct,30);
  const declaredFactor=honorariaApplies?honorariaBasePct/100:1;
  const declaredFob=honorariaApplies?fob*declaredFactor:fob;

  const normalTaxes={...totals};
  const normalItemTaxes=itemTaxes.map(i=>({...i}));
  const normalTaxesTotal=num(normalTaxes.taxesTotal);
  if(honorariaApplies){
    if(taxMode==='product' && items.length){
      const totalItemFob=items.reduce((s,i)=>s+num(i.unitFob)*num(i.qty,1),0)||fob||1;
      const declaredTotals={duty:0,vat:0,vatAdditional:0,earnings:0,iibb:0,statisticalFee:0,taxesTotal:0,recoverable:0};
      itemTaxes=items.map((i,idx)=>{
        const itemFob=num(i.unitFob)*num(i.qty,1);
        const share=itemFob/totalItemFob;
        const itemCommission=itemFob*(num(i.agentCommissionPct)/100);
        const r=computeTaxesFromBase({
          fob:itemFob*declaredFactor,
          agentCommission:itemCommission*declaredFactor,
          freight:internationalFreight*share,
          insurance:insurance*share*declaredFactor,
          profile:i.taxProfile||tax,
          use:i.productUse||'commercial'
        });
        Object.keys(declaredTotals).forEach(k=>declaredTotals[k]+=num(r[k]));
        return {productId:i.productId,sku:i.sku,name:i.name,productUse:i.productUse||'commercial',taxProfileId:i.taxProfileId||input.taxProfileId,agentCommissionPct:num(i.agentCommissionPct),agentCommissionAmount:itemCommission*declaredFactor,normalTaxesTotal:num(normalItemTaxes[idx]?.taxesTotal),declaredFob:itemFob*declaredFactor,...r};
      });
      totals=declaredTotals;
      dutyBase=itemTaxes.reduce((s,x)=>s+num(x.dutyBase),0);
      vatBase=itemTaxes.reduce((s,x)=>s+num(x.vatBase),0);
    } else {
      const r=computeTaxesFromBase({
        fob:fob*declaredFactor,
        agentCommission:agentCommissionTotal*declaredFactor,
        freight:internationalFreight,
        insurance:insurance*declaredFactor,
        profile:tax,
        use:input.shipmentUse||'commercial'
      });
      totals={duty:r.duty,vat:r.vat,vatAdditional:r.vatAdditional,earnings:r.earnings,iibb:r.iibb,statisticalFee:r.statisticalFee,taxesTotal:r.taxesTotal,recoverable:r.recoverable};
      dutyBase=r.dutyBase; vatBase=r.vatBase;
    }
  }
  const taxSavings=honorariaApplies?normalTaxesTotal-num(totals.taxesTotal):0;
  const honoraria=honorariaApplies?taxSavings*honorariaRatePct/100:0;
  const realRecovery=honorariaApplies?Math.max(0,taxSavings-honoraria):0;
  const totalToPay=totals.taxesTotal+logisticsTotal+agentCommissionTotal+honoraria;
  const landedCost=fob+totalToPay;
  const customsRecoverable=totals.recoverable;
  const servicesVatRecoverable=logisticsVat;
  const totalRecoverable=customsRecoverable+servicesVatRecoverable;
  const netCost=landedCost-totalRecoverable;
  const logisticsAllInPerCbm=cbm>0?logisticsTotal/cbm:0;
  const logisticsAllInPerKg=chargeableKg>0?logisticsTotal/chargeableKg:0;
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
  const isContainerProfile=String(log.type||'').toUpperCase()==='FCL'||String(log.unit||'').toLowerCase()==='container';
  const containerCapacityCbm=isContainerProfile?num(log.capacityCbm,68):0;
  const containerType=isContainerProfile?(log.containerType||'40HQ'):'';
  const containersRequired=containerCapacityCbm>0&&cbm>0?Math.max(1,Math.ceil(cbm/containerCapacityCbm)):0;
  const totalContainerCapacity=containersRequired*containerCapacityCbm;
  const containerUtilizationPct=totalContainerCapacity>0?(cbm/totalContainerCapacity)*100:0;
  const containerRemainingCbm=totalContainerCapacity>0?Math.max(0,totalContainerCapacity-cbm):0;
  const exceedsSingleContainer=containerCapacityCbm>0&&cbm>containerCapacityCbm;
  return {fob,declaredFob,declaredFactor,cbm,kg,volumetricKg,chargeableKg,weightDivisor,insurance,agentCommissionTotal,cif,dutyBase,vatBase,...totals,customsRecoverable,servicesVatRecoverable,totalRecoverable,normalTaxesTotal,taxSavings,taxMode,itemTaxes,itemLandedCosts,honorariaApplies,honorariaBasePct,honorariaRatePct,honorariaTaxBase:taxSavings,honoraria,realRecovery,logisticsLines:computedLines,logisticsNet,logisticsVat,logisticsTotal,logisticsAllInPerCbm,logisticsAllInPerKg,containerType,containerCapacityCbm,containersRequired,totalContainerCapacity,containerUtilizationPct,containerRemainingCbm,exceedsSingleContainer,totalToPay,landedCost,netCost};
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
      'courier': { name:'Courier', type:'COURIER', route:'China → Argentina', unit:'KG', lines:[
        {code:'freight',name:'Courier base + KG',basis:'base_plus_kg',baseAmount:112,ratePerKg:16,amount:112}
      ]},
      'courier-hk': { name:'Courier HK', type:'COURIER', route:'Hong Kong → Argentina', unit:'KG', lines:[
        {code:'freight',name:'Courier HK base + KG',basis:'base_plus_kg',baseAmount:112,ratePerKg:18,amount:112},
        {code:'lithium_gt_100wh',name:'Lithium battery with capacity > 100 Wh',basis:'conditional_kg',amount:32,optional:true}
      ]},
      'solo-fiscal': { name:'Solo Fiscal', type:'FISCAL', route:'Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:150},{code:'decon',name:'Desconsolidación',basis:'cbm',amount:20},{code:'fiscal',name:'Depósito fiscal',basis:'fixed',amount:0},{code:'verify',name:'Verificación',basis:'fixed',amount:0}
      ]}
    };
    for (const [pid,p] of Object.entries(profiles)) await createIfMissing('logisticsProfiles',pid,{...p,active:true});
    // Migración segura del Courier HK seed viejo: solo se actualiza si conserva exactamente
    // la estructura default anterior. Perfiles personalizados no se pisan.
    try {
      const hkRef=col(tid,'logisticsProfiles').doc('courier-hk');
      const hkSnap=await hkRef.get();
      if(hkSnap.exists){
        const hk=hkSnap.data()||{}; const lines=Array.isArray(hk.lines)?hk.lines:[];
        const legacy=lines.length===4 && lines[0]?.code==='freight' && lines[0]?.basis==='kg' && num(lines[0]?.amount)===18 && lines[1]?.code==='handling' && num(lines[1]?.amount)===50 && lines[2]?.code==='export' && num(lines[2]?.amount)===110 && lines[3]?.code==='clearance' && num(lines[3]?.amount)===120;
        if(legacy) await hkRef.set({lines:profiles['courier-hk'].lines,updatedAt:now(),formulaVersion:2},{merge:true});
      }
    } catch(e){ console.warn('Courier HK profile migration skipped:',e.message); }
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
  app.post(`/api/${entity}`, async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const requestedId=entity==='products'?'':req.body.id;const docId=safeDocId(requestedId,entity.slice(0,3));const ref=col(tid,entity).doc(docId);const payload={...req.body};delete payload.id;delete payload.tenantId;if(entity==='products')delete payload.logisticsProfileId;await ref.set({...payload,createdAt:now(),updatedAt:now(),...(entity==='products'?{logisticsProfileId:FieldValue.delete()}:{})},{merge:true});res.json({ok:true,id:ref.id});}catch(e){next(e)}});
  app.put(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);const payload={...req.body};delete payload.id;delete payload.tenantId;if(entity==='products')delete payload.logisticsProfileId;await col(tid,entity).doc(req.params.id).set({...payload,updatedAt:now(),...(entity==='products'?{logisticsProfileId:FieldValue.delete()}:{})},{merge:true});res.json({ok:true});}catch(e){next(e)}});
  app.delete(`/api/${entity}/:id`, async (req,res,next)=>{try{const tid=tenantId(req);await col(tid,entity).doc(req.params.id).delete();res.json({ok:true});}catch(e){next(e)}});
}

app.post('/api/products/import', upload.single('file'), async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); if(!req.file) return res.status(400).json({error:'Archivo requerido'});
  const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
  const existingSnap=await col(tid,'products').limit(1000).get();
  const existingBySku=new Map(existingSnap.docs.map(d=>[String(d.data()?.sku||'').trim().toLowerCase(),d]));
  const supplierSnap=await col(tid,'suppliers').limit(500).get();
  const supplierLookup=new Map();
  supplierSnap.docs.forEach(d=>{const x=d.data()||{};[x.publicAlias,x.name,d.id].filter(Boolean).forEach(v=>supplierLookup.set(String(v).trim().toLowerCase(),d.id));});
  const groups=new Map(); const errors=[];
  rows.forEach((row,i)=>{
    const sku=String(row.SKU||row.sku||row.Codigo||row.Código||'').trim();
    const name=String(row.Producto||row.producto||row.Nombre||row.nombre||'').trim();
    if(!sku||!name){errors.push({row:i+2,error:'SKU y Producto son obligatorios'});return;}
    const key=sku.toLowerCase(); if(!groups.has(key))groups.set(key,{sku,name,rows:[]}); groups.get(key).rows.push({row,rowNo:i+2});
  });
  let imported=0,variants=0; const batchSize=350; const entries=[...groups.values()];
  for(let start=0;start<entries.length;start+=batchSize){
    const batch=firestore.batch();
    for(const g of entries.slice(start,start+batchSize)){
      const first=g.rows[0].row; const existing=existingBySku.get(g.sku.toLowerCase()); const ref=existing?existing.ref:col(tid,'products').doc(id('prd'));
      const prices=g.rows.map(({row},idx)=>{
        const supplierText=String(row.Proveedor||row.proveedor||row.Supplier||row.supplier||'').trim();
        const listName=String(row.Lista||row.lista||row.Variante||row.variante||row.Condicion||row['Condición']||row['Lista de precio']||row['Lista de precios']||'').trim() || (g.rows.length>1?`Variante ${idx+1}`:'Standard');
        return {id:`pr_${Date.now()}_${start}_${idx}_${crypto.randomBytes(2).toString('hex')}`,listName,supplierId:supplierLookup.get(supplierText.toLowerCase())||'',currency:String(row.Moneda||row.moneda||row.Currency||'USD').trim()||'USD',price:num(row.FOB||row['FOB (USD)']||row.Precio||row.precio),moq:num(row.MOQ||row.moq),validFrom:String(row.Desde||row['Vigencia desde']||'').trim(),validTo:String(row.Hasta||row['Vigencia hasta']||'').trim(),notes:String(row.Notas||row.Observaciones||row['Condición comercial']||'').trim(),isDefault:idx===0};
      });
      const defaultPrice=prices[0]; variants+=prices.length;
      const supplierIds=[...new Set(prices.map(x=>x.supplierId).filter(Boolean))];
      batch.set(ref,{sku:g.sku,name:g.name,description:first.Descripcion||first.Descripción||'',category:first.Categoria||first.Categoría||'',fob:num(defaultPrice?.price),cbm:num(first.CBM),kg:num(first.KG||first.Peso),moq:num(defaultPrice?.moq||first.MOQ),agentCommissionPct:num(first.ComisionAgenteCompra||first['Comisión agente compra']||first['Comision agente compra']||first.AgentCommissionPct||first['Comisión compra']||0),taxProfileId:first.PerfilImpositivo||first['Perfil impositivo']||'general',productUse:String(first.Uso||first['Tipo uso']||first.TipoUso||'commercial').toLowerCase().replace(/ /g,'_'),imageUrl:first.Imagen||first.Image||first.image_url||'',supplierIds,prices,logisticsProfileId:FieldValue.delete(),active:String(first.Estado||'Activo').toLowerCase()!=='inactivo',createdAt:existing?(existing.data()?.createdAt||now()):now(),updatedAt:now()},{merge:true}); imported++;
    }
    await batch.commit();
  }
  res.json({ok:true,processed:rows.length,products:imported,priceVariants:variants,imported,errors,message:`${imported} productos · ${variants} precios/variantes`});
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
    const ids=[...new Set(body.items.map(i=>i.taxProfileId).filter(pid=>pid&&!isManualTaxId(pid)))]; const map={};
    await Promise.all(ids.map(async pid=>{const s=await col(tid,'taxProfiles').doc(pid).get();if(s.exists)map[pid]=s.data();}));
    body.items=body.items.map(i=>({...i,taxProfile:isManualTaxId(i.taxProfileId)?(i.taxProfile||{}):(map[i.taxProfileId]||i.taxProfile||body.taxProfile||{})}));
  }
  res.json(calculateQuote(body));
}catch(e){next(e)}});
app.post('/api/quotes', async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); const body={...req.body}; const taxSnap=(body.taxProfileId&&!isManualTaxId(body.taxProfileId))?await col(tid,'taxProfiles').doc(body.taxProfileId).get():null; const logSnap=body.logisticsProfileId?await col(tid,'logisticsProfiles').doc(body.logisticsProfileId).get():null; body.taxProfile=isManualTaxId(body.taxProfileId)?(body.taxProfile||{}):(taxSnap?.exists?taxSnap.data():(body.taxProfile||{})); body.logisticsProfile=logSnap?.exists?logSnap.data():(body.logisticsProfile||{});
  if(body.taxMode==='product'&&Array.isArray(body.items)){const ids=[...new Set(body.items.map(i=>i.taxProfileId).filter(pid=>pid&&!isManualTaxId(pid)))],map={};await Promise.all(ids.map(async pid=>{const s=await col(tid,'taxProfiles').doc(pid).get();if(s.exists)map[pid]=s.data();}));body.items=body.items.map(i=>({...i,taxProfile:isManualTaxId(i.taxProfileId)?(i.taxProfile||{}):(map[i.taxProfileId]||i.taxProfile||body.taxProfile||{})}));}
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
  const isProduct=(q.mode||tenant.module||'product')==='product' || tenant.module==='products';
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
  const tag=(x,y,text,color=C.green,bg=C.greenSoft,w=null)=>{const tw=Math.ceil(doc.widthOfString(text,{fontSize:8.4}))+18; const ww=w||tw; box(x,y,ww,20,bg,color,10); doc.fillColor(color).font('Helvetica-Bold').fontSize(8.4).text(text,x+8,y+6,{width:ww-16,height:10,ellipsis:true,lineBreak:false,align:'center'});};
  const kv=(x,y,label,value,{labelW=78,valueW=150,bold=false,valueColor='#111',fs=9.2,align='right'}={})=>{doc.fillColor(C.muted).font('Helvetica').fontSize(fs-0.3).text(label,x,y,{width:labelW}); doc.fillColor(valueColor).font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs).text(value,x+labelW+4,y,{width:valueW,align}); doc.font('Helvetica');};
  const amountRow=(x,y,w,label,val,{color='#111',fs=9,bold=false,valPrefix=''}={})=>{const labelW=w-108; const h=Math.max(16,doc.heightOfString(label,{width:labelW,fontSize:fs})+2); doc.fillColor('#33414e').font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs).text(label,x,y,{width:labelW}); doc.fillColor(color).font('Helvetica-Bold').text(`${valPrefix}${money(val)}`,x+labelW+8,y,{width:100,align:'right'}); doc.font('Helvetica'); return h;};
  const newPage=()=>{doc.addPage({size:'A4',margin:30}); return drawHeader();};
  const ensure=(y,needed)=> y+needed>B ? newPage() : y;

  function drawHeader(){
    if(logoPath && fs.existsSync(logoPath)) { try { doc.image(logoPath,L,T-2,{fit:[265,86]}); } catch {} }
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(20).text(isProduct?'Cotización de Productos':'Cotización Logística',L,116);
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(isProduct?'Estimación de importación y costo puesto en Argentina':'Estimación logística y costos operativos',L,141);
    line(L,162,L+44,C.green,3); line(L+48,162,L+76,C.orange,3);

    const hx=R-205, hy=T+4, hw=205, hh=144;
    box(hx,hy,hw,hh,'#fff',C.line,14);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(10.2).text('Detalle de cotización',hx+14,hy+12);
    line(hx+14,hy+29,hx+hw-14,C.line);
    kv(hx+14,hy+39,'Cotización N°',safe(q.quoteNo),{labelW:76,valueW:100,bold:true,valueColor:C.header,fs:8.6});
    kv(hx+14,hy+57,'Fecha',new Date().toLocaleDateString('es-AR'),{labelW:76,valueW:100,bold:true,fs:8.6});
    kv(hx+14,hy+75,'Validez','7 días',{labelW:76,valueW:100,bold:true,fs:8.6,valueColor:C.header});
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.3).text('Comercial',hx+14,hy+93,{width:76});
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.1).text(safe(q.salesRep||tenant.name||'MRAPI Quotes'),hx+90,hy+92,{width:101,align:'right'});
    kv(hx+14,hy+108,'Moneda','USD',{labelW:76,valueW:100,bold:true,fs:8.6,valueColor:C.header});
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.6).text(isProduct?'Producto / Ref.':'Ítem / Referencia',hx+14,hy+126,{width:76,height:10,lineBreak:false});
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.9).text(safe(q.reference,'-'),hx+94,hy+126,{width:96,height:10,ellipsis:true,lineBreak:false,align:'right'});
    doc.font('Helvetica');
    return 196;
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
  kv(L+274,y+74,'Perfil imp.',isProduct?safe(q.taxProfileSnapshot?.name,'General'):'Por ítem de mercadería',{labelW:62,valueW:170,fs:8.9,align:'left'});
  tag(L+14,y+98,`Operación: ${safe(logisticsProfileName)}`,C.green,C.greenSoft,250);
  tag(L+276,y+98,isProduct?`Modalidad: ${c.taxMode==='product'?'Por producto':'Por envío'}`:'Impuestos: Por ítem',C.orange,C.orangeSoft,170);
  if(hasConsolidadoBadge) tag(L + Math.round((W-160)/2),y+122,'Incluye Gastos a FOB',C.green,C.greenSoft,160);
  if(hasFobBadge) tag(L + Math.round((W-160)/2),y+122,'FOB sin gastos a FOB',C.orange,C.orangeSoft,160);
  y += generalH + 10;

  if(isProduct && (q.items||[]).length){
    y=ensure(y,96);
    const cols=[58,166,78,84,55,94];
    const heads=['SKU','Producto','Uso','FOB total','CBM','Comisión'];
    const drawQuotedProductsHeader=(continued=false)=>{
      tag(L,y,continued?'PRODUCTOS COTIZADOS · CONT.':'PRODUCTOS COTIZADOS',C.header,C.soft,continued?175:138); y+=28;
      box(L,y,W,24,C.header,C.header,8); let hx=L;
      heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.1).text(h,hx+7,y+8,{width:cols[i]-14,height:10,lineBreak:false,align:i>=3?'right':'left'}); hx+=cols[i];});
      y+=26;
    };
    drawQuotedProductsHeader(false);
    (q.items||[]).forEach((it,idx)=>{
      const qty=num(it.qty,1), fobTot=num(it.unitFob)*qty, cbmTot=num(it.unitCbm)*qty, com=fobTot*num(it.agentCommissionPct)/100;
      const priceMeta=[it.priceListName,it.supplierAlias].filter(Boolean).join(' · ');
      const vals=[safe(it.sku),`${safe(it.name)} x${qty}${priceMeta?`\n${safe(priceMeta)}`:''}`,useLabel(it.productUse),money(fobTot),Number(cbmTot).toFixed(3),`${num(it.agentCommissionPct).toFixed(1)}% · ${money(com)}`];
      doc.font('Helvetica-Bold').fontSize(8);
      const productTextH=doc.heightOfString(vals[1],{width:cols[1]-14});
      const rowH=Math.max(26,Math.ceil(productTextH)+14);
      if(y+rowH+8>B){ y=newPage(); drawQuotedProductsHeader(true); }
      if(idx%2===0) box(L,y,W,rowH,C.row,'#ECF1F4',6);
      let cx=L;
      vals.forEach((v,i)=>{doc.fillColor(i===1?C.header:'#243341').font(i===1?'Helvetica-Bold':'Helvetica').fontSize(8).text(v,cx+7,y+7,{width:cols[i]-14,height:rowH-12,ellipsis:true,align:i>=3?'right':'left'}); cx+=cols[i];});
      y += rowH+2;
    });
    if(y+38>B) y=newPage();
    box(L,y,W,28,C.greenSoft,'#AFD8A4',8);
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(9).text(`FOB total: ${money(c.fob)}`,L+12,y+9,{width:175,height:11,lineBreak:false});
    doc.fillColor(C.orange).text(`CBM total: ${Number(c.cbm||0).toFixed(3)}`,L+195,y+9,{width:125,height:11,lineBreak:false});
    doc.fillColor(C.greenDark).text(`Comisión de compra: ${money(c.agentCommissionTotal)}`,L+338,y+9,{width:185,height:11,lineBreak:false,align:'right'});
    y += 38;
  } else if(!isProduct && (q.items||[]).length){
    y=ensure(y,110);
    const cols=[178,72,74,60,72,79];
    const heads=['Ítem','Uso','FOB total','CBM','KG','Perfil imp.'];
    const drawGoodsHeader=(continued=false)=>{
      tag(L,y,continued?'ÍTEMS DE MERCADERÍA · CONT.':'ÍTEMS DE MERCADERÍA',C.header,C.soft,continued?180:142); y+=28;
      box(L,y,W,24,C.header,C.header,8); let hx=L;
      heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.0).text(h,hx+7,y+8,{width:cols[i]-14,height:10,lineBreak:false,align:i>=2?'right':'left'});hx+=cols[i];});
      y+=26;
    };
    drawGoodsHeader(false);
    for(const [idx,it] of (q.items||[]).entries()){
      const qty=num(it.qty,1), fobTot=num(it.unitFob)*qty, cbmTot=num(it.unitCbm)*qty, kgTot=num(it.unitKg)*qty;
      const vals=[`${safe(it.name)} x${qty}`,useLabel(it.productUse),money(fobTot),Number(cbmTot).toFixed(3),Number(kgTot).toFixed(2),safe(it.taxProfileId,'general')];
      doc.font('Helvetica-Bold').fontSize(8);
      const itemTextH=doc.heightOfString(vals[0],{width:cols[0]-14});
      const rowH=Math.max(26,Math.ceil(itemTextH)+14);
      if(y+rowH+8>B){ y=newPage(); drawGoodsHeader(true); }
      if(idx%2===0) box(L,y,W,rowH,C.row,'#ECF1F4',6);
      let cx=L;
      vals.forEach((v,i)=>{doc.fillColor(i===0?C.header:'#243341').font(i===0?'Helvetica-Bold':'Helvetica').fontSize(8.0).text(v,cx+7,y+7,{width:cols[i]-14,height:rowH-12,ellipsis:true,align:i>=2?'right':'left'});cx+=cols[i];});
      y+=rowH+2;
    }
    if(y+38>B) y=newPage();
    box(L,y,W,28,C.greenSoft,'#AFD8A4',8);
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(9).text(`FOB mercadería: ${money(c.fob)}`,L+12,y+9,{width:190,height:11,lineBreak:false});
    doc.fillColor(C.orange).text(`CBM total: ${Number(c.cbm||0).toFixed(3)}`,L+220,y+9,{width:130,height:11,lineBreak:false});
    doc.fillColor(C.header).text(`KG total: ${Number(c.kg||0).toFixed(2)}`,L+390,y+9,{width:130,height:11,lineBreak:false,align:'right'});
    y+=38;
  }

  if(!isProduct && c.weightDivisor){
    y=ensure(y,54);
    box(L,y,W,44,C.soft,C.line,10);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(9).text(`Peso real: ${Number(c.kg||0).toFixed(2)} KG`,L+12,y+10);
    doc.fillColor(C.header).text(`Volumétrico /${Number(c.weightDivisor)}: ${Number(c.volumetricKg||0).toFixed(2)} KG`,L+190,y+10);
    doc.fillColor(C.greenDark).text(`KG cobrable: ${Number(c.chargeableKg||0).toFixed(2)} KG`,L+380,y+10);
    y+=54;
  }

  const costRows=[
    {label:'FOB mercadería',net:c.fob,total:c.fob},
    ...(isProduct?[{label:'Comisión agente de compra',net:c.agentCommissionTotal,total:c.agentCommissionTotal}]:[]),
    ...(c.logisticsLines||[]).map(l=>({
      label:`${l.name}${l.vatTreatment==='plus_vat'?' (+ IVA 21%)':l.vatTreatment==='included_vat'?' (IVA incluido)':''}`,
      net:num(l.netAmount),
      total:num(l.total)
    })),
    {label:'Seguro internacional',net:c.insurance,total:c.insurance}
  ];
  const conceptW=W-226, netW=96, totalW=102;
  // Measure every row before drawing. This prevents the next section from ever
  // starting on top of a wrapped logistics concept or summary line.
  doc.font('Helvetica').fontSize(8.8);
  const measuredCostRows=costRows.map(r=>({
    ...r,
    h:Math.max(18,Math.ceil(doc.heightOfString(r.label,{width:conceptW-8}))+2)
  }));
  const summaryLabels=[
    'Base CIF',
    'Logística neta (sin IVA)',
    'IVA servicios logísticos',
    'Total costos logísticos (con IVA)',
    c.weightDivisor?'Logística all-in real por KG':'Logística all-in real por m³'
  ];
  doc.font('Helvetica-Bold').fontSize(9.2);
  const summaryHeights=summaryLabels.map(label=>Math.max(16,Math.ceil(doc.heightOfString(label,{width:(W-28)-108}))+2));
  const rowsHeight=measuredCostRows.reduce((a,r)=>a+r.h+6,0);
  const summariesHeight=summaryHeights.reduce((a,h)=>a+h+4,0);
  const containerHeight=c.containerCapacityCbm?48:0;
  const costH=12+30+rowsHeight+9+summariesHeight+5+containerHeight+12;
  const fullCostSectionH=36+costH+10;
  y=ensure(y,fullCostSectionH);
  box(L,y,W,28,C.greenSoft,'#AFD8A4',10);
  doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.8).text('Costos logísticos y base imponible',L+12,y+9);
  y += 36;
  box(L,y,W,costH,'#fff',C.line,12);
  let cy=y+12;
  box(L+14,cy,W-28,24,C.soft,'#E9EFF4',8);
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.8).text('Concepto',L+22,cy+8,{width:conceptW-12,height:10,lineBreak:false});
  doc.text('Neto sin IVA',L+14+conceptW,cy+8,{width:netW,height:10,lineBreak:false,align:'right'});
  doc.text('Total c/ IVA',L+14+conceptW+netW+10,cy+8,{width:totalW,height:10,lineBreak:false,align:'right'});
  cy += 30;
  for(const r of measuredCostRows){
    doc.fillColor('#33414e').font('Helvetica').fontSize(8.8).text(r.label,L+18,cy,{width:conceptW-8,height:r.h,ellipsis:true});
    doc.fillColor(C.header).font('Helvetica-Bold').text(money(r.net),L+14+conceptW,cy,{width:netW,height:r.h,align:'right'});
    doc.fillColor(C.header).font('Helvetica-Bold').text(money(r.total),L+14+conceptW+netW+10,cy,{width:totalW,height:r.h,align:'right'});
    cy += r.h + 6;
  }
  line(L+14,cy,R-14,C.green); cy += 9;
  cy += amountRow(L+14,cy,W-28,'Base CIF',c.cif,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'Logística neta (sin IVA)',c.logisticsNet,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'IVA servicios logísticos',c.logisticsVat,{color:C.orange,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,'Total costos logísticos (con IVA)',c.logisticsTotal,{color:C.greenDark,fs:9.2,bold:true})+4;
  cy += amountRow(L+14,cy,W-28,c.weightDivisor?'Logística all-in real por KG':'Logística all-in real por m³',c.weightDivisor?c.logisticsAllInPerKg:c.logisticsAllInPerCbm,{color:C.greenDark,fs:9.2,bold:true})+5;
  if(c.containerCapacityCbm){
    box(L+14,cy,W-28,40,C.greenSoft,'#AFD8A4',10);
    doc.fillColor(C.header).font('Helvetica-Bold').fontSize(9.1).text(`${safe(c.containerType,'Contenedor')} · ${Number(c.cbm||0).toFixed(2)} / ${Number(c.totalContainerCapacity||c.containerCapacityCbm).toFixed(2)} m³`,L+24,cy+10,{width:310,height:11,ellipsis:true,lineBreak:false});
    doc.fillColor(C.greenDark).text(`${Number(c.containerUtilizationPct||0).toFixed(1)}% ocupado`,R-144,cy+10,{width:112,height:11,lineBreak:false,align:'right'});
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.2).text(c.containersRequired>1?`${c.containersRequired} contenedores requeridos`:`Espacio disponible: ${Number(c.containerRemainingCbm||0).toFixed(2)} m³`,L+24,cy+24,{width:300,height:10,ellipsis:true,lineBreak:false});
    cy += 48;
  }
  // Advance from what was actually drawn, never from an estimate.
  y = cy + 12;

  const gap=12, half=(W-gap)/2;
  const taxRows=[['Derechos',c.duty],['IVA',c.vat],['IVA adicional',c.vatAdditional],['Ganancia',c.earnings],['IIBB',c.iibb],['Tasa estadística',c.statisticalFee]];
  const recoveryRows=[['Recupero IVA',c.vat],['Recupero IVA adicional',c.vatAdditional],['Recupero Ganancia',c.earnings],['Recupero IIBB',c.iibb],['Recupero IVA servicios',c.servicesVatRecoverable]];
  doc.font('Helvetica').fontSize(8.7);
  const leftRowHs=taxRows.map(([lab])=>Math.max(16,Math.ceil(doc.heightOfString(lab,{width:(half-24)-108}))+2));
  const rightRowHs=recoveryRows.map(([lab])=>Math.max(16,Math.ceil(doc.heightOfString(lab,{width:(half-24)-108}))+2));
  const taxBodyH=Math.max(
    leftRowHs.reduce((a,h)=>a+h+1,0),
    rightRowHs.reduce((a,h)=>a+h+1,0)
  );
  const taxBoxH=36+taxBodyH+9+20+12;
  y=ensure(y,taxBoxH+12);
  box(L,y,half,taxBoxH,C.orangeSoft,'#F2C48A',12);
  box(L+half+gap,y,half,taxBoxH,C.greenSoft,'#AFD8A4',12);
  doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text('Derechos e impuestos',L+12,y+12,{width:half-24,height:14,lineBreak:false});
  doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.8).text('Recupero de impuestos (detallado)',L+half+gap+12,y+12,{width:half-24,height:14,ellipsis:true,lineBreak:false});
  let ty=y+36;
  taxRows.forEach(([lab,val])=>{ ty += amountRow(L+12,ty,half-24,lab,val,{fs:8.7})+1; });
  let ry=y+36;
  recoveryRows.forEach(([lab,val])=>{ ry += amountRow(L+half+gap+12,ry,half-24,lab,val,{fs:8.7,color:C.greenDark})+1; });
  const totalY=y+36+taxBodyH+7;
  line(L+12,totalY,L+half-12,C.orange);
  amountRow(L+12,totalY+5,half-24,'Total impuestos',c.taxesTotal,{color:C.orange,fs:9.2,bold:true});
  line(L+half+gap+12,totalY,R-12,C.green);
  amountRow(L+half+gap+12,totalY+5,half-24,'Recupero total',c.totalRecoverable,{color:C.greenDark,fs:9.2,bold:true});
  y += taxBoxH + 12;

  // v34: landed cost cards for ALL quoted products, with real pagination.
  if(isProduct && (c.itemLandedCosts||[]).length){
    const shown=(c.itemLandedCosts||[]);
    const innerX=L+14, innerW=W-28;
    const widths=[118,78,70,72,82,87]; // total 507
    const labels=['Producto','Costo prod.','Logística','Impuestos','Bruto total','Recuperos'];
    const colors=[C.muted,C.muted,C.muted,C.muted,C.orange,C.greenDark];

    const drawLandedHeader=()=>{
      y=ensure(y,102);
      box(L,y,W,92,'#fff',C.line,14);
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(11.5).text('Costo final por producto puesto en Argentina',L+14,y+14);
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.1).text(
        'Primero se muestra cuánto dinero total debe desembolsar el cliente por cada ítem. Luego se descuentan los recuperos para estimar el costo neto final.',
        L+14,y+32,{width:W-28}
      );
      const tableY=y+60;
      box(innerX,tableY,innerW,26,C.soft,'#E9EFF4',8);
      let hx=innerX;
      labels.forEach((label,i)=>{doc.fillColor(colors[i]).font('Helvetica-Bold').fontSize(7.3).text(label,hx+6,tableY+9,{width:widths[i]-12,align:i===0?'left':'right'}); hx += widths[i];});
      y=tableY+32;
    };

    drawLandedHeader();
    let grossSubtotal=0, recoveriesSubtotal=0, netSubtotal=0;

    shown.forEach((it,idx)=>{
      // Reserve room for the complete item card. If it does not fit, start a new page
      // and repeat the section/column header so no products disappear.
      const qty=Math.max(1,num(it.qty,1));
      doc.font('Helvetica-Bold').fontSize(8.5);
      const itemNameH=Math.max(11,Math.ceil(doc.heightOfString(safe(it.name||it.sku),{width:widths[0]-16})));
      const topAreaH=Math.max(44,10+itemNameH+14);
      const cardH=topAreaH+30+33+10;
      const before=y;
      y=ensure(y,cardH+18);
      if(y < before){ drawLandedHeader(); }
      const py=y;
      const productCost=num(it.itemFob)+num(it.agentCommissionAmount)+num(it.honorariaAmount);
      const deduction=num(it.recoverableAmount)+num(it.servicesVatShare);
      const grossUnit=num(it.grossArgentinaTotal)/qty;
      const netUnit=num(it.netArgentinaTotal)/qty;
      grossSubtotal += num(it.grossArgentinaTotal);
      recoveriesSubtotal += deduction;
      netSubtotal += num(it.netArgentinaTotal);

      box(innerX,py,innerW,cardH,'#fff','#E5EDF2',10);
      let cx=innerX;
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(8.5).text(safe(it.name||it.sku),cx+8,py+9,{width:widths[0]-16,height:itemNameH,ellipsis:true});
      doc.fillColor(C.muted).font('Helvetica').fontSize(7.1).text(`${Number(it.itemCbm||0).toFixed(3)} m³ · x${qty}`,cx+8,py+11+itemNameH,{width:widths[0]-16,height:10,lineBreak:false});
      cx += widths[0];
      doc.fillColor('#243341').font('Helvetica').fontSize(8.0).text(money(productCost),cx+4,py+12,{width:widths[1]-8,align:'right'}); cx += widths[1];
      doc.text(money(it.logisticsAmount),cx+4,py+12,{width:widths[2]-8,align:'right'}); cx += widths[2];
      doc.text(money(it.taxAmount),cx+4,py+12,{width:widths[3]-8,align:'right'}); cx += widths[3];
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(8.4).text(money(it.grossArgentinaTotal),cx+4,py+10,{width:widths[4]-8,align:'right'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(6.9).text(`Total del ítem`,cx+4,py+26,{width:widths[4]-8,align:'right'}); cx += widths[4];
      doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(8.1).text(`- ${money(deduction)}`,cx+4,py+12,{width:widths[5]-8,align:'right'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(6.9).text(`Descuentos`,cx+4,py+26,{width:widths[5]-8,align:'right'});

      const strip1Y=py+topAreaH;
      box(innerX+8,strip1Y,innerW-16,25,C.orangeSoft,'#F2C48A',9);
      doc.fillColor(C.header).font('Helvetica-Bold').fontSize(7.6).text('COSTO TOTAL DEL ÍTEM',innerX+18,strip1Y+8,{width:130});
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(12.8).text(money(it.grossArgentinaTotal),innerX+162,strip1Y+5,{width:145,align:'left'});
      doc.fillColor(C.muted).font('Helvetica').fontSize(7.1).text('Unitario bruto',innerX+336,strip1Y+8,{width:72,align:'right'});
      doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text(money(grossUnit),innerX+416,strip1Y+5,{width:74,align:'right'});

      const strip2Y=strip1Y+30;
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

      y = py + cardH + 8;
    });

    // Totals are calculated over ALL quoted items, not only the first page.
    y=ensure(y,112);
    box(innerX,y+4,innerW,78,C.soft,'#D9E3EA',10);
    const sumX=innerX+14, sumW=innerW-28, valueW=155;
    const sumRows=[
      ['Subtotal bruto total',grossSubtotal,C.header,false],
      ['Recuperos totales',recoveriesSubtotal,C.greenDark,true],
      ['Subtotal neto final',netSubtotal,C.greenDark,false]
    ];
    let sy=y+15;
    sumRows.forEach(([label,value,color,negative],idx)=>{
      doc.fillColor(idx===2?C.header:color).font('Helvetica-Bold').fontSize(idx===2?9.6:8.8).text(label,sumX,sy,{width:sumW-valueW-10,height:13,lineBreak:false});
      doc.fillColor(color).font('Helvetica-Bold').fontSize(idx===2?12.2:10.2).text(`${negative?'- ':''}${money(value)}`,sumX+sumW-valueW,sy-2,{width:valueW,align:'right',height:15,lineBreak:false});
      if(idx<2) line(sumX,sy+17,sumX+sumW,C.line,0.6);
      sy+=22;
    });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.8).text(c.weightDivisor?`Logística all-in por KG cobrable: ${money(c.logisticsAllInPerKg)} / KG.`:`Logística all-in distribuida proporcionalmente por m³: ${money(c.logisticsAllInPerCbm)} / m³.`,innerX,y+90,{width:innerW,height:11,ellipsis:true,lineBreak:false});
    y += 106;
  }

  if(c.honorariaApplies){
    y=ensure(y,102);
    box(L,y,W,90,C.orangeSoft,'#F2C48A',12);
    doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(10.8).text('Honorarios del envío',L+12,y+12);
    doc.fillColor('#36424f').font('Helvetica').fontSize(8.8).text(`Impuestos normales (100%): ${money(c.normalTaxesTotal)}`,L+12,y+35);
    doc.text(`Impuestos declarados (${c.honorariaBasePct}%): ${money(c.taxesTotal)}`,L+210,y+35);
    doc.fillColor(C.greenDark).text(`Ahorro impositivo: ${money(c.taxSavings)}`,L+12,y+52);
    doc.fillColor(C.orange).font('Helvetica-Bold').text(`Honorarios: ${money(c.honoraria)}`,R-170,y+52,{width:140,align:'right'});
    doc.fillColor(C.greenDark).font('Helvetica-Bold').fontSize(10.2).text(`Recupero real: ${money(c.realRecovery)}`,L+12,y+69,{width:W-24});
    y += 102;
  }

  y=ensure(y,142);
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

  doc.fillColor(C.muted).font('Helvetica').fontSize(7.7).text('• En operaciones FCL + Consolidado se consideran Gastos a FOB. En FCL FOB, ese concepto no aplica.',L,y,{width:W,height:12});
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
