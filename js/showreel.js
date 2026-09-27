/* ===== HarmonyAI — видео-презентация на главной (v2) =====
   Трек «New Melody XLII» (Tomasz Szmajda) берётся из /media/new-melody-xlii.mp3.
   Без файла ролик идёт беззвучно, а под плеером появляется подсказка.

   Всё состояние кадра вычисляется из одного числа — текущего времени t
   (audio.currentTime). Поэтому пауза, перемотка и повтор всегда показывают
   ровно тот кадр, который соответствует музыке.

   Фон — пять линий нотного стана во всю ширину кадра. Они мягко «дышат»
   волной; амплитуда волны зависит от громкости музыки (Web Audio). */
(function(){
  'use strict';
  var root=document.getElementById('showreel');
  if(!root)return;
  var stage=root.querySelector('.sr-stage');
  var audio=root.querySelector('audio');
  var reduced=false;try{reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
  var TOTAL=43;

  /* ---------- сцены ---------- */
  var SCENES=[
    {id:'intro',t:0,d:5.2},
    {id:'title',t:5.2,d:4.8},
    {id:'chat',t:10,d:22},
    {id:'words',t:32,d:5},
    {id:'cta',t:37,d:6}
  ];
  var sceneEl={};
  SCENES.forEach(function(s){sceneEl[s.id]=stage.querySelector('[data-scene="'+s.id+'"]');});

  /* ---------- фон: нотный стан ---------- */
  var cv=stage.querySelector('.sr-bgcanvas'),ctx=cv.getContext('2d');
  var floaters=[];for(var f=0;f<14;f++)floaters.push({x:Math.random(),y:Math.random(),s:.6+Math.random()*.8,v:.006+Math.random()*.01,r:Math.random()*6});
  function sizeCanvas(){var r=stage.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);cv.width=r.width*d;cv.height=r.height*d;}
  sizeCanvas();try{new ResizeObserver(sizeCanvas).observe(stage);}catch(e){}
  function drawBg(t,lv){
    var w=cv.width,h=cv.height;ctx.clearRect(0,0,w,h);
    var gap=h*.075,cy=h*.5,amp=h*(.012+lv*.05);
    var intro=Math.min(1,t/2.2);          // линии «прочерчиваются» в начале
    ctx.lineWidth=Math.max(1,h*.0022);
    for(var i=0;i<5;i++){
      var y0=cy+(i-2)*gap;
      ctx.strokeStyle='rgba(160,180,255,'+(0.10+0.05*i/4+lv*.12)+')';
      ctx.beginPath();
      var end=w*intro;
      for(var x=0;x<=end;x+=w/90){
        var y=y0+Math.sin(x/w*6.2+t*.9+i*.35)*amp*(0.6+0.4*Math.sin(t*.3+i));
        x?ctx.lineTo(x,y):ctx.moveTo(x,y);
      }
      ctx.stroke();
    }
    // плывущие ноты
    for(var k=0;k<floaters.length;k++){
      var n=floaters[k];var x=((n.x+t*n.v)%1.1-.05)*w;var yy=cy+(n.y-.5)*gap*9+Math.sin(t+n.r)*gap*.3;
      ctx.save();ctx.translate(x,yy);ctx.rotate(-.35);
      ctx.fillStyle='rgba(190,205,255,'+(0.07+lv*.15)+')';
      ctx.beginPath();ctx.ellipse(0,0,gap*.42*n.s,gap*.3*n.s,0,0,Math.PI*2);ctx.fill();ctx.restore();
      ctx.fillRect(x+gap*.36*n.s,yy-gap*2.4*n.s,Math.max(1,h*.002),gap*2.3*n.s);
    }
    // световая «головка воспроизведения» — мягкое пятно, идущее по стану
    var px=((t*.11)%1)*w;
    var g=ctx.createRadialGradient(px,cy,0,px,cy,gap*4);
    g.addColorStop(0,'rgba(130,155,255,'+(0.16+lv*.25)+')');g.addColorStop(1,'rgba(130,155,255,0)');
    ctx.fillStyle=g;ctx.fillRect(px-gap*4,cy-gap*4,gap*8,gap*8);
  }

  /* ---------- сцена чата: всё считается из t ---------- */
  var C=stage.querySelector('.sr-app');
  var q=C.querySelectorAll('[data-q]');
  var composer=C.querySelector('.sr-comp-text');
  var msgs=C.querySelector('.sr-msgs');
  var Q=[
    {ask:'Что такое септаккорд?',at:1.0,type:1.4,think:1.6,ans:'Аккорд из четырёх звуков, сложенных по терциям. Между крайними — септима, отсюда и название.',ansDur:3.2,kind:'text'},
    {ask:'Покажи его от ноты до',at:8.2,type:1.2,think:1.2,ans:'До — ми — соль — си-бемоль. Это доминантсептаккорд:',ansDur:2.0,kind:'staff'},
    {ask:'Нарисуй обложку для моего этюда',at:14.6,type:1.5,think:.4,ans:'',ansDur:4.4,kind:'image'}
  ];
  var built=Q.map(function(item,i){
    var u=document.createElement('div');u.className='sr-u';u.textContent=item.ask;
    var a=document.createElement('div');a.className='sr-a';
    a.innerHTML='<b>H</b><div class="sr-a-body"><div class="sr-thinking"><svg viewBox="0 0 36 22"><g class="l"><line x1="0" x2="36" y1="3" y2="3"/><line x1="0" x2="36" y1="7" y2="7"/><line x1="0" x2="36" y1="11" y2="11"/><line x1="0" x2="36" y1="15" y2="15"/><line x1="0" x2="36" y1="19" y2="19"/></g><ellipse class="n n1" cx="7" cy="15" rx="2.3" ry="1.6"/><ellipse class="n n2" cx="15" cy="11" rx="2.3" ry="1.6"/><ellipse class="n n3" cx="23" cy="7" rx="2.3" ry="1.6"/><ellipse class="n n4" cx="31" cy="11" rx="2.3" ry="1.6"/></svg><span>'+(item.kind==='image'?'Рисую…':'Думаю')+'</span></div><div class="sr-a-text"></div>'+
      (item.kind==='staff'?'<svg class="sr-mini-staff" viewBox="0 0 200 70"><g stroke="currentColor" stroke-width="1" opacity=".45"><line x1="0" x2="200" y1="14" y2="14"/><line x1="0" x2="200" y1="24" y2="24"/><line x1="0" x2="200" y1="34" y2="34"/><line x1="0" x2="200" y1="44" y2="44"/><line x1="0" x2="200" y1="54" y2="54"/></g><g class="ch"><line x1="84" x2="116" y1="64" y2="64" stroke="currentColor" stroke-width="1"/><ellipse cx="100" cy="64" rx="7" ry="5" transform="rotate(-20 100 64)"/><ellipse cx="100" cy="54" rx="7" ry="5" transform="rotate(-20 100 54)"/><ellipse cx="100" cy="44" rx="7" ry="5" transform="rotate(-20 100 44)"/><ellipse cx="100" cy="34" rx="7" ry="5" transform="rotate(-20 100 34)"/><text x="80" y="38" font-size="14" fill="currentColor">♭</text></g></svg>':'')+
      (item.kind==='image'?'<div class="sr-img"><i></i></div>':'')+'</div>';
    msgs.appendChild(u);msgs.appendChild(a);
    return {u:u,a:a,text:a.querySelector('.sr-a-text'),item:item};
  });
  function chat(t){
    var tc=t-SCENES[2].t;var typing='';
    for(var i=0;i<built.length;i++){
      var b=built[i],it=b.item;
      var tSend=it.at+it.type,tAns=tSend+it.think;
      if(tc>=it.at&&tc<tSend)typing=it.ask.slice(0,Math.ceil((tc-it.at)/it.type*it.ask.length));
      b.u.classList.toggle('show',tc>=tSend);
      b.a.classList.toggle('show',tc>=tSend+.25);
      b.a.classList.toggle('thinking',tc>=tSend+.25&&tc<tAns+(it.kind==='image'?it.ansDur:0));
      var p=Math.max(0,Math.min(1,(tc-tAns)/it.ansDur));
      if(it.kind!=='image'){var n=Math.round(p*it.ans.length);if(b.text._n!==n){b.text._n=n;b.text.textContent=it.ans.slice(0,n);}}
      b.a.classList.toggle('done',p>=1);
      b.a.style.setProperty('--p',p.toFixed(3));
    }
    composer.textContent=typing;
    C.classList.toggle('has-text',!!typing);
    // прокрутка ленты: держим последние сообщения в кадре
    var last=null;for(var j=built.length-1;j>=0;j--){if(built[j].u.classList.contains('show')){last=built[j];break;}}
    var off=0;if(last){var box=msgs.parentElement.clientHeight;var bottom=last.a.offsetTop+last.a.offsetHeight+16;off=Math.max(0,bottom-box);}
    msgs.style.transform='translateY('+(-off)+'px)';
  }

  /* ---------- слова ---------- */
  var words=stage.querySelectorAll('.sr-word-flip span');
  function wordsStep(t){var tc=t-SCENES[3].t;var k=Math.min(words.length-1,Math.floor(tc/1.4));
    for(var i=0;i<words.length;i++)words[i].classList.toggle('on',i===k);}

  function setScenes(t){
    SCENES.forEach(function(s){var el=sceneEl[s.id];var on=t>=s.t&&t<s.t+s.d;
      if(on!==el.classList.contains('on'))el.classList.toggle('on',on);});
  }

  /* ---------- звук ---------- */
  var actx=null,analyser=null,freq=null,hasAudio=true;
  function markNoAudio(){hasAudio=false;root.classList.add('sr-noaudio');}
  audio.addEventListener('error',markNoAudio);
  // Проверяем, лежит ли файл на сайте, до нажатия «Смотреть».
  try{fetch(audio.getAttribute('src'),{method:'HEAD'}).then(function(r){if(!r.ok)markNoAudio();}).catch(function(){});}catch(e){}
  function ensureAnalyser(){
    if(actx||!hasAudio)return;
    try{var AC=window.AudioContext||window.webkitAudioContext;actx=new AC();
      var src=actx.createMediaElementSource(audio);analyser=actx.createAnalyser();analyser.fftSize=256;
      freq=new Uint8Array(analyser.frequencyBinCount);src.connect(analyser);analyser.connect(actx.destination);}catch(e){analyser=null;}
  }
  function level(t){
    if(analyser&&!audio.paused){analyser.getByteFrequencyData(freq);var s=0;for(var i=2;i<24;i++)s+=freq[i];return Math.min(1,s/(22*200));}
    return .18+.12*Math.pow(Math.max(0,Math.sin(t*3.2)),6);
  }

  /* ---------- плеер ---------- */
  var mode='preview',clockT0=performance.now(),pausedAt=0,raf=0;
  var bar=root.querySelector('.sr-progress i'),timeEl=root.querySelector('.sr-time');
  function fmt(t){t=Math.max(0,Math.floor(t));return Math.floor(t/60)+':'+(t%60<10?'0':'')+t%60;}
  function curT(){
    if(mode==='preview')return 10+((performance.now()-clockT0)/1000)%22; // превью — сцена чата по кругу
    if(hasAudio)return audio.currentTime;
    return mode==='paused'?pausedAt:(performance.now()-clockT0)/1000;
  }
  function frame(){
    var t=curT(),lv=level(t);
    root.style.setProperty('--lv',lv.toFixed(3));
    drawBg(t,lv);setScenes(t);chat(t);wordsStep(t);
    if(mode!=='preview'){
      bar.style.transform='scaleX('+Math.min(1,t/TOTAL).toFixed(4)+')';
      timeEl.textContent=fmt(t)+' / '+fmt(TOTAL);
      if(t>=TOTAL||(hasAudio&&audio.ended)){end();return;}
    }
    raf=requestAnimationFrame(frame);
  }
  function loop(){if(!raf)raf=requestAnimationFrame(frame);}
  function play(){
    root.classList.add('sr-live');root.classList.remove('sr-ended','sr-paused');
    if(hasAudio){
      ensureAnalyser();try{actx&&actx.resume();}catch(e){}
      if(mode==='preview'||mode==='ended')audio.currentTime=0;
      var pr=audio.play();if(pr&&pr.catch)pr.catch(function(){markNoAudio();clockT0=performance.now();});
    }else{
      clockT0=performance.now()-((mode==='paused')?pausedAt*1000:0);
    }
    mode='playing';loop();
  }
  function pause(){
    mode='paused';root.classList.add('sr-paused');
    if(hasAudio)audio.pause();else pausedAt=(performance.now()-clockT0)/1000;
  }
  function end(){mode='ended';root.classList.add('sr-ended');try{audio.pause();}catch(e){}cancelAnimationFrame(raf);raf=0;}
  root.querySelector('.sr-play').addEventListener('click',function(e){e.stopPropagation();play();});
  root.querySelector('.sr-toggle').addEventListener('click',function(e){e.stopPropagation();mode==='playing'?pause():play();});
  stage.addEventListener('click',function(e){if(e.target.closest('a,button,.sr-ctrl'))return;if(mode==='preview')return play();mode==='playing'?pause():play();});
  var mute=root.querySelector('.sr-mute');
  mute.addEventListener('click',function(e){e.stopPropagation();audio.muted=!audio.muted;mute.classList.toggle('is-muted',audio.muted);});
  root.querySelector('.sr-progress').addEventListener('click',function(e){
    e.stopPropagation();if(mode==='preview')return;
    var r=this.getBoundingClientRect(),t=Math.max(0,Math.min(TOTAL-.1,(e.clientX-r.left)/r.width*TOTAL));
    if(hasAudio)audio.currentTime=t;else if(mode==='paused')pausedAt=t;else clockT0=performance.now()-t*1000;
    if(mode==='ended'){play();}
    loop();
  });

  if(reduced){root.classList.add('sr-reduced');drawBg(3,.2);setScenes(12);chat(30);return;}
  var io=new IntersectionObserver(function(es){es.forEach(function(e){
    if(e.isIntersecting)loop();
    else if(mode==='preview'){cancelAnimationFrame(raf);raf=0;}
    else if(mode==='playing')pause();
  });},{threshold:.2});
  io.observe(root);
})();
