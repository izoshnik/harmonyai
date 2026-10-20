/* ===== HarmonyAI — интерактивные блоки в ответах ИИ =====
   Модель пишет обычный Markdown и, где уместно, специальные блоки:

     ```quiz     — тест: вопросы с вариантами, проверка, подсказки, результаты
     ```chart    — интерактивный график: функции с ползунками или данные
     ```diagram  — схема / карта понятий (синтаксис Mermaid)
     ```photo    — фото по теме (Википедия) или иллюстрация, нарисованная ИИ
     ```buttons  — кнопки следующих шагов: нажатие отправляет готовый запрос

   Формулы — LaTeX: $…$ в строке, $$…$$ отдельной строкой (KaTeX).
   Код JavaScript и Python запускается кнопкой «Запустить» прямо в браузере:
   JS — в изолированном iframe, Python — Pyodide в отдельном потоке.

   Тяжёлые библиотеки (KaTeX, Mermaid, Pyodide) грузятся только когда нужны.
   Блок с ошибкой в JSON не ломает ответ: показывается аккуратная заглушка.

   API: window.HmRich = { splitRich, render, renderPending, mdToHtml, typeset,
                          runCode, chartToImage, findPhoto, KINDS }            */
(function(){
  'use strict';

  var KINDS=['quiz','chart','diagram','mermaid','photo','image','buttons'];
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
    return out;
  }

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
  function mdToHtml(md){
    var pm=protectMath(md);
    var html=typeof window.marked!=='undefined'?window.marked.parse(pm.md):esc(pm.md);
    if(!pm.maths.length)return html;
    return html.replace(/\u2063HMMATH(\d+)\u2063/g,function(_,i){
      var m=pm.maths[+i];if(!m)return '';
      return m.display
        ?'<span class="hm-math hm-math-block" data-display="1" data-tex="'+esc(m.tex)+'">'+esc(m.tex)+'</span>'
        :'<span class="hm-math" data-tex="'+esc(m.tex)+'">'+esc(m.tex)+'</span>';
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
  function typeset(root){
    if(!root||!root.querySelector)return;
    var nodes=root.querySelectorAll('.hm-math:not([data-done])');
    if(!nodes.length)return;
    loadKatex().then(function(k){
      nodes.forEach(function(n){
        if(n.dataset.done)return;
        try{k.render(n.getAttribute('data-tex')||'',n,{displayMode:n.dataset.display==='1',throwOnError:false,strict:'ignore',output:'html'});n.dataset.done='1';}catch(e){}
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

  function normChart(raw){
    var d=parseLoose(raw);if(!d||typeof d!=='object')return null;
    var type=String(d.type||(d.functions||d.function||d.expr?'function':'line')).toLowerCase();
    if(type==='function'||type==='functions'||type==='plot'){
      var fns=d.functions||(d.function?[d.function]:d.expr?[d.expr]:[]);
      fns=fns.map(function(f){return typeof f==='string'?{expr:f,label:'y = '+f}:{expr:f.expr||f.y||f.f||'',label:f.label||f.name||('y = '+(f.expr||f.y||''))};}).filter(function(f){return f.expr;});
      if(!fns.length)return null;
      var compiled=[];
      try{fns.forEach(function(f){compiled.push(compileExpr(f.expr.replace(/^\s*y\s*=\s*/i,'')));});}catch(e){return {error:e.message};}
      var params=(d.params||d.parameters||[]).map(function(p){var min=+p.min,max=+p.max;if(!isFinite(min))min=-5;if(!isFinite(max))max=5;var v=isFinite(+p.value)?+p.value:(min+max)/2;return {name:String(p.name||'a'),label:p.label||p.name,min:min,max:max,step:+p.step||(max-min)/100,value:v};});
      var x=d.x||d.xRange||d.domain||[-10,10];
      return {kind:'fn',title:d.title||'',fns:fns,compiled:compiled,params:params,x:[+x[0],+x[1]],y:d.y||d.yRange||null,xLabel:d.xLabel||'x',yLabel:d.yLabel||'y'};
    }
    var labels=d.labels||d.x||[];var series=d.series||d.datasets||(d.data?[{name:d.name||'',data:d.data}]:[]);
    series=series.map(function(s,i){return {name:s.name||s.label||'',data:(s.data||s.values||[]).map(Number),color:s.color||PALETTE[i%PALETTE.length]};}).filter(function(s){return s.data.length;});
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
    if(items.length>1||c.kind==='fn'||c.kind==='pie'){var lg=el('div','hmr-legend');items.forEach(function(it){var sp=el('span');sp.innerHTML='<i style="background:'+it.color+'"></i>'+mdToHtml(it.name).replace(/^<p>|<\/p>\s*$/g,'');lg.appendChild(sp);});card.appendChild(lg);}
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
    }catch(e){console.warn('[hm-rich]',kind,e);return renderBroken(host,'блок',body);}
    return null;
  }
  function renderPending(kind,host){
    if(kind==='quiz')return quizSkeleton(host);
    if(kind==='buttons')return null;
    var card=el('div','hmr-card hmr-skel');
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
  var RUN_LANGS={js:'js',javascript:'js',mjs:'js',py:'py',python:'py',python3:'py'};
  function runnable(lang){return RUN_LANGS[String(lang||'').toLowerCase()]||'';}
  function outPanel(block){
    var o=block.querySelector(':scope > .code-out');
    if(!o){o=el('div','code-out');block.appendChild(o);}
    o.innerHTML='<div class="code-out-head">'+esc(t('Результат'))+'</div>';return o;
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
        if(m.t==='done'){if(o.children.length<2)outLine(o,t('(нет вывода)'),'st');end();return;}
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
    btn.disabled=true;btn.classList.add('running');
    try{await (lang==='py'?runPy(code,o):runJs(code,o));}
    finally{btn.disabled=false;btn.classList.remove('running');}
  }

  window.HmRich={KINDS:KINDS,splitRich:splitRich,render:render,renderPending:renderPending,mdToHtml:mdToHtml,typeset:typeset,
    runCode:runCode,runnable:runnable,chartToImage:chartToImage,findPhoto:findPhoto,sendPrompt:sendPrompt,compileExpr:compileExpr,parseLoose:parseLoose,ICON:ICON};
})();
