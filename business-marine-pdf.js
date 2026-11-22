import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
export const MARINE_PDF_VERSION='marine-original-v2-15days';
// Visual structure and company data come from the user's original workbook.
// Price, date and validity always come from the persisted Quote snapshot.
export async function marinePdf(q){
 const doc=new PDFDocument({size:'A4',margin:22,info:{Title:q.quoteNo,Author:'Sentire Marine SA.'}}),chunks=[];
 const done=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 doc.registerFont('Marine',fileURLToPath(new URL('./assets/LiberationSans-Regular.ttf',import.meta.url)));
 doc.registerFont('Marine-Bold',fileURLToPath(new URL('./assets/LiberationSans-Bold.ttf',import.meta.url)));
 const navy='#0B304F',ink='#223447',muted='#64758A',line='#D8E1E9',pale='#F3F6F9',head='#E6EDF2';
 const x=24,W=547,right=x+W,c=q.calculation,i=q.input||{},money=n=>'USD '+Number(n||0).toFixed(2);
 function text(t,xx,y,w,size=8.2,bold=false,color=ink,align='left',height=20){
  doc.font(bold?'Marine-Bold':'Marine').fontSize(size).fillColor(color).text(String(t??''),xx,y,{width:w,height,align,ellipsis:true,lineBreak:true});
 }
 function rect(xx,y,w,h,fill){doc.rect(xx,y,w,h).fillAndStroke(fill,line);}
 function band(label,y){doc.rect(x,y,W,21).fill(navy);text(label,x+7,y+6,W-14,8.8,true,'#FFFFFF');}
 const date=v=>{const [a,b,d]=String(v||'').slice(0,10).split('-');return d?`${d}/${b}/${a}`:'';};
 function header(continued=false){
  doc.image(fileURLToPath(new URL('./assets/marine-logo.jpg',import.meta.url)),x,23,{width:76,height:76});
  text('SENTIRE MARINE',x+132,36,245,18,true,navy);
  text('PRESUPUESTO',right-157,38,157,15.5,true,navy,'right');
  text('Importación con eficiencia',x+132,77,300,9,false,muted);
  if(continued)text(q.quoteNo,x+132,94,350,8,false,muted);
 }
 header();band('DATOS DEL PRESUPUESTO',111);
 const company=[['Empresa','Sentire Marine SA.','Teléfono','11-5246-2128'],['CUIT','30-71774543-0','Presupuesto Nº',q.quoteNo],['Email','ventas@sentiremarine.com.ar','Fecha de emisión',date(q.createdAt)],['CBU','0270009010053120240039','Válido hasta',date(q.validUntil)]];
 for(let n=0;n<company.length;n++){
  const y=132+n*20,[a,b,d,e]=company[n];rect(x,y,W,20,'#FFFFFF');
  text(a,x+5,y+6,60,8,true,muted);text(b,x+69,y+6,199,8);
  text(d,x+278,y+6,107,8,true,muted);text(e,x+388,y+6,155,e===q.quoteNo?7.3:8);
 }
 rect(x,212,W,20,'#FFFFFF');text('Dirección',x+5,218,60,8,true,muted);text('Av. Brasil 55 (Piso 6), San Telmo, CABA, Argentina',x+69,218,W-75,8);
 band('DATOS DEL CLIENTE',232);
 const client=[['Cliente',i.clientName],['CUIT',i.clientTaxId],['Dirección',i.clientAddress],['Teléfono',i.clientPhone],['Solicitante',i.requestedBy]];
 client.forEach(([a,b],n)=>{const y=253+n*20;rect(x,y,W,20,'#FFFFFF');text(a,x+5,y+6,62,8,true,muted);text(b||'',x+69,y+6,W-75,8);});
 let y=353;const widths=[64,71,129,82,51,82,68],labels=['Motor','Código','Descripción','Plazo de entrega','Cantidad','Precio unitario','Importe'];
 function tableHeader(){band('DETALLE DE PRODUCTOS',y);y+=21;let xx=x;labels.forEach((label,n)=>{rect(xx,y,widths[n],29,head);text(label,xx+3,y+9,widths[n]-6,7.6,true,navy,'center');xx+=widths[n];});y+=29;}
 tableHeader();
 const lines=c.lines||[],count=Math.max(7,lines.length);
 for(let n=0;n<count;n++){
  if(y+28>650){doc.addPage();header(true);y=118;tableHeader();}
  const l=lines[n],values=l?[i.engine||'',l.code,l.description,'15 días',l.qty,money(l.unitPrice),money(l.amount??l.net)]:Array(7).fill('');
  let xx=x;values.forEach((value,k)=>{rect(xx,y,widths[k],28,n%2===0?pale:'#FFFFFF');text(value,xx+4,y+8,widths[k]-8,k===2?7.3:7.5,false,ink,k===2?'left':k>=5?'right':'center',18);xx+=widths[k];});y+=28;
 }
 if(y+174>810){doc.addPage();header(true);y=118;}
 band('CONDICIONES Y TOTALES',y);y+=21;
 text('Todos los importes expresados en USD. IVA incluido.',x+5,y+8,320,8,false,muted);
 text('Importación aérea',x+5,y+29,320,8,false,muted);
 text('Cotización según códigos y cantidades indicados.\nEntrega: 15 días. Importación desde Bélgica.\nStock a confirmar. Compatibilidad técnica no verificada.',x+5,y+51,322,7.8,false,muted,'left',43);
 const totals=[['Subtotal',c.subtotal],['Descuento',c.discountAmount||0],['Envío',c.shipping||0],['Impuestos',c.vat||0]];
 totals.forEach(([label,value],n)=>{text(label,x+352,y+8+n*20,90,8,false,muted);text(money(value),x+440,y+8+n*20,103,8,false,ink,'right');});
 doc.rect(x+336,y+88,W-336,30).fill(navy);text('TOTAL FINAL',x+343,y+98,97,10,true,'#FFFFFF');text(money(c.totalToPay),x+440,y+98,101,10,true,'#FFFFFF','right');
 doc.end();return done;
}
