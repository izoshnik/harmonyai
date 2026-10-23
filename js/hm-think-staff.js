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
    var m=Math.floor(s/60),r=s%60;return m+' мин'+(r?' '+r+' с':'');
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

  /* ---------- анимации рядом с подписью ----------
     staff — нотный стан, только для музыкальных вопросов. Остальные — 15 canvas-
     анимаций: рисуются в поле 56×56 на скрытом холсте и уменьшаются до размера
     чуть выше заглавной буквы подписи (так свечение и толщина линий не «плывут»). */
  var CANVAS_ANIMS=['spark','orb','particles','globe','comets','ripple','lissajous','swarm','face','torus',
    'siri','gemini','cloud','aurora','plasma'];
  var COLOR_LABEL={siri:['#ff4fa3','#5fd8ff','#a78bfa'],gemini:['#4f8bff','#c084fc','#f472b6'],
    cloud:['#60a5fa','#e0f2fe','#3b82f6'],aurora:['#34d399','#22d3ee','#a78bfa'],plasma:['#fb923c','#f43f5e','#c026d3']};
  var ANIMS=['staff'].concat(CANVAS_ANIMS);
  var MUSIC_RE=/музык|нот(?:а|ы|у|ой|ам|ах|н|ный|ная)?(?![а-яё])|нотн|аккорд|гармони|сольфедж|интервал|тональн|мажор|минор|ритм|мелоди|композит|песн|трек|плейлист|альбом|исполнит|гамм|(?:^|[^а-яё])лад|септаккорд|трезвуч|доминант|тоник|субдоминант|каденц|модуляц|кварт|квинт|терци|секунд[аы] (?:малая|большая)|октав|фортепиан|пианин|гитар|скрипк|виолончел|симфон|опер[аы]|джаз|блюз|техно|хаус|рок|рэп|хип-хоп|бит(?:ы|ов)?(?![а-яё])|синтез|вокал|хор|баян|домр|балалайк|партитур|такт|темп|размер\s+\d|ключ(?:е|а)?\s+(?:до|соль|фа)|\b(?:music|chord|harmony|melody|scale|song|track|playlist|tempo|rhythm|piano|guitar|key of)\b/i;
  function isMusicQuestion(q){return MUSIC_RE.test(String(q||''));}

  var S56=56,C56=28,TAU=Math.PI*2;
  function rot(p,ry,rx){var cy=Math.cos(ry),sy=Math.sin(ry),cx=Math.cos(rx),sx=Math.sin(rx);
    var x1=p[0]*cy-p[2]*sy,z1=p[0]*sy+p[2]*cy;return [x1,p[1]*cx-z1*sx,p[1]*sx+z1*cx];}
  function wobbly(x,t,base,amp){x.beginPath();for(var i=0;i<=64;i++){var a=i/64*TAU;
    var r=base+amp*(Math.sin(a*3+t*2.2)*.6+Math.sin(a*5-t*1.7)*.4+Math.sin(a*2+t*3.1)*.5);
    var px=C56+Math.cos(a)*r,py=C56+Math.sin(a)*r;i?x.lineTo(px,py):x.moveTo(px,py);}x.closePath();}
  var SPHERE=(function(n){var o=[];for(var i=0;i<n;i++){var y=1-i/(n-1)*2,r=Math.sqrt(1-y*y),th=i*2.39996;o.push([Math.cos(th)*r,y,Math.sin(th)*r]);}return o;})(140);
  var CLOUD=[];for(var ci=0;ci<70;ci++)CLOUD.push({s:Math.random()*TAU,sp:.8+Math.random()*1.4,inc:Math.random()*Math.PI,yaw:Math.random()*TAU});
  var TORUS=[];for(var u=0;u<28;u++)for(var v=0;v<10;v++){var aa=u/28*TAU,bb=v/10*TAU;TORUS.push([(13+6*Math.cos(bb))*Math.cos(aa),6*Math.sin(bb),(13+6*Math.cos(bb))*Math.sin(aa)]);}

  /* ink — цвет «белых» анимаций: белый на тёмной теме, тёмный на светлой. */
  function painters(ink,paper){
    var W=function(a){return 'rgba('+ink+','+a+')';},INK='rgb('+ink+')',PAPER='rgb('+paper+')';
    return {
      spark:function(x,t){x.translate(C56,C56);x.rotate(t*.35);x.strokeStyle=INK;x.lineCap='round';x.shadowColor=INK;x.shadowBlur=8;
        for(var i=0;i<12;i++){var a=i/12*TAU,k=.5+.5*Math.sin(t*2.6+i*2.13),l=8+14*k;x.lineWidth=2+1.5*k;
          x.beginPath();x.moveTo(Math.cos(a)*3,Math.sin(a)*3);x.lineTo(Math.cos(a)*l,Math.sin(a)*l);x.stroke();}},
      orb:function(x,t){var br=1+.06*Math.sin(t*2);x.shadowColor=W(.6);x.shadowBlur=16;wobbly(x,t,17*br,1.4);
        var g=x.createRadialGradient(C56-6,C56-7,2,C56,C56,22);g.addColorStop(0,W(1));g.addColorStop(.7,W(.88));g.addColorStop(1,W(.62));x.fillStyle=g;x.fill();},
      particles:function(x,t){SPHERE.forEach(function(p){var w=1+.14*Math.sin(p[1]*7-t*4),q=rot(p,t*.7,.45),d=(q[2]+1)/2,R=20*w;
        x.fillStyle=W(.15+d*.85);x.beginPath();x.arc(C56+q[0]*R,C56+q[1]*R,.6+d*1.3,0,TAU);x.fill();});},
      globe:function(x,t){var R=20,k;x.lineWidth=1.6;
        for(k=0;k<8;k++){var ph=k/8*Math.PI+t*.8;x.strokeStyle=W(Math.sin(ph)>0?.9:.2);x.beginPath();x.ellipse(C56,C56,Math.abs(Math.cos(ph))*R,R,0,0,TAU);x.stroke();}
        for(k=-2;k<=2;k++){var lat=k/3*Math.PI/2,y=C56+Math.sin(lat)*R,rx=Math.cos(lat)*R;x.strokeStyle=W(.5);x.beginPath();x.ellipse(C56,y,rx,rx*.18,0,0,TAU);x.stroke();}
        x.fillStyle=INK;x.shadowColor=INK;x.shadowBlur=10;x.beginPath();x.arc(C56,C56,2+Math.sin(t*3),0,TAU);x.fill();},
      comets:function(x,t){x.fillStyle=INK;x.shadowColor=INK;x.shadowBlur=12;x.beginPath();x.arc(C56,C56,4+Math.sin(t*3)*.8,0,TAU);x.fill();x.shadowBlur=0;
        [[0,2.2],[TAU/3,1.7],[TAU*2/3,2.6]].forEach(function(o){for(var k=30;k>=0;k--){var a=t*o[1]-k*.07,ex=Math.cos(a)*22,ey=Math.sin(a)*8;
          var px=C56+ex*Math.cos(o[0])-ey*Math.sin(o[0]),py=C56+ex*Math.sin(o[0])+ey*Math.cos(o[0]);
          x.fillStyle=W(Math.pow(1-k/30,2));x.beginPath();x.arc(px,py,2.2*(1-k/34),0,TAU);x.fill();}});},
      ripple:function(x,t){for(var i=0;i<4;i++){var p=(t*.55+i/4)%1;x.strokeStyle=W(Math.pow(1-p,1.5));x.lineWidth=2*(1-p)+.5;x.beginPath();x.arc(C56,C56,5+p*22,0,TAU);x.stroke();}
        x.fillStyle=INK;x.shadowColor=INK;x.shadowBlur=14;x.beginPath();x.arc(C56,C56,5+1.5*Math.sin(t*3.5),0,TAU);x.fill();},
      lissajous:function(x,t){var pt=function(s){return rot([Math.sin(3*s),Math.sin(2*s+.5),Math.cos(3*s)],t*.5,.3);};x.lineCap='round';
        for(var k=80;k>0;k--){var a=pt(t*1.3-k*.03),b=pt(t*1.3-(k-1)*.03);x.strokeStyle=W((1-k/80)*(.4+.6*(b[2]+1)/2));x.lineWidth=2.2*(1-k/90);
          x.beginPath();x.moveTo(C56+a[0]*21,C56+a[1]*21);x.lineTo(C56+b[0]*21,C56+b[1]*21);x.stroke();}
        var h=pt(t*1.3);x.fillStyle=INK;x.shadowColor=INK;x.shadowBlur=10;x.beginPath();x.arc(C56+h[0]*21,C56+h[1]*21,2.6,0,TAU);x.fill();},
      swarm:function(x,t){var R=19+2*Math.sin(t*1.6);CLOUD.forEach(function(p){var a=p.s+t*p.sp;
        var vv=rot([Math.cos(a),Math.sin(a)*Math.cos(p.inc),Math.sin(a)*Math.sin(p.inc)],p.yaw+t*.3,0),d=(vv[2]+1)/2;
        x.fillStyle=W(.2+d*.8);x.beginPath();x.arc(C56+vv[0]*R,C56+vv[1]*R,.7+d*1.4,0,TAU);x.fill();});},
      face:function(x,t){x.translate(0,Math.sin(t*1.5)*1.2);x.fillStyle=INK;x.shadowColor=W(.5);x.shadowBlur=12;
        x.beginPath();x.arc(C56,C56,19,0,TAU);x.fill();x.shadowBlur=0;
        var lx=4.5*Math.sin(t*.9)*Math.min(1,Math.abs(Math.sin(t*.45))*3),ly=-2+2.5*Math.sin(t*1.3);
        var ph=t%3.4,blink=ph<.16?Math.abs(Math.cos(ph/.16*Math.PI)):1;x.fillStyle=PAPER;
        [-1,1].forEach(function(s){x.beginPath();x.ellipse(C56+s*6.5+lx,C56-2+ly,2.3,3.4*Math.max(.12,blink),0,0,TAU);x.fill();});
        x.strokeStyle=PAPER;x.lineWidth=2;x.lineCap='round';var m=Math.sin(t*.9)*2;
        x.beginPath();x.moveTo(C56-4+m+lx*.4,C56+8);x.quadraticCurveTo(C56+m+lx*.4,C56+8+1.5*Math.sin(t*2),C56+4+m+lx*.4,C56+7);x.stroke();},
      torus:function(x,t){TORUS.forEach(function(p){var q=rot(p,t*.9,.9+Math.sin(t*.6)*.5),d=(q[2]/19+1)/2;
        x.fillStyle=W(.1+d*.9);x.beginPath();x.arc(C56+q[0],C56+q[1],.5+d*1.2,0,TAU);x.fill();});},
      siri:function(x,t){x.save();x.beginPath();x.arc(C56,C56,21,0,TAU);x.clip();x.fillStyle='#07071a';x.fillRect(0,0,S56,S56);
        x.globalCompositeOperation='lighter';
        [['255,45,149',1.3,0],['45,212,255',1.7,2],['124,58,237',1.1,4],['52,211,153',2.1,1]].forEach(function(o){
          var bx=C56+Math.cos(t*o[1]+o[2])*8,by=C56+Math.sin(t*o[1]*1.3+o[2])*8,g=x.createRadialGradient(bx,by,0,bx,by,17);
          g.addColorStop(0,'rgba('+o[0]+',.95)');g.addColorStop(1,'rgba('+o[0]+',0)');x.fillStyle=g;x.fillRect(0,0,S56,S56);});
        x.restore();var h=x.createRadialGradient(C56-7,C56-8,0,C56-7,C56-8,10);h.addColorStop(0,'rgba(255,255,255,.5)');h.addColorStop(1,'rgba(255,255,255,0)');
        x.fillStyle=h;x.beginPath();x.arc(C56,C56,21,0,TAU);x.fill();x.strokeStyle='rgba(255,255,255,.25)';x.lineWidth=1;x.stroke();},
      gemini:function(x,t){var star=function(cx,cy,r,ra){x.save();x.translate(cx,cy);x.rotate(ra);x.beginPath();
          for(var i=0;i<4;i++){var a=i/4*TAU,b=(i+1)/4*TAU;if(!i)x.moveTo(Math.cos(a)*r,Math.sin(a)*r);x.quadraticCurveTo(0,0,Math.cos(b)*r,Math.sin(b)*r);}x.restore();};
        var sc=1+.12*Math.sin(t*2.4),ang=Math.sin(t*.9)*.8;
        var g=x.createLinearGradient(C56+Math.cos(t)*20,C56+Math.sin(t)*20,C56-Math.cos(t)*20,C56-Math.sin(t)*20);
        g.addColorStop(0,'#4f8bff');g.addColorStop(.5,'#a855f7');g.addColorStop(1,'#f472b6');
        x.shadowColor='#a855f7';x.shadowBlur=14;x.fillStyle=g;star(C56,C56,19*sc,ang);x.fill();
        for(var i=0;i<2;i++){var a=t*1.8+i*Math.PI,k=.5+.5*Math.sin(t*4+i*2);x.fillStyle=i?'#f9a8d4':'#93c5fd';star(C56+Math.cos(a)*22,C56+Math.sin(a)*22,3.5*k+1,a);x.fill();}},
      cloud:function(x,t){x.shadowColor='#3b82f6';x.shadowBlur=16;x.beginPath();x.arc(C56,C56,20+Math.sin(t*2)*.8,0,TAU);
        var base=x.createLinearGradient(0,C56-20,0,C56+20);base.addColorStop(0,'#bfe3ff');base.addColorStop(1,'#2563eb');x.fillStyle=base;x.fill();x.shadowBlur=0;
        x.save();x.clip();for(var i=0;i<5;i++){var cx=C56+((t*(6+i*2)+i*17)%60)-30,cy=C56+Math.sin(t*.8+i*1.7)*10,g=x.createRadialGradient(cx,cy,0,cx,cy,11+i);
          g.addColorStop(0,'rgba(255,255,255,.85)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,S56,S56);}x.restore();},
      aurora:function(x,t){x.save();x.beginPath();x.arc(C56,C56,22,0,TAU);x.clip();x.globalCompositeOperation='lighter';x.lineCap='round';
        ['#34d399','#22d3ee','#a78bfa','#f472b6'].forEach(function(c,i){x.strokeStyle=c;x.lineWidth=3;x.shadowColor=c;x.shadowBlur=8;x.beginPath();
          for(var px=4;px<=52;px+=1.5){var env=Math.sin((px-4)/48*Math.PI),py=C56+env*12*Math.sin(px*.16+t*(2+i*.5)+i*1.4)*Math.sin(t*1.1+i);px===4?x.moveTo(px,py):x.lineTo(px,py);}
          x.stroke();});x.restore();},
      plasma:function(x,t){x.shadowColor='#f43f5e';x.shadowBlur=18;wobbly(x,t*1.4,17+Math.sin(t*2)*1.2,2.2);
        if(x.createConicGradient){var g=x.createConicGradient(t*1.5,C56,C56);['#fb923c','#f43f5e','#c026d3','#6366f1','#fb923c'].forEach(function(c,i){g.addColorStop(i/4,c);});x.fillStyle=g;}
        else x.fillStyle='#f43f5e';x.fill();x.shadowBlur=0;
        var h=x.createRadialGradient(C56-6,C56-7,0,C56-6,C56-7,12);h.addColorStop(0,'rgba(255,255,255,.55)');h.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=h;x.fill();}
    };
  }
  function isLightTheme(){
    var th=document.documentElement.getAttribute('data-theme');
    if(th==='light'||th==='messenger')return true;
    if(th==='dark')return false;
    try{return !matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){return false;}
  }
  /* Холст рядом с подписью. Возвращает {el, frame(t), dispose()}. */
  function buildCanvas(kind){
    var wrap=el('span','hts-cv hts-cv-'+kind);wrap.setAttribute('aria-hidden','true');
    var cv=document.createElement('canvas');wrap.appendChild(cv);
    var off=document.createElement('canvas');off.width=off.height=S56*2;
    var octx=off.getContext('2d'),ctx=cv.getContext('2d'),light=null,draw=null,sized=0;
    function paint(t){
      var lt=isLightTheme();
      if(lt!==light){light=lt;draw=painters(lt?'38,36,48':'255,255,255',lt?'255,255,255':'18,18,24')[kind];}
      var px=Math.round((wrap.getBoundingClientRect().height||13)*Math.min(3,window.devicePixelRatio||1));
      if(px!==sized&&px>0){sized=px;cv.width=cv.height=px;}
      octx.setTransform(1,0,0,1,0,0);octx.clearRect(0,0,off.width,off.height);
      octx.setTransform(2,0,0,2,0,0);octx.save();try{draw(octx,t);}catch(e){}octx.restore();
      ctx.clearRect(0,0,cv.width,cv.height);ctx.imageSmoothingQuality='high';ctx.drawImage(off,0,0,cv.width,cv.height);
    }
    return {el:wrap,frame:paint};
  }

  /* ---------- индикатор «Думаю» ---------- */
  function create(question,opts){
    opts=opts||{};
    var root=el('span','hts');root.setAttribute('data-state','thinking');
    var st=buildStaffSvg();
    var anim=opts.anim&&ANIMS.indexOf(opts.anim)>=0?opts.anim
      :isMusicQuestion(question)?'staff':CANVAS_ANIMS[Math.floor(Math.random()*CANVAS_ANIMS.length)];
    var isStaff=anim==='staff';
    var cvAnim=isStaff?null:buildCanvas(anim);
    root.setAttribute('data-anim',anim);
    if(COLOR_LABEL[anim]){var lc=(anim==='cloud'&&isLightTheme())?['#3b82f6','#1d4ed8','#60a5fa']:COLOR_LABEL[anim];root.classList.add('hts-color');
      root.style.setProperty('--lc-a',lc[0]);root.style.setProperty('--lc-b',lc[1]);root.style.setProperty('--lc-c',lc[2]);}
    var verb=opts.label||pickVerb();
    var label=el('span','hts-label',verb);
    var head=el('span','hts-head','');head.hidden=true;
    var chip=el('span','hts-key');chip.hidden=true;
    var time=el('span','hts-time','');
    root.appendChild(isStaff?st.svg:cvAnim.el);root.appendChild(label);root.appendChild(head);root.appendChild(chip);root.appendChild(time);
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
      if(cvAnim)cvAnim.frame(reduced?0.6:e/1000);
      var s=Math.floor(e/1000);
      if(s!==lastSec){lastSec=s;time.textContent=s>0?fmtSecs(s*1000):'';}
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

  window.HmThinkStaff={create:create,detectKey:detectKey,fmtSecs:fmtSecs,verbs:VERBS,anims:ANIMS,isMusicQuestion:isMusicQuestion};
  window.HmGenAnim={image:image,file:file};
})();
