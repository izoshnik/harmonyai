/* ===== HarmonyAI — анимация-«видео» на главной =====
   Мини-презентация из 7 сцен (~42 с), синхронизированная с треком
   «New Melody XLII» (Tomasz Szmajda). Трек не хранится в коде: положите
   файл в /media/new-melody-xlii.mp3 (нужна лицензия на использование).

   Как работает:
   • Время сцен берётся из audio.currentTime — картинка идёт ровно по музыке,
     пауза/перемотка музыки двигают и анимацию.
   • Web Audio анализатор даёт «пульс» (громкость низких частот) — от него
     дышат фон, эквалайзер и логотип. Без звука пульс идёт от таймера.
   • Пока пользователь не нажал «Смотреть», в кадре крутится беззвучное превью.
   • prefers-reduced-motion: только статичный кадр и кнопка.  */
(function(){
  'use strict';
  var root=document.getElementById('showreel');
  if(!root)return;
  var stage=root.querySelector('.sr-stage');
  var audio=root.querySelector('audio');
  var btnPlay=root.querySelector('.sr-play');
  var btnToggle=root.querySelector('.sr-toggle');
  var btnMute=root.querySelector('.sr-mute');
  var bar=root.querySelector('.sr-progress i');
  var timeEl=root.querySelector('.sr-time');
  var eq=root.querySelector('.sr-eq');
  var reduced=false;try{reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}

  /* Сцены: [начало, конец] в секундах */
  var SCENES=[
    {id:'intro',t:0,d:6},
    {id:'tag',t:6,d:6},
    {id:'chat',t:12,d:8},
    {id:'staff',t:20,d:6},
    {id:'image',t:26,d:6},
    {id:'topics',t:32,d:5},
    {id:'cta',t:37,d:6}
  ];
  var TOTAL=43;
  var scenes={};
  SCENES.forEach(function(s){scenes[s.id]=stage.querySelector('[data-scene="'+s.id+'"]');});

  /* EQ-полоски */
  var bars=[];
  for(var i=0;i<28;i++){var b=document.createElement('i');eq.appendChild(b);bars.push(b);}

  var playing=false,preview=true,clock0=performance.now(),raf=0,actx=null,analyser=null,freq=null,hasAudio=true;
  audio.addEventListener('error',function(){hasAudio=false;root.classList.add('sr-noaudio');});

  function fmt(t){t=Math.max(0,Math.floor(t));return Math.floor(t/60)+':'+(t%60<10?'0':'')+t%60;}

  function now(){
    if(!preview&&hasAudio&&!audio.paused)return audio.currentTime;
    if(!preview&&hasAudio&&audio.paused)return audio.currentTime;
    return ((performance.now()-clock0)/1000)%(preview?TOTAL:1e9);
  }

  function level(t){
    if(analyser&&!audio.paused){
      analyser.getByteFrequencyData(freq);
      var s=0;for(var i=1;i<10;i++)s+=freq[i];
      return Math.min(1,s/(9*210));
    }
    // Без звука — мягкий «метроном» ~ 96 BPM
    var ph=(t*1.6)%1;return Math.pow(1-ph,3)*.7+.15;
  }

  function setScene(t){
    for(var i=0;i<SCENES.length;i++){
      var s=SCENES[i],el=scenes[s.id];if(!el)continue;
      var on=t>=s.t&&t<s.t+s.d;
      if(on!==el.classList.contains('on'))el.classList.toggle('on',on);
      if(on)el.style.setProperty('--p',((t-s.t)/s.d).toFixed(3));
    }
  }

  /* Сцена чата: печать ответа по времени (детерминированно — перемотка работает) */
  var chatAns=stage.querySelector('.sr-chat-ans');
  var ANS=chatAns?chatAns.getAttribute('data-text'):'';
  function chatText(t){
    if(!chatAns)return;
    var p=(t-SCENES[2].t-2.6)/4.2;
    var n=Math.max(0,Math.min(ANS.length,Math.round(p*ANS.length)));
    if(chatAns._n!==n){chatAns._n=n;chatAns.textContent=ANS.slice(0,n);}
    stage.querySelector('.sr-chat').classList.toggle('typing',p<0);
  }

  /* Сцена картинки: мозаика «проявляется» */
  var mos=stage.querySelector('.sr-mosaic');var cells=[];
  if(mos){for(var k=0;k<64;k++){var c=document.createElement('i');var x=k%8,y=(k/8)|0;
    var d=Math.hypot(x-3.5,y-3.5)/5;c.style.setProperty('--d',d.toFixed(2));
    c.style.setProperty('--h',(250+x*9+y*12)%360);mos.appendChild(c);cells.push(c);}}

  function frame(){
    var t=now();
    var lv=level(t);
    root.style.setProperty('--lv',lv.toFixed(3));
    for(var i=0;i<bars.length;i++){
      var v=analyser&&!audio.paused?freq[2+i*2]/255:(.25+.6*Math.abs(Math.sin(t*2.1+i*.55))*lv);
      bars[i].style.transform='scaleY('+Math.max(.06,v).toFixed(3)+')';
    }
    setScene(t);chatText(t);
    if(!preview){
      var dur=(hasAudio&&isFinite(audio.duration)&&audio.duration)||TOTAL;
      bar.style.transform='scaleX('+Math.min(1,t/Math.min(dur,TOTAL)).toFixed(4)+')';
      timeEl.textContent=fmt(t)+' / '+fmt(Math.min(dur,TOTAL));
      if(t>=TOTAL-.05||(hasAudio&&audio.ended)){finish();return;}
      if(!hasAudio&&playing===false){raf=0;return;}
    }
    raf=requestAnimationFrame(frame);
  }

  function ensureAnalyser(){
    if(actx||!hasAudio)return;
    try{
      var AC=window.AudioContext||window.webkitAudioContext;actx=new AC();
      var src=actx.createMediaElementSource(audio);analyser=actx.createAnalyser();
      analyser.fftSize=128;freq=new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);analyser.connect(actx.destination);
    }catch(e){analyser=null;}
  }

  function start(){
    preview=false;root.classList.add('sr-live');root.classList.remove('sr-ended');
    playing=true;btnToggle.setAttribute('aria-label','Пауза');root.classList.remove('sr-paused');
    if(hasAudio){
      ensureAnalyser();
      try{actx&&actx.resume();}catch(e){}
      audio.currentTime=0;
      var pr=audio.play();
      if(pr&&pr.catch)pr.catch(function(){hasAudio=false;root.classList.add('sr-noaudio');clock0=performance.now();});
    }else clock0=performance.now();
    if(!raf)raf=requestAnimationFrame(frame);
  }
  function toggle(){
    if(preview)return start();
    if(root.classList.contains('sr-ended'))return start();
    if(hasAudio){if(audio.paused){audio.play();root.classList.remove('sr-paused');}else{audio.pause();root.classList.add('sr-paused');}}
    else{playing=!playing;root.classList.toggle('sr-paused',!playing);if(playing){clock0=performance.now()-(parseFloat(root.dataset.pt)||0)*1000;raf=requestAnimationFrame(frame);}else root.dataset.pt=now();}
  }
  function finish(){
    playing=false;root.classList.add('sr-ended');setScene(TOTAL-.5);
    try{audio.pause();}catch(e){}
    cancelAnimationFrame(raf);raf=0;
  }
  btnPlay.addEventListener('click',start);
  btnToggle.addEventListener('click',toggle);
  stage.addEventListener('click',function(e){if(e.target.closest('a,button'))return;if(!preview)toggle();});
  btnMute.addEventListener('click',function(){audio.muted=!audio.muted;btnMute.classList.toggle('is-muted',audio.muted);btnMute.setAttribute('aria-label',audio.muted?'Включить звук':'Выключить звук');});
  root.querySelector('.sr-progress').addEventListener('click',function(e){
    if(preview)return;var r=this.getBoundingClientRect();var t=(e.clientX-r.left)/r.width*TOTAL;
    if(hasAudio)audio.currentTime=t;else clock0=performance.now()-t*1000;
  });

  if(reduced){root.classList.add('sr-reduced');setScene(SCENES[1].t+1);return;}

  /* Превью крутится только когда блок на экране — не тратим батарею */
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting){if(!raf)raf=requestAnimationFrame(frame);}
      else if(preview){cancelAnimationFrame(raf);raf=0;}
      else if(hasAudio&&!audio.paused){audio.pause();root.classList.add('sr-paused');}
    });
  },{threshold:.25});
  io.observe(root);
})();
