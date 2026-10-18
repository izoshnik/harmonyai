/* ===== HarmonyAI — сборка PDF / DOCX / PPTX прямо в браузере =====
   Зачем: серверный PDF был на base-14 Helvetica без кириллицы — весь русский
   текст превращался в «?????». DOCX и PDF получали сырой Markdown (#, **, |---|),
   картинки в документы не попадали, а презентаций (PPTX) не было вовсе.

   Теперь файл собирают проверенные библиотеки (pdfmake со шрифтом Roboto —
   в нём есть кириллица; docx; pptxgenjs). Они грузятся ЛЕНИВО, только когда
   пользователь нажал «Скачать», с jsDelivr, а при сбое — с unpkg (оба домена
   уже разрешены в CSP). Markdown разбирается в общие блоки, из которых
   строится каждый формат: заголовки, абзацы с жирным/курсивом, списки,
   таблицы, код, картинки (по ссылке ![подпись](https://…)).

   API: HmDocGen.build(spec, fmt) → Promise<Blob>
        spec = {filename, title?, content}  fmt = 'pdf' | 'docx' | 'pptx'      */
(function(){
  'use strict';

  /* ---------- ленивая загрузка библиотек ---------- */
  var LIBS={
    pdfmake:{paths:['pdfmake@0.2.10/build/pdfmake.min.js','pdfmake@0.2.10/build/vfs_fonts.js'],ok:function(){return window.pdfMake&&window.pdfMake.vfs&&window.pdfMake.vfs['Roboto-Regular.ttf'];}},
    docx:{paths:['docx@8.5.0/build/index.umd.js'],ok:function(){return window.docx&&window.docx.Document;}},
    pptx:{paths:['pptxgenjs@3.12.0/dist/pptxgen.bundle.js'],ok:function(){return typeof window.PptxGenJS==='function';}}
  };
  var CDNS=['https://cdn.jsdelivr.net/npm/','https://unpkg.com/'];
  var loading={};
  function loadScript(src){
    return new Promise(function(resolve,reject){
      var s=document.createElement('script');var done=false;
      var t=setTimeout(function(){if(done)return;done=true;s.remove();reject(new Error('timeout'));},30000);
      s.src=src;s.async=false;
      s.onload=function(){if(done)return;done=true;clearTimeout(t);resolve();};
      s.onerror=function(){if(done)return;done=true;clearTimeout(t);s.remove();reject(new Error('load error'));};
      document.head.appendChild(s);
    });
  }
  function loadLib(name){
    var lib=LIBS[name];
    if(lib.ok())return Promise.resolve();
    if(loading[name])return loading[name];
    loading[name]=(async function(){
      var lastErr=null;
      for(var c=0;c<CDNS.length;c++){
        try{
          for(var i=0;i<lib.paths.length;i++)await loadScript(CDNS[c]+lib.paths[i]);
          if(lib.ok())return;
        }catch(e){lastErr=e;}
      }
      throw new Error('Не удалось загрузить модуль сборки файла. Проверьте соединение и попробуйте ещё раз.'+(lastErr?'':''));
    })();
    loading[name].catch(function(){delete loading[name];});
    return loading[name];
  }

  /* ---------- Markdown → блоки ---------- */
  var IMG_LINE=/^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;
  function parseInline(text){
    var out=[];var re=/(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)\3(?!\w)|`([^`]+)`|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;
    var last=0,m;
    text=String(text||'');
    while((m=re.exec(text))){
      if(m.index>last)out.push({text:text.slice(last,m.index)});
      if(m[2]!=null)parseInline(m[2]).forEach(function(r){r.bold=true;out.push(r);});
      else if(m[4]!=null)parseInline(m[4]).forEach(function(r){r.italics=true;out.push(r);});
      else if(m[5]!=null)out.push({text:m[5],code:true});
      else if(m[6]!=null)out.push({text:m[6]?('['+m[6]+']'):''});
      else if(m[8]!=null)out.push({text:m[8]});
      last=re.lastIndex;
    }
    if(last<text.length)out.push({text:text.slice(last)});
    return out.filter(function(r){return r.text!=='';});
  }
  function splitRow(line){
    var t=line.trim().replace(/^\|/,'').replace(/\|$/,'');
    return t.split('|').map(function(c){return c.trim();});
  }
  function parseMarkdown(md){
    var lines=String(md||'').replace(/\r/g,'').split('\n');
    var blocks=[];var para=[];
    function flush(){if(para.length){blocks.push({type:'p',runs:parseInline(para.join(' '))});para=[];}}
    for(var i=0;i<lines.length;i++){
      var line=lines[i];var m;
      if(/^\s*```/.test(line)){
        flush();var code=[];i++;
        while(i<lines.length&&!/^\s*```/.test(lines[i])){code.push(lines[i]);i++;}
        blocks.push({type:'code',text:code.join('\n')});continue;
      }
      if(!line.trim()){flush();continue;}
      if((m=/^\s*(#{1,6})\s+(.*)$/.exec(line))){flush();blocks.push({type:'h',level:m[1].length,runs:parseInline(m[2].replace(/\s*#+\s*$/,''))});continue;}
      if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){flush();blocks.push({type:'hr'});continue;}
      if((m=IMG_LINE.exec(line))){flush();blocks.push({type:'img',alt:m[1],url:m[2]});continue;}
      if(/^\s*\|.*\|\s*$/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}/.test(lines[i+1])){
        flush();var rows=[splitRow(line)];i+=2;
        while(i<lines.length&&/^\s*\|.*\|?\s*$/.test(lines[i])&&lines[i].trim()){rows.push(splitRow(lines[i]));i++;}
        i--;var n=Math.max.apply(null,rows.map(function(r){return r.length;}));
        rows=rows.map(function(r){while(r.length<n)r.push('');return r.map(parseInline);});
        blocks.push({type:'table',rows:rows});continue;
      }
      if((m=/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line))){
        flush();var ordered=/\d/.test(m[2]);var items=[];var j=i;
        while(j<lines.length){
          var mm=/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(lines[j]);
          if(!mm||/\d/.test(mm[2])!==ordered)break;
          items.push({level:Math.min(3,Math.floor(mm[1].replace(/\t/g,'  ').length/2)),runs:parseInline(mm[3])});j++;
        }
        i=j-1;blocks.push({type:'list',ordered:ordered,items:items});continue;
      }
      if((m=/^\s*>\s?(.*)$/.exec(line))){flush();blocks.push({type:'quote',runs:parseInline(m[1])});continue;}
      para.push(line.trim());
    }
    flush();
    return blocks;
  }
  function plain(runs){return (runs||[]).map(function(r){return r.text;}).join('');}

  /* ---------- картинки: URL → PNG/JPEG dataURL + размеры ---------- */
  async function fetchImage(url){
    if(!/^(https?:|data:image\/)/i.test(url))throw new Error('bad url');
    var ctrl=new AbortController();var t=setTimeout(function(){ctrl.abort();},15000);
    try{
      var blob=url.indexOf('data:')===0?await (await fetch(url)).blob():await (await fetch(url,{mode:'cors',signal:ctrl.signal})).blob();
      if(!/^image\//.test(blob.type))throw new Error('not an image');
      var bmp=await createImageBitmap(blob);
      var maxSide=1600;var k=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
      var w=Math.max(1,Math.round(bmp.width*k)),h=Math.max(1,Math.round(bmp.height*k));
      var c=document.createElement('canvas');c.width=w;c.height=h;
      var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.drawImage(bmp,0,0,w,h);
      var dataUrl=c.toDataURL('image/jpeg',0.88);
      return {dataUrl:dataUrl,width:w,height:h};
    }finally{clearTimeout(t);}
  }
  async function resolveImages(blocks){
    var imgs=blocks.filter(function(b){return b.type==='img';}).slice(0,20);
    await Promise.all(imgs.map(async function(b){try{b.data=await fetchImage(b.url);}catch(e){b.data=null;}}));
  }
  function dataUrlToBytes(d){var b=atob(d.split(',')[1]);var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
  function fitBox(w,h,maxW,maxH){var k=Math.min(maxW/w,maxH/h,1e9);return {w:w*k,h:h*k};}

  /* ---------- PDF (pdfmake) ---------- */
  async function buildPdf(spec,blocks){
    await loadLib('pdfmake');
    function runs(rs){return rs.map(function(r){var o={text:r.text};if(r.bold)o.bold=true;if(r.italics)o.italics=true;if(r.code){o.background='#f0f0f0';o.fontSize=10;}return o;});}
    var content=[];
    if(spec.title&&!(blocks[0]&&blocks[0].type==='h'))content.push({text:spec.title,style:'h1'});
    blocks.forEach(function(b){
      if(b.type==='h')content.push({text:runs(b.runs),style:'h'+Math.min(3,b.level)});
      else if(b.type==='p')content.push({text:runs(b.runs),margin:[0,0,0,8]});
      else if(b.type==='quote')content.push({text:runs(b.runs),italics:true,color:'#555',margin:[12,0,0,8]});
      else if(b.type==='list'){var items=b.items.map(function(it){return {text:runs(it.runs),margin:[it.level*14,0,0,2]};});content.push(b.ordered?{ol:items,margin:[0,0,0,8]}:{ul:items,margin:[0,0,0,8]});}
      else if(b.type==='table'){content.push({table:{headerRows:1,widths:b.rows[0].map(function(){return '*';}),body:b.rows.map(function(r,ri){return r.map(function(c){return {text:runs(c),bold:ri===0,fontSize:10};});})},layout:'lightHorizontalLines',margin:[0,4,0,10]});}
      else if(b.type==='code')content.push({table:{widths:['*'],body:[[{text:b.text,fontSize:9,preserveLeadingSpaces:true}]]},layout:{fillColor:function(){return '#f4f4f4';},hLineWidth:function(){return 0;},vLineWidth:function(){return 0;},paddingLeft:function(){return 8;},paddingTop:function(){return 6;},paddingBottom:function(){return 6;}},margin:[0,0,0,10]});
      else if(b.type==='hr')content.push({canvas:[{type:'line',x1:0,y1:4,x2:515,y2:4,lineWidth:0.5,lineColor:'#bbb'}],margin:[0,4,0,10]});
      else if(b.type==='img'){
        if(b.data){var f=fitBox(b.data.width,b.data.height,480,360);content.push({image:b.data.dataUrl,width:f.w,height:f.h,alignment:'center',margin:[0,6,0,4]});if(b.alt)content.push({text:b.alt,italics:true,fontSize:9,color:'#666',alignment:'center',margin:[0,0,0,10]});}
        else content.push({text:'[Изображение недоступно'+(b.alt?': '+b.alt:'')+']',italics:true,color:'#888',margin:[0,0,0,8]});
      }
    });
    var dd={
      info:{title:spec.title||spec.filename||'Документ',creator:'HarmonyAI'},
      pageSize:'A4',pageMargins:[40,48,40,48],
      content:content.length?content:[{text:' '}],
      defaultStyle:{font:'Roboto',fontSize:11,lineHeight:1.25},
      styles:{h1:{fontSize:20,bold:true,margin:[0,0,0,10]},h2:{fontSize:16,bold:true,margin:[0,10,0,6]},h3:{fontSize:13,bold:true,margin:[0,8,0,4]}},
      footer:function(cur,total){return {text:cur+' / '+total,alignment:'center',fontSize:8,color:'#999',margin:[0,16,0,0]};}
    };
    return await new Promise(function(resolve,reject){
      try{window.pdfMake.createPdf(dd).getBlob(function(b){resolve(b);});}catch(e){reject(e);}
    });
  }

  /* ---------- DOCX (docx) ---------- */
  async function buildDocx(spec,blocks){
    await loadLib('docx');
    var D=window.docx;
    function runs(rs,extra){return rs.map(function(r){return new D.TextRun(Object.assign({text:r.text,bold:!!r.bold,italics:!!r.italics},r.code?{font:'Courier New'}:{},extra||{}));});}
    var HL=[D.HeadingLevel.HEADING_1,D.HeadingLevel.HEADING_2,D.HeadingLevel.HEADING_3,D.HeadingLevel.HEADING_4,D.HeadingLevel.HEADING_5,D.HeadingLevel.HEADING_6];
    var children=[];var olCount=0;
    if(spec.title&&!(blocks[0]&&blocks[0].type==='h'))children.push(new D.Paragraph({heading:D.HeadingLevel.TITLE,children:[new D.TextRun(spec.title)]}));
    blocks.forEach(function(b){
      if(b.type==='h')children.push(new D.Paragraph({heading:HL[b.level-1],children:runs(b.runs)}));
      else if(b.type==='p')children.push(new D.Paragraph({children:runs(b.runs),spacing:{after:120}}));
      else if(b.type==='quote')children.push(new D.Paragraph({children:runs(b.runs,{italics:true}),indent:{left:400}}));
      else if(b.type==='list'){
        var ref='ol'+(olCount++);
        b.items.forEach(function(it){
          children.push(new D.Paragraph(b.ordered?{children:runs(it.runs),numbering:{reference:'hm-ol',level:it.level,instance:olCount}}:{children:runs(it.runs),bullet:{level:it.level}}));
        });
      }
      else if(b.type==='table'){
        children.push(new D.Table({width:{size:100,type:D.WidthType.PERCENTAGE},rows:b.rows.map(function(r,ri){return new D.TableRow({tableHeader:ri===0,children:r.map(function(c){return new D.TableCell({children:[new D.Paragraph({children:runs(c,ri===0?{bold:true}:null)})]});})});})}));
        children.push(new D.Paragraph(''));
      }
      else if(b.type==='code')b.text.split('\n').forEach(function(l){children.push(new D.Paragraph({children:[new D.TextRun({text:l||' ',font:'Courier New',size:18})],shading:{fill:'F2F2F2'}}));});
      else if(b.type==='hr')children.push(new D.Paragraph({border:{bottom:{color:'BBBBBB',space:1,style:D.BorderStyle.SINGLE,size:6}}}));
      else if(b.type==='img'){
        if(b.data){var f=fitBox(b.data.width,b.data.height,560,420);children.push(new D.Paragraph({alignment:D.AlignmentType.CENTER,children:[new D.ImageRun({data:dataUrlToBytes(b.data.dataUrl),transformation:{width:Math.round(f.w),height:Math.round(f.h)}})]}));if(b.alt)children.push(new D.Paragraph({alignment:D.AlignmentType.CENTER,children:[new D.TextRun({text:b.alt,italics:true,size:18,color:'666666'})]}));}
        else children.push(new D.Paragraph({children:[new D.TextRun({text:'[Изображение недоступно'+(b.alt?': '+b.alt:'')+']',italics:true,color:'888888'})]}));
      }
    });
    var levels=[0,1,2,3].map(function(l){return {level:l,format:D.LevelFormat.DECIMAL,text:'%'+(l+1)+'.',alignment:D.AlignmentType.START,style:{paragraph:{indent:{left:720*(l+1),hanging:360}}}};});
    var doc=new D.Document({
      creator:'HarmonyAI',title:spec.title||spec.filename||'Документ',
      styles:{default:{document:{run:{font:'Calibri',size:22}}}},
      numbering:{config:[{reference:'hm-ol',levels:levels}]},
      sections:[{children:children.length?children:[new D.Paragraph('')]}]
    });
    return await D.Packer.toBlob(doc);
  }

  /* ---------- PPTX (pptxgenjs) ---------- */
  function toSlides(spec,blocks){
    // Новый слайд — на заголовке #/## или на разделителе ---. ### остаётся подзаголовком внутри слайда.
    var slides=[];var cur=null;
    function start(title){cur={title:title||'',body:[],images:[],tables:[]};slides.push(cur);}
    blocks.forEach(function(b){
      if(b.type==='h'&&b.level<=2){start(plain(b.runs));return;}
      if(b.type==='hr'){start('');return;}
      if(!cur)start('');
      if(b.type==='img')cur.images.push(b);
      else if(b.type==='table')cur.tables.push(b);
      else cur.body.push(b);
    });
    return slides.filter(function(s){return s.title||s.body.length||s.images.length||s.tables.length;});
  }
  async function buildPptx(spec,blocks){
    await loadLib('pptx');
    var pptx=new window.PptxGenJS();
    pptx.layout='LAYOUT_WIDE'; // 13.33 × 7.5 дюйма
    pptx.title=spec.title||spec.filename||'Презентация';
    var FONT='Arial',W=13.33,H=7.5;
    var ACC='2563EB';
    function txtRuns(runs,opts){return runs.map(function(r){return {text:r.text,options:Object.assign({bold:!!r.bold,italic:!!r.italics,fontFace:r.code?'Courier New':FONT},opts||{})};});}
    var slides=toSlides(spec,blocks);
    // Титульный слайд
    var first=slides[0];
    var deckTitle=spec.title||(first&&first.title)||spec.filename||'Презентация';
    var ts=pptx.addSlide();
    ts.background={color:'FFFFFF'};
    ts.addShape(pptx.ShapeType.rect,{x:0,y:0,w:W,h:0.18,fill:{color:ACC},line:{color:ACC}});
    ts.addText(deckTitle,{x:0.8,y:2.4,w:W-1.6,h:1.6,fontFace:FONT,fontSize:40,bold:true,color:'111111',valign:'middle',fit:'shrink'});
    ts.addText('HarmonyAI',{x:0.8,y:4.1,w:W-1.6,h:0.6,fontFace:FONT,fontSize:18,color:'666666'});
    if(first&&first.title===deckTitle&&!first.body.length&&!first.images.length&&!first.tables.length)slides.shift();
    slides.forEach(function(sd){
      // Текст слайда: абзацы и списки; длинные слайды делятся на продолжения.
      var paras=[];
      sd.body.forEach(function(b){
        if(b.type==='list')b.items.forEach(function(it,ix){paras.push({runs:it.runs,bullet:b.ordered?{type:'number'}:true,indent:it.level});});
        else if(b.type==='h')paras.push({runs:b.runs,bold:true});
        else if(b.type==='code')b.text.split('\n').slice(0,14).forEach(function(l){paras.push({runs:[{text:l||' ',code:true}]});});
        else paras.push({runs:b.runs});
      });
      var chunks=[];for(var i=0;i<Math.max(1,paras.length);i+=9)chunks.push(paras.slice(i,i+9));
      chunks.forEach(function(chunk,ci){
        var s=pptx.addSlide();
        s.background={color:'FFFFFF'};
        s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:0.18,h:H,fill:{color:ACC},line:{color:ACC}});
        var title=(sd.title||deckTitle)+(ci?' (продолжение)':'');
        s.addText(title,{x:0.6,y:0.35,w:W-1.2,h:0.9,fontFace:FONT,fontSize:30,bold:true,color:'111111',fit:'shrink'});
        var img=ci===0?sd.images.find(function(b){return b.data;}):null;
        var table=ci===0?sd.tables[0]:null;
        var hasText=chunk.length>0;
        var textW=(img||table)&&hasText?W*0.5:W-1.2;
        if(hasText){
          var arr=[];
          chunk.forEach(function(p,pi){
            var rs=txtRuns(p.runs,{fontSize:20,color:'222222',bold:p.bold||undefined});
            if(!rs.length)rs=[{text:' ',options:{}}];
            rs[0].options=Object.assign({},rs[0].options,{bullet:p.bullet||false,indentLevel:p.indent||0,paraSpaceAfter:6});
            if(pi<chunk.length-1)rs[rs.length-1].options=Object.assign({},rs[rs.length-1].options,{breakLine:true});
            arr=arr.concat(rs);
          });
          s.addText(arr,{x:0.6,y:1.45,w:textW,h:H-2.0,valign:'top',fontFace:FONT,fit:'shrink'});
        }
        if(img){
          var boxX=hasText?0.6+textW+0.3:1.2,boxW=hasText?W-boxX-0.6:W-2.4,boxH=H-2.1;
          var f=fitBox(img.data.width,img.data.height,boxW,boxH);
          s.addImage({data:img.data.dataUrl,x:boxX+(boxW-f.w)/2,y:1.45+(boxH-f.h)/2,w:f.w,h:f.h});
        }else if(table){
          var tx=hasText?0.6+textW+0.3:0.6,tw=hasText?W-tx-0.6:W-1.2;
          s.addTable(table.rows.slice(0,12).map(function(r,ri){return r.map(function(c){return {text:plain(c),options:{bold:ri===0,fill:ri===0?{color:'EEF2FF'}:undefined}};});}),{x:tx,y:1.45,w:tw,fontFace:FONT,fontSize:14,border:{type:'solid',pt:0.5,color:'CCCCCC'},autoPage:false});
        }
        // Остальные картинки слайда — отдельными слайдами, чтобы не потерять.
        if(ci===0)sd.images.filter(function(b){return b.data&&b!==img;}).forEach(function(b){
          var s2=pptx.addSlide();s2.background={color:'FFFFFF'};
          s2.addText(sd.title||deckTitle,{x:0.6,y:0.35,w:W-1.2,h:0.9,fontFace:FONT,fontSize:28,bold:true,color:'111111',fit:'shrink'});
          var f2=fitBox(b.data.width,b.data.height,W-2.4,H-2.3);
          s2.addImage({data:b.data.dataUrl,x:(W-f2.w)/2,y:1.4+(H-2.3-f2.h)/2,w:f2.w,h:f2.h});
          if(b.alt)s2.addText(b.alt,{x:0.6,y:H-0.75,w:W-1.2,h:0.5,fontFace:FONT,fontSize:14,italic:true,color:'666666',align:'center'});
        });
      });
    });
    return await pptx.write({outputType:'blob'});
  }

  async function build(spec,fmt){
    var blocks=parseMarkdown(spec&&spec.content);
    await resolveImages(blocks);
    if(fmt==='pdf')return buildPdf(spec||{},blocks);
    if(fmt==='docx')return buildDocx(spec||{},blocks);
    if(fmt==='pptx')return buildPptx(spec||{},blocks);
    throw new Error('Неизвестный формат файла');
  }
  window.HmDocGen={build:build,parseMarkdown:parseMarkdown,formats:['pdf','docx','pptx']};
})();
