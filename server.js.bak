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

function calculateQuote(input) {
  const fob = num(input.fob);
  const cbm = num(input.cbm);
  const kg = num(input.kg);
  const tax = input.taxProfile || {};
  const log = input.logisticsProfile || {};
  const insurancePct = num(input.insurancePct, num(log.insurancePct, 0));
  const insurance = input.insuranceAmount != null ? num(input.insuranceAmount) : fob * insurancePct / 100;

  const logisticsLines = Array.isArray(log.lines) ? log.lines : [];
  const computedLines = logisticsLines.map(line => {
    const basis = line.basis || 'fixed';
    const unit = num(line.amount);
    let qty = 1;
    if (basis === 'cbm') qty = cbm;
    if (basis === 'kg') qty = kg;
    if (basis === 'percent_fob') qty = fob / 100;
    return { ...line, qty, total: unit * qty };
  });
  const logisticsTotal = computedLines.reduce((a,b)=>a+num(b.total),0);
  const internationalFreight = computedLines.filter(x=>['freight','flete','flete internacional','flete marítimo','flete maritimo','flete aéreo','flete aereo'].includes(String(x.code||x.name||'').toLowerCase())).reduce((a,b)=>a+num(b.total),0);
  const cif = fob + internationalFreight + insurance;
  const statBase = cif;
  const dutyBase = cif + (cif * num(tax.statisticalFee)/100);
  const duty = dutyBase * num(tax.duty)/100;
  const vatBase = dutyBase + duty;
  const vat = vatBase * num(tax.vat)/100;
  const vatAdditional = vatBase * num(tax.vatAdditional)/100;
  const earnings = vatBase * num(tax.earnings)/100;
  const iibb = vatBase * num(tax.iibb)/100;
  const statisticalFee = statBase * num(tax.statisticalFee)/100;
  const taxesTotal = duty + vat + vatAdditional + earnings + iibb + statisticalFee;
  const honoraria = tax.honorariaApplies ? (tax.honorariaType === 'percent' ? vatBase * num(tax.honorariaValue)/100 : num(tax.honorariaValue)) : 0;
  const recoverable = vat + vatAdditional + earnings + iibb;
  const totalToPay = taxesTotal + logisticsTotal + honoraria;
  const landedCost = fob + totalToPay;
  const netCost = landedCost - recoverable;
  return { fob, cbm, kg, insurance, cif, dutyBase, vatBase, duty, vat, vatAdditional, earnings, iibb, statisticalFee, taxesTotal, honoraria, logisticsLines: computedLines, logisticsTotal, recoverable, totalToPay, landedCost, netCost };
}

