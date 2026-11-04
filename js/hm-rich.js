/* ===== HarmonyAI — интерактивные блоки в ответах ИИ =====
   Модель пишет обычный Markdown и, где уместно, специальные блоки:

     ```quiz     — тест: вопросы с вариантами, проверка, подсказки, результаты
     ```chart    — интерактивный график: функции с ползунками или данные
     ```diagram  — схема / карта понятий (синтаксис Mermaid)
     ```photo    — фото по теме (Википедия) или иллюстрация, нарисованная ИИ
     ```buttons  — кнопки следующих шагов: нажатие отправляет готовый запрос
     ```steps    — шаги с картинками слева (фото по теме или иконка), как в ChatGPT
     ```compare  — сравнение «было / стало»: колонки со строками и итогом
     ```flow     — схема-поток: блоки с иконками и стрелками между ними
     ```timeline — шкала времени: метки и события, итог цветом

   Формулы — LaTeX: $…$ в строке, $$…$$ отдельной строкой (KaTeX).
   Код JavaScript и Python запускается кнопкой «Запустить» прямо в браузере:
   JS — в изолированном iframe, Python — Pyodide в отдельном потоке.

   Тяжёлые библиотеки (KaTeX, Mermaid, Pyodide) грузятся только когда нужны.
   Блок с ошибкой в JSON не ломает ответ: показывается аккуратная заглушка.

   API: window.HmRich = { splitRich, render, renderPending, mdToHtml, typeset,
                          runCode, chartToImage, findPhoto, KINDS }            */
