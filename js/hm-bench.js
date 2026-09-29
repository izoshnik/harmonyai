/* ===== HarmonyAI — «мини-компьютер» справа от чата (только компьютер) =====
   Когда ИИ пишет код или создаёт файл (md, txt, pdf, docx, pptx, html, css, js…),
   справа открывается окно на 3/8 ширины: слева чат, справа «компьютер».

   Что умеет окно:
   • HTML / SVG / Markdown — вкладки «Просмотр» и «Код». HTML запускается в
     изолированном iframe (sandbox без доступа к сайту и к вашему входу).
   • Копировать, Скачать, Поделиться (системное меню «Поделиться», а если его
     нет — копируется текст).
   • Для файлов PDF/DOCX/PPTX «Скачать» собирает настоящий файл через тот же
     /api/generate-file, что и карточка в чате.
   • Несколько файлов в ответе — вкладки сверху.

   API: HmBench.open(item) · HmBench.close() · HmBench.scan(msgEl, autoOpen)
   item = {name, lang, content, fmt?, spec?}                               */
(function(){
  'use strict';
  var MIN_WIDTH=1000;              // на узких экранах окно не открывается само
  var MIN_LINES=12;                // короткие фрагменты кода остаются в чате
  var EXT={html:'html',htm:'html',css:'css',js:'js',javascript:'js',ts:'ts',typescript:'ts',jsx:'jsx',tsx:'tsx',json:'json',
    py:'py',python:'py',md:'md',markdown:'md',txt:'txt',text:'txt',svg:'svg',xml:'xml',sql:'sql',sh:'sh',bash:'sh',
    java:'java',c:'c',cpp:'cpp','c++':'cpp',cs:'cs',go:'go',rs:'rs',rust:'rs',php:'php',rb:'rb',kotlin:'kt',swift:'swift',yaml:'yml',yml:'yml',abc:'abc'};
  var MIME={html:'text/html',css:'text/css',js:'text/javascript',json:'application/json',md:'text/markdown',svg:'image/svg+xml',txt:'text/plain'};
  var BINARY={pdf:1,docx:1,pptx:1,xlsx:1};

  var el=null,items=[],cur=0,view='preview';

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function wide(){return window.innerWidth>=MIN_WIDTH;}
  function extOf(it){var m=/\.([a-z0-9]+)$/i.exec(it.name||'');return (m?m[1]:(EXT[(it.lang||'').toLowerCase()]||'txt')).toLowerCase();}
  function previewable(it){var e=extOf(it);return e==='html'||e==='htm'||e==='svg'||e==='md'||BINARY[e];}

  var IC={
    copy:'<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M6 15H5a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8"/></svg>',
    dl:'<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share:'<svg viewBox="0 0 24 24" fill="none"><path d="M12 15V4m0 0L8 8m4-4l4 4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12v6.5A1.5 1.5 0 007.5 20h9a1.5 1.5 0 001.5-1.5V12" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    x:'<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    open:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M14 4v16" stroke="currentColor" stroke-width="1.8"/></svg>'
  };

  function build(){
    if(el)return el;
    el=document.createElement('aside');
    el.className='hmb';el.setAttribute('aria-label','Окно с кодом и файлами');
    el.innerHTML='<div class="hmb-win">'
      +'<div class="hmb-bar"><span class="hmb-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="hmb-tabs" role="tablist"></div>'
      +'<button type="button" class="hmb-ic hmb-close" title="Закрыть" aria-label="Закрыть">'+IC.x+'</button></div>'
      +'<div class="hmb-tools"><div class="hmb-seg" role="tablist"><button type="button" data-v="preview">Просмотр</button><button type="button" data-v="code">Код</button></div>'
      +'<span class="hmb-meta"></span>'
      +'<button type="button" class="hmb-ic" data-a="copy" title="Скопировать">'+IC.copy+'</button>'
      +'<button type="button" class="hmb-ic" data-a="dl" title="Скачать">'+IC.dl+'</button>'
      +'<button type="button" class="hmb-ic" data-a="share" title="Поделиться">'+IC.share+'</button></div>'
      +'<div class="hmb-body"></div></div>';
    document.body.appendChild(el);
    el.querySelector('.hmb-close').onclick=close;
    el.querySelector('.hmb-seg').onclick=function(e){var b=e.target.closest('button');if(b){view=b.dataset.v;render();}};
    el.querySelector('.hmb-tools').addEventListener('click',function(e){var b=e.target.closest('[data-a]');if(!b)return;
      var a=b.dataset.a;if(a==='copy')copy(b);else if(a==='dl')download(b);else share(b);});
    el.querySelector('.hmb-tabs').onclick=function(e){var b=e.target.closest('button');if(b){cur=+b.dataset.i;view=previewable(items[cur])?'preview':'code';render();}};
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.body.classList.contains('hm-bench-open')&&!document.querySelector('.settings-overlay.open'))close();});
    return el;
  }

  function render(){
    var it=items[cur];if(!it)return;
    var e=extOf(it);
    el.querySelector('.hmb-tabs').innerHTML=items.map(function(x,i){return '<button type="button" role="tab" aria-selected="'+(i===cur)+'" data-i="'+i+'" class="'+(i===cur?'on':'')+'">'+esc(x.name)+'</button>';}).join('');
    var seg=el.querySelector('.hmb-seg');
    seg.style.display=previewable(it)?'':'none';
    Array.prototype.forEach.call(seg.children,function(b){b.classList.toggle('on',b.dataset.v===view);});
    var lines=String(it.content||'').split('\n').length;
    el.querySelector('.hmb-meta').textContent=(BINARY[e]?e.toUpperCase()+' · ':'')+lines+' '+(lines%10===1&&lines%100!==11?'строка':(lines%10>=2&&lines%10<=4&&(lines%100<10||lines%100>=20)?'строки':'строк'));
    var body=el.querySelector('.hmb-body');
    if(view==='preview'&&previewable(it)){
      if(e==='html'||e==='htm'||e==='svg'){
        body.innerHTML='<iframe class="hmb-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerpolicy="no-referrer" title="Просмотр '+esc(it.name)+'"></iframe>';
        body.firstChild.srcdoc=e==='svg'?'<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">'+it.content+'</body>':it.content;
      }else{
        var html='';try{html=window.marked?window.marked.parse(String(it.content||'')):esc(it.content);}catch(err){html=esc(it.content);}
        body.innerHTML='<div class="hmb-doc'+(BINARY[e]?' hmb-paper':'')+'">'+html+'</div>';
        // Текст ИИ показываем без скриптов и обработчиков
        body.querySelectorAll('script,iframe,object,embed').forEach(function(n){n.remove();});
        body.querySelectorAll('*').forEach(function(n){for(var i=n.attributes.length-1;i>=0;i--){var a=n.attributes[i].name;if(/^on/i.test(a))n.removeAttribute(a);}});
      }
    }else{
      var code=String(it.content||'');
      var hl=code;try{hl=typeof window.highlightCode==='function'?window.highlightCode(code,it.lang||e):esc(code);}catch(err){hl=esc(code);}
      var nums='';for(var i=1;i<=lines;i++)nums+=i+'\n';
      body.innerHTML='<div class="hmb-code"><pre class="hmb-ln" aria-hidden="true">'+nums+'</pre><pre class="hmb-src"><code class="hljs">'+hl+'</code></pre></div>';
    }
  }

  function flash(b,ok){b.classList.add(ok?'ok':'err');setTimeout(function(){b.classList.remove('ok','err');},1100);}
  function copy(b){var it=items[cur];navigator.clipboard.writeText(String(it.content||'')).then(function(){flash(b,true);},function(){flash(b,false);});}
  function blobOf(it){var e=extOf(it);return new Blob([String(it.content||'')],{type:(MIME[e]||'text/plain')+';charset=utf-8'});}
  function download(b){
    var it=items[cur],e=extOf(it);
    if(BINARY[e]&&it.card){var fb=it.card.querySelector('.file-card-btn');if(fb){fb.click();flash(b,true);return;}}
    var a=document.createElement('a');a.href=URL.createObjectURL(blobOf(it));a.download=it.name;
    document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800);flash(b,true);
  }
  function share(b){
    var it=items[cur];
    try{
      var f=new File([blobOf(it)],it.name,{type:blobOf(it).type});
      if(navigator.canShare&&navigator.canShare({files:[f]})){navigator.share({files:[f],title:it.name}).then(function(){flash(b,true);},function(){});return;}
    }catch(err){}
    navigator.clipboard.writeText(String(it.content||'')).then(function(){flash(b,true);if(window.showSettingsToast)showSettingsToast('Поделиться файлом здесь нельзя — текст скопирован');});
  }

  function open(list,idx){
    build();
    items=Array.isArray(list)?list:[list];cur=idx||0;
    view=previewable(items[cur])?'preview':'code';
    render();
    document.body.classList.add('hm-bench-open');
  }
  function close(){document.body.classList.remove('hm-bench-open');}

  /* Находит в сообщении код и файлы, добавляет кнопку «Открыть в окне»,
     при autoOpen — открывает окно (только на широком экране). */
  function scan(msgEl,autoOpen){
    if(!msgEl)return;
    var found=[];
    msgEl.querySelectorAll('.code-block').forEach(function(cb){
      var code='';try{code=decodeURIComponent(cb.getAttribute('data-code')||'');}catch(e){}
      var lang=(cb.getAttribute('data-lang')||'').toLowerCase();
      if(lang==='abc')return;
      var n=code.split('\n').length;
      var big=n>=MIN_LINES||['html','htm','svg'].indexOf(lang)>=0;
      var ext=EXT[lang]||'txt';
      var it={name:(ext==='html'?'index':'file'+(found.length?found.length+1:''))+'.'+ext,lang:lang,content:code};
      if(!cb.querySelector('.code-bench')){
        var b=document.createElement('button');b.type='button';b.className='code-copy code-bench';b.title='Открыть в окне';b.setAttribute('aria-label','Открыть в окне');b.innerHTML=IC.open;
        b.onclick=function(){open(it);};
        var head=cb.querySelector('.code-head');if(head){var cp=head.querySelector('.code-copy');head.insertBefore(b,cp);}
      }
      if(big)found.push(it);
    });
    msgEl.parentElement&&msgEl.parentElement.querySelectorAll('.file-card').forEach(function(card){
      var sp=card._hmSpec;if(!sp)return;
      var it={name:sp.name,lang:sp.fmt,content:sp.content,card:card};
      if(!card.querySelector('.file-card-open')){
        var b=document.createElement('button');b.type='button';b.className='file-card-open';b.textContent='Открыть';
        b.onclick=function(ev){ev.stopPropagation();open(it);};
        card.insertBefore(b,card.querySelector('.file-card-btn'));
      }
      found.push(it);
    });
    if(autoOpen&&found.length&&wide())open(found,0);
  }

  /* Кнопки «Открыть в окне» и у сообщений из истории */
  function watch(){
    var inner=document.getElementById('chatInner');if(!inner){setTimeout(watch,600);return;}
    var t=0;new MutationObserver(function(){clearTimeout(t);t=setTimeout(function(){
      inner.querySelectorAll('.msg-ai').forEach(function(m){if(m.querySelector('.code-block:not([data-hmb]),.file-card')||m.parentElement.querySelector('.file-card')){m.querySelectorAll('.code-block').forEach(function(c){c.setAttribute('data-hmb','1');});scan(m,false);}});
    },250);}).observe(inner,{childList:true,subtree:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch);else watch();
  window.addEventListener('resize',function(){if(!wide())close();});

  window.HmBench={open:open,close:close,scan:scan};
})();