async function seedTenant(tid) {
  const ref = tdoc(tid);
  const snap = await ref.get();
  if (snap.exists) return;
  const isScb = tid === 'sentire-customs-broker';
  await ref.set({
    name: isScb ? 'Sentire Customs Broker' : 'Shenzhen Sentire Trading',
    module: isScb ? 'logistics' : 'products',
    logo: isScb ? '/assets/scb-logo.jpeg' : '/assets/shenzhen-logo.png',
    createdAt: now()
  });
  await col(tid,'taxProfiles').doc('general').set({
    name:'General', duty:18, vat:21, vatAdditional:20, earnings:6, iibb:3, statisticalFee:3,
    honorariaApplies:true, honorariaType:'fixed', honorariaValue:200, isDefault:true, active:true, updatedAt:now()
  });
  if (isScb) {
    const profiles = {
      'lcl-propio': { name:'LCL Propio', type:'LCL', route:'China → Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete marítimo',basis:'cbm',amount:400},{code:'fiscal',name:'Depósito fiscal / canal rojo / verificación',basis:'fixed',amount:500},{code:'delivery',name:'Entrega final',basis:'fixed',amount:0}
      ]},
      'lcl-fiscal': { name:'LCL Fiscal', type:'LCL', route:'China → Argentina', unit:'CBM', lines:[
        {code:'freight',name:'Flete internacional',basis:'cbm',amount:90},{code:'fiscal',name:'Depósito fiscal',basis:'fixed',amount:2500},{code:'fob',name:'Gastos a FOB',basis:'fixed',amount:800},{code:'clearance',name:'Honorarios despacho',basis:'fixed',amount:650}
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
    const ref=col(tid,'products').doc(sku.replace(/[\\/#?]/g,'-')); batch.set(ref,{sku,name,description:row.Descripcion||row.Descripción||'',category:row.Categoria||row.Categoría||'',fob:num(row.FOB||row['FOB (USD)']),cbm:num(row.CBM),kg:num(row.KG||row.Peso),moq:num(row.MOQ),taxProfileId:row.PerfilImpositivo||row['Perfil impositivo']||'general',logisticsProfileId:row.PerfilLogistico||row['Perfil logístico']||'',imageUrl:row.Imagen||row.Image||row.image_url||'',active:String(row.Estado||'Activo').toLowerCase()!=='inactivo',updatedAt:now()},{merge:true});ok++; }
    await batch.commit();
  }
  res.json({ok:true,processed:rows.length,imported:ok,errors});
}catch(e){next(e)}});

app.post('/api/products/:id/image', upload.single('image'), async (req,res,next)=>{try{
  const tid=tenantId(req); if(!req.file) return res.status(400).json({error:'Imagen requerida'}); const ext=path.extname(req.file.originalname)||'.jpg'; const object=`tenants/${tid}/products/${req.params.id}/${Date.now()}${ext}`; const bucket=storage.bucket(bucketName); const file=bucket.file(object); await file.save(req.file.buffer,{contentType:req.file.mimetype,resumable:false}); const imageUrl=`https://storage.googleapis.com/${bucketName}/${object}`; await col(tid,'products').doc(req.params.id).set({imageUrl,updatedAt:now()},{merge:true}); res.json({ok:true,imageUrl});
}catch(e){next(e)}});

app.post('/api/calculate', async (req,res,next)=>{try{res.json(calculateQuote(req.body));}catch(e){next(e)}});
app.post('/api/quotes', async (req,res,next)=>{try{
  const tid=tenantId(req); await seedTenant(tid); const body={...req.body}; const taxSnap=body.taxProfileId?await col(tid,'taxProfiles').doc(body.taxProfileId).get():null; const logSnap=body.logisticsProfileId?await col(tid,'logisticsProfiles').doc(body.logisticsProfileId).get():null; body.taxProfile=taxSnap?.exists?taxSnap.data():(body.taxProfile||{}); body.logisticsProfile=logSnap?.exists?logSnap.data():(body.logisticsProfile||{}); const calc=calculateQuote(body); const ref=col(tid,'quotes').doc(body.id||id('q')); const quoteNo=body.quoteNo||`MRQ-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`; await ref.set({...body,quoteNo,calculation:calc,taxProfileSnapshot:body.taxProfile,logisticsProfileSnapshot:body.logisticsProfile,status:body.status||'draft',createdAt:now(),updatedAt:now()}); res.json({ok:true,id:ref.id,quoteNo,calculation:calc});
}catch(e){next(e)}});
app.put('/api/quotes/:id', async (req,res,next)=>{try{const tid=tenantId(req);await col(tid,'quotes').doc(req.params.id).set({...req.body,updatedAt:now()},{merge:true});res.json({ok:true});}catch(e){next(e)}});
app.get('/api/quotes', async (req,res,next)=>{try{const tid=tenantId(req);await seedTenant(tid);const q=await col(tid,'quotes').orderBy('createdAt','desc').limit(200).get();res.json(q.docs.map(d=>({id:d.id,...d.data()})));}catch(e){next(e)}});
app.get('/api/quotes/:id/pdf', async (req,res,next)=>{try{
  const tid=tenantId(req); const snap=await col(tid,'quotes').doc(req.params.id).get(); if(!snap.exists)return res.status(404).send('No encontrada'); const q=snap.data(); const tenant=(await tdoc(tid).get()).data()||{}; const c=q.calculation||calculateQuote(q);
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${q.quoteNo||req.params.id}.pdf"`); const doc=new PDFDocument({margin:42}); doc.pipe(res); doc.fontSize(20).text(tenant.name||'MRAPI Quotes');doc.fontSize(10).fillColor('#666').text('Cotización / Preliminar de costos');doc.moveDown();doc.fillColor('#111').fontSize(11).text(`Proforma: ${q.quoteNo||'-'}`);doc.text(`Cliente: ${q.clientName||q.client||'-'}`);doc.text(`Descripción: ${q.description||'-'}`);doc.text(`FOB: USD ${num(c.fob).toFixed(2)}   |   CBM: ${num(c.cbm).toFixed(3)}   |   KG: ${num(c.kg).toFixed(2)}`);doc.moveDown();doc.fontSize(13).text('Derechos e impuestos');doc.fontSize(10);[['Derecho',c.duty],['IVA',c.vat],['IVA adicional',c.vatAdditional],['Ganancias',c.earnings],['IIBB',c.iibb],['Tasa estadística',c.statisticalFee],['Honorarios',c.honoraria]].forEach(([n,v])=>doc.text(`${n}: USD ${num(v).toFixed(2)}`));doc.moveDown();doc.fontSize(13).text('Gastos logísticos');doc.fontSize(10);(c.logisticsLines||[]).forEach(l=>doc.text(`${l.name}: USD ${num(l.total).toFixed(2)}`));doc.moveDown();doc.fontSize(14).fillColor('#148a18').text(`Total a abonar: USD ${num(c.totalToPay).toFixed(2)}`);doc.fillColor('#111').fontSize(10).text(`Costo total con mercadería: USD ${num(c.landedCost).toFixed(2)}`);doc.text(`Recupero estimado: USD ${num(c.recoverable).toFixed(2)}`);doc.moveDown(2);doc.fontSize(8).fillColor('#666').text('Cotización estimativa. Tributos, gastos y condiciones sujetos a confirmación al momento de la operación.');doc.end();
}catch(e){next(e)}});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:err.message||'Error interno'});});
app.listen(PORT,()=>console.log(`MRAPI Quotes listening on ${PORT} db=${databaseId} bucket=${bucketName}`));