(function(){
  'use strict';

  var KINDS=['quiz','chart','diagram','mermaid','photo','image','buttons','steps','compare','flow','timeline','figure','molecule','email','tracks'];
  var FENCE_SRC='```[ \\t]*('+KINDS.join('|')+')[ \\t]*\\r?\\n([\\s\\S]*?)```';
  var OPEN_RE=new RegExp('```[ \\t]*('+KINDS.join('|')+')[ \\t]*(?:\\r?\\n[\\s\\S]*)?$','i');

  /* ---------- утилиты ---------- */
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function hash(s){var h=5381;s=String(s||'');for(var i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return (h>>>0).toString(36);}
  function store(k,v){try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||'null');localStorage.setItem(k,JSON.stringify(v));}catch(e){return null;}}
  function t(s){try{return window.i18n&&window.i18n.t?window.i18n.t(s):s;}catch(e){return s;}}
  function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
  var ICON={
    prev:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bulb:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0012 3z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M6 15H5a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    done:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5 11-11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    spin:'<svg class="hmr-spin" viewBox="0 0 24 24" fill="none"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    arrow:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>'
  };

  /* Модели часто пишут «почти JSON»: висячие запятые, «умные» кавычки,
     комментарии. Чиним самое частое и пробуем ещё раз. */
  function parseLoose(src){
    var s=String(src||'').trim();
    try{return JSON.parse(s);}catch(e){}
    s=s.replace(/^\uFEFF/,'').replace(/[\u201c\u201d\u201e]/g,'"').replace(/[\u2018\u2019]/g,"'")
       .replace(/\/\/[^\n"]*$/gm,'').replace(/,\s*([}\]])/g,'$1');
    try{return JSON.parse(s);}catch(e){}
    // одинарные кавычки вместо двойных
    try{return JSON.parse(s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g,function(_,x){return '"'+x.replace(/"/g,'\\"')+'"';}));}catch(e){}
    // LaTeX в строках (\approx, \perp) — недопустимые для JSON экранирования: удваиваем обратную косую.
    try{return JSON.parse(s.replace(/\\(?!["\\/bfnrtu])/g,'\\\\'));}catch(e){}
    return null;
  }

  /* ---------- разбиение ответа на текст и блоки ---------- */
  function splitRich(text){
    var src=String(text||'');var out=[];var re=new RegExp(FENCE_SRC,'gi');var last=0,m;
    while((m=re.exec(src))){
      if(m.index>last)out.push({type:'text',raw:src.slice(last,m.index)});
      out.push({type:'rich',kind:m[1].toLowerCase(),body:m[2],raw:m[0]});
      last=re.lastIndex;
    }
    var tail=src.slice(last);
    var om=OPEN_RE.exec(tail);
    if(om){
      if(om.index>0)out.push({type:'text',raw:tail.slice(0,om.index)});
      out.push({type:'rich-pending',kind:om[1].toLowerCase(),raw:om[0]});
    }else if(tail)out.push({type:'text',raw:tail});
    /* Ответ — конец ответа — кнопки: модель любит подписывать кнопки
       («Выберите следующее действие:», «Что дальше?») — такую строку убираем. */
    for(var i=1;i<out.length;i++){
      var k=out[i];if(!k.kind||k.kind!=='buttons'||out[i-1].type!=='text')continue;
      out[i-1].raw=out[i-1].raw.replace(BTN_LEAD,'\n');
    }
    return out;
  }
  var BTN_LEAD=/\n?[ \t]*(?:[*_#>]+[ \t]*)?(?:выберите|выбери|что дальше|дальше можно|следующ|варианты|можно продолжить|что сделаем|куда двигаемся|next step|choose)[^\n]{0,70}\s*$/i;

  /* ---------- формулы ---------- */
  var MATH_MARK='\u2063HMMATH';
  function protectMath(md){
    var maths=[];
    // Код не трогаем: ```…``` и `…` (незакрытый ``` при стриме — тоже код до конца).
    var parts=String(md||'').split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
    for(var i=0;i<parts.length;i+=2){
      var p=parts[i];if(!p||p.indexOf('$')<0&&p.indexOf('\\(')<0&&p.indexOf('\\[')<0)continue;
      var put=function(tex,display){maths.push({tex:tex,display:display});return MATH_MARK+(maths.length-1)+'\u2063';};
      p=p.replace(/\$\$([\s\S]+?)\$\$/g,function(_,x){return put(x,true);})
         .replace(/\\\[([\s\S]+?)\\\]/g,function(_,x){return put(x,true);})
         .replace(/\\\(([\s\S]+?)\\\)/g,function(_,x){return put(x,false);})
         .replace(/(^|[^\\$\w])\$(?!\s)((?:[^$\n]{0,300}?)[^\s\\$])\$(?![\d\w])/g,function(_,pre,x){return pre+put(x,false);});
      parts[i]=p;
    }
    return {md:parts.join(''),maths:maths};
  }
  /* Модели часто пишут LaTeX без долларов: «\frac{3}{4} + \sqrt{2}». Такие
     куски сами оборачиваем в $…$, чтобы KaTeX их отрисовал. Код не трогаем. */
  var LATEX_CMD=/\\(?:d?frac|tfrac|sqrt|cdot|times|div|pm|mp|leq?|geq?|neq|approx|equiv|infty|pi|alpha|beta|gamma|delta|Delta|theta|lambda|mu|sigma|Sigma|omega|varphi|phi|sum|prod|int|lim|log|ln|sin|cos|tan|cot|to|rightarrow|Rightarrow|circ|degree|angle|perp|parallel|in|notin|subset|cup|cap|forall|exists|overline|vec|hat|bar|binom|left|right|text|mathrm|quad)(?![A-Za-z])/;
  function wrapBareLatex(md){
    var parts=String(md||'').split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g);
    for(var i=0;i<parts.length;i+=2){
      var p=parts[i];if(!p||p.indexOf('\\')<0||!LATEX_CMD.test(p))continue;
      parts[i]=p.replace(/[A-Za-z0-9\\{}^_()\[\]+\-*\/=<>.,|!'° ]*\\[A-Za-z]+[A-Za-z0-9\\{}^_()\[\]+\-*\/=<>.,|!'° ]*/g,function(run){
        if(!LATEX_CMD.test(run))return run;
        var lead=run.match(/^[\s.,]*/)[0],tail=run.match(/[\s.,;:!]*$/)[0];
        var core=run.slice(lead.length,run.length-tail.length);
        return core?lead+'$'+core+'$'+tail:run;
      });
    }
    return parts.join('');
  }
  /* Обычный текст после Markdown: «x^2» → x², «10^-3» → 10⁻³ (через <sup>),
     аккорды «F#m», «Bb7» → F♯m, B♭7. Код, формулы и ссылки не трогаем. */
  function prettifyHtml(html){
    if(typeof document==='undefined'||!/[\^#b]/.test(html))return html;
    var box=document.createElement('div');box.innerHTML=html;
    var walker=document.createTreeWalker(box,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
      for(var p=n.parentNode;p&&p!==box;p=p.parentNode){if(/^(CODE|PRE|A|SCRIPT|STYLE)$/.test(p.nodeName)||(p.classList&&p.classList.contains('hm-math')))return NodeFilter.FILTER_REJECT;}
      return NodeFilter.FILTER_ACCEPT;}});
    var list=[];while(walker.nextNode())list.push(walker.currentNode);
    var POW=/([A-Za-zА-Яа-я0-9)\]π]+)\^(\{([^{}]{1,30})\}|\(([^()]{1,30})\)|(-?\d+(?:[.,]\d+)?|-?[A-Za-zπ][A-Za-z0-9]{0,3}))/g;
    var CHORD=/(^|[\s(\[«"'\/,–—-])([A-G])(#|b)(?=(?:m(?!a[a-z])|maj|min|dim|aug|sus|add|\d|\/|[\s),.;:!?»"'\]]|$))/g;
    list.forEach(function(n){
      var t0=n.nodeValue;
      // «C#» без продолжения может быть языком программирования — заменяем, только если рядом музыка.
      var musicCtx=/аккорд|тональн|нот|гамм|лад|мажор|минор|диез|бемоль|chord|key|scale/i.test(t0);
      var t1=t0.replace(CHORD,function(all,pre,note,acc,off,str){
        var next=str.charAt(off+all.length);
        if(acc==='#'&&!musicCtx&&!/[md\d\/as]/.test(next))return all;
        return pre+note+(acc==='#'?'♯':'♭');
      });
      if(t1.indexOf('^')<0||!POW.test(t1)){if(t1!==t0)n.nodeValue=t1;return;}
      POW.lastIndex=0;
      var frag=document.createDocumentFragment(),last=0,m;
      while((m=POW.exec(t1))){
        frag.appendChild(document.createTextNode(t1.slice(last,m.index)+m[1]));
        var sup=document.createElement('sup');sup.textContent=(m[3]||m[4]||m[5]).replace(/^-/,'−').replace(/\*/g,'·');
        frag.appendChild(sup);last=POW.lastIndex;
      }
      frag.appendChild(document.createTextNode(t1.slice(last)));
      n.parentNode.replaceChild(frag,n);
    });
    return box.innerHTML;
  }
  /* «**Структура.**По» — Markdown не включает жирный, если за закрывающими
     звёздочками сразу идёт буква после знака препинания. Добавляем пробел. */
  function fixEmphasis(md){
    var parts=String(md||'').split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
    for(var i=0;i<parts.length;i+=2){
      if(parts[i]&&parts[i].indexOf('**')>=0)parts[i]=parts[i].replace(/(\*\*[^*\n]{1,160}?[.,:;!?»)…])\*\*(?=[A-Za-zА-Яа-яЁё0-9«(])/g,'$1** ');
    }
    return parts.join('');
  }
  /* Запасная отрисовка формулы, пока KaTeX не загрузился (или если сеть его не
     отдала): дроби столбиком, степени и индексы, корень, знаки — вместо сырого
     «\frac{3}{4}». KaTeX потом заменит её точной вёрсткой. */
  var TEX_SYM={cdot:'·',times:'×',div:'÷',pm:'±',mp:'∓',le:'≤',leq:'≤',ge:'≥',geq:'≥',ne:'≠',neq:'≠',approx:'≈',equiv:'≡',infty:'∞',pi:'π',alpha:'α',beta:'β',gamma:'γ',delta:'δ',Delta:'Δ',theta:'θ',lambda:'λ',mu:'μ',sigma:'σ',Sigma:'Σ',omega:'ω',phi:'φ',varphi:'φ',sum:'∑',prod:'∏',int:'∫',to:'→',rightarrow:'→',Rightarrow:'⇒',circ:'°',degree:'°',angle:'∠',perp:'⊥',parallel:'∥',in:'∈',notin:'∉',cup:'∪',cap:'∩',forall:'∀',exists:'∃',quad:' ',sin:'sin',cos:'cos',tan:'tan',log:'log',ln:'ln',lim:'lim',sharp:'♯',flat:'♭',natural:'♮'};
  function texLite(tex){
    var s=esc(String(tex||''));
    var grp='\\{((?:[^{}]|\\{[^{}]*\\})*)\\}';
    for(var i=0;i<4;i++){
      s=s.replace(new RegExp('\\\\[dt]?frac\\s*'+grp+'\\s*'+grp,'g'),'<span class="hm-tfrac"><span>$1</span><span>$2</span></span>');
      s=s.replace(new RegExp('\\\\sqrt\\s*'+grp,'g'),'√<span class="hm-tsqrt">$1</span>');
      s=s.replace(new RegExp('\\^'+grp,'g'),'<sup>$1</sup>').replace(new RegExp('_'+grp,'g'),'<sub>$1</sub>');
    }
    s=s.replace(/\^([A-Za-z0-9])/g,'<sup>$1</sup>').replace(/_([A-Za-z0-9])/g,'<sub>$1</sub>')
     .replace(/\\(?:left|right|displaystyle|,|;|!)/g,'').replace(/\\text\{([^{}]*)\}|\\mathrm\{([^{}]*)\}/g,'$1$2')
     .replace(/\\([A-Za-z]+)/g,function(m,w){return TEX_SYM[w]!=null?TEX_SYM[w]:w;})
     .replace(/[{}]/g,'');
    return s;
  }
  function mdToHtml(md){
    var pm=protectMath(wrapBareLatex(fixEmphasis(md)));
    var html=typeof window.marked!=='undefined'?window.marked.parse(pm.md):esc(pm.md);
    html=prettifyHtml(html);
    if(!pm.maths.length)return html;
    return html.replace(/\u2063HMMATH(\d+)\u2063/g,function(_,i){
      var m=pm.maths[+i];if(!m)return '';
      return m.display
        ?'<span class="hm-math hm-math-block" data-display="1" data-tex="'+esc(m.tex)+'">'+texLite(m.tex)+'</span>'
        :'<span class="hm-math" data-tex="'+esc(m.tex)+'">'+texLite(m.tex)+'</span>';
    });
  }
  var katexP=null;
  function loadKatex(){
    if(window.katex)return Promise.resolve(window.katex);
    if(katexP)return katexP;
    katexP=new Promise(function(res,rej){
      var base='https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/';
      var css=document.createElement('link');css.rel='stylesheet';css.href=base+'katex.min.css';document.head.appendChild(css);
      var s=document.createElement('script');s.src=base+'katex.min.js';s.async=true;
      s.onload=function(){window.katex?res(window.katex):rej(new Error('katex'));};
      s.onerror=function(){katexP=null;rej(new Error('katex'));};
      document.head.appendChild(s);
    });
    return katexP;
  }
  /* Модели пишут в формулах «x₂», «x²», «−», «·» юникодом — KaTeX такие символы
     не понимает и показывает формулу красным исходником. Переводим их в TeX. */
  var SUB_MAP={'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9','₊':'+','₋':'-','₌':'=','₍':'(','₎':')','ₐ':'a','ₑ':'e','ₒ':'o','ₓ':'x','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t'};
  var SUP_MAP={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')','ⁿ':'n','ⁱ':'i'};
  function normalizeTex(tex){
    var s=String(tex||'');
    s=s.replace(/[₀-ₜᵢⱼ]+/g,function(r){var o='';for(var i=0;i<r.length;i++)o+=SUB_MAP[r[i]]!=null?SUB_MAP[r[i]]:r[i];return '_{'+o+'}';});
    s=s.replace(/[⁰¹²³⁴-⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g,function(r){var o='';for(var i=0;i<r.length;i++)o+=SUP_MAP[r[i]]!=null?SUP_MAP[r[i]]:r[i];return '^{'+o+'}';});
    s=s.replace(/−/g,'-').replace(/·/g,'\\cdot ').replace(/×/g,'\\times ').replace(/÷/g,'\\div ').replace(/≤/g,'\\le ').replace(/≥/g,'\\ge ').replace(/≠/g,'\\ne ').replace(/≈/g,'\\approx ').replace(/√/g,'\\sqrt ').replace(/π/g,'\\pi ').replace(/∞/g,'\\infty ').replace(/°/g,'^{\\circ}');
    s=s.replace(/♯/g,'\\sharp ').replace(/♭/g,'\\flat ').replace(/♮/g,'\\natural ');
    // Русский текст внутри формулы — в \text{}, иначе KaTeX ругается.
    s=s.replace(/([А-Яа-яЁё][А-Яа-яЁё .,:;!?-]*[А-Яа-яЁё.]|[А-Яа-яЁё])/g,function(m,w,off,str){
      var before=str.slice(Math.max(0,off-40),off);
      return /\\(?:text|mathrm|textbf|operatorname)\{[^}]*$/.test(before)?m:'\\text{'+m+'}';
    });
    return s;
  }
  function typeset(root){
    if(!root||!root.querySelector)return;
    var nodes=root.querySelectorAll('.hm-math:not([data-done])');
    if(!nodes.length)return;
    loadKatex().then(function(k){
      nodes.forEach(function(n){
        if(n.dataset.done)return;
        var raw=n.getAttribute('data-tex')||'',opts={displayMode:n.dataset.display==='1',throwOnError:true,strict:'ignore',output:'html'};
        // Сначала как есть, потом нормализованный вариант. Если KaTeX всё равно не
        // справился — остаётся запасная вёрстка texLite (никакого красного исходника).
        var tries=[normalizeTex(raw),raw];
        for(var i=0;i<tries.length;i++){
          try{var tmp=document.createElement('span');k.render(tries[i],tmp,opts);n.innerHTML=tmp.innerHTML;n.dataset.done='1';return;}catch(e){}
        }
        n.dataset.done='1';n.classList.add('hm-math-lite');
      });
    }).catch(function(){});
  }

  /* ======================================================================
     ТЕСТ
     ====================================================================== */
  function normQuiz(raw){
    var d=parseLoose(raw);if(!d)return null;
    var qs=Array.isArray(d)?d:(d.questions||d.items||[]);
    var out=[];
    (qs||[]).forEach(function(q){
      if(!q)return;
      var text=q.question||q.q||q.text||'';
      var opts=q.options||q.answers||q.variants||[];
      var correctIdx=typeof q.answer==='number'?q.answer:typeof q.correct==='number'?q.correct:-1;
      var exps=q.explanations||[];
      var o=opts.map(function(op,i){
        if(typeof op==='string')return {text:op,correct:i===correctIdx,why:exps[i]||''};
        return {text:op.text||op.option||op.label||'',correct:Boolean(op.correct||op.isCorrect||op.right)||i===correctIdx,why:op.explanation||op.why||op.comment||exps[i]||''};
      }).filter(function(x){return x.text;});
      if(!text||o.length<2)return;
      if(!o.some(function(x){return x.correct;}))return; // без правильного ответа вопрос бесполезен
      out.push({q:String(text),opts:o,hint:q.hint||q.tip||'',expl:q.explanation||''});
    });
    return out.length?{title:d.title||'',questions:out}:null;
  }

  function renderQuiz(body,host,ctx){
    var quiz=normQuiz(body);
    if(!quiz)return renderBroken(host,'тест',body);
    var key='hm_quiz_'+hash(body);
    var st=store(key)||{pos:0,ans:{},done:false};
    var card=el('div','hmr-card hmr-quiz');card.setAttribute('role','group');card.setAttribute('aria-label',t('Тест'));
    host.appendChild(card);
    var L='ABCDEFGH';
    function save(){store(key,st);}
    function sendPrompt(p){if(window.HmRich&&window.HmRich.sendPrompt)window.HmRich.sendPrompt(p);}
    function draw(){
      card.innerHTML='';
      if(st.done)return drawResults();
      var n=quiz.questions.length;var i=Math.min(st.pos,n-1);var q=quiz.questions[i];var picked=st.ans[i];
      var head=el('div','hmr-head');
      var prev=el('button','hmr-ib',ICON.prev);prev.type='button';prev.setAttribute('aria-label',t('Предыдущий вопрос'));prev.disabled=i===0;
      prev.onclick=function(){st.pos=i-1;save();draw();};
      var cnt=el('span','hmr-counter',(i+1)+' '+t('из')+' '+n);
      var nxt=el('button','hmr-ib',ICON.next);nxt.type='button';nxt.setAttribute('aria-label',t('Следующий вопрос'));
      nxt.disabled=!(picked!=null&&i<n-1);nxt.onclick=function(){st.pos=i+1;save();draw();};
      head.append(prev,cnt,nxt,el('span','hmr-sp'));
      if(q.hint){
        var bulb=el('button','hmr-ib'+(st.hint===i?' on':''),ICON.bulb);bulb.type='button';bulb.title=t('Подсказка');bulb.setAttribute('aria-label',t('Подсказка'));
        bulb.onclick=function(){st.hint=st.hint===i?null:i;save();draw();};head.appendChild(bulb);
      }
      var cp=el('button','hmr-ib',ICON.copy);cp.type='button';cp.title=t('Копировать тест');cp.setAttribute('aria-label',t('Копировать тест'));
      cp.onclick=function(){
        var txt=(quiz.title?quiz.title+'\n\n':'')+quiz.questions.map(function(qq,k){return (k+1)+'. '+qq.q+'\n'+qq.opts.map(function(o,j){return '   '+L[j]+') '+o.text;}).join('\n');}).join('\n\n');
        try{navigator.clipboard.writeText(txt).then(function(){cp.innerHTML=ICON.done;setTimeout(function(){cp.innerHTML=ICON.copy;},1300);});}catch(e){}
      };
      head.appendChild(cp);card.appendChild(head);
      card.appendChild(el('div','hmr-q',mdToHtml(q.q).replace(/^<p>|<\/p>\s*$/g,'')));
      if(st.hint===i&&q.hint)card.appendChild(el('div','hmr-hint',esc(q.hint)));
      var list=el('div','hmr-opts');
      q.opts.forEach(function(o,j){
        var b=el('button','hmr-opt');b.type='button';
        var state='';
        if(picked!=null){
          b.disabled=true;
          if(o.correct)state=' ok';else if(j===picked)state=' bad';else state=' dim';
        }
        b.className='hmr-opt'+state;
        b.innerHTML='<span class="hmr-letter">'+L[j]+'</span><span class="hmr-otext">'+mdToHtml(o.text).replace(/^<p>|<\/p>\s*$/g,'')+'</span>'
          +(picked!=null&&(o.correct||j===picked)&&o.why?'<span class="hmr-why">'+esc(o.why)+'</span>':'');
        if(picked==null)b.onclick=function(){st.ans[i]=j;st.hint=null;save();draw();};
        list.appendChild(b);
      });
      card.appendChild(list);
      var foot=el('div','hmr-foot');
      if(picked!=null){
        var ex=el('button','hmr-link',t('Разобрать вопрос'));ex.type='button';
        ex.onclick=function(){
          var right=q.opts.filter(function(o){return o.correct;}).map(function(o){return o.text;}).join('; ');
          sendPrompt('Разбери подробно вопрос из теста: «'+q.q+'». Я выбрал «'+q.opts[picked].text+'», правильный ответ — «'+right+'». Объясни, почему так, и как не ошибиться в похожих заданиях.');
        };
        foot.appendChild(ex);
      }else foot.appendChild(el('span','hmr-sp'));
      var last=i===n-1;
      var go=el('button','hmr-btn'+(picked!=null?' primary':''),t(last?'Результаты':'Далее'));go.type='button';go.disabled=picked==null;
      go.onclick=function(){if(last){st.done=true;}else st.pos=i+1;save();draw();};
      foot.appendChild(go);card.appendChild(foot);
      typeset(card);
    }
    function drawResults(){
      var n=quiz.questions.length;var right=0;
      quiz.questions.forEach(function(q,i){var p=st.ans[i];if(p!=null&&q.opts[p]&&q.opts[p].correct)right++;});
      var pct=Math.round(right/n*100);
      var box=el('div','hmr-res');
      var R=32,C=2*Math.PI*R;
      var verdict=pct===100?t('Отлично! Все ответы верные.'):pct>=70?t('Хороший результат!'):pct>=40?t('Неплохо, но есть что повторить.'):t('Стоит разобрать тему ещё раз.');
      box.innerHTML='<div class="hmr-score"><svg class="hmr-ring" viewBox="0 0 76 76" aria-hidden="true"><circle class="bg" cx="38" cy="38" r="'+R+'"/><circle class="fg" cx="38" cy="38" r="'+R+'" transform="rotate(-90 38 38)" stroke-dasharray="'+C.toFixed(1)+'" stroke-dashoffset="'+C.toFixed(1)+'"/></svg>'
        +'<div><b>'+right+' '+t('из')+' '+n+'</b><span>'+esc(verdict)+' ('+pct+'%)</span></div></div>';
      var ul=el('ul','hmr-rlist');
      quiz.questions.forEach(function(q,i){
        var p=st.ans[i];var ok=p!=null&&q.opts[p]&&q.opts[p].correct;
        var right=q.opts.filter(function(o){return o.correct;}).map(function(o){return o.text;}).join('; ');
        var li=el('li');li.innerHTML='<span class="hmr-mark '+(ok?'ok':'bad')+'">'+(ok?'✓':'✕')+'</span><div>'+esc(q.q)+(ok?'':'<small>'+esc(t('Верно:'))+' '+esc(right)+'</small>')+'</div>';
        ul.appendChild(li);
      });
      box.appendChild(ul);
      var foot=el('div','hmr-foot');
      var again=el('button','hmr-btn',t('Пройти заново'));again.type='button';
      again.onclick=function(){st={pos:0,ans:{},done:false};save();draw();};
      var wrong=quiz.questions.map(function(q,i){var p=st.ans[i];return p!=null&&!q.opts[p].correct?q:null;}).filter(Boolean);
      var right2=el('div');right2.style.cssText='display:flex;gap:8px;flex-wrap:wrap;';
      if(wrong.length){
        var exp=el('button','hmr-btn primary',t('Разобрать ошибки'));exp.type='button';
        exp.onclick=function(){
          sendPrompt('Я прошёл тест и ошибся в вопросах:\n'+wrong.map(function(q,k){var p=st.ans[quiz.questions.indexOf(q)];return (k+1)+'. «'+q.q+'» — я ответил «'+q.opts[p].text+'»';}).join('\n')+'\nРазбери каждую ошибку простым языком и дай короткое правило, чтобы запомнить.');
        };
        right2.appendChild(exp);
      }else{
        var more=el('button','hmr-btn primary',t('Тест посложнее'));more.type='button';
        more.onclick=function(){sendPrompt('Сделай ещё один тест по этой же теме, но посложнее'+(n?' — '+n+' вопрос'+(n>4?'ов':n>1?'а':''):'')+'.');};
        right2.appendChild(more);
      }
      foot.append(again,right2);box.appendChild(foot);
      card.appendChild(box);
      requestAnimationFrame(function(){var fg=card.querySelector('.hmr-ring .fg');if(fg)fg.style.strokeDashoffset=(C*(1-right/n)).toFixed(1);});
    }
    draw();
    return card;
  }

  function quizSkeleton(host){
    var card=el('div','hmr-card hmr-skel');
    card.innerHTML='<div class="hmr-head"><span class="hmr-ib" aria-hidden="true">'+ICON.prev+'</span>'+ICON.spin+'<span class="hmr-ib" aria-hidden="true">'+ICON.next+'</span><span class="hmr-sp"></span><span class="hmr-ib" aria-hidden="true">'+ICON.bulb+'</span></div>'
      +'<div class="hmr-bar" style="width:92%"></div><div class="hmr-bar" style="width:62%"></div>'
      +['A','B','C','D'].map(function(x){return '<div class="hmr-row"><span class="hmr-letter">'+x+'</span><span class="hmr-bar"></span></div>';}).join('')
      +'<div class="hmr-skel-label" style="justify-content:flex-end">'+esc(t('Составляю тест…'))+'</div>';
    host.appendChild(card);return card;
  }

  /* ======================================================================
     ГРАФИКИ
     ====================================================================== */
  /* Безопасный разбор формул (без eval): + − × ÷ ^, скобки, функции, константы,
     неявное умножение «2x», «3(x+1)», «x sin x» → «x*sin(x)» не поддерживается. */
  var FUNCS={sin:Math.sin,cos:Math.cos,tan:Math.tan,tg:Math.tan,asin:Math.asin,acos:Math.acos,atan:Math.atan,arctg:Math.atan,arcsin:Math.asin,arccos:Math.acos,
    sinh:Math.sinh,cosh:Math.cosh,tanh:Math.tanh,sqrt:Math.sqrt,cbrt:Math.cbrt,abs:Math.abs,ln:Math.log,log:Math.log10,lg:Math.log10,log2:Math.log2,exp:Math.exp,
    floor:Math.floor,ceil:Math.ceil,round:Math.round,sign:Math.sign,min:Math.min,max:Math.max,pow:Math.pow,ctg:function(x){return 1/Math.tan(x);}};
  var CONSTS={pi:Math.PI,'π':Math.PI,e:Math.E,tau:2*Math.PI};
  function compileExpr(src){
    var s=String(src||'').replace(/·|×/g,'*').replace(/÷/g,'/').replace(/−/g,'-').replace(/,(?=\d)/g,'.');
    var toks=[];var re=/\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-zπ_][A-Za-z0-9_]*|\*\*|[-+*/^(),])/y;var m;re.lastIndex=0;
    while(re.lastIndex<s.length){var p=re.lastIndex;m=re.exec(s);if(!m){if(/^\s*$/.test(s.slice(p)))break;throw new Error('Не понимаю «'+s.slice(p,p+8)+'»');}toks.push(m[1]);}
    // неявное умножение
    var tk=[];
    for(var i=0;i<toks.length;i++){
      var a=tk[tk.length-1],b=toks[i];
      var aEnd=a!=null&&(/^[\d.]/.test(a)||a===')'||(/^[A-Za-zπ_]/.test(a)&&!FUNCS[a.toLowerCase()]));
      var bStart=/^[\d.A-Za-zπ_(]/.test(b);
      if(aEnd&&bStart&&!(/^[\d.]/.test(a)&&/^[\d.]/.test(b)))tk.push('*');
      tk.push(b);
    }
    var pos=0;
    function peek(){return tk[pos];}
    function eat(x){if(tk[pos]!==x)throw new Error('Ожидалось «'+x+'»');pos++;}
    function expr(){var f=term();while(peek()==='+'||peek()==='-'){var op=tk[pos++];var g=term();f=(function(f,g,op){return op==='+'?function(v){return f(v)+g(v);}:function(v){return f(v)-g(v);};})(f,g,op);}return f;}
    function term(){var f=unary();while(peek()==='*'||peek()==='/'){var op=tk[pos++];var g=unary();f=(function(f,g,op){return op==='*'?function(v){return f(v)*g(v);}:function(v){return f(v)/g(v);};})(f,g,op);}return f;}
    function unary(){if(peek()==='-'){pos++;var f=unary();return function(v){return -f(v);};}if(peek()==='+'){pos++;return unary();}return power();}
    function power(){var b=primary();if(peek()==='^'||peek()==='**'){pos++;var e=unary();return function(v){return Math.pow(b(v),e(v));};}return b;}
    function primary(){
      var x=tk[pos++];if(x==null)throw new Error('Формула оборвалась');
      if(/^[\d.]/.test(x)){var n=parseFloat(x);return function(){return n;};}
      if(x==='('){var f=expr();eat(')');return f;}
      if(/^[A-Za-zπ_]/.test(x)){
        var lx=x.toLowerCase();
        if(FUNCS[lx]&&peek()==='('){pos++;var args=[expr()];while(peek()===','){pos++;args.push(expr());}eat(')');var fn=FUNCS[lx];
          return function(v){var a=[];for(var k=0;k<args.length;k++)a.push(args[k](v));return fn.apply(null,a);};}
        if(FUNCS[lx]){var arg=unary();var fn1=FUNCS[lx];return function(v){return fn1(arg(v));};}
        if(lx in CONSTS&&!(x in {}))return (function(c){return function(v){return x in v?v[x]:c;};})(CONSTS[lx]);
        return function(v){var r=v[x];return r==null?NaN:r;};
      }
      throw new Error('Неожиданный символ «'+x+'»');
    }
    var f=expr();if(pos<tk.length)throw new Error('Лишнее «'+tk[pos]+'»');
    return f;
  }
  function niceTicks(min,max,count){
    if(!isFinite(min)||!isFinite(max)||min===max){max=min+1;}
    var span=max-min;var step=Math.pow(10,Math.floor(Math.log10(span/count)));var err=span/count/step;
    if(err>=7.5)step*=10;else if(err>=3.5)step*=5;else if(err>=1.5)step*=2;
    var out=[];for(var v=Math.ceil(min/step)*step;v<=max+step*1e-9;v+=step)out.push(+v.toFixed(10));
    return out;
  }
  function fmtNum(v){if(!isFinite(v))return '—';var a=Math.abs(v);if(a!==0&&(a>=1e5||a<1e-3))return v.toExponential(1);return String(+v.toFixed(a<1?3:a<100?2:1)).replace('.',',');}
  var PALETTE=['#4f7cff','#f97316','#16a34a','#e11d48','#a855f7','#0ea5e9','#eab308','#14b8a6'];

  /* Формула в любом виде → то, что понимает compileExpr:
     LaTeX (\frac{1}{x}, \sqrt{x}, x^{2}, \cdot), надстрочные цифры (x²),
     модуль |x|, «y =», «f(x) =», юникодные минусы и знаки умножения. */
  var SUPS={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁻':'-','⁺':'+'};
  function exprToPlain(src){
    var s=String(src||'').trim().replace(/^\$+|\$+$/g,'');
    s=s.replace(/^\s*(?:[a-zA-Z]\s*\(\s*x\s*\)|y)\s*=\s*/,'');
    for(var i=0;i<4;i++)s=s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,'(($1)/($2))');
    s=s.replace(/\\sqrt\s*\[(\d+)\]\s*\{([^{}]*)\}/g,'(($2)^(1/$1))').replace(/\\sqrt\s*\{([^{}]*)\}/g,'sqrt($1)')
     .replace(/\\left|\\right/g,'').replace(/\\cdot|\\times/g,'*').replace(/\\div/g,'/').replace(/\\pi/g,'pi')
     .replace(/\\(sin|cos|tan|cot|ln|log|exp|arcsin|arccos|arctan)/g,'$1').replace(/\\,|\;|\\!/g,'')
     .replace(/\^\{([^{}]*)\}/g,'^($1)').replace(/[{}]/g,function(c){return c==='{'?'(':')';});
    s=s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g,function(m){return '^('+m.split('').map(function(c){return SUPS[c];}).join('')+')';});
    s=s.replace(/√\s*\(/g,'sqrt(').replace(/√\s*([A-Za-z0-9.]+)/g,'sqrt($1)');
    s=s.replace(/\|([^|]+)\|/g,'abs($1)');
    return s;
  }
  function pickExpr(f){
    if(f==null)return '';
    if(typeof f==='string'||typeof f==='number')return String(f);
    return String(f.expr||f.expression||f.y||f.f||f.fn||f.func||f.function||f.formula||f.equation||f.eq||'');
  }
  function rangeOf(v,dflt){
    if(Array.isArray(v)&&v.length>=2&&isFinite(+v[0])&&isFinite(+v[1]))return [+v[0],+v[1]];
    if(v&&typeof v==='object'&&isFinite(+v.min)&&isFinite(+v.max))return [+v.min,+v.max];
    if(typeof v==='string'){var m=v.match(/(-?\d+(?:\.\d+)?)\s*(?:\.\.|…|;|,|to|до)\s*(-?\d+(?:\.\d+)?)/);if(m)return [+m[1],+m[2]];}
    return dflt;
  }
  var KNOWN=/^(x|pi|e|tau|π)$/i;
  function freeVars(expr){
    var out=[];(String(expr).match(/[A-Za-z_][A-Za-z0-9_]*/g)||[]).forEach(function(w){
      if(KNOWN.test(w)||FUNCS[w.toLowerCase()])return;
      // «kx», «ab» без знака — несколько однобуквенных параметров подряд
      var parts=w.length<=3&&/^[a-z]+$/i.test(w)&&!FUNCS[w.toLowerCase()]?w.split(''):[w];
      parts.forEach(function(p){if(!KNOWN.test(p)&&out.indexOf(p)<0)out.push(p);});
    });
    return out;
  }
  /* Текст вместо JSON: «y = 2x + 1», «f(x)=x^2; -5..5» — по одной функции на строку. */
  function chartFromText(raw){
    var lines=String(raw||'').split(/\n|;(?![^(]*\))/).map(function(l){return l.trim();}).filter(Boolean);
    var fns=[],x=null;
    lines.forEach(function(l){
      var r=rangeOf(l,null);if(r&&!/[a-wyzA-Z]{2,}|=/.test(l.replace(/x/g,''))){x=r;return;}
      if(/(^|[^a-z])x([^a-z]|$)/i.test(l)&&/[=x]/.test(l))fns.push({expr:l});
    });
    return fns.length?{type:'function',functions:fns,x:x||undefined}:null;
  }

  function normChart(raw){
    var d=parseLoose(raw);
    if(!d||typeof d!=='object'){d=chartFromText(raw);if(!d)return null;}
    if(Array.isArray(d))d=d.length&&typeof d[0]==='object'&&(d[0].data||d[0].values)?{series:d}:{functions:d};
    var fnSrc=d.functions||d.function||d.functions_list||d.expressions||d.expression||d.expr||d.equations||d.equation||d.formula||d.formulas||d.plots||d.graphs||d.fn||d.f;
    if(!fnSrc&&Array.isArray(d.lines)&&d.lines.some(function(l){return pickExpr(l);}))fnSrc=d.lines;
    if(!fnSrc&&Array.isArray(d.series)&&d.series.some(function(l){return l&&(l.expr||l.expression||l.formula);}))fnSrc=d.series;
    var type=String(d.type||(fnSrc?'function':'line')).toLowerCase();
    if(fnSrc||/function|plot|graph|функц/.test(type)){
      var list=Array.isArray(fnSrc)?fnSrc:(fnSrc?[fnSrc]:[]);
      var fns=list.map(function(f){
        var e=pickExpr(f);
        var lbl=(f&&typeof f==='object'&&(f.label||f.name||f.title))||('y = '+String(e).replace(/^\s*y\s*=\s*/i,''));
        return {expr:e,label:String(lbl)};
      }).filter(function(f){return String(f.expr).trim();});
      if(!fns.length)return null;
      // Параметры: массив, объект {k:2} или {k:{min,max,value}}
      var rawP=d.params||d.parameters||d.sliders||d.vars||d.variables||[];
      if(!Array.isArray(rawP))rawP=Object.keys(rawP).map(function(k){var v=rawP[k];return v&&typeof v==='object'?Object.assign({name:k},v):{name:k,value:+v};});
      var params=rawP.map(function(p){
        var min=+p.min,max=+p.max,v=+(p.value!=null?p.value:p.default!=null?p.default:p.initial);
        if(!isFinite(min))min=isFinite(v)?Math.min(-5,v-5):-5;
        if(!isFinite(max))max=isFinite(v)?Math.max(5,v+5):5;
        if(!isFinite(v))v=(min+max)/2;
        return {name:String(p.name||p.id||'a'),label:p.label||p.title||p.name,min:min,max:max,step:+p.step||(max-min)/100,value:v};
      });
      // «kx», «ab» — произведение однобуквенных величин, если так не назван параметр.
      var have={};params.forEach(function(p){have[p.name]=1;});
      var plain=fns.map(function(f){
        return exprToPlain(f.expr).replace(/[A-Za-z_][A-Za-z0-9_]*/g,function(w){
          if(have[w]||FUNCS[w.toLowerCase()]||KNOWN.test(w)||w.length<2||w.length>3||!/^[a-z]+$/i.test(w))return w;
          return w.split('').join('*');
        });
      });
      var compiled=[];
      try{plain.forEach(function(e){compiled.push(compileExpr(e));});}catch(e){return {error:e.message};}
      // Буквы в формуле без значения (y = kx + b) — сами делаем ползунки.
      plain.forEach(function(e){freeVars(e).forEach(function(n){
        if(have[n])return;have[n]=1;
        params.push({name:n,label:n,min:-5,max:5,step:0.1,value:n==='b'||n==='c'?1:2});
      });});
      var x=rangeOf(d.x||d.xRange||d.x_range||d.domain||d.range,null)||(isFinite(+d.xMin)&&isFinite(+d.xMax)?[+d.xMin,+d.xMax]:[-10,10]);
      var y=rangeOf(d.y||d.yRange||d.y_range,null)||(isFinite(+d.yMin)&&isFinite(+d.yMax)?[+d.yMin,+d.yMax]:null);
      return {kind:'fn',title:d.title||'',fns:fns,compiled:compiled,params:params,x:x,y:y,xLabel:d.xLabel||'x',yLabel:d.yLabel||'y'};
    }
    var labels=d.labels||d.categories||(Array.isArray(d.x)?d.x:[])||[];
    var series=d.series||d.datasets||(d.data?[{name:d.name||'',data:d.data}]:[]);
    if(!Array.isArray(series))series=[series];
    series=series.map(function(s,i){
      var data=s.data||s.values||s.y||[];
      // [{label:'Янв', value:10}] или [{x:1,y:2}]
      if(data.length&&typeof data[0]==='object'){
        if(!labels.length)labels=data.map(function(p){return p.label!=null?p.label:p.name!=null?p.name:p.x;});
        data=data.map(function(p){return p.value!=null?p.value:p.y!=null?p.y:p.count;});
      }
      return {name:s.name||s.label||'',data:data.map(Number),color:s.color||PALETTE[i%PALETTE.length]};
    }).filter(function(s){return s.data.length;});
    if(!series.length)return null;
    if(!labels.length)labels=series[0].data.map(function(_,i){return String(i+1);});
    return {kind:/bar|column|hist/.test(type)?'bar':/pie|donut/.test(type)?'pie':/scatter|point/.test(type)?'scatter':/area/.test(type)?'area':'line',
      title:d.title||'',labels:labels.map(String),series:series,xLabel:d.xLabel||'',yLabel:d.yLabel||''};
  }

  /* SVG-строка графика: одна функция и для живого блока, и для PNG в документах. */
  function chartSvg(c,o){
    var W=o.w,H=o.h,col=o.colors||{};var P={l:46,r:14,t:12,b:o.xTitle?42:28};
    var iw=W-P.l-P.r,ih=H-P.t-P.b;var s=[];
    var axis=col.axis?' stroke="'+col.axis+'"':'',grid=col.grid?' stroke="'+col.grid+'"':'',tick=col.tick?' fill="'+col.tick+'"':'';
    var out={};
    if(c.kind==='pie'){
      var data=c.series[0].data;var sum=data.reduce(function(a,b){return a+Math.max(0,b);},0)||1;
      var cx=W/2,cy=H/2,r=Math.min(W,H)/2-16,a0=-Math.PI/2;
      data.forEach(function(v,i){
        var a1=a0+Math.max(0,v)/sum*2*Math.PI;var large=a1-a0>Math.PI?1:0;
        var x0=cx+r*Math.cos(a0),y0=cy+r*Math.sin(a0),x1=cx+r*Math.cos(a1),y1=cy+r*Math.sin(a1);
        s.push('<path d="M'+cx+','+cy+' L'+x0.toFixed(1)+','+y0.toFixed(1)+' A'+r+','+r+' 0 '+large+' 1 '+x1.toFixed(1)+','+y1.toFixed(1)+' Z" fill="'+PALETTE[i%PALETTE.length]+'" stroke="'+(col.bg||'#fff')+'" stroke-width="2" data-i="'+i+'"/>');
        var am=(a0+a1)/2;if(v/sum>0.05)s.push('<text x="'+(cx+r*0.62*Math.cos(am)).toFixed(1)+'" y="'+(cy+r*0.62*Math.sin(am)+4).toFixed(1)+'" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">'+Math.round(v/sum*100)+'%</text>');
        a0=a1;
      });
      return {svg:s.join(''),meta:out};
    }
    var xmin,xmax,ymin=Infinity,ymax=-Infinity,lines=[];
    if(c.kind==='fn'){
      xmin=c.x[0];xmax=c.x[1];if(!(xmax>xmin)){xmin=-10;xmax=10;}
      var vars={};c.params.forEach(function(p){vars[p.name]=p.value;});
      var N=Math.max(200,Math.min(700,iw*1.5));var all=[];
      c.compiled.forEach(function(f){var pts=[];for(var k=0;k<=N;k++){var x=xmin+(xmax-xmin)*k/N;vars.x=x;var y;try{y=f(vars);}catch(e){y=NaN;}pts.push([x,y]);if(isFinite(y))all.push(y);}lines.push(pts);});
      if(c.y){ymin=+c.y[0];ymax=+c.y[1];}
      else if(c.params.length){
        /* С ползунками шкала фиксируется по всему диапазону параметров —
           иначе автоподгонка «съедала» изменение амплитуды и график не менялся. */
        if(!c._yFixed){
          var vals=[],ps=c.params.slice(0,4),combos=1<<ps.length;
          for(var mask=0;mask<combos;mask++){
            var vv={};c.params.forEach(function(p){vv[p.name]=p.value;});
            ps.forEach(function(p,bi){vv[p.name]=(mask>>bi)&1?p.max:p.min;});
            c.compiled.forEach(function(f){for(var k=0;k<=120;k++){vv.x=xmin+(xmax-xmin)*k/120;var y;try{y=f(vv);}catch(e){y=NaN;}if(isFinite(y))vals.push(y);}});
          }
          all.forEach(function(y){vals.push(y);});
          vals.sort(function(a,b){return a-b;});
          var lo=vals[Math.floor(vals.length*0.01)],hi=vals[Math.ceil(vals.length*0.99)-1];var pad2=(hi-lo)*0.08||1;
          c._yFixed=[lo-pad2,hi+pad2];
        }
        ymin=c._yFixed[0];ymax=c._yFixed[1];
      }
      else if(all.length){all.sort(function(a,b){return a-b;});ymin=all[Math.floor(all.length*0.02)];ymax=all[Math.ceil(all.length*0.98)-1];var pad=(ymax-ymin)*0.12||1;ymin-=pad;ymax+=pad;}
      if(!isFinite(ymin)||!isFinite(ymax)){ymin=-1;ymax=1;}
    }else{
      xmin=0;xmax=c.labels.length-1;
      c.series.forEach(function(se){se.data.forEach(function(v){if(isFinite(v)){ymin=Math.min(ymin,v);ymax=Math.max(ymax,v);}});});
      if(c.kind==='bar'||c.kind==='area')ymin=Math.min(0,ymin);
      var pd=(ymax-ymin)*0.1||1;ymax+=pd;if(ymin<0||c.kind==='line'||c.kind==='scatter')ymin-=c.kind==='bar'?0:pd;
    }
    var X=function(v){return P.l+(c.kind==='bar'?(v+0.5)/(c.labels.length)*iw:(v-xmin)/(xmax-xmin||1)*iw);};
    var Y=function(v){return P.t+(1-(v-ymin)/(ymax-ymin||1))*ih;};
    out.X=X;out.Y=Y;out.P=P;out.iw=iw;out.xmin=xmin;out.xmax=xmax;out.lines=lines;
    // сетка и оси
    niceTicks(ymin,ymax,5).forEach(function(v){var y=Y(v).toFixed(1);s.push('<line class="grid"'+grid+' x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y+'" y2="'+y+'"/>');s.push('<text class="tick"'+tick+' x="'+(P.l-6)+'" y="'+(+y+4)+'" text-anchor="end" font-size="11">'+fmtNum(v)+'</text>');});
    if(c.kind==='fn'){
      niceTicks(xmin,xmax,Math.max(4,Math.floor(iw/70))).forEach(function(v){var x=X(v).toFixed(1);s.push('<line class="grid"'+grid+' y1="'+P.t+'" y2="'+(H-P.b)+'" x1="'+x+'" x2="'+x+'"/>');s.push('<text class="tick"'+tick+' x="'+x+'" y="'+(H-P.b+16)+'" text-anchor="middle" font-size="11">'+fmtNum(v)+'</text>');});
      if(ymin<0&&ymax>0)s.push('<line class="ax"'+axis+' x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+Y(0).toFixed(1)+'" y2="'+Y(0).toFixed(1)+'"/>');
      if(xmin<0&&xmax>0)s.push('<line class="ax"'+axis+' y1="'+P.t+'" y2="'+(H-P.b)+'" x1="'+X(0).toFixed(1)+'" x2="'+X(0).toFixed(1)+'"/>');
      lines.forEach(function(pts,li){
        var d='',pen=false;
        pts.forEach(function(p,k){
          var ok=isFinite(p[1])&&p[1]>ymin-(ymax-ymin)*3&&p[1]<ymax+(ymax-ymin)*3;
          if(ok&&k&&pen&&Math.abs(p[1]-pts[k-1][1])>(ymax-ymin)*1.5)pen=false; // разрыв (асимптота)
          if(!ok){pen=false;return;}
          d+=(pen?'L':'M')+X(p[0]).toFixed(1)+','+Math.max(-5000,Math.min(5000,Y(p[1]))).toFixed(1);pen=true;
        });
        s.push('<path d="'+d+'" fill="none" stroke="'+PALETTE[li%PALETTE.length]+'" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#'+o.clip+')"/>');
      });
    }else{
      var step=Math.max(1,Math.ceil(c.labels.length/Math.max(2,Math.floor(iw/64))));
      c.labels.forEach(function(lb,i){if(i%step)return;s.push('<text class="tick"'+tick+' x="'+X(i).toFixed(1)+'" y="'+(H-P.b+16)+'" text-anchor="middle" font-size="11">'+esc(lb.length>12?lb.slice(0,11)+'…':lb)+'</text>');});
      s.push('<line class="ax"'+axis+' x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+Y(Math.max(ymin,0)).toFixed(1)+'" y2="'+Y(Math.max(ymin,0)).toFixed(1)+'"/>');
      var ns=c.series.length,bw=Math.min(iw/c.labels.length*0.62/ns,56);
      c.series.forEach(function(se,si){
        if(c.kind==='bar'){se.data.forEach(function(v,i){var x=X(i)-bw*ns/2+bw*si;var y0=Y(Math.max(ymin,0)),y1=Y(v);
          s.push('<rect x="'+x.toFixed(1)+'" y="'+Math.min(y0,y1).toFixed(1)+'" width="'+(bw-4).toFixed(1)+'" height="'+Math.abs(y1-y0).toFixed(1)+'" rx="6" fill="'+se.color+'" data-s="'+si+'" data-i="'+i+'"/>');
          if(bw>=22)s.push('<text class="tick"'+tick+' x="'+(x+(bw-4)/2).toFixed(1)+'" y="'+(Math.min(y0,y1)-6).toFixed(1)+'" text-anchor="middle" font-size="11" font-weight="600">'+fmtNum(v)+'</text>');});return;}
        var d=se.data.map(function(v,i){return (i?'L':'M')+X(i).toFixed(1)+','+Y(v).toFixed(1);}).join('');
        if(c.kind==='area')s.push('<path d="'+d+'L'+X(se.data.length-1).toFixed(1)+','+Y(Math.max(ymin,0)).toFixed(1)+'L'+X(0).toFixed(1)+','+Y(Math.max(ymin,0)).toFixed(1)+'Z" fill="'+se.color+'" fill-opacity=".18"/>');
        if(c.kind!=='scatter')s.push('<path d="'+d+'" fill="none" stroke="'+se.color+'" stroke-width="2.4" stroke-linejoin="round"/>');
        se.data.forEach(function(v,i){s.push('<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(v).toFixed(1)+'" r="'+(c.kind==='scatter'?4:3)+'" fill="'+se.color+'"/>');});
      });
    }
    if(o.xTitle)s.push('<text class="lbl"'+tick+' x="'+(P.l+iw/2)+'" y="'+(H-6)+'" text-anchor="middle" font-size="12">'+esc(o.xTitle)+'</text>');
    s.unshift('<defs><clipPath id="'+o.clip+'"><rect x="'+P.l+'" y="'+P.t+'" width="'+iw+'" height="'+ih+'"/></clipPath></defs>');
    return {svg:s.join(''),meta:out};
  }

  var chartSeq=0;
  function renderChart(body,host){
    var c=normChart(body);
    if(!c)return renderBroken(host,'график',body);
    if(c.error)return renderBroken(host,'график','Ошибка в формуле: '+c.error);
    var card=el('div','hmr-card hmr-chart');host.appendChild(card);
    if(c.title)card.appendChild(el('div','hmr-chart-title',esc(c.title)));
    var svgWrap=el('div');card.appendChild(svgWrap);
    var readout=el('div','hmr-readout');card.appendChild(readout);
    var clip='hmrclip'+(++chartSeq);var hoverX=null;var meta=null;
    function draw(){
      var W=Math.max(260,Math.round(svgWrap.clientWidth||card.clientWidth||560));var H=Math.round(Math.min(340,Math.max(220,W*0.56)));
      var r=chartSvg(c,{w:W,h:H,clip:clip,xTitle:c.kind==='fn'?'':c.xLabel});meta=r.meta;
      var cross='';
      if(hoverX!=null&&c.kind!=='pie'&&meta.X){
        var x=meta.X(hoverX);cross='<line x1="'+x.toFixed(1)+'" x2="'+x.toFixed(1)+'" y1="'+meta.P.t+'" y2="'+(H-meta.P.b)+'" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 3"/>';
        if(c.kind==='fn'){var vars={x:hoverX};c.params.forEach(function(p){vars[p.name]=p.value;});
          c.compiled.forEach(function(f,i){var y=f(vars);if(isFinite(y))cross+='<circle cx="'+x.toFixed(1)+'" cy="'+meta.Y(y).toFixed(1)+'" r="4.5" fill="'+PALETTE[i%PALETTE.length]+'" stroke="var(--bg2)" stroke-width="2"/>';});}
      }
      svgWrap.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="'+esc(c.title||t('График'))+'">'+r.svg+cross+'</svg>';
    }
    function pointer(ev){
      if(!meta||c.kind==='pie')return;
      var svg=svgWrap.querySelector('svg');var rect=svg.getBoundingClientRect();var px=(ev.touches?ev.touches[0].clientX:ev.clientX)-rect.left;
      var W=rect.width;var x;
      if(c.kind==='fn'){x=meta.xmin+(px-meta.P.l)/meta.iw*(meta.xmax-meta.xmin);x=Math.max(meta.xmin,Math.min(meta.xmax,x));hoverX=x;
        var vars={x:x};c.params.forEach(function(p){vars[p.name]=p.value;});
        readout.textContent='x = '+fmtNum(x)+'   '+c.compiled.map(function(f,i){return (c.fns[i].label||'y').replace(/=.*$/,'').trim()+' = '+fmtNum(f(vars));}).join('   ');
      }else{var i=Math.round((px-meta.P.l)/meta.iw*c.labels.length-0.5);if(c.kind!=='bar')i=Math.round((px-meta.P.l)/meta.iw*(c.labels.length-1));i=Math.max(0,Math.min(c.labels.length-1,i));hoverX=i;
        readout.textContent=c.labels[i]+':   '+c.series.map(function(s){return (s.name?s.name+' — ':'')+fmtNum(s.data[i]);}).join('   ');}
      draw();
    }
    svgWrap.addEventListener('mousemove',pointer);svgWrap.addEventListener('touchmove',pointer,{passive:true});
    svgWrap.addEventListener('mouseleave',function(){hoverX=null;readout.textContent='';draw();});
    // легенда
    var items=c.kind==='fn'?c.fns.map(function(f,i){return {name:f.label,color:PALETTE[i%PALETTE.length]};}):c.kind==='pie'?c.labels.map(function(l,i){return {name:l+' — '+fmtNum(c.series[0].data[i]),color:PALETTE[i%PALETTE.length]};}):c.series.filter(function(s){return s.name;}).map(function(s){return {name:s.name,color:s.color};});
    if(items.length>1||c.kind==='fn'||c.kind==='pie'){var lg=el('div','hmr-legend');items.forEach(function(it){var sp=el('span');sp.innerHTML='<i style="background:'+it.color+'"></i>'+mdToHtml(String(it.name).replace(/\s*\*\s*/g,'·')).replace(/^<p>|<\/p>\s*$/g,'');lg.appendChild(sp);});card.appendChild(lg);}
    // ползунки параметров
    if(c.kind==='fn'&&c.params.length){
      var box=el('div','hmr-params');
      c.params.forEach(function(p){
        var w=el('div','hmr-param');var id='hmrp'+(++chartSeq);
        w.innerHTML='<label for="'+id+'"><span>'+esc(p.label)+'</span><b>'+p.name+' = '+fmtNum(p.value)+'</b></label><input id="'+id+'" type="range" min="'+p.min+'" max="'+p.max+'" step="'+p.step+'" value="'+p.value+'">';
        var inp=w.querySelector('input'),out=w.querySelector('b');
        inp.addEventListener('input',function(){p.value=+inp.value;out.textContent=p.name+' = '+fmtNum(p.value);draw();});
        box.appendChild(w);
      });
      card.appendChild(box);
    }
    draw();typeset(card);
    if(window.ResizeObserver){var ro=new ResizeObserver(function(){draw();});ro.observe(svgWrap);}
    return card;
  }

  /* PNG графика для PDF/PPTX (светлая тема, фиксированный размер). */
  function chartToImage(spec){
    return new Promise(function(resolve,reject){
      var c=normChart(typeof spec==='string'?spec:JSON.stringify(spec));
      if(!c||c.error)return reject(new Error('bad chart'));
      var W=900,H=500;var titleH=c.title?40:0;
      var r=chartSvg(c,{w:W,h:H-titleH,clip:'cx',xTitle:c.xLabel,colors:{axis:'#555',grid:'#e3e3ea',tick:'#555',bg:'#fff'}});
      var legend='';
      if(c.kind==='fn'||c.series.length>1){var lx=56;legend=(c.kind==='fn'?c.fns.map(function(f){return f.label;}):c.series.map(function(s){return s.name;})).map(function(n,i){var s='<rect x="'+lx+'" y="'+(H-14)+'" width="14" height="4" fill="'+PALETTE[i%PALETTE.length]+'"/><text x="'+(lx+20)+'" y="'+(H-9)+'" font-size="13" fill="#333">'+esc(n)+'</text>';lx+=34+String(n).length*7;return s;}).join('');}
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+(H+(legend?16:0))+'" font-family="Arial,sans-serif"><rect width="100%" height="100%" fill="#fff"/>'
        +(c.title?'<text x="'+W/2+'" y="26" text-anchor="middle" font-size="18" font-weight="700" fill="#111">'+esc(c.title)+'</text>':'')
        +'<g transform="translate(0,'+titleH+')">'+r.svg.replace(/ class="(grid|ax|tick|lbl)"/g,'')+'</g>'+legend+'</svg>';
      var img=new Image();
      img.onload=function(){var cv=document.createElement('canvas');cv.width=img.width;cv.height=img.height;cv.getContext('2d').drawImage(img,0,0);resolve({dataUrl:cv.toDataURL('image/png'),width:img.width,height:img.height});};
      img.onerror=function(){reject(new Error('svg'));};
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    });
  }

  /* ======================================================================
     СХЕМЫ (Mermaid)
     ====================================================================== */
  var mermaidP=null,mermaidSeq=0;
  function isDark(){var th=document.documentElement.getAttribute('data-theme');if(th==='light')return false;if(th==='dark')return true;try{return getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0,3).reduce(function(a,b){return a+ +b;},0)<380;}catch(e){return true;}}
  function loadMermaid(){
    if(window.mermaid)return Promise.resolve(window.mermaid);
    if(mermaidP)return mermaidP;
    mermaidP=new Promise(function(res,rej){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';s.async=true;
      s.onload=function(){window.mermaid?res(window.mermaid):rej(new Error('mermaid'));};s.onerror=function(){mermaidP=null;rej(new Error('Не удалось загрузить модуль схем'));};document.head.appendChild(s);});
    return mermaidP;
  }
  function jsonTreeToMermaid(d){
    var lines=['flowchart TD'];var n=0;
    function walk(node,parent){var id='n'+(n++);var label=String(node.label||node.name||node.title||node.root||node).replace(/["\[\]]/g,"'");lines.push('  '+id+'["'+label+'"]');if(parent)lines.push('  '+parent+' --> '+id);(node.children||[]).forEach(function(ch){walk(ch,id);});}
    walk(d,null);return lines.join('\n');
  }
  function renderDiagram(body,host){
    var card=el('div','hmr-card hmr-diagram');host.appendChild(card);
    var src=String(body||'').trim();
    if(/^[{\[]/.test(src)){var j=parseLoose(src);if(j)src=jsonTreeToMermaid(Array.isArray(j)?{label:'',children:j}:j);}
    card.innerHTML='<div class="hmr-skel-label">'+ICON.spin+esc(t('Рисую схему…'))+'</div>';
    loadMermaid().then(function(m){
      // Цвета схемы — из темы приложения, а не стандартная фиолетовая палитра Mermaid.
      var dark=isDark(),cs=getComputedStyle(document.documentElement);
      var txt=(cs.getPropertyValue('--text')||'').trim()||(dark?'#fff':'#111');
      m.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',fontFamily:'inherit',
        flowchart:{curve:'basis',htmlLabels:true,padding:14,nodeSpacing:36,rankSpacing:46},
        themeVariables:{fontSize:'15px',background:'transparent',primaryColor:dark?'#1c2333':'#eef2ff',primaryBorderColor:'#4f7cff',primaryTextColor:txt,
          secondaryColor:dark?'#1f2a22':'#ecfdf3',tertiaryColor:dark?'#2a2030':'#fdf2f8',lineColor:dark?'#8b93a7':'#6b7280',textColor:txt,mainBkg:dark?'#1c2333':'#eef2ff',nodeBorder:'#4f7cff',clusterBkg:'transparent'},
        themeCSS:'.node rect,.node polygon{rx:12px;ry:12px;stroke-width:1.5px}.edgePath .path,.flowchart-link{stroke-width:1.6px}'});
      return m.render('hmrmm'+(++mermaidSeq)+'_'+Date.now().toString(36),src);
    }).then(function(r){card.innerHTML=r.svg;}).catch(function(e){
      card.innerHTML='<div class="hmr-diagram-err">'+esc(t('Схему не удалось нарисовать'))+'</div>';
      var pre=el('pre');pre.textContent=src;pre.style.cssText='font-size:12px;opacity:.7;white-space:pre-wrap;margin:8px 0 0;';card.appendChild(pre);
    });
    return card;
  }

  /* ======================================================================
     ФОТО: Википедия → иллюстрация ИИ
     ====================================================================== */
  var photoInflight={};
  async function wikiPhoto(query,lang){
    var url='https://'+lang+'.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=4&gsrsearch='+encodeURIComponent(query)+'&prop=pageimages|info&inprop=url&piprop=thumbnail|name&pithumbsize=900';
    var r=await fetch(url,{credentials:'omit'});if(!r.ok)return null;var d=await r.json();
    var pages=Object.values((d.query&&d.query.pages)||{}).sort(function(a,b){return (a.index||0)-(b.index||0);});
    var p=pages.find(function(x){return x.thumbnail&&x.thumbnail.source&&!/\.svg/i.test(x.pageimage||'');})||pages.find(function(x){return x.thumbnail;});
    return p?{url:p.thumbnail.source,source:'Википедия — '+p.title,href:p.fullurl}:null;
  }
  async function findPhoto(query){
    if(!query)return null;
    for(var lang of ['ru','en']){try{var r=await wikiPhoto(query,lang);if(r)return r;}catch(e){}}
    return null;
  }
  /* Фото в ответе ещё ищется или рисуется: data-gen="1". Когда готово (или не
     вышло) — событие hm-photo-settled: приложение показывает строку действий
     под ответом только после этого (см. setMessageActionsVisible в app.html). */
  function photoBusy(fig,on){
    if(on){fig.dataset.gen='1';return;}
    if(fig.dataset.gen!=='1')return;
    delete fig.dataset.gen;
    try{fig.dispatchEvent(new CustomEvent('hm-photo-settled',{bubbles:true}));}catch(e){}
  }
  /* Подпись над холстом и анимация создания — те же, что у генерации картинок в чате. */
  function genStage(fig,label){
    fig.innerHTML='';
    var lab=el('div','igx-label');lab.innerHTML='<span class="igx-text"></span>';lab.firstChild.textContent=label;
    var stage=el('div','hmr-photo-gen');
    fig.appendChild(lab);fig.appendChild(stage);
    try{if(typeof window.hmImgGenAnim==='function')window.hmImgGenAnim(stage);else stage.innerHTML='<div class="hmr-photo-ph">'+ICON.spin+'</div>';}catch(e){}
  }
  async function generateIllustration(prompt){
    // Сбой (таймаут, ошибка шлюза) — одна повторная попытка.
    try{return await generateIllustrationOnce(prompt);}
    catch(e){if(/лимит|limit|модерац|правил|недопуст/i.test(String(e&&e.message||'')))throw e;return await generateIllustrationOnce(prompt);}
  }
  async function generateIllustrationOnce(prompt){
    var eps=typeof window.buildImageApiCandidates==='function'?window.buildImageApiCandidates():['/api/generate-image'];
    var headers=typeof window.hmAuthHeaders==='function'?await window.hmAuthHeaders():{'Content-Type':'application/json'};
    for(var i=0;i<eps.length;i++){
      try{var r=await fetch(eps[i],{method:'POST',headers:headers,body:JSON.stringify({prompt:prompt,model:(function(){try{return typeof curModel!=='undefined'?curModel:'lite';}catch(e){return 'lite';}})()}),credentials:'omit'});
        var d=await r.json().catch(function(){return null;});if(r.ok&&d&&d.image)return d.image;if(d&&d.error)throw new Error(d.error.message);}catch(e){if(i===eps.length-1)throw e;}
    }
    throw new Error('Не удалось нарисовать иллюстрацию');
  }
  function renderPhoto(body,host,ctx){
    var d=parseLoose(body);if(!d&&body.trim())d={query:body.trim()};
    if(!d)return renderBroken(host,'фото',body);
    var fig=el('figure','hmr-photo');host.appendChild(fig);
    var key='hm_photo_'+hash(body);var cached=store(key);
    function show(r){
      photoBusy(fig,false);
      fig.innerHTML='';var img=el('img');img.loading='lazy';img.alt=d.caption||d.query||d.prompt||'';img.src=r.url;
      img.onerror=function(){fig.innerHTML='<div class="hmr-photo-ph">'+esc(t('Фото недоступно'))+'</div>';};
      fig.appendChild(img);
      var cap=(d.caption?esc(d.caption):'')+(r.source?(d.caption?' · ':'')+(r.href?'<a href="'+esc(r.href)+'" target="_blank" rel="noopener">'+esc(r.source)+'</a>':esc(r.source)):'');
      if(cap)fig.appendChild(el('figcaption','',cap));
    }
    if(cached&&cached.url){show(cached);return fig;}
    var live=Boolean(ctx&&ctx.live)||Boolean(photoInflight[key]);
    if(live)photoBusy(fig,true);
    fig.innerHTML='<div class="hmr-photo-ph">'+ICON.spin+esc(t('Ищу фото…'))+'</div>';
    (async function(){
      var r=d.query?await findPhoto(d.query):null;
      if(r){store(key,r);show(r);return;}
      if(!d.prompt){fig.innerHTML='<div class="hmr-photo-ph">'+esc(t('Подходящее фото не найдено'))+'</div>';photoBusy(fig,false);return;}
      // Генерация стоит лимитов: автоматически — только для свежего ответа, из истории — по кнопке.
      var start=function(){
        photoBusy(fig,true);
        genStage(fig,t('Рисую иллюстрацию'));
        var p=photoInflight[key]||(photoInflight[key]=generateIllustration(d.prompt));
        p.then(function(url){var rr={url:url,source:t('Иллюстрация создана ИИ')};store(key,rr);show(rr);})
         .catch(function(){
           // Без «Ошибка сервиса №…» на полэкрана: короткая подпись и кнопка «Повторить».
           delete photoInflight[key];
           fig.innerHTML='';var ph=el('div','hmr-photo-ph hmr-photo-fail');
           ph.appendChild(el('span','',esc(t('Не получилось нарисовать иллюстрацию'))));
           var b=el('button','hmr-btn',t('Повторить'));b.type='button';b.onclick=start;ph.appendChild(b);fig.appendChild(ph);
           photoBusy(fig,false);
         });
      };
      if(live)start();
      else{fig.innerHTML='';var b=el('button','hmr-btn',t('Показать иллюстрацию'));b.type='button';b.onclick=start;var ph=el('div','hmr-photo-ph');ph.appendChild(b);fig.appendChild(ph);}
    })();
    return fig;
  }

  /* ======================================================================
     ШАГИ, СРАВНЕНИЕ, ПОТОК, ШКАЛА ВРЕМЕНИ — визуальные блоки как в ChatGPT
     ====================================================================== */
  var GI={ // иконки 24×24, линия currentColor
    phone:'<rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M11 18.5h2"/>',
    server:'<rect x="4" y="4" width="16" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.8"/><path d="M8 7.2h.01M8 16.7h.01"/>',
    brain:'<path d="M12 3.5l1.9 5 5.1 1.9-5.1 1.9-1.9 5-1.9-5-5.1-1.9 5.1-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    bolt:'<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6l1-8z"/>',
    user:'<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    cloud:'<path d="M7 18.5h10a4 4 0 00.6-8A5.5 5.5 0 007 9.2 4.7 4.7 0 007 18.5z"/>',
    database:'<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v13c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-13M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
    music:'<path d="M9 18V5.5l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
    note:'<path d="M14 4v10.5"/><circle cx="10.5" cy="16" r="3.5"/><path d="M14 4c1.5 1.8 4 2.3 4 5"/>',
    book:'<path d="M4.5 5.5A2 2 0 016.5 3.5H19v15H6.5a2 2 0 00-2 2v-15z"/><path d="M4.5 18.5a2 2 0 012-2H19"/>',
    check:'<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16 9.5"/>',
    star:'<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
    globe:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.5 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.5-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
    image:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
    file:'<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h6"/>',
    code:'<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>',
    chat:'<path d="M5 18.5l-1.5 3 4-1.5A8.5 8.5 0 105 18.5z"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5"/>',
    heart:'<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.5 4.3 4.3 0 0119.5 10c0 5.4-7.5 10-7.5 10z"/>',
    mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5v3.5"/>',
    piano:'<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M8 4.5v15M12 4.5v15M16 4.5v15"/><path d="M6.5 4.5v8M10 4.5v8M14 4.5v8M17.5 4.5v8" stroke-width="2.6"/>',
    bulb:'<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0012 3z"/>',
    target:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    chart:'<path d="M4 20V4M4 20h16"/><path d="M8 16l3.5-4.5 3 2.5L19 8"/>',
    play:'<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>',
    headphones:'<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.6"/><rect x="16.5" y="14" width="4" height="6" rx="1.6"/>',
    eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    warn:'<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17h.01"/>',
    arrowdown:'<path d="M12 4v15M6 13l6 6 6-6"/>',
    updown:'<path d="M8 4v15M4.5 8L8 4.5 11.5 8M16 20V5M12.5 16l3.5 3.5 3.5-3.5"/>'
  };
  var GI_GUESS=[
    [/телефон|смартфон|интерфейс|экран|приложени|фронтенд|frontend|клиент/i,'phone'],[/сервер|backend|бэкенд|vercel|прокси/i,'server'],
    [/модел|нейро|ии\b|ai\b|llm|мозг|токен|думает|генерир/i,'brain'],[/врем|сек|минут|ожидан|ждать|час/i,'clock'],
    [/быстр|скорост|мгновен|стрим|молни/i,'bolt'],[/пользоват|ученик|ты\b|человек|автор/i,'user'],[/облак|cloud/i,'cloud'],[/баз[аы]|данн|хранил/i,'database'],
    [/музык|трек|песн|звук|аудио/i,'music'],[/нот|мелоди|гамм|аккорд|интервал/i,'note'],[/учеб|книг|урок|правил|теори/i,'book'],[/код|програм|функци|скрипт/i,'code'],
    [/чат|сообщ|запрос|вопрос|диалог/i,'chat'],[/настро|параметр|режим/i,'gear'],[/ключ|пароль|доступ/i,'key'],[/фото|картин|изображ/i,'image'],
    [/файл|документ|pdf/i,'file'],[/готов|итог|результат|провер|верно/i,'check'],[/сеть|интернет|сайт|мир/i,'globe'],[/идея|совет|подсказ/i,'bulb'],
    [/цель|задач/i,'target'],[/график|рост|статист/i,'chart'],[/фортепиан|пианино|клавиш/i,'piano'],[/голос|пение|спой|микрофон/i,'mic'],[/слуш|слух|наушник/i,'headphones']
  ];
  function guessIcon(name,text){
    if(name&&GI[String(name).toLowerCase()])return String(name).toLowerCase();
    var s=String(name||'')+' '+String(text||'');
    for(var i=0;i<GI_GUESS.length;i++)if(GI_GUESS[i][0].test(s))return GI_GUESS[i][1];
    return 'star';
  }
  function gIcon(name,size){return '<svg class="hmr-gi" width="'+(size||22)+'" height="'+(size||22)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(GI[name]||GI.star)+'</svg>';}
  function inlineMd(s){return mdToHtml(String(s==null?'':s)).replace(/^\s*<p>|<\/p>\s*$/g,'');}
  function blockTitle(card,d){
    if(d&&d.title){var h=el('div','hmr-btitle');h.innerHTML=inlineMd(d.title);card.appendChild(h);}
    if(d&&(d.intro||d.subtitle)){var p=el('div','hmr-bintro');p.innerHTML=inlineMd(d.intro||d.subtitle);card.appendChild(p);}
  }
  function blocksSkeleton(kind,host){
    var card=el('div','hmr-blocks hmr-skel-blocks');
    var n=kind==='flow'?3:kind==='steps'?3:2;
    for(var i=0;i<n;i++){var r=el('div','hmr-skel-row');r.innerHTML=kind==='steps'?'<span class="hmr-skel-thumb"></span><span class="hmr-skel-lines"><i></i><i></i><i></i></span>':'<span class="hmr-skel-lines"><i></i><i></i></span>';card.appendChild(r);}
    host.appendChild(card);return card;
  }

  /* ----- шаги с картинками ----- */
  var stepImgCache={};
  function stepImage(query){
    if(!query)return Promise.resolve(null);
    var key='hm_stepimg_'+hash(query);
    var c=store(key);if(c&&c.url)return Promise.resolve(c);
    if(stepImgCache[key])return stepImgCache[key];
    return (stepImgCache[key]=findPhoto(query).then(function(r){if(r&&r.url)store(key,r);return r;}).catch(function(){return null;}));
  }
  function renderSteps(body,host,ctx){
    var d=parseLoose(body);var items=Array.isArray(d)?d:(d&&(d.items||d.steps))||[];
    items=items.map(function(it){return typeof it==='string'?{title:it}:it;}).filter(function(it){return it&&(it.title||it.text);}).slice(0,10);
    if(!items.length)return renderBroken(host,'шаги',body);
    var card=el('div','hmr-blocks hmr-steps');blockTitle(card,Array.isArray(d)?null:d);
    var ol=el('ol','hmr-step-list');card.appendChild(ol);
    items.forEach(function(it,i){
      var li=el('li','hmr-step');li.style.setProperty('--i',i);
      var media=el('div','hmr-step-media');
      var ic=guessIcon(it.icon,(it.title||'')+' '+(it.text||''));
      var hue=[262,210,150,28,330,190,95,0,45,280][i%10];
      media.style.setProperty('--h',hue);
      media.innerHTML='<span class="hmr-step-ic">'+gIcon(ic,30)+'</span>';
      var q=it.image||it.photo||it.query||'';
      if(q){
        media.classList.add('is-loading');
        stepImage(q).then(function(r){
          media.classList.remove('is-loading');
          if(!r||!r.url)return;
          var img=new Image();img.alt=it.title||'';img.loading='lazy';img.decoding='async';
          img.onload=function(){media.classList.add('has-img');media.appendChild(img);requestAnimationFrame(function(){img.classList.add('on');});};
          img.src=r.url;
        });
      }
      li.appendChild(media);
      var tx=el('div','hmr-step-body');
      tx.innerHTML='<div class="hmr-step-title">'+(i+1)+'. '+inlineMd(it.title||'')+'</div>'+(it.text?'<div class="hmr-step-text">'+inlineMd(it.text)+'</div>':'');
      li.appendChild(tx);ol.appendChild(li);
    });
    host.appendChild(card);typeset(card);return card;
  }

  /* ----- сравнение ----- */
  function toneCls(t){t=String(t||'').toLowerCase();return /good|ok|green|success|хорош|зел/.test(t)?' is-good':/bad|red|err|плох|крас/.test(t)?' is-bad':/warn|amber|yellow|жёлт|желт/.test(t)?' is-warn':'';}
  function rowsHtml(rows,result){
    var h='';
    (rows||[]).forEach(function(r){
      if(typeof r==='string')r={text:r};
      h+='<div class="hmr-crow'+toneCls(r.tone)+'">'+(r.label||r.time?'<div class="hmr-clabel">'+inlineMd(r.label||r.time)+'</div>':'')+'<div class="hmr-ctext">'+inlineMd(r.text||r.value||'')+'</div></div>';
    });
    if(result){if(typeof result==='string')result={text:result,tone:'good'};h+='<div class="hmr-cres'+(toneCls(result.tone||'good')||' is-good')+'">'+inlineMd(result.text||'')+'</div>';}
    return h;
  }
  function renderCompare(body,host){
    var d=parseLoose(body);var cols=Array.isArray(d)?d:(d&&(d.columns||d.items||d.cols))||[];
    cols=cols.filter(function(c){return c&&(c.title||c.rows||c.items);}).slice(0,4);
    if(!cols.length)return renderBroken(host,'сравнение',body);
    var card=el('div','hmr-blocks hmr-compare');blockTitle(card,Array.isArray(d)?null:d);
    var grid=el('div','hmr-cgrid');grid.style.setProperty('--n',cols.length);card.appendChild(grid);
    cols.forEach(function(c,i){
      var col=el('div','hmr-ccol');
      var ic=guessIcon(c.icon,c.title);
      col.innerHTML='<div class="hmr-chead">'+gIcon(ic,18)+'<span>'+inlineMd(c.title||'')+'</span></div><div class="hmr-cpanel'+(i===0&&cols.length>1&&!c.tone?' is-muted':toneCls(c.tone))+'">'+rowsHtml(c.rows||c.items,c.result||c.footer)+'</div>';
      grid.appendChild(col);
    });
    if(d&&!Array.isArray(d)&&d.note){var n=el('div','hmr-bnote');n.innerHTML=inlineMd(d.note);card.appendChild(n);}
    host.appendChild(card);typeset(card);return card;
  }
  function renderTimeline(body,host){
    var d=parseLoose(body);var rows=Array.isArray(d)?d:(d&&(d.items||d.rows||d.events))||[];
    if(!rows.length)return renderBroken(host,'шкала',body);
    var card=el('div','hmr-blocks hmr-compare hmr-timeline');blockTitle(card,Array.isArray(d)?null:d);
    var col=el('div','hmr-ccol');
    col.innerHTML=(d&&d.label?'<div class="hmr-chead">'+gIcon(guessIcon(d.icon,d.label),18)+'<span>'+inlineMd(d.label)+'</span></div>':'')+'<div class="hmr-cpanel">'+rowsHtml(rows,d&&!Array.isArray(d)?d.result:null)+'</div>';
    card.appendChild(col);host.appendChild(card);typeset(card);return card;
  }

  /* ----- поток / архитектура ----- */
  function renderFlow(body,host){
    var d=parseLoose(body);var nodes=Array.isArray(d)?d:(d&&(d.nodes||d.items||d.steps))||[];
    nodes=nodes.map(function(n){return typeof n==='string'?{title:n}:n;}).filter(function(n){return n&&n.title;}).slice(0,8);
    if(!nodes.length)return renderBroken(host,'схема',body);
    var both=d&&!Array.isArray(d)&&/both|two|двус|⇅|↕/i.test(String(d.arrows||d.direction||''));
    var card=el('div','hmr-blocks hmr-flow');blockTitle(card,Array.isArray(d)?null:d);
    var box=el('div','hmr-flow-col');card.appendChild(box);
    nodes.forEach(function(n,i){
      if(i){var a=el('div','hmr-flow-arrow');a.innerHTML=gIcon(both||n.both?'updown':'arrowdown',18);if(n.edge||n.label_edge){a.innerHTML+='<span>'+inlineMd(n.edge||n.label_edge)+'</span>';}box.appendChild(a);}
      var node=el('div','hmr-flow-node'+toneCls(n.tone));
      node.innerHTML='<span class="hmr-flow-ic">'+gIcon(guessIcon(n.icon,n.title+' '+(n.text||'')),22)+'</span><div class="hmr-flow-title">'+inlineMd(n.title)+'</div>'+(n.text?'<div class="hmr-flow-text">'+inlineMd(n.text)+'</div>':'');
      box.appendChild(node);
    });
    host.appendChild(card);typeset(card);return card;
  }

  /* ======================================================================
     КНОПКИ СЛЕДУЮЩИХ ШАГОВ
     ====================================================================== */
  function renderButtons(body,host){
    var d=parseLoose(body);var list=Array.isArray(d)?d:(d&&(d.buttons||d.actions||d.items))||[];
    list=list.map(function(b){return typeof b==='string'?{label:b,prompt:b}:{label:b.label||b.text||b.title||'',prompt:b.prompt||b.message||b.label||b.text||''};}).filter(function(b){return b.label&&b.prompt;}).slice(0,5);
    if(!list.length)return null;
    var row=el('div','hmr-chips');row.setAttribute('role','group');row.setAttribute('aria-label',t('Следующие шаги'));
    list.forEach(function(b){var c=el('button','hmr-chip');c.type='button';c.innerHTML=ICON.arrow+'<span>'+esc(b.label)+'</span>';c.title=b.prompt;
      c.onclick=function(){if(window.HmRich.sendPrompt(b.prompt))row.querySelectorAll('button').forEach(function(x){x.disabled=true;});};row.appendChild(c);});
    host.appendChild(row);return row;
  }

  /* ======================================================================
     ПИСЬМО (```email) — карточка: получатели, тема, текст. «Изменить» —
     правка прямо в карточке, «Копировать» — тема и текст, «Отправить» —
     открыть черновик в выбранной почте (Gmail, Почта Mail.ru, Яндекс Почта,
     Outlook) или в почтовом приложении (iCloud / системная почта — mailto).
     ====================================================================== */
  var MAIL_ICONS={
    edit:'<svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4L19 9l-4-4L4 16v4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="1.8"/></svg>',
    copy:'<svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>',
    send:'<svg viewBox="0 0 24 24" fill="none"><path d="M21 3L10 14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M21 3l-7 18-4-7-7-4 18-7z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    ok:'<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  var MAIL_TARGETS=[
    {id:'gmail',name:'Gmail',url:function(m){return 'https://mail.google.com/mail/?view=cm&fs=1&to='+encodeURIComponent(m.to)+(m.cc?'&cc='+encodeURIComponent(m.cc):'')+'&su='+encodeURIComponent(m.subject)+'&body='+encodeURIComponent(m.body);}},
    {id:'mailru',name:'Почта Mail.ru',url:function(m){return 'https://e.mail.ru/compose/?to='+encodeURIComponent(m.to)+(m.cc?'&cc='+encodeURIComponent(m.cc):'')+'&subject='+encodeURIComponent(m.subject)+'&body='+encodeURIComponent(m.body);}},
    {id:'yandex',name:'Яндекс Почта',url:function(m){return 'https://mail.yandex.ru/compose?to='+encodeURIComponent(m.to)+(m.cc?'&cc='+encodeURIComponent(m.cc):'')+'&subject='+encodeURIComponent(m.subject)+'&body='+encodeURIComponent(m.body);}},
    {id:'outlook',name:'Outlook',url:function(m){return 'https://outlook.live.com/mail/0/deeplink/compose?to='+encodeURIComponent(m.to)+(m.cc?'&cc='+encodeURIComponent(m.cc):'')+'&subject='+encodeURIComponent(m.subject)+'&body='+encodeURIComponent(m.body);}},
    {id:'icloud',name:'iCloud Mail / Почта Apple',url:mailto},
    {id:'other',name:'Другое приложение',url:mailto}
  ];
  function mailto(m){return 'mailto:'+encodeURIComponent(m.to).replace(/%40/g,'@').replace(/%2C/g,',')+'?'+(m.cc?'cc='+encodeURIComponent(m.cc)+'&':'')+'subject='+encodeURIComponent(m.subject)+'&body='+encodeURIComponent(m.body);}
  function renderEmail(body,host){
    var d=parseLoose(body)||{};
    var asList=function(v){return (Array.isArray(v)?v:String(v||'').split(/[,;]/)).map(function(x){return String(x).trim();}).filter(Boolean).join(', ');};
    var m={to:asList(d.to||d.recipients||d.recipient),cc:asList(d.cc),subject:String(d.subject||d.title||'').trim(),body:String(d.body||d.text||d.content||'').replace(/\r/g,'').trim()};
    if(!m.subject&&!m.body)return null;
    var card=el('div','hmr-mail');
    card.innerHTML='<div class="hmr-mail-head"><span>'+esc(t('Электронная почта'))+'</span><div class="hmr-mail-tools">'
      +'<button type="button" class="hmr-mail-btn" data-a="edit" aria-label="'+esc(t('Изменить'))+'" title="'+esc(t('Изменить'))+'">'+MAIL_ICONS.edit+'</button>'
      +'<button type="button" class="hmr-mail-btn" data-a="copy" aria-label="'+esc(t('Копировать'))+'" title="'+esc(t('Копировать'))+'">'+MAIL_ICONS.copy+'</button>'
      +'<button type="button" class="hmr-mail-btn hmr-mail-send" data-a="send" aria-label="'+esc(t('Отправить'))+'" title="'+esc(t('Отправить'))+'">'+MAIL_ICONS.send+'</button></div></div>'
      +'<div class="hmr-mail-row hmr-mail-to" data-f="to" data-ph="'+esc(t('Получатели'))+'"></div>'
      +'<div class="hmr-mail-row hmr-mail-subj" data-f="subject" data-ph="'+esc(t('Тема'))+'"></div>'
      +'<div class="hmr-mail-body" data-f="body"></div>';
    card.querySelector('[data-f=to]').textContent=m.to;
    card.querySelector('[data-f=subject]').textContent=m.subject;
    card.querySelector('[data-f=body]').textContent=m.body;
    var read=function(){['to','subject','body'].forEach(function(f){var n=card.querySelector('[data-f='+f+']');m[f]=String(n.innerText||n.textContent||'').trim();});return m;};
    var flash=function(b){var old=b.innerHTML;b.innerHTML=MAIL_ICONS.ok;setTimeout(function(){b.innerHTML=old;},1100);};
    card.querySelector('[data-a=edit]').onclick=function(){
      var on=!card.classList.contains('editing');card.classList.toggle('editing',on);
      card.querySelectorAll('[data-f]').forEach(function(n){n.contentEditable=on?'plaintext-only':'false';});
      if(on){var f=card.querySelector('[data-f=to]');try{f.focus();}catch(e){}}else read();
    };
    card.querySelector('[data-a=copy]').onclick=function(){read();var b=this;
      navigator.clipboard.writeText((m.subject?m.subject+'\n\n':'')+m.body).then(function(){flash(b);}).catch(function(){});};
    card.querySelector('[data-a=send]').onclick=function(e){e.stopPropagation();read();openMailMenu(card,m);};
    host.appendChild(card);return card;
  }
  function openMailMenu(card,m){
    var old=document.querySelector('.hmr-mail-menu');if(old){old.remove();return;}
    var menu=el('div','hmr-mail-menu');menu.setAttribute('role','menu');
    var head=el('div','hmr-mail-menu-h',t('Открыть черновик в'));menu.appendChild(head);
    MAIL_TARGETS.forEach(function(x){var b=el('button','hmr-mail-opt');b.type='button';b.setAttribute('role','menuitem');b.textContent=x.name;
      b.onclick=function(){menu.remove();var url=x.url(m);if(/^mailto:/.test(url))location.href=url;else window.open(url,'_blank','noopener');};menu.appendChild(b);});
    card.appendChild(menu);
    setTimeout(function(){document.addEventListener('click',function off(ev){if(!menu.contains(ev.target)){menu.remove();document.removeEventListener('click',off);}});},0);
  }

  /* ======================================================================
     ГДЕ ПОСЛУШАТЬ (```tracks) — {"query":"The Weeknd Starboy","connect":true}.
     Ссылки на поиск трека в музыкальных сервисах; если Яндекс Музыка не
     подключена — кнопка «Слушать прямо здесь».
     ====================================================================== */
  var TRACK_SERVICES=[
    {name:'Яндекс Музыка',host:'music.yandex.ru',url:function(q){return 'https://music.yandex.ru/search?text='+encodeURIComponent(q);}},
    {name:'VK Музыка',host:'vk.com',url:function(q){return 'https://vk.com/search/music?q='+encodeURIComponent(q);}},
    {name:'YouTube',host:'youtube.com',url:function(q){return 'https://www.youtube.com/results?search_query='+encodeURIComponent(q);}},
    {name:'YouTube Music',host:'music.youtube.com',url:function(q){return 'https://music.youtube.com/search?q='+encodeURIComponent(q);}},
    {name:'Spotify',host:'open.spotify.com',url:function(q){return 'https://open.spotify.com/search/'+encodeURIComponent(q);}},
    {name:'Apple Music',host:'music.apple.com',url:function(q){return 'https://music.apple.com/ru/search?term='+encodeURIComponent(q);}},
    {name:'SoundCloud',host:'soundcloud.com',url:function(q){return 'https://soundcloud.com/search?q='+encodeURIComponent(q);}}
  ];
  var NOTE_ICON='<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="17.5" cy="16" r="2.5" stroke="currentColor" stroke-width="1.8"/></svg>';
  function renderTracks(body,host){
    var d=parseLoose(body)||{};
    var q=String(d.query||d.title||'').replace(/\s+/g,' ').trim().slice(0,160);
    if(!q)return null;
    var card=el('div','hmr-tl');
    card.innerHTML='<div class="hmr-tl-head">'+NOTE_ICON+'<div class="hmr-tl-q"></div></div><div class="hmr-tl-sub">'+esc(t('Где послушать'))+'</div><div class="hmr-tl-list"></div>';
    card.querySelector('.hmr-tl-q').textContent=q;
    var list=card.querySelector('.hmr-tl-list');
    TRACK_SERVICES.forEach(function(x){
      var a=el('a','hmr-tl-row');a.href=x.url(q);a.target='_blank';a.rel='noopener noreferrer';
      a.innerHTML='<img alt="" loading="lazy" referrerpolicy="no-referrer" src="https://icons.duckduckgo.com/ip3/'+x.host+'.ico"><span>'+esc(x.name)+'</span><svg class="hmr-tl-go" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M9 7h8v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var img=a.querySelector('img');img.onerror=function(){img.style.visibility='hidden';};
      list.appendChild(a);
    });
    if(d.connect){
      var b=el('button','hmr-tl-connect');b.type='button';b.textContent=t('Слушать прямо здесь — подключить Яндекс Музыку');
      b.onclick=function(){sendPrompt('Подключи Яндекс Музыку');};
      card.appendChild(b);
    }
    host.appendChild(card);return card;
  }

  function renderBroken(host,what,body){
    var card=el('div','hmr-card');card.innerHTML='<div class="hmr-diagram-err">'+esc(t('Не удалось показать'))+' '+esc(t(what))+'.</div>';
    host.appendChild(card);return card;
  }

  /* ======================================================================
     ЧЕРТЁЖ (```figure) — геометрия, алгебра, физика: точки, отрезки, прямые,
     многоугольники, окружности, углы, векторы сил, графики функций, подписи.
     Координаты — математические (ось y вверх); масштаб по осям ОДИНАКОВЫЙ,
     поэтому пропорции чертежа точные.
     ====================================================================== */
  var figSeq=0;
  /* Подписи чертежа — простой текст: модель иногда пишет LaTeX ($F_{тр} \approx 9,8$ Н). */
  var SUB={'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','x':'ₓ','+':'₊','-':'₋'};
  var SUP={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻','+':'⁺','n':'ⁿ'};
  function figText(v){
    var s=String(v==null?'':v).replace(/\$/g,'');
    s=s.replace(/\\text\{([^}]*)\}|\\mathrm\{([^}]*)\}/g,function(_,a,b){return a||b||'';})
       .replace(/\\approx/g,'≈').replace(/\\perp/g,'⊥').replace(/\\parallel/g,'∥').replace(/\\cdot|\\times/g,'·').replace(/\\angle/g,'∠').replace(/\\triangle/g,'△')
       .replace(/\\alpha/g,'α').replace(/\\beta/g,'β').replace(/\\gamma/g,'γ').replace(/\\varphi|\\phi/g,'φ').replace(/\\mu/g,'μ').replace(/\\pi/g,'π').replace(/\\Delta/g,'Δ').replace(/\\omega/g,'ω').replace(/\\lambda/g,'λ')
       .replace(/\^\{?\\circ\}?/g,'°').replace(/\\circ/g,'°').replace(/\\vec\{([^}]*)\}/g,'$1⃗').replace(/\\sqrt\{([^}]*)\}/g,'√$1').replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g,'$1/$2')
       .replace(/_\{([^}]*)\}/g,function(_,x){return /^[0-9x+\-]+$/.test(x)?x.split('').map(function(c){return SUB[c]||c;}).join(''):x;})
       .replace(/_([0-9])/g,function(_,c){return SUB[c];}).replace(/\^\{([^}]*)\}/g,function(_,x){return x.split('').map(function(c){return SUP[c]||c;}).join('');})
       .replace(/\^([0-9n])/g,function(_,c){return SUP[c];}).replace(/\\[a-zA-Z]+/g,'').replace(/[{}]/g,'').replace(/\s+/g,' ').trim();
    return s;
  }
  var FIG_COLORS={accent:'var(--accent,#4f7cff)',red:'#e11d48',blue:'#2563eb',green:'#16a34a',orange:'#f97316',purple:'#a855f7',gray:'#8a8d95'};
  function figColor(c){return FIG_COLORS[c]||(/^#[0-9a-f]{3,6}$/i.test(c||'')?c:'currentColor');}
  /* Физика: тело на наклонной (angle>0) или горизонтальной (angle=0) плоскости.
     Модель задаёт только угол и силы — направления считает код, поэтому N всегда
     перпендикулярна опоре, mg — вертикально вниз, трение — вдоль поверхности. */
  function expandIncline(d){
    var c=d.incline||{};var a=Math.max(0,Math.min(75,+c.angle||0))*Math.PI/180;var B=6,H=B*Math.tan(a),s=1,F=1.9;
    var dn={x:Math.cos(a),y:-Math.sin(a)},nn={x:Math.sin(a),y:Math.cos(a)};
    var M0={x:B/2-dn.x*0.2,y:H/2-dn.y*0.2};
    if(a<1e-6){M0={x:B/2,y:0};}
    d.points=(d.points||[]);d.polygons=(d.polygons||[]);d.vectors=(d.vectors||[]);d.angles=(d.angles||[]);
    if(a>1e-6){d.points.push({id:'_p0',x:0,y:0,label:''},{id:'_p1',x:B,y:0,label:''},{id:'_p2',x:0,y:H,label:''});d.polygons.push({points:['_p0','_p1','_p2'],color:'gray'});
      d.angles.push({vertex:'_p1',from:'_p2',to:'_p0',label:(c.angle||0)+'°'});}
    else{d.polygons.push({points:[[0,0],[B,0],[B,-0.35],[0,-0.35]],color:'gray'});}
    var q=[[M0.x-dn.x*s/2,M0.y-dn.y*s/2],[M0.x+dn.x*s/2,M0.y+dn.y*s/2],[M0.x+dn.x*s/2+nn.x*s,M0.y+dn.y*s/2+nn.y*s],[M0.x-dn.x*s/2+nn.x*s,M0.y-dn.y*s/2+nn.y*s]];
    d.polygons.push({points:q,color:'accent'});
    var C={x:M0.x+nn.x*s/2,y:M0.y+nn.y*s/2};
    var forces=Array.isArray(c.forces)?c.forces:[];
    /* Направление «вверх по склону» (на столе — вправо) = +1. Трение всегда против тяги. */
    var sgn=function(v,def){v=String(v||'').toLowerCase();if(/down|вниз|left|влево/.test(v))return a>1e-6?-1:-1;if(/up|вверх|right|вправо/.test(v))return 1;return def;};
    var pull=forces.filter(function(f){return !/grav|тяж|weight|mg|norm|реакц|опор|fric|трен/.test(String(f.type||'').toLowerCase());})[0];
    var pullS=pull?sgn(pull.dir,1):0;
    var along=function(sg){return a>1e-6?(sg>0?{x:-dn.x,y:-dn.y}:dn):{x:sg,y:0};};
    forces.forEach(function(f){
      var t=String(f.type||'').toLowerCase(),k=+f.scale||1,lab=f.label,from=C,dir=null,col=f.color;
      if(/grav|тяж|weight|mg/.test(t)){dir={x:0,y:-1};col=col||'red';lab=lab||'mg';}
      else if(/norm|реакц|опор/.test(t)){dir=nn;from=M0;col=col||'blue';lab=lab||'N';}
      else if(/fric|трен/.test(t)){dir=along(pull?-pullS:sgn(f.dir,1));from=M0;col=col||'orange';lab=lab||'Fтр';}
      else{dir=along(f===pull?pullS:sgn(f.dir,1));col=col||'green';}
      d.vectors.push({from:[from.x,from.y],to:[from.x+dir.x*F*k,from.y+dir.y*F*k],label:lab,color:col});
    });
  }
  /* Камера для объёмных фигур: поворот вокруг вертикали и взгляд сверху.
     Ортогональная проекция — параллельные рёбра остаются параллельными, как в учебнике. */
  function view3d(v){
    v=v||{};var th=(isFinite(+v.rotate)?+v.rotate:-28)*Math.PI/180,e=(isFinite(+v.elevation)?+v.elevation:27)*Math.PI/180;
    var ct=Math.cos(th),st=Math.sin(th),ce=Math.cos(e),se=Math.sin(e);
    return {p:function(x,y,z){var xr=x*ct-y*st,yr=x*st+y*ct;return {x:xr,y:z*ce+yr*se,depth:yr*ce-z*se};},
      eye:{x:-ce*st,y:-ce*ct,z:se}};
  }
  /* Многогранники и тела вращения по размерам: невидимые рёбра — пунктиром. */
  function expandSolid(d){
    var c=d.solid||{};var type=String(c.type||'pyramid').toLowerCase();
    // Треугольное основание под углом -28° видно почти ребром — поворачиваем иначе.
    if((+c.n===3||type==='tetra')&&!(d.view&&isFinite(+d.view.rotate)))d.view=Object.assign({},d.view||{},{rotate:20});
    var V=view3d(d.view);
    d.points=d.points||[];d.segments=d.segments||[];d.angles=d.angles||[];d.curves=d.curves||[];
    var L='ABCDEFGHKLMN';var lab=Array.isArray(c.labels)?c.labels:[];
    var verts={},faces=[],center={x:0,y:0,z:0};
    function addV(id,x,y,z,label){verts[id]={x:x,y:y,z:z};d.points.push({id:id,x:x,y:y,z:z,label:label!=null?label:id});}
    var accent='accent';
    var extras=[];
    if(/pyramid|prism|cube|box|parallelepiped|tetra/.test(type)){
      var n=Math.max(3,Math.min(8,+c.n||(type==='cube'||type==='box'||type==='parallelepiped'?4:type==='tetra'?3:4)));
      var a=+c.a||4,b=+c.b||a,h=+c.h||(type==='cube'?a:type==='tetra'?a*Math.sqrt(2/3):4);if(type==='cube'){b=a;h=a;}
      var base=[];
      if(n===4&&(type==='box'||type==='parallelepiped'||type==='cube'||b!==a||/prism/.test(type))){base=[[-a/2,-b/2],[a/2,-b/2],[a/2,b/2],[-a/2,b/2]];}
      else{var R=a/(2*Math.sin(Math.PI/n)),st0=-Math.PI/2-Math.PI/n;for(var i=0;i<n;i++){var an=st0+2*Math.PI*i/n;base.push([R*Math.cos(an),R*Math.sin(an)]);}}
      var ids=base.map(function(q,i){var id=lab[i]||L[i];addV(id,q[0],q[1],0);return id;});
      if(/pyramid|tetra/.test(type)){
        var apex=c.apex||'S';addV(apex,0,0,h);faces.push(ids.slice().reverse());
        ids.forEach(function(id,i){faces.push([id,ids[(i+1)%n],apex]);});
        var cen=c.center||'O';
        if(c.height!==false){addV(cen,0,0,0);extras.push({from:apex,to:cen,color:accent,label:c.heightLabel||''});
          d.angles.push({vertex:cen,from:apex,to:ids[Math.min(2,n-1)],right:true});}
        if(n===4&&c.diagonals!==false&&c.height!==false){extras.push({from:ids[0],to:ids[2],style:'dashed',color:'gray'},{from:ids[1],to:ids[3],style:'dashed',color:'gray'});}
        else if(c.height!==false){ids.forEach(function(id){if(c.radii)extras.push({from:cen,to:id,style:'dashed',color:'gray'});});}
        if(c.apothem){var m=c.apothem===true?'M':String(c.apothem);var p0=verts[ids[0]],p1=verts[ids[1]];addV(m,(p0.x+p1.x)/2,(p0.y+p1.y)/2,0);extras.push({from:apex,to:m,color:'orange'});}
      }else{
        var top=ids.map(function(id,i){var tid=(lab[n+i])||(id+'₁');var q=verts[id];addV(tid,q.x,q.y,h);return tid;});
        faces.push(ids.slice().reverse());faces.push(top.slice());
        ids.forEach(function(id,i){var j=(i+1)%n;faces.push([id,ids[j],top[j],top[i]]);});
      }
      Object.keys(verts).forEach(function(k){center.x+=verts[k].x;center.y+=verts[k].y;center.z+=verts[k].z;});var nv=Object.keys(verts).length;center={x:center.x/nv,y:center.y/nv,z:center.z/nv};
      /* Видимость рёбер: ребро видно, если видна хотя бы одна из прилегающих граней. */
      var edges={};
      faces.forEach(function(f){
        var A=verts[f[0]],B=verts[f[1]],C=verts[f[2]];
        var ux=B.x-A.x,uy=B.y-A.y,uz=B.z-A.z,vx=C.x-A.x,vy=C.y-A.y,vz=C.z-A.z;
        var nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
        var fc={x:0,y:0,z:0};f.forEach(function(id){fc.x+=verts[id].x;fc.y+=verts[id].y;fc.z+=verts[id].z;});fc.x/=f.length;fc.y/=f.length;fc.z/=f.length;
        if(nx*(fc.x-center.x)+ny*(fc.y-center.y)+nz*(fc.z-center.z)<0){nx=-nx;ny=-ny;nz=-nz;}
        var vis=nx*V.eye.x+ny*V.eye.y+nz*V.eye.z>1e-9;
        f.forEach(function(id,i){var j=f[(i+1)%f.length];var key=id<j?id+'|'+j:j+'|'+id;edges[key]=edges[key]||{a:id,b:j,vis:false};if(vis)edges[key].vis=true;});
      });
      var given=(d.segments||[]).slice();d.segments=[];
      Object.keys(edges).forEach(function(k){var e=edges[k];
        var g=given.find(function(sg){return (sg.from===e.a&&sg.to===e.b)||(sg.from===e.b&&sg.to===e.a);});
        d.segments.push({from:e.a,to:e.b,style:e.vis?'solid':'dashed',color:e.vis?accent:'gray',label:g&&g.label,ticks:g&&g.ticks});
        if(g)given.splice(given.indexOf(g),1);});
      extras.forEach(function(x){var g=given.find(function(sg){return (sg.from===x.from&&sg.to===x.to)||(sg.from===x.to&&sg.to===x.from);});if(g){x.label=g.label||x.label;given.splice(given.indexOf(g),1);}d.segments.push(x);});
      // Отрезки от центра основания O лежат внутри тела — по правилам черчения пунктир.
      var cid=c.center||'O';given.forEach(function(sg){if(!sg.style&&(sg.from===cid||sg.to===cid)){sg.style='dashed';sg.color=sg.color||'gray';}});
      d.segments=d.segments.concat(given);
      return;
    }
    /* Тела вращения: окружности — эллипсы, задняя половина основания — пунктир. */
    var r=+c.r||2,hh=+c.h||(type==='sphere'?0:4),N=72;
    function ring(z,from,to){var out=[];for(var i=0;i<=N;i++){var t=from+(to-from)*i/N;out.push([r*Math.cos(t),r*Math.sin(t),z]);}return out;}
    function split(z,topVisible){
      var pts=[];for(var i=0;i<=N;i++){var t=2*Math.PI*i/N;pts.push([r*Math.cos(t),r*Math.sin(t),z]);}
      var front=[],back=[];pts.forEach(function(q){(V.p(q[0],q[1],q[2]).depth<=V.p(0,0,z).depth+1e-9?front:back).push(q);});
      var sort=function(arr){return arr.map(function(q){return {q:q,a:Math.atan2(q[1],q[0])};});};
      if(topVisible){d.curves.push({points:pts,color:accent});return;}
      var seg=function(cond,style,color){var cur=[];pts.forEach(function(q){var isF=V.p(q[0],q[1],q[2]).depth<=V.p(0,0,z).depth+1e-9;if(isF===cond)cur.push(q);else{if(cur.length>1)d.curves.push({points:cur,style:style,color:color});cur=[];}});if(cur.length>1)d.curves.push({points:cur,style:style,color:color});};
      seg(true,'solid',accent);seg(false,'dashed','gray');
    }
    var cen2=c.center||'O';addV(cen2,0,0,0);
    if(type==='sphere'){
      var e=view3d(d.view);var pts=[];for(var i=0;i<=N;i++){var t=2*Math.PI*i/N;pts.push([r*Math.cos(t),0,r*Math.sin(t)]);}
      // Силуэт шара — окружность радиуса r в плоскости экрана: строим в мировых координатах через ось взгляда.
      var ex=e.eye,ax={x:-ex.y,y:ex.x,z:0},al=Math.hypot(ax.x,ax.y)||1;ax={x:ax.x/al,y:ax.y/al,z:0};
      var bx={x:ex.y*ax.z-ex.z*ax.y,y:ex.z*ax.x-ex.x*ax.z,z:ex.x*ax.y-ex.y*ax.x};
      var sil=[];for(var k=0;k<=N;k++){var tt=2*Math.PI*k/N;sil.push([r*(Math.cos(tt)*ax.x+Math.sin(tt)*bx.x),r*(Math.cos(tt)*ax.y+Math.sin(tt)*bx.y),r*(Math.cos(tt)*ax.z+Math.sin(tt)*bx.z)]);}
      d.curves.push({points:sil,color:accent});split(0,false);
      if(c.radius!==false){addV('_R',r,0,0,'');d.segments.push({from:cen2,to:'_R',label:c.radiusLabel||'R',color:'gray',style:'dashed'});}
      return;
    }
    split(0,false);
    var tx=V.p(r,0,0),silA=null,silB=null;
    // Образующие-силуэты: точки основания с крайними экранными x.
    var best=[null,null];for(var i=0;i<N;i++){var t=2*Math.PI*i/N,q=V.p(r*Math.cos(t),r*Math.sin(t),0);if(!best[0]||q.x<best[0].px)best[0]={px:q.x,w:[r*Math.cos(t),r*Math.sin(t)]};if(!best[1]||q.x>best[1].px)best[1]={px:q.x,w:[r*Math.cos(t),r*Math.sin(t)]};}
    if(/cyl/.test(type)){
      split(hh,true);addV(c.topCenter||'O₁',0,0,hh);
      best.forEach(function(bq){d.curves.push({points:[[bq.w[0],bq.w[1],0],[bq.w[0],bq.w[1],hh]],color:accent});});
      d.segments.push({from:cen2,to:c.topCenter||'O₁',style:'dashed',color:'gray',label:c.heightLabel||''});
    }else{
      var apx=c.apex||'S';addV(apx,0,0,hh);
      best.forEach(function(bq){d.curves.push({points:[[bq.w[0],bq.w[1],0],[0,0,hh]],color:accent});});
      d.segments.push({from:apx,to:cen2,color:'accent',label:c.heightLabel||''});
    }
    if(c.radius!==false){addV('_R',best[1].w[0],best[1].w[1],0,'');d.segments.push({from:cen2,to:'_R',style:'dashed',color:'gray',label:c.radiusLabel||'R'});}
  }
  function renderFigure(body,host){
    var d=parseLoose(body);if(!d||typeof d!=='object')return renderBroken(host,'чертёж',body);
    if(d.incline)expandIncline(d);
    if(d.solid)expandSolid(d);
    /* Объёмный чертёж: у точек есть z — проецируем (камера сверху-сбоку). */
    var is3d=Boolean(d.solid)||(d.points||[]).some(function(p){return p&&p.z!=null;});
    var V3=is3d?view3d(d.view):null;
    var P={};
    (d.points||[]).forEach(function(p){if(!p||p.id==null||!isFinite(+p.x)||!isFinite(+p.y))return;var q=V3?V3.p(+p.x,+p.y,+p.z||0):{x:+p.x,y:+p.y};P[p.id]={x:q.x,y:q.y,label:p.label!=null?p.label:p.id,hidden:!!p.hidden,color:p.color};});
    function pt(v){if(Array.isArray(v)&&v.length>=3&&V3&&isFinite(+v[2]))return V3.p(+v[0],+v[1],+v[2]);
      if(Array.isArray(v)&&isFinite(+v[0])&&isFinite(+v[1]))return {x:+v[0],y:+v[1]};if(typeof v==='string'&&P[v])return P[v];if(v&&isFinite(+v.x)&&isFinite(+v.y))return {x:+v.x,y:+v.y};return null;}
    var xs=[],ys=[];function addB(x,y){if(isFinite(x)&&isFinite(y)){xs.push(x);ys.push(y);}}
    Object.keys(P).forEach(function(k){addB(P[k].x,P[k].y);});
    var circles=(d.circles||[]).map(function(c){var o=pt(c.center);if(!o)return null;var r=+c.r;if(!(r>0)){var th=pt(c.through);if(th)r=Math.hypot(th.x-o.x,th.y-o.y);}if(!(r>0))return null;addB(o.x-r,o.y-r);addB(o.x+r,o.y+r);return {o:o,r:r,label:c.label,dashed:c.style==='dashed',color:c.color};}).filter(Boolean);
    (d.vectors||[]).forEach(function(v){var a=pt(v.from),b=pt(v.to);if(a)addB(a.x,a.y);if(b)addB(b.x,b.y);});
    var curves=(d.curves||[]).map(function(c){var ps=(c.points||[]).map(pt).filter(Boolean);ps.forEach(function(q){addB(q.x,q.y);});return {ps:ps,dashed:c.style==='dashed',color:c.color};}).filter(function(c){return c.ps.length>1;});
    (d.texts||[]).forEach(function(tx){addB(+tx.x,+tx.y);});
    var funcs=[];
    (d.functions||[]).forEach(function(f){try{var fn=compileExpr(exprToPlain(f.expr||f.f||''));funcs.push({fn:fn,dom:Array.isArray(f.domain)?f.domain.map(Number):null,label:f.label,color:f.color});}catch(e){}});
    if(Array.isArray(d.x)){addB(+d.x[0],0);addB(+d.x[1],0);}
    if(Array.isArray(d.y)){addB(0,+d.y[0]);addB(0,+d.y[1]);}
    if(d.axes){addB(0,0);}
    if(funcs.length){
      var fx0=xs.length?Math.min.apply(null,xs):-5,fx1=xs.length?Math.max.apply(null,xs):5;if(fx1-fx0<1e-9){fx0-=5;fx1+=5;}
      funcs.forEach(function(f){var a=f.dom?f.dom[0]:fx0,b=f.dom?f.dom[1]:fx1;f.a=a;f.b=b;addB(a,0);addB(b,0);
        if(!Array.isArray(d.y)){for(var i=0;i<=60;i++){var x=a+(b-a)*i/60,y=f.fn({x:x});if(isFinite(y)&&Math.abs(y)<1e6)addB(x,y);}}});
    }
    if(!xs.length)return renderBroken(host,'чертёж',body);
    var minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys);
    if(Array.isArray(d.y)){minY=Math.min(+d.y[0],+d.y[1]);maxY=Math.max(+d.y[0],+d.y[1]);}
    var spanX=Math.max(maxX-minX,1e-6),spanY=Math.max(maxY-minY,1e-6),pad=Math.max(spanX,spanY)*0.14+0.0001;
    minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
    var card=el('div','hmr-card hmr-figure');host.appendChild(card);
    if(d.title)card.appendChild(el('div','hmr-chart-title',esc(d.title)));
    var wrap=el('div','hmr-fig-wrap');card.appendChild(wrap);
    if(d.caption)card.appendChild(el('div','hmr-fig-cap',esc(d.caption)));
    var id='hmrfig'+(++figSeq);
    function draw(){
      var W=Math.max(240,Math.min(620,Math.round(wrap.clientWidth||card.clientWidth||520)));
      var k=W/(maxX-minX);var H=(maxY-minY)*k;
      if(H>460){k=460/(maxY-minY);H=460;}if(H<160){H=160;}
      var offX=(W-(maxX-minX)*k)/2,offY=(H-(maxY-minY)*k)/2;
      function X(x){return offX+(x-minX)*k;}function Y(y){return H-offY-(y-minY)*k;}
      var cx=0,cy=0,n=0;Object.keys(P).forEach(function(q){cx+=P[q].x;cy+=P[q].y;n++;});if(n){cx/=n;cy/=n;}else{cx=(minX+maxX)/2;cy=(minY+maxY)/2;}
      var o=[];
      o.push('<defs><marker id="'+id+'a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>');
      var lab=function(x,y,txt,anchor,cls){return '<text x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" text-anchor="'+(anchor||'middle')+'" class="'+(cls||'hmr-fig-lbl')+'">'+esc(figText(txt))+'</text>';};
      if(d.grid||d.axes){
        var tx=niceTicks(minX,maxX,Math.max(4,Math.round(W/70))),ty=niceTicks(minY,maxY,Math.max(4,Math.round(H/60)));
        if(d.grid){tx.forEach(function(v){o.push('<line class="hmr-fig-grid" x1="'+X(v)+'" y1="0" x2="'+X(v)+'" y2="'+H+'"/>');});ty.forEach(function(v){o.push('<line class="hmr-fig-grid" x1="0" y1="'+Y(v)+'" x2="'+W+'" y2="'+Y(v)+'"/>');});}
        if(d.axes){
          var ax=Math.min(Math.max(0,minX),maxX),ay=Math.min(Math.max(0,minY),maxY);
          o.push('<line class="hmr-fig-axis" x1="0" y1="'+Y(ay)+'" x2="'+W+'" y2="'+Y(ay)+'" marker-end="url(#'+id+'a)"/>');
          o.push('<line class="hmr-fig-axis" x1="'+X(ax)+'" y1="'+H+'" x2="'+X(ax)+'" y2="0" marker-end="url(#'+id+'a)"/>');
          tx.forEach(function(v){if(Math.abs(v)<1e-9)return;o.push('<line class="hmr-fig-axis" x1="'+X(v)+'" y1="'+(Y(ay)-3)+'" x2="'+X(v)+'" y2="'+(Y(ay)+3)+'"/>'+lab(X(v),Y(ay)+15,fmtNum(v),'middle','hmr-fig-tick'));});
          ty.forEach(function(v){if(Math.abs(v)<1e-9)return;o.push('<line class="hmr-fig-axis" x1="'+(X(ax)-3)+'" y1="'+Y(v)+'" x2="'+(X(ax)+3)+'" y2="'+Y(v)+'"/>'+lab(X(ax)-6,Y(v)+4,fmtNum(v),'end','hmr-fig-tick'));});
          o.push(lab(W-6,Y(ay)-8,d.xLabel||'x','end','hmr-fig-tick')+lab(X(ax)+8,12,d.yLabel||'y','start','hmr-fig-tick'));
        }
      }
      (d.polygons||[]).forEach(function(pg){var pts=(pg.points||[]).map(pt).filter(Boolean);if(pts.length<3)return;
        o.push('<polygon class="hmr-fig-poly'+(pg.fill===false?'':' is-fill')+'" style="--c:'+figColor(pg.color||'accent')+'" points="'+pts.map(function(q){return X(q.x).toFixed(1)+','+Y(q.y).toFixed(1);}).join(' ')+'"/>');});
      circles.forEach(function(c){o.push('<circle class="hmr-fig-line'+(c.dashed?' is-dash':'')+'" style="stroke:'+figColor(c.color)+'" cx="'+X(c.o.x)+'" cy="'+Y(c.o.y)+'" r="'+(c.r*k)+'"/>');if(c.label)o.push(lab(X(c.o.x+c.r*0.72),Y(c.o.y+c.r*0.72)-4,c.label,'start'));});
      (d.lines||[]).forEach(function(l){var th=l.through||[];var a=pt(th[0]),b=pt(th[1]);if(!a||!b)return;var dx=b.x-a.x,dy=b.y-a.y,L=Math.hypot(dx,dy);if(!L)return;var big=(maxX-minX+maxY-minY)*2;var ray=l.type==='ray';
        var p1=ray?a:{x:a.x-dx/L*big,y:a.y-dy/L*big},p2={x:a.x+dx/L*big,y:a.y+dy/L*big};
        o.push('<line class="hmr-fig-line'+(l.style==='dashed'?' is-dash':'')+'" style="stroke:'+figColor(l.color)+'" x1="'+X(p1.x)+'" y1="'+Y(p1.y)+'" x2="'+X(p2.x)+'" y2="'+Y(p2.y)+'"/>');
        if(l.label){var lx=b.x+dx/L*(maxX-minX)*0.08,ly=b.y+dy/L*(maxY-minY)*0.08;o.push(lab(X(lx)+6,Y(ly)-6,l.label,'start'));}});
      funcs.forEach(function(f,fi){var path='',pen=false,prev=null;for(var i=0;i<=400;i++){var x=f.a+(f.b-f.a)*i/400,y=f.fn({x:x});
          if(!isFinite(y)||y<minY-(maxY-minY)*3||y>maxY+(maxY-minY)*3||(prev!=null&&Math.abs(y-prev)>(maxY-minY)*1.5)){pen=false;prev=isFinite(y)?y:null;continue;}
          path+=(pen?'L':'M')+X(x).toFixed(1)+' '+Y(y).toFixed(1);pen=true;prev=y;}
        var col=f.color?figColor(f.color):PALETTE[fi%PALETTE.length];
        o.push('<path class="hmr-fig-fn" style="stroke:'+col+'" d="'+path+'"/>');
        if(f.label){var yl=f.fn({x:f.b});if(isFinite(yl)&&yl<=maxY&&yl>=minY)o.push('<text class="hmr-fig-lbl" style="fill:'+col+'" x="'+(X(f.b)-4).toFixed(1)+'" y="'+(Y(yl)-8).toFixed(1)+'" text-anchor="end">'+esc(figText(f.label))+'</text>');}});
      curves.forEach(function(c){o.push('<path class="hmr-fig-line'+(c.dashed?' is-dash':'')+'" style="stroke:'+figColor(c.color)+'" d="'+c.ps.map(function(q,i){return (i?'L':'M')+X(q.x).toFixed(1)+' '+Y(q.y).toFixed(1);}).join('')+'"/>');});
      (d.segments||[]).forEach(function(sg){var a=pt(sg.from),b=pt(sg.to);if(!a||!b)return;
        o.push('<line class="hmr-fig-line'+(sg.style==='dashed'?' is-dash':'')+'" style="stroke:'+figColor(sg.color)+'" x1="'+X(a.x)+'" y1="'+Y(a.y)+'" x2="'+X(b.x)+'" y2="'+Y(b.y)+'"/>');
        // В середине отрезка стоит точка (например, M — середина AB) — подпись сдвигаем к краю.
        var tpos=Object.keys(P).some(function(q){return Math.hypot(X(P[q].x)-X((a.x+b.x)/2),Y(P[q].y)-Y((a.y+b.y)/2))<8;})?0.28:0.5;
        var mx=a.x+(b.x-a.x)*tpos,my=a.y+(b.y-a.y)*tpos,dx=X(b.x)-X(a.x),dy=Y(b.y)-Y(a.y),L=Math.hypot(dx,dy)||1,nx=-dy/L,ny=dx/L;
        var sx=X(mx)-X(cx),sy=Y(my)-Y(cy);if(nx*sx+ny*sy<0){nx=-nx;ny=-ny;}
        var tk=+sg.ticks||0;for(var q=0;q<tk;q++){var sh=(q-(tk-1)/2)*5;var px=X(mx)+dx/L*sh,py=Y(my)+dy/L*sh;o.push('<line class="hmr-fig-line" x1="'+(px-nx*6)+'" y1="'+(py-ny*6)+'" x2="'+(px+nx*6)+'" y2="'+(py+ny*6)+'"/>');}
        if(sg.label)o.push(lab(X(mx)+nx*14,Y(my)+ny*14+4,sg.label));});
      (d.angles||[]).forEach(function(an){var v=pt(an.vertex),a=pt(an.from),b=pt(an.to);if(!v||!a||!b)return;
        var a1=Math.atan2(-(Y(a.y)-Y(v.y)),X(a.x)-X(v.x)),a2=Math.atan2(-(Y(b.y)-Y(v.y)),X(b.x)-X(v.x));var dA=a2-a1;while(dA<=-Math.PI)dA+=2*Math.PI;while(dA>Math.PI)dA-=2*Math.PI;
        var R=+an.radius||20;var vx=X(v.x),vy=Y(v.y);
        if(an.right){var u1={x:Math.cos(a1),y:-Math.sin(a1)},u2={x:Math.cos(a2),y:-Math.sin(a2)},s=R*0.6;
          o.push('<path class="hmr-fig-ang" d="M'+(vx+u1.x*s)+' '+(vy+u1.y*s)+'L'+(vx+(u1.x+u2.x)*s)+' '+(vy+(u1.y+u2.y)*s)+'L'+(vx+u2.x*s)+' '+(vy+u2.y*s)+'"/>');}
        else{var x1=vx+R*Math.cos(a1),y1=vy-R*Math.sin(a1),x2=vx+R*Math.cos(a1+dA),y2=vy-R*Math.sin(a1+dA);
          o.push('<path class="hmr-fig-ang" d="M'+x1.toFixed(1)+' '+y1.toFixed(1)+'A'+R+' '+R+' 0 0 '+(dA>0?0:1)+' '+x2.toFixed(1)+' '+y2.toFixed(1)+'"/>');}
        if(an.label){var mid=a1+dA/2,lr=R+13;o.push(lab(vx+lr*Math.cos(mid),vy-lr*Math.sin(mid)+4,an.label,'middle','hmr-fig-lbl is-small'));}});
      (d.vectors||[]).forEach(function(vc){var a=pt(vc.from),b=pt(vc.to);if(!a||!b)return;var col=figColor(vc.color||'accent');
        o.push('<line class="hmr-fig-vec" style="stroke:'+col+'" x1="'+X(a.x)+'" y1="'+Y(a.y)+'" x2="'+X(b.x)+'" y2="'+Y(b.y)+'" marker-end="url(#'+id+'a)"/>');
        if(vc.label){var dx=X(b.x)-X(a.x),dy=Y(b.y)-Y(a.y),L=Math.hypot(dx,dy)||1;o.push('<text class="hmr-fig-lbl" style="fill:'+col+'" x="'+(X(b.x)+dx/L*12-dy/L*10).toFixed(1)+'" y="'+(Y(b.y)+dy/L*12+dx/L*10+4).toFixed(1)+'" text-anchor="middle">'+esc(figText(vc.label))+'</text>');}});
      Object.keys(P).forEach(function(q){var p=P[q];if(p.hidden)return;var px=X(p.x),py=Y(p.y);o.push('<circle class="hmr-fig-pt" style="fill:'+figColor(p.color)+'" cx="'+px+'" cy="'+py+'" r="3.2"/>');
        if(p.label!==''&&p.label!=null){var dx=px-X(cx),dy=py-Y(cy),L=Math.hypot(dx,dy);if(L<1){dx=-1;dy=-1;L=Math.SQRT2;}o.push(lab(px+dx/L*14,py+dy/L*14+5,String(p.label),'middle','hmr-fig-pl'));}});
      (d.texts||[]).forEach(function(tt){if(isFinite(+tt.x)&&isFinite(+tt.y)&&tt.text)o.push(lab(X(+tt.x),Y(+tt.y),tt.text,'middle'));});
      wrap.innerHTML='<svg class="hmr-fig-svg" viewBox="0 0 '+W+' '+Math.round(H)+'" width="'+W+'" height="'+Math.round(H)+'" role="img" aria-label="'+esc(d.title||'Чертёж')+'">'+o.join('')+'</svg>';
    }
    draw();
    var last=0;if(window.ResizeObserver){new ResizeObserver(function(){var w=wrap.clientWidth;if(Math.abs(w-last)>8){last=w;draw();}}).observe(wrap);}
    return card;
  }

  /* ======================================================================
     МОЛЕКУЛА (```molecule) — структурная формула по SMILES (smiles-drawer).
     ====================================================================== */
  var smilesLoad=null;
  function loadSmiles(){
    if(window.SmilesDrawer)return Promise.resolve(window.SmilesDrawer);
    if(smilesLoad)return smilesLoad;
    smilesLoad=new Promise(function(ok,no){var sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/smiles-drawer@2.1.7/dist/smiles-drawer.min.js';sc.async=true;
      sc.onload=function(){window.SmilesDrawer?ok(window.SmilesDrawer):no(new Error('smiles-drawer'));};sc.onerror=function(){smilesLoad=null;no(new Error('smiles-drawer'));};document.head.appendChild(sc);});
    return smilesLoad;
  }
  function renderMolecule(body,host){
    var d=parseLoose(body);var list=Array.isArray(d)?d:(d&&Array.isArray(d.molecules)?d.molecules:[d]);
    list=(list||[]).filter(function(m){return m&&((typeof m.smiles==='string'&&m.smiles.length<400)||m.en);}).slice(0,4);
    if(!list.length)return renderBroken(host,'формулу',body);
    var card=el('div','hmr-card hmr-mol');host.appendChild(card);
    var grid=el('div','hmr-mol-grid');card.appendChild(grid);
    var dark=document.documentElement.getAttribute('data-theme')!=='light'&&document.documentElement.getAttribute('data-theme')!=='messenger';
    list.forEach(function(m){
      var cell=el('div','hmr-mol-cell');grid.appendChild(cell);
      var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','hmr-mol-svg');cell.appendChild(svg);
      cell.appendChild(el('div','hmr-mol-name',esc(m.name||m.smiles)+(m.formula?' <span>'+esc(m.formula)+'</span>':'')));
      /* Структуру по названию берём из PubChem: SMILES по памяти модель часто
         пишет с ошибками (глюкоза превращалась во фруктозу). */
      var en=String(m.en||m.english||'').trim();
      var smilesP=en?fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/'+encodeURIComponent(en)+'/property/SMILES,MolecularFormula/JSON')
        .then(function(r){return r.ok?r.json():null;}).then(function(j){var p=j&&j.PropertyTable&&j.PropertyTable.Properties&&j.PropertyTable.Properties[0];return p&&(p.SMILES||p.IsomericSMILES||p.CanonicalSMILES)||m.smiles;}).catch(function(){return m.smiles;})
        :Promise.resolve(m.smiles);
      Promise.all([loadSmiles(),smilesP]).then(function(r){var SD=r[0];m.smiles=r[1]||m.smiles;
        var w=Math.min(300,Math.max(180,cell.clientWidth||240));
        var opts={width:w,height:Math.round(w*0.8),bondThickness:1.1,fontSizeLarge:9,fontSizeSmall:6,padding:12,compactDrawing:false};
        SD.parse(m.smiles,function(tree){
          if(SD.SvgDrawer){new SD.SvgDrawer(opts).draw(tree,svg,dark?'dark':'light');}
          else{var cv=document.createElement('canvas');cv.width=opts.width;cv.height=opts.height;svg.replaceWith(cv);new SD.Drawer(opts).draw(tree,cv,dark?'dark':'light',false);}
          svg.removeAttribute('width');svg.removeAttribute('height');svg.style.width='100%';svg.style.height='auto';svg.style.maxHeight='240px';
        },function(){cell.insertBefore(el('div','hmr-diagram-err',esc(t('Не удалось разобрать формулу'))+' «'+esc(m.smiles)+'»'),svg);svg.remove();});
      }).catch(function(){cell.insertBefore(el('div','hmr-diagram-err',esc(t('Не удалось загрузить модуль формул'))),svg);svg.remove();});
    });
    if(d&&d.caption)card.appendChild(el('div','hmr-fig-cap',esc(d.caption)));
    return card;
  }

  /* ---------- общий вход ---------- */
  function render(kind,body,host,ctx){
    try{
      if(kind==='quiz')return renderQuiz(body,host,ctx);
      if(kind==='chart')return renderChart(body,host,ctx);
      if(kind==='diagram'||kind==='mermaid')return renderDiagram(body,host,ctx);
      if(kind==='photo'||kind==='image')return renderPhoto(body,host,ctx);
      if(kind==='buttons')return renderButtons(body,host,ctx);
      if(kind==='steps')return renderSteps(body,host,ctx);
      if(kind==='compare')return renderCompare(body,host,ctx);
      if(kind==='timeline')return renderTimeline(body,host,ctx);
      if(kind==='flow')return renderFlow(body,host,ctx);
      if(kind==='figure')return renderFigure(body,host,ctx);
      if(kind==='molecule')return renderMolecule(body,host,ctx);
      if(kind==='email')return renderEmail(body,host,ctx);
      if(kind==='tracks')return renderTracks(body,host,ctx);
    }catch(e){console.warn('[hm-rich]',kind,e);return renderBroken(host,'блок',body);}
    return null;
  }
  function renderPending(kind,host){
    if(kind==='quiz')return quizSkeleton(host);
    if(kind==='buttons')return null;
    var card=el('div','hmr-card hmr-skel');
    if(kind==='steps'||kind==='compare'||kind==='flow'||kind==='timeline')return blocksSkeleton(kind,host);
    var label={email:'Пишу письмо…',figure:'Строю чертёж…',molecule:'Рисую формулу…',chart:'Строю график…',diagram:'Рисую схему…',mermaid:'Рисую схему…',photo:'Подбираю фото…',image:'Подбираю фото…'}[kind]||'Готовлю…';
    card.innerHTML='<div class="hmr-skel-label">'+ICON.spin+esc(t(label))+'</div><div class="hmr-bar" style="height:140px;border-radius:16px"></div>';
    host.appendChild(card);return card;
  }

  /* Отправить готовый запрос от имени пользователя (кнопки, «Разобрать»). */
  function sendPrompt(text){
    if(!text)return false;
    // isGenerating и curModel объявлены в app.html через let — это не свойства window.
    try{if(typeof isGenerating!=='undefined'&&isGenerating)return false;}catch(e){}
    var ta=document.getElementById('msgTa');if(!ta||typeof window.sendMsg!=='function')return false;
    ta.value=text;ta.dispatchEvent(new Event('input',{bubbles:true}));
    window.sendMsg();return true;
  }

  /* ======================================================================
     ЗАПУСК КОДА
     ====================================================================== */
  var RUN_LANGS={js:'js',javascript:'js',mjs:'js',py:'py',python:'py',python3:'py',html:'html',htm:'html',svg:'html'};
  function runnable(lang){return RUN_LANGS[String(lang||'').toLowerCase()]||'';}
  function outPanel(block){
    var o=block.querySelector(':scope > .code-out');
    if(!o){o=el('div','code-out');block.appendChild(o);}
    o.innerHTML='';o.classList.remove('is-html');return o;
  }
  /* Живое превью сгенерированной страницы. iframe изолирован (без
     allow-same-origin: страница не видит сайт, cookies и аккаунт), поэтому
     обращение к localStorage/sessionStorage в нём бросает исключение — и весь
     скрипт страницы падал на первой строке: кнопки не нажимались. Подкладываем
     хранилище в памяти до кода страницы; светлая схема — чтобы страница без
     своего фона не рисовалась чёрным текстом на тёмном. */
  var SANDBOX_SHIM='<meta name="color-scheme" content="light"><script>(function(){function M(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}'
    +"['localStorage','sessionStorage'].forEach(function(n){var ok=false;try{ok=!!window[n]}catch(e){}if(!ok){try{Object.defineProperty(window,n,{value:M(),configurable:true})}catch(e){}}});"
    +"try{document.cookie}catch(e){try{var c='';Object.defineProperty(document,'cookie',{get:function(){return c},set:function(v){c=(c?c+'; ':'')+String(v).split(';')[0]},configurable:true})}catch(e2){}}"
    +'})();<\/script>';
  function sandboxDoc(code){
    var src=String(code||'');
    if(!/<html|<body|<!doctype|<head/i.test(src))return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+SANDBOX_SHIM+'</head><body style="margin:0;background:#fff">'+src+'</body></html>';
    if(/<head[^>]*>/i.test(src))return src.replace(/<head[^>]*>/i,function(m){return m+SANDBOX_SHIM;});
    if(/<html[^>]*>/i.test(src))return src.replace(/<html[^>]*>/i,function(m){return m+'<head>'+SANDBOX_SHIM+'</head>';});
    if(/<!doctype[^>]*>/i.test(src))return src.replace(/<!doctype[^>]*>/i,function(m){return m+SANDBOX_SHIM;});
    return SANDBOX_SHIM+src;
  }
  window.hmSandboxDoc=sandboxDoc;
  var SANDBOX_FLAGS='allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock';
  window.hmSandboxFlags=SANDBOX_FLAGS;
  function runHtml(code,o){
    o.classList.add('is-html');
    var fr=document.createElement('iframe');fr.className='code-frame';
    fr.setAttribute('sandbox',SANDBOX_FLAGS);
    fr.setAttribute('referrerpolicy','no-referrer');fr.title=t('Результат');
    fr.srcdoc=sandboxDoc(code);o.appendChild(fr);
    return Promise.resolve();
  }
  function showCode(btn){
    var block=btn.closest('.code-block');if(!block)return;
    block.classList.remove('show-out');
    block.querySelectorAll('.code-tab').forEach(function(b){b.classList.toggle('on',b.classList.contains('code-tab-code'));});
    var o=block.querySelector(':scope > .code-out');if(o&&o.classList.contains('is-html'))o.innerHTML='';
  }
  function outLine(o,text,cls){var d=el('div',cls||'');d.textContent=text;o.appendChild(d);o.scrollTop=o.scrollHeight;}
  function fmtVal(v){try{if(typeof v==='string')return v;if(v instanceof Error)return v.stack||String(v);return JSON.stringify(v,null,2);}catch(e){return String(v);}}

  function runJs(code,o){
    return new Promise(function(resolve){
      var fr=document.createElement('iframe');fr.setAttribute('sandbox','allow-scripts');fr.style.display='none';
      var finished=false;
      function end(){if(finished)return;finished=true;window.removeEventListener('message',onMsg);clearTimeout(timer);fr.remove();resolve();}
      function onMsg(e){
        if(e.source!==fr.contentWindow||!e.data||!e.data.hmRun)return;
        var m=e.data;
        if(m.t==='ready'){fr.contentWindow.postMessage({code:code},'*');return;}
        if(m.t==='done'){if(!o.children.length)outLine(o,t('(нет вывода)'),'st');end();return;}
        outLine(o,(m.a||[]).join(' '),m.t==='error'||m.t==='warn'?'err':'');
      }
      window.addEventListener('message',onMsg);
      var timer=setTimeout(function(){outLine(o,t('Остановлено: выполнение дольше 8 секунд'),'err');end();},8000);
      fr.srcdoc='<!doctype html>'+SANDBOX_SHIM+'<script>'
        +'var S=function(t,a){parent.postMessage({hmRun:1,t:t,a:a},"*")};'
        +'var F=function(v){try{if(typeof v==="string")return v;if(v instanceof Error)return v.stack||String(v);if(typeof v==="function")return String(v);var j=JSON.stringify(v);return j&&j.length>80?JSON.stringify(v,null,2):j}catch(e){return String(v)}};'
        +'["log","info","warn","error","debug"].forEach(function(k){console[k]=function(){S(k,[].map.call(arguments,F))}});'
        +'window.onerror=function(m,s,l,c,e){S("error",[String(e&&e.stack||m)])};'
        +'window.addEventListener("message",function(e){if(!e.data||typeof e.data.code!=="string")return;'
        +'var AF=Object.getPrototypeOf(async function(){}).constructor;'
        +'try{new AF(e.data.code)().then(function(r){if(r!==undefined)S("log",["→ "+F(r)]);S("done",[])},function(err){S("error",[String(err&&err.stack||err)]);S("done",[])})}catch(err){S("error",[String(err&&err.stack||err)]);S("done",[])}});'
        +'S("ready",[]);<\/script>';
      document.body.appendChild(fr);
    });
  }

  var pyWorker=null,pySeq=0,pyHandlers={};
  function getPyWorker(){
    if(pyWorker)return pyWorker;
    var src=[
      "importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');",
      "var py=null;",
      "self.onmessage=async function(e){var id=e.data.id,code=e.data.code;function S(t,a){self.postMessage({id:id,t:t,a:a});}",
      "try{if(!py){S('status','Загружаю Python (один раз, ~10 МБ)…');py=await loadPyodide();}",
      "py.setStdout({batched:function(s){S('log',s)}});py.setStderr({batched:function(s){S('error',s)}});",
      "await py.loadPackagesFromImports(code,{messageCallback:function(m){S('status',m)}});",
      "py.runPython(\"import os\\nos.environ['MPLBACKEND']='AGG'\");",
      "var r=await py.runPythonAsync(code);",
      "if(r!==undefined&&r!==null){try{S('log','→ '+String(r));}catch(_){}}",
      "var figs=py.runPython(\"import sys\\n_hm=[]\\nif 'matplotlib' in sys.modules:\\n  import matplotlib.pyplot as _p, io as _i, base64 as _b\\n  for _n in _p.get_fignums():\\n    _f=_p.figure(_n);_buf=_i.BytesIO();_f.savefig(_buf,format='png',dpi=110,bbox_inches='tight');_hm.append(_b.b64encode(_buf.getvalue()).decode())\\n  _p.close('all')\\n_hm\").toJs();",
      "figs.forEach(function(b){S('img',b)});S('done','');}",
      "catch(err){S('error',String(err&&err.message||err));S('done','');}};"
    ].join('\n');
    pyWorker=new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})));
    pyWorker.onmessage=function(e){var h=pyHandlers[e.data.id];if(h)h(e.data);};
    pyWorker.onerror=function(e){Object.keys(pyHandlers).forEach(function(k){pyHandlers[k]({t:'error',a:String(e.message||'Ошибка Python')});pyHandlers[k]({t:'done'});});};
    return pyWorker;
  }
  function runPy(code,o){
    return new Promise(function(resolve){
      var id=++pySeq;var w=getPyWorker();var any=false;
      var timer=setTimeout(function(){outLine(o,t('Остановлено: выполнение дольше 60 секунд'),'err');try{pyWorker.terminate();}catch(e){}pyWorker=null;delete pyHandlers[id];resolve();},60000);
      var status=null;
      pyHandlers[id]=function(m){
        if(m.t==='status'){if(!status){status=el('div','st');o.appendChild(status);}status.textContent=m.a;return;}
        if(status){status.remove();status=null;}
        if(m.t==='img'){var img=el('img');img.src='data:image/png;base64,'+m.a;img.alt=t('График');o.appendChild(img);any=true;return;}
        if(m.t==='done'){if(!any)outLine(o,t('(нет вывода)'),'st');clearTimeout(timer);delete pyHandlers[id];resolve();return;}
        any=true;outLine(o,m.a,m.t==='error'?'err':'');
      };
      w.postMessage({id:id,code:code});
    });
  }
  async function runCode(btn){
    var block=btn.closest('.code-block');if(!block||btn.disabled)return;
    var lang=runnable(block.getAttribute('data-lang'));if(!lang)return;
    var code='';try{code=decodeURIComponent(block.getAttribute('data-code')||'');}catch(e){code=(block.querySelector('code')||{}).textContent||'';}
    var o=outPanel(block);
    block.classList.add('show-out');
    block.querySelectorAll('.code-tab').forEach(function(b){b.classList.toggle('on',b===btn);});
    btn.disabled=true;btn.classList.add('running');
    try{await (lang==='py'?runPy(code,o):lang==='html'?runHtml(code,o):runJs(code,o));}
    finally{btn.disabled=false;btn.classList.remove('running');}
  }

  window.HmRich={KINDS:KINDS,splitRich:splitRich,render:render,renderPending:renderPending,mdToHtml:mdToHtml,typeset:typeset,
    runCode:runCode,showCode:showCode,runnable:runnable,chartToImage:chartToImage,findPhoto:findPhoto,sendPrompt:sendPrompt,compileExpr:compileExpr,parseLoose:parseLoose,ICON:ICON};
})();
