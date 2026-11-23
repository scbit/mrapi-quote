import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
export const FFW_PDF_VERSION='ffw-commercial-v1';
export async function ffwPdf(q){
 const doc=new PDFDocument({size:'A4',margins:{top:40,left:40,right:40,bottom:20},info:{Title:q.quoteNo,Author:'Sentire Freight Forwarder'}}),chunks=[];
 const done=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 for(const [name,file] of [['Body','LiberationSans-Regular.ttf'],['Bold','LiberationSans-Bold.ttf']])doc.registerFont(name,fileURLToPath(new URL('./assets/'+file,import.meta.url)));
 const c=q.calculation,i=q.input||{},L=40,R=555,W=515,navy='#163D3B',green='#36A511',ink='#263B3A',muted='#677976',pale='#F1F6F3';
 const money=n=>Number(n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
 const text=(v,x,y,w,size=10,bold=false,color=ink,align='left')=>doc.font(bold?'Bold':'Body').fontSize(size).fillColor(color).text(String(v??''),x,y,{width:w,align,lineGap:2});
 function footer(){doc.moveTo(L,783).lineTo(R,783).strokeColor('#DCE6E1').stroke();text('SENTIRE FREIGHT FORWARDER',L,796,270,8,true,navy);text('sales@sentireffw.com  |  sentireffw.com',L,811,W,8,false,muted);text('USD',R-50,796,50,8,true,muted,'right');}
 function header(){
  doc.image(fileURLToPath(new URL('./assets/ffw-logo.png',import.meta.url)),L,35,{width:198});
  text(q.preview?'PDF DE PRUEBA':'COTIZACIÓN DE FLETE',300,46,255,16,true,navy,'right');text(q.quoteNo,300,73,255,9,true,muted,'right');
  const date=new Date(q.createdAt).toLocaleDateString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'});text('Emisión: '+date,300,91,255,9,false,muted,'right');
  doc.rect(L,140,W,3).fill(green);footer();
 }
 header();
 text('PREPARADA PARA',L,162,W,8,true,muted);text(i.clientName||'Cliente',L,179,W,15,true,navy);
 doc.roundedRect(L,215,W,82,9).fill(navy);
 text('ORIGEN',L+17,229,222,8,true,'#BED5C7');text('DESTINO',L+276,229,222,8,true,'#BED5C7');
 text(c.origin,L+17,246,225,19,true,'#FFFFFF');text(c.destination,L+276,246,222,19,true,'#FFFFFF');
 text(`${c.mode||i.mode||''}  |  ${c.equipment||i.equipment||''}  |  ${i.containers||1} contenedor(es)`,L,314,W,10,true,navy);
 if(c.entryPort)text('Ingreso vía '+c.entryPort,L,333,W,9,false,muted);
 let y=353;
 function columns(){doc.rect(L,y,W,27).fill(pale);text('CONCEPTO',L+9,y+8,255,8,true,muted);text('CANT.',310,y+8,40,8,true,muted,'right');text('UNITARIO USD',360,y+8,85,8,true,muted,'right');text('NETO USD',455,y+8,90,8,true,muted,'right');y+=27;}
 columns();
 for(const l of c.lines){
  if(y>650){doc.addPage();header();y=168;columns();}
  const name=l.description+(l.vatPct===0?' · exento':` · IVA ${l.vatPct}%`);
  doc.font('Body').fontSize(9);const h=Math.max(c.lines.length>3?34:47,doc.heightOfString(name,{width:250})+16);
  text(name,L+9,y+13,250,9);text(l.qty,310,y+13,40,9,false,ink,'right');text(money(l.unitPrice),360,y+13,85,9,false,ink,'right');text(money(l.net),455,y+13,90,9,true,ink,'right');
  y+=h;doc.moveTo(L,y).lineTo(R,y).strokeColor('#E4EBE7').stroke();
 }
 const notes=[c.conditions,c.exclusions].filter(Boolean).filter((v,n,a)=>a.indexOf(v)===n);
 doc.font('Body').fontSize(8.5);const noteHeight=notes.reduce((n,t)=>n+doc.heightOfString(t,{width:W,lineGap:2})+9,0);
 if(y+17+(c.insurance?66:44)+76+19+Math.min(noteHeight,110)>767){doc.addPage();header();y=168;}
 y+=17;
 for(const [label,value] of [['Subtotal neto',c.subtotal],['IVA sobre conceptos gravados',c.vat],...(c.insurance?[['Seguro',c.insurance]]:[])]){text(label,282,y,165,9,false,muted);text(money(value),451,y,94,10,false,ink,'right');y+=22;}
 doc.roundedRect(L,y+3,W,47,7).fill(navy);text('TOTAL COTIZADO · USD',L+14,y+20,260,11,true,'#FFFFFF');text(money(c.totalToPay),328,y+15,213,21,true,'#FFFFFF','right');y+=76;
 text('ALCANCE Y CONDICIONES',L,y,W,8,true,green);y+=19;
 for(const note of notes){doc.font('Body').fontSize(8.5);const h=doc.heightOfString(note,{width:W,lineGap:2});if(y+h>767){doc.addPage();header();y=168;}text(note,L,y,W,8.5,false,muted);y+=h+9;}
 doc.end();return done;
}
