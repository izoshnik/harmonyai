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

  var KINDS=['quiz','chart','diagram','mermaid','photo','image','buttons','steps','compare','flow','timeline'];
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
  async function generateIllustration(prompt){
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
      fig.innerHTML='';var img=el('img');img.loading='lazy';img.alt=d.caption||d.query||d.prompt||'';img.src=r.url;
      img.onerror=function(){fig.innerHTML='<div class="hmr-photo-ph">'+esc(t('Фото недоступно'))+'</div>';};
      fig.appendChild(img);
      var cap=(d.caption?esc(d.caption):'')+(r.source?(d.caption?' · ':'')+(r.href?'<a href="'+esc(r.href)+'" target="_blank" rel="noopener">'+esc(r.source)+'</a>':esc(r.source)):'');
      if(cap)fig.appendChild(el('figcaption','',cap));
    }
    if(cached&&cached.url){show(cached);return fig;}
    fig.innerHTML='<div class="hmr-photo-ph">'+ICON.spin+esc(t('Ищу фото…'))+'</div>';
    (async function(){
      var r=d.query?await findPhoto(d.query):null;
      if(r){store(key,r);show(r);return;}
      if(!d.prompt){fig.innerHTML='<div class="hmr-photo-ph">'+esc(t('Подходящее фото не найдено'))+'</div>';return;}
      // Генерация стоит лимитов: автоматически — только для свежего ответа, из истории — по кнопке.
      var start=function(){
        fig.innerHTML='<div class="hmr-photo-ph">'+ICON.spin+esc(t('Рисую иллюстрацию…'))+'</div>';
        var p=photoInflight[key]||(photoInflight[key]=generateIllustration(d.prompt));
        p.then(function(url){var rr={url:url,source:t('Иллюстрация создана ИИ')};store(key,rr);show(rr);})
         .catch(function(e){fig.innerHTML='<div class="hmr-photo-ph">'+esc(e.message||t('Не удалось нарисовать иллюстрацию'))+'</div>';delete photoInflight[key];});
      };
      if(ctx&&ctx.live||photoInflight[key])start();
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

  function renderBroken(host,what,body){
    var card=el('div','hmr-card');card.innerHTML='<div class="hmr-diagram-err">'+esc(t('Не удалось показать'))+' '+esc(t(what))+'.</div>';
    host.appendChild(card);return card;
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
    }catch(e){console.warn('[hm-rich]',kind,e);return renderBroken(host,'блок',body);}
    return null;
  }
  function renderPending(kind,host){
    if(kind==='quiz')return quizSkeleton(host);
    if(kind==='buttons')return null;
    var card=el('div','hmr-card hmr-skel');
    if(kind==='steps'||kind==='compare'||kind==='flow'||kind==='timeline')return blocksSkeleton(kind,host);
    var label={chart:'Строю график…',diagram:'Рисую схему…',mermaid:'Рисую схему…',photo:'Подбираю фото…',image:'Подбираю фото…'}[kind]||'Готовлю…';
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
  /* HTML/SVG — живая страница в изолированном iframe (без доступа к сайту и аккаунту). */
  function runHtml(code,o){
    o.classList.add('is-html');
    var fr=document.createElement('iframe');fr.className='code-frame';
    fr.setAttribute('sandbox','allow-scripts allow-modals allow-pointer-lock');
    fr.setAttribute('referrerpolicy','no-referrer');fr.title=t('Результат');
    var doc=/<html|<body|<!doctype/i.test(code)?code:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#fff">'+code;
    fr.srcdoc=doc;o.appendChild(fr);
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
      fr.srcdoc='<!doctype html><script>'
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
