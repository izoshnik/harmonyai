/* ===== HarmonyAI — индикатор «Думаю» (нотный стан) и анимации генерации =====
   Подключается в app.html тегом <script defer src="/js/hm-think-staff.js">.
   Стили — /css/hm-think.css. Внешних зависимостей нет.

   window.HmThinkStaff.create(question, opts) → ручка:
     .el          — корневой элемент (<span class="hts">): нотный стан + подпись + тональность + секунды
     .start()     — запустить анимацию (вызывается автоматически)
     .setLabel(s) — сменить подпись с плавным переходом
     .finish(ms)  — ноты сходятся в тоническое трезвучие, подпись «Думал N с»
     .stop()      — остановить без финала (обрыв, ошибка)
   Тональность ищется в тексте вопроса («ля минор», «F# major», «a-moll»). Если её
   нет — цвет берётся из хеша вопроса, а чип тональности не показывается.

   window.HmGenAnim.image(canvasEl) → {stop()} — «проявка» картинки мозаикой.
   window.HmGenAnim.file(cardEl)    → {stop(ok)} — документ «пишется» строками.

   Внутреннюю цепочку рассуждений модели мы не показываем и не имитируем:
   здесь только визуальный индикатор и реально прошедшее время. */
(function(){
  'use strict';
  var reduced=false;
  try{reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
  var SVGNS='http://www.w3.org/2000/svg';

  /* ---------- тональность ---------- */
  var RU_NOTE={'до':'C','ре':'D','ми':'E','фа':'F','соль':'G','ля':'A','си':'B'};
  var RU_NAME={C:'до',D:'ре',E:'ми',F:'фа',G:'соль',A:'ля',B:'си'};
  function makeKey(letter,acc,mode,detected){
    var name=RU_NAME[letter]+(acc==='#'?'-диез':acc==='b'?'-бемоль':'')+(mode==='major'?' мажор':' минор');
    return {letter:letter,acc:acc,mode:mode,name:name,detected:detected!==false};
  }
  function detectKey(q){
    q=String(q||'');
    var m=q.match(/(?:^|[^а-яё])(до|ре|ми|фа|соль|ля|си)(?:[\s-]*(диез|бемоль))?\s+(мажор|минор)/i);
    if(m)return makeKey(RU_NOTE[m[1].toLowerCase()],m[2]?(m[2].toLowerCase()==='диез'?'#':'b'):'',m[3].toLowerCase().indexOf('мажор')===0?'major':'minor');
    m=q.match(/\b([A-G])(#|♯|b|♭)?\s*(major|minor|maj|min)\b/i);
    if(m)return makeKey(m[1].toUpperCase(),m[2]?(/[#♯]/.test(m[2])?'#':'b'):'',/^maj/i.test(m[3])?'major':'minor');
    m=q.match(/\b([a-h])(is|es|s)?-(dur|moll)\b/i);
    if(m){
      var l=m[1].toUpperCase(),acc=m[2]?(m[2].toLowerCase()==='is'?'#':'b'):'';
      if(l==='H')l='B';else if(l==='B'){l='B';acc='b';}
      return makeKey(l,acc,m[3].toLowerCase()==='dur'?'major':'minor');
    }
    return null;
  }
  function keyFor(q){
    var k=detectKey(q);if(k)return k;
    var h=0,s=String(q||'');
    for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;
    return makeKey('CDEFGAB'[h%7],'',(h>>3)%2?'major':'minor',false);
  }

  function fmtSecs(ms){
    var s=Math.max(1,Math.round((Number(ms)||0)/1000));
    if(s<60)return s+' с';
    var m=Math.floor(s/60),r=s%60;return m+' мин '+(r<10?'0':'')+r+' с';
  }

  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function sv(tag,attrs){var e=document.createElementNS(SVGNS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);return e;}

  function buildStaffSvg(){
    var svg=sv('svg',{'class':'hts-staff',viewBox:'0 0 36 22','aria-hidden':'true',focusable:'false'});
    var g=sv('g',{'class':'hts-lines'});
    [3,7,11,15,19].forEach(function(y){g.appendChild(sv('line',{x1:0,x2:36,y1:y,y2:y}));});
    svg.appendChild(g);
    var ph=sv('line',{'class':'hts-playhead',x1:2,x2:2,y1:0,y2:22});svg.appendChild(ph);
    var notes=[];
    for(var i=0;i<5;i++){var n=sv('g',{'class':'hts-n'});n.appendChild(sv('ellipse',{rx:2.3,ry:1.6}));svg.appendChild(n);notes.push(n);}
    return {svg:svg,playhead:ph,notes:notes};
  }

  /* ---------- глаголы «Думаю» ----------
     На каждый запрос выбирается одно случайное слово. Это только
     подпись-индикатор: что именно модель обдумывает, показывает заголовок
     из её настоящих рассуждений (setHeadline), а не эти слова. */
  var VERBS=['Думаю','Размышляю','Рассуждаю','Обдумываю','Осмысливаю','Анализирую','Изучаю','Исследую','Разбираю',
    'Рассматриваю','Продумываю','Прорабатываю','Сопоставляю','Сравниваю','Проверяю','Перепроверяю','Уточняю','Выясняю',
    'Прикидываю','Вникаю','Углубляюсь','Интерпретирую','Разбираюсь','Обозреваю','Рассчитываю','Принимаю решение',
    'Обосновываю','Систематизирую','Структурирую','Синтезирую'];
  function pickVerb(prev){var v;do{v=VERBS[Math.floor(Math.random()*VERBS.length)];}while(v===prev&&VERBS.length>1);return v;}

  /* ---------- другие анимации рядом с подписью ----------
     staff — нотный стан (JS), остальные — чистый CSS в том же поле 36×22. */
  var ANIMS=['staff','eq','metro','wave','keys','orbit'];
  function buildAlt(kind){
    var svg=sv('svg',{'class':'hts-staff hts-alt hts-'+kind,viewBox:'0 0 36 22','aria-hidden':'true',focusable:'false'});
    var i;
    if(kind==='eq'){            // эквалайзер: 6 полос прыгают вразнобой
      for(i=0;i<6;i++){var r=sv('rect',{x:3+i*5.4,y:3,width:3.2,height:16,rx:1.4});r.style.animationDelay=(-i*.17)+'s';svg.appendChild(r);}
    }else if(kind==='metro'){   // метроном: маятник качается, грузик скользит
      svg.appendChild(sv('path',{'class':'mb',d:'M12 21h12l-3-17h-6z'}));
      var arm=sv('g',{'class':'ma'});arm.appendChild(sv('line',{x1:18,y1:19,x2:18,y2:3}));arm.appendChild(sv('rect',{'class':'mw',x:16,y:7,width:4,height:3,rx:1}));svg.appendChild(arm);
    }else if(kind==='wave'){    // звуковая волна бежит по линии
      svg.appendChild(sv('path',{'class':'w1',d:'M-36 11q4.5-8 9 0t9 0 9 0 9 0 9 0 9 0 9 0 9 0 9 0'}));
      svg.appendChild(sv('path',{'class':'w2',d:'M-36 11q4.5-5 9 0t9 0 9 0 9 0 9 0 9 0 9 0 9 0 9 0'}));
    }else if(kind==='keys'){    // клавиши: белые нажимаются по очереди
      for(i=0;i<5;i++){var k=sv('rect',{'class':'kw',x:1+i*7,y:2,width:6.4,height:18,rx:1.2});k.style.animationDelay=(i*.18)+'s';svg.appendChild(k);}
      [5.5,12.5,26.5].forEach(function(x){svg.appendChild(sv('rect',{'class':'kb',x:x,y:2,width:4,height:10.5,rx:.8}));});
    }else{                       // orbit: три ноты кружат вокруг центра
      svg.appendChild(sv('circle',{'class':'oc',cx:18,cy:11,r:7.5}));
      for(i=0;i<3;i++){var g=sv('g',{'class':'on'});g.style.animationDelay=(-i*.6)+'s';g.appendChild(sv('ellipse',{cx:18,cy:3.5,rx:2.3,ry:1.7}));svg.appendChild(g);}
    }
    return svg;
  }

  /* ---------- индикатор «Думаю» ---------- */
  function create(question,opts){
    opts=opts||{};
    var root=el('span','hts');root.setAttribute('data-state','thinking');
    var st=buildStaffSvg();
    var anim=opts.anim&&ANIMS.indexOf(opts.anim)>=0?opts.anim:ANIMS[Math.floor(Math.random()*ANIMS.length)];
    var isStaff=anim==='staff';
    root.setAttribute('data-anim',anim);
    var verb=opts.label||pickVerb();
    var label=el('span','hts-label',verb);
    var head=el('span','hts-head','');head.hidden=true;
    var chip=el('span','hts-key');chip.hidden=true;
    var time=el('span','hts-time','');
    root.appendChild(isStaff?st.svg:buildAlt(anim));root.appendChild(label);root.appendChild(head);root.appendChild(chip);root.appendChild(time);
    var lastVerb=0;

    var notes=st.notes,ells=notes.map(function(n){return n.firstChild;}),playhead=st.playhead;
    var X=[6,12,18,24,30],Y=[3,5,7,9,11,13,15,17,19],LET=['F','E','D','C','B','A','G','F','E'];
    var LOOP=1800,SWAP_EVERY=2300;
    var key=keyFor(question),S='CDEFGAB',ki=S.indexOf(key.letter);
    var chordSet={};chordSet[S[ki]]=1;chordSet[S[(ki+2)%7]]=1;chordSet[S[(ki+4)%7]]=1;
    var baseHue=(key.mode==='major'?28:250)+ki*7+(key.acc==='#'?10:key.acc==='b'?-10:0);
    root.style.setProperty('--h0',baseHue);
    chip.textContent=key.name;chip.hidden=!key.detected;

    var col=[0,1,2,3,4],pitch=X.map(function(){return 2+Math.floor(Math.random()*5);}),wasLit=[0,0,0,0,0];
    var raf=0,running=false,lastSec=-1,lastSwap=0,timers=[];
    var t0=Number(opts.startedAt)||performance.now();
    function place(i,y,x,delay){
      if(x==null)x=X[col[i]];
      notes[i].style.transitionDelay=(delay||0)+'ms';
      notes[i].style.transform='translate('+x+'px,'+y+'px)';
    }
    notes.forEach(function(n,i){place(i,Y[pitch[i]]);});
    function step(i){
      var cur=pitch[i],o=[];
      for(var p=Math.max(0,cur-3);p<=Math.min(8,cur+3);p++){if(p===cur)continue;var w=chordSet[LET[p]]?3:1;for(var k=0;k<w;k++)o.push(p);}
      pitch[i]=o[Math.floor(Math.random()*o.length)];place(i,Y[pitch[i]]);
    }
    function swap(){
      var a=Math.floor(Math.random()*5),b=Math.floor(Math.random()*4);if(b>=a)b++;
      var t=col[a];col[a]=col[b];col[b]=t;
      [a,b].forEach(function(i){notes[i].classList.add('swap');place(i,Y[pitch[i]]);
        timers.push(setTimeout(function(){notes[i].classList.remove('swap');},780));});
    }
    function frame(now){
      if(!running)return;
      if(!root.isConnected){running=false;return;}   // элемент удалён — цикл гаснет сам
      var e=now-t0;
      // Одно случайное слово на весь запрос (следующий запрос — новое слово).
      if(!reduced&&isStaff){
        var x=2+((e%LOOP)/LOOP)*32;
        playhead.setAttribute('x1',x);playhead.setAttribute('x2',x);
        for(var i=0;i<5;i++){
          var nx=X[col[i]],lit=Math.abs(nx-x)<3.2;
          if(wasLit[i]&&!lit&&Math.random()<.75)step(i);
          wasLit[i]=lit;notes[i].classList.toggle('lit',lit);
          ells[i].style.setProperty('--h',(baseHue+38*Math.sin(e/700-nx/7)+(9-pitch[i])*3).toFixed(1));
        }
        if(e-lastSwap>SWAP_EVERY){lastSwap=e;swap();}
      }else if(isStaff)ells.forEach(function(x){x.style.setProperty('--h',baseHue);});
      var s=Math.floor(e/1000);
      if(s!==lastSec){lastSec=s;time.textContent=s>0?s+' с':'';}
      raf=requestAnimationFrame(frame);
    }
    function setLabel(str){
      if(label.textContent===str)return;
      if(reduced){label.textContent=str;return;}
      label.classList.add('out');
      timers.push(setTimeout(function(){label.textContent=str;label.classList.remove('out');},180));
    }
    var api={
      el:root,key:key,startedAt:t0,verb:verb,anim:anim,
      start:function(){if(running)return;running=true;raf=requestAnimationFrame(frame);},
      setLabel:setLabel,
      /* Заголовок из НАСТОЯЩИХ рассуждений модели: «Сравниваю гармонический минор с мелодическим». */
      setHeadline:function(t){
        t=String(t||'').trim();
        if(!t){head.hidden=true;return;}
        if(head.textContent===t)return;
        head.hidden=false;
        if(reduced){head.textContent=t;return;}
        head.classList.add('out');
        timers.push(setTimeout(function(){head.textContent=t;head.classList.remove('out');},160));
      },
      stop:function(){running=false;cancelAnimationFrame(raf);timers.forEach(clearTimeout);timers=[];},
      finish:function(durationMs,text){
        api.stop();
        var ms=durationMs!=null&&isFinite(durationMs)?durationMs:(performance.now()-t0);
        root.setAttribute('data-state','done');
        if(!isStaff){time.textContent='';setLabel(text||('Думал '+fmtSecs(ms)));return ms;}
        var chord=[];for(var p=0;p<9;p++)if(chordSet[LET[p]])chord.push(p);
        chord.sort(function(a,b){return b-a;});chord=chord.slice(0,4);
        notes.forEach(function(n,i){
          n.classList.remove('lit','swap');
          if(i<chord.length){pitch[i]=chord[i];ells[i].style.setProperty('--h',baseHue+i*14);place(i,Y[chord[i]],18,i*70);}
          else n.classList.add('gone');
        });
        time.textContent='';
        setLabel(text||('Думал '+fmtSecs(ms)));
        return ms;
      }
    };
    api.start();
    return api;
  }

  /* ---------- генерация картинки: «проявка» мозаикой ---------- */
  function image(canvasEl,opts){
    opts=opts||{};
    if(!canvasEl)return {stop:function(){}};
    var host=el('span','hga-img');host.setAttribute('aria-hidden','true');
    var cv=document.createElement('canvas');host.appendChild(cv);
    var sweep=el('span','hga-sweep');host.appendChild(sweep);
    var clock=el('span','hga-clock','');
    canvasEl.appendChild(host);canvasEl.appendChild(clock);
    canvasEl.classList.add('hga-on');
    if(opts.mini){host.classList.add('hga-img-mini');clock.remove();}
    var ctx=cv.getContext('2d'),N=opts.mini?5:12,raf=0,alive=true,t0=performance.now(),seed=Math.random()*360,lastSec=-1;
    var cells=[];for(var i=0;i<N*N;i++)cells.push({d:Math.random(),v:0});
    function size(){
      var r=host.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
      cv.width=Math.max(1,Math.round(r.width*dpr));cv.height=Math.max(1,Math.round(r.height*dpr));
    }
    size();
    function draw(now){
      if(!alive)return;
      if(!host.isConnected){alive=false;return;}
      var e=(now-t0)/1000;
      if(cv.width<4)size();
      var w=cv.width,h=cv.height,cw=w/N,ch=h/N;
      ctx.clearRect(0,0,w,h);
      // Фронт «проявки» идёт волной из центра и возвращается: картинка как будто
      // набирается пятнами цвета, но никогда не «заканчивается» раньше ответа сервера.
      var front=(Math.sin(e*0.55-Math.PI/2)+1)/2*1.25+(opts.mini?0.45:0.12);
      for(var y=0;y<N;y++)for(var x=0;x<N;x++){
        var c=cells[y*N+x];
        var dx=(x+.5)/N-.5,dy=(y+.5)/N-.5,dist=Math.sqrt(dx*dx+dy*dy)*1.4+c.d*.25;
        var target=dist<front?1:0;
        c.v+=(target-c.v)*(reduced?1:0.08);
        if(c.v<0.02)continue;
        var hue=(seed+x*9+y*6+40*Math.sin(e*0.6+x*.4-y*.3))%360;
        var light=46+14*Math.sin(e*1.3+c.d*6);
        ctx.globalAlpha=c.v*0.9;
        ctx.fillStyle='hsl('+hue.toFixed(0)+' 62% '+light.toFixed(0)+'%)';
        var pad=Math.max(1,cw*0.08*(1-c.v));
        var r=Math.min(cw,ch)*0.22;
        roundRect(ctx,x*cw+pad,y*ch+pad,cw-pad*2,ch-pad*2,r);ctx.fill();
      }
      ctx.globalAlpha=1;
      var s=Math.floor(e);if(s!==lastSec){lastSec=s;clock.textContent=s>0?s+' с':'';}
      if(!reduced)raf=requestAnimationFrame(draw);
    }
    function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
    var ro=null;try{ro=new ResizeObserver(size);ro.observe(host);}catch(e){}
    raf=requestAnimationFrame(draw);
    return {stop:function(){alive=false;cancelAnimationFrame(raf);try{ro&&ro.disconnect();}catch(e){}}};
  }

  /* ---------- генерация файла: документ «пишется» ---------- */
  function file(cardEl){
    if(!cardEl)return {stop:function(){}};
    cardEl.classList.remove('hga-file-ok','hga-file-err');
    cardEl.classList.add('hga-file');
    var ic=cardEl.querySelector('.file-card-ic');
    var doc=el('span','hga-doc');doc.setAttribute('aria-hidden','true');
    for(var i=0;i<5;i++){var l=el('i');l.style.setProperty('--i',i);doc.appendChild(l);}
    var bar=el('span','hga-bar');bar.setAttribute('aria-hidden','true');bar.appendChild(el('i'));
    if(ic){ic._hgaOld=ic.innerHTML;ic.innerHTML='';ic.appendChild(doc);}
    cardEl.appendChild(bar);
    return {stop:function(ok){
      cardEl.classList.remove('hga-file');
      cardEl.classList.add(ok===false?'hga-file-err':'hga-file-ok');
      setTimeout(function(){
        if(ic&&ic._hgaOld!=null){ic.innerHTML=ic._hgaOld;ic._hgaOld=null;}
        bar.remove();cardEl.classList.remove('hga-file-ok','hga-file-err');
      },900);
    }};
  }

  window.HmThinkStaff={create:create,detectKey:detectKey,fmtSecs:fmtSecs,verbs:VERBS,anims:ANIMS};
  window.HmGenAnim={image:image,file:file};
})();
