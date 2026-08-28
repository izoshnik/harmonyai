/* ============================================================================
   HarmonyAI — аудио-анализатор (клиентский, Web Audio API + Web Worker).

   Всё считается в браузере: Web Audio декодирует файл, тяжёлая математика
   (FFT-хромаграмма для тональности, onset-огибающая с автокорреляцией для
   BPM, частотный баланс, спектральная новизна для структуры) крутится в
   Web Worker, собранном из Blob — интерфейс не подвисает, и на сервер не
   уходит ни один байт звука.

   Кнопка «Анализировать с помощью ИИ» отправляет в чат компактный JSON
   результатов (1–2 КБ) через существующий /api/chat — никаких новых
   Vercel-функций и никакой загрузки аудио на сервер.
   ============================================================================ */
(function (global) {
  'use strict';

  var SR_TARGET = 22050;       // рабочая частота анализа
  var MAX_ANALYZE_SEC = 360;   // дольше 6 минут — анализируем начало и говорим об этом

  /* ==================== WORKER (String.raw — чтобы \b и \d в regex не съелись) ==================== */

  var WORKER_SRC = String.raw`
'use strict';
var NOTE_RU=['До','До#','Ре','Ре#','Ми','Фа','Фа#','Соль','Соль#','Ля','Ля#','Си'];
var KR_MAJ=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
var KR_MIN=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
var BAND_EDGES=[[20,60],[60,250],[250,500],[500,2000],[2000,6000],[6000,20000]];

function fft(re,im){
  var n=re.length;
  for(var i=1,j=0;i<n;i++){
    var bit=n>>1;
    for(;j&bit;bit>>=1)j^=bit;
    j^=bit;
    if(i<j){var t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
  }
  for(var len=2;len<=n;len<<=1){
    var ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang);
    for(var a=0;a<n;a+=len){
      var cr=1, ci=0;
      for(var k=0;k<len/2;k++){
        var ar=re[a+k], ai=im[a+k];
        var br=re[a+k+len/2], bi=im[a+k+len/2];
        var vr=br*cr-bi*ci, vi=br*ci+bi*cr;
        re[a+k]=ar+vr; im[a+k]=ai+vi;
        re[a+k+len/2]=ar-vr; im[a+k+len/2]=ai-vi;
        var nr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=nr;
      }
    }
  }
}
function hann(n){
  var w=new Float32Array(n);
  for(var i=0;i<n;i++)w[i]=0.5*(1-Math.cos(2*Math.PI*i/(n-1)));
  return w;
}
function pearson(a,b){
  var n=a.length,ma=0,mb=0,i;
  for(i=0;i<n;i++){ma+=a[i];mb+=b[i];}
  ma/=n;mb/=n;
  var num=0,da=0,db=0;
  for(i=0;i<n;i++){var x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}
  if(da<=0||db<=0)return 0;
  return num/Math.sqrt(da*db);
}
function clamp01(v){return v<0?0:(v>1?1:v);}

function analyze(samples,sr,report){
  var frame=2048, hop=512;
  var win=hann(frame);
  var bins=frame/2+1;
  var re=new Float32Array(frame), im=new Float32Array(frame);
  var prevMag=new Float32Array(bins);
  var chroma=new Float32Array(12);
  var specAvg=new Float32Array(bins);
  var flux=[];
  var bandVec=[];
  var total=Math.max(1,Math.floor((samples.length-frame)/hop));
  var i,b,k,f;
  for(f=0;f<total;f++){
    var off=f*hop;
    for(i=0;i<frame;i++){re[i]=samples[off+i]*win[i];im[i]=0;}
    fft(re,im);
    var fl=0;
    var bv=new Float32Array(6);
    for(b=1;b<bins;b++){
      var mg=Math.sqrt(re[b]*re[b]+im[b]*im[b]);
      specAvg[b]+=mg;
      var d=mg-prevMag[b]; if(d>0)fl+=d; prevMag[b]=mg;
      var freq=b*sr/frame;
      if(freq>=55&&freq<=5000){
        var midi=Math.round(12*Math.log2(freq/440))+69;
        var pc=midi%12; if(pc<0)pc+=12;
        chroma[pc]+=mg*mg;
      }
      for(k=0;k<6;k++){
        if(freq>=BAND_EDGES[k][0]&&freq<BAND_EDGES[k][1]){bv[k]+=mg;break;}
      }
    }
    flux.push(fl);
    bandVec.push([bv[0],bv[1],bv[2],bv[3],bv[4],bv[5]]);
    if((f&1023)===0)report('spectrum',f/total);
  }

  report('tempo',0);
  var mean=0,len=flux.length;
  for(f=0;f<len;f++)mean+=flux[f];
  mean/=Math.max(1,len);
  var env=new Float32Array(len);
  for(f=0;f<len;f++)env[f]=Math.max(0,flux[f]-mean);
  var sm=new Float32Array(len);
  for(f=1;f<len-1;f++)sm[f]=(env[f-1]+2*env[f]+env[f+1])/4;
  var envRms=0;
  for(f=0;f<len;f++)envRms+=sm[f]*sm[f];
  envRms=Math.sqrt(envRms/Math.max(1,len))||1;
  var ht=hop/sr;
  var minLag=Math.max(4,Math.round((60/200)/ht));
  var maxLag=Math.min(len-2,Math.round((60/50)/ht));
  var accMean=0,accN=0,bestScore=-1,bestLag=0;
  for(var lag=minLag;lag<=maxLag;lag++){
    var acc=0;
    for(f=0;f+lag<len;f++)acc+=sm[f]*sm[f+lag];
    acc/=(len-lag);
    if(acc>bestScore){bestScore=acc;bestLag=lag;}
    accMean+=acc;accN++;
  }
  accMean/=Math.max(1,accN);
  var bpm=0,bpmConf=0;
  if(bestLag>0&&bestScore>0){
    bpm=60/(bestLag*ht);
    while(bpm>=190)bpm/=2;
    while(bpm<60)bpm*=2;
    bpm=Math.round(bpm);
    bpmConf=clamp01(accMean>0?((bestScore/accMean)-1)/1.2:0);
  }

  report('key',0);
  var cands=[];
  for(var t=0;t<12;t++){
    var cm=new Float32Array(12), cn=new Float32Array(12);
    for(i=0;i<12;i++){cm[i]=chroma[(t+i)%12];cn[i]=chroma[(t+i)%12];}
    cands.push({name:NOTE_RU[t]+' мажор',score:pearson(cm,KR_MAJ)});
    cands.push({name:NOTE_RU[t]+' минор',score:pearson(cn,KR_MIN)});
  }
  cands.sort(function(a,b2){return b2.score-a.score;});
  var keyName=cands.length?cands[0].name:'';
  var keyConf=0;
  if(cands.length>1){
    var s1=cands[0].score,s2=cands[1].score;
    keyConf=clamp01(s1>0?(s1-s2)*2.6:0);
  }

  var bandEnergy=new Float32Array(6);
  var bsum=0;
  for(b=1;b<bins;b++){
    var fr=b*sr/frame, p=specAvg[b]*specAvg[b];
    for(k=0;k<6;k++){ if(fr>=BAND_EDGES[k][0]&&fr<BAND_EDGES[k][1]){bandEnergy[k]+=p;break;} }
  }
  for(k=0;k<6;k++)bsum+=bandEnergy[k];
  var bands=[];
  for(k=0;k<6;k++)bands.push(bsum>0?Math.round(bandEnergy[k]/bsum*1000)/10:0);

  report('structure',0);
  var nlen=bandVec.length;
  var nov=new Float32Array(nlen);
  for(f=1;f<nlen;f++){
    var dd=0;
    for(k=0;k<6;k++){var dv0=bandVec[f][k]-bandVec[f-1][k];dd+=dv0*dv0;}
    nov[f]=Math.sqrt(dd);
  }
  var sw=Math.max(1,Math.round(0.5/ht));
  var snov=new Float32Array(nlen);
  for(f=0;f<nlen;f++){
    var ss=0,nn=0;
    for(var q2=-sw;q2<=sw;q2++){
      var idx=f+q2;
      if(idx>=0&&idx<nlen){ss+=nov[idx];nn++;}
    }
    snov[f]=ss/Math.max(1,nn);
  }
  var nMean=0;
  for(f=0;f<nlen;f++)nMean+=snov[f];
  nMean/=Math.max(1,nlen);
  var nVar=0;
  for(f=0;f<nlen;f++){var dvx=snov[f]-nMean;nVar+=dvx*dvx;}
  var sig=Math.sqrt(nVar/Math.max(1,nlen))||1e-9;
  var boundaries=[];
  var minGap=Math.round(10/ht), last=-minGap;
  var thr=nMean+1.7*sig;
  for(f=2;f<nlen-2;f++){
    if(snov[f]>thr&&snov[f]>=snov[f-1]&&snov[f]>snov[f+1]){
      if(f-last>=minGap){
        boundaries.push({time:Math.round(f*ht*10)/10,strength:Math.round((snov[f]-nMean)/sig*10)/10});
        last=f;
      }
    }
  }

  report('done',1);
  return {
    bpm:{value:bpm,confidence:Math.round(bpmConf*100)/100},
    key:{name:keyName,confidence:Math.round(keyConf*100)/100},
    bands:bands,
    boundaries:boundaries
  };
}

self.onmessage=function(ev){
  var d=ev.data||{};
  if(d.type!=='analyze'||!d.samples)return;
  var report=function(phase,fraction){self.postMessage({type:'progress',phase:phase,fraction:fraction});};
  try{
    var r=analyze(d.samples,d.sampleRate||22050,report);
    self.postMessage({type:'result',result:r});
  }catch(e){
    self.postMessage({type:'error',message:String((e&&(e.message||e))||e)});
  }
};
`;

  var worker = null;
  function getWorker() {
    if (worker) return worker;
    var blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    return worker;
  }

  /* ==================== утилиты ==================== */

  var ICON_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="margin-left:2px"><path d="M8 5.5v13l11-6.5z"/></svg>';
  var ICON_PAUSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) { if (!isFinite(sec) || sec < 0) sec = 0; var m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function db(v) { return +(20 * Math.log10(Math.max(v, 1e-8))).toFixed(1); }
  function fmtBytes(b) {
    var v = Number(b) || 0;
    if (v < 1024) return v + ' Б';
    if (v < 1048576) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' КБ';
    return (v / 1048576).toFixed(v < 10485760 ? 1 : 0) + ' МБ';
  }

  /* ==================== состояние ==================== */

  var ui = {}, st = {
    file: null, url: null, buf: null, mono: null,
    sr: 0, aSr: 0, meta: {}, quick: null,
    energy: null, wave: null, result: null,
    analyzing: false, wToken: 0, token: 0, seeking: false, audio: null
  };

  /* ==================== CSS и разметка модалки ==================== */

  var CSS = ''
    + '.aa-ovl{position:fixed;inset:0;z-index:760;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}'
    + '.aa-ovl[hidden]{display:none;}'
    + '.aa-card{width:min(720px,100%);max-height:92dvh;overflow:auto;background:var(--bg2,#16161a);border:1px solid var(--border);border-radius:24px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 30px 80px rgba(0,0,0,.5);}'
    + '.aa-head{display:flex;align-items:center;gap:10px;}'
    + '.aa-title{font-size:18px;font-weight:800;color:var(--text);}'
    + '.aa-x{margin-left:auto;width:32px;height:32px;border-radius:50%;border:none;background:rgba(127,127,140,.14);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;}'
    + '.aa-drop{border:1.5px dashed var(--border);border-radius:18px;padding:26px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;color:var(--text2);transition:border-color .15s,background .15s;}'
    + '.aa-drop--mini{padding:12px;flex-direction:row;justify-content:center;}'
    + '.aa-drop.aa-over{border-color:var(--accent);background:rgba(47,143,255,.06);}'
    + '.aa-drop-t{font-size:14px;color:var(--text2);}'
    + '.aa-btn{border:none;border-radius:12px;padding:11px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:filter .15s,transform .1s;}'
    + '.aa-btn:active{transform:scale(.97);}'
    + '.aa-btn-primary{background:var(--send-bg,#2f8fff);color:var(--send-txt,#fff);}'
    + '.aa-btn-primary:disabled{opacity:.45;cursor:default;}'
    + '.aa-btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text);}'
    + '.aa-fileline{display:flex;gap:8px;align-items:baseline;min-width:0;}'
    + '.aa-name{font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '.aa-size{color:var(--text2);font-size:12px;flex-shrink:0;}'
    + '.aa-player{display:flex;align-items:center;gap:12px;}'
    + '.aa-play{width:44px;height:44px;border-radius:50%;border:none;background:var(--send-bg,#fff);color:var(--send-txt,#111);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}'
    + '.aa-seek{flex:1;height:6px;border-radius:3px;background:rgba(127,127,140,.28);position:relative;cursor:pointer;touch-action:none;min-width:60px;}'
    + '.aa-seek-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--accent,#2f8fff);border-radius:3px;}'
    + '.aa-seek-thumb{position:absolute;top:50%;left:0;width:13px;height:13px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.4);}'
    + '.aa-time{font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;flex-shrink:0;}'
    + '.aa-dl{color:var(--text2);text-decoration:none;font-size:16px;flex-shrink:0;}'
    + '.aa-wave{width:100%;border-radius:12px;background:rgba(127,127,140,.10);cursor:pointer;display:block;}'
    + '.aa-chips{display:flex;flex-wrap:wrap;gap:8px;}'
    + '.aa-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:12px;background:var(--bg3,rgba(255,255,255,.06));border:1px solid var(--border2,rgba(255,255,255,.08));font-size:12.5px;color:var(--text2);}'
    + '.aa-chip-v{color:var(--text);font-weight:700;}'
    + '.aa-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}'
    + '@media(max-width:600px){.aa-grid{grid-template-columns:1fr;}}'
    + '.aa-panel{border:1px solid var(--border);border-radius:16px;padding:12px;background:var(--bg3,rgba(255,255,255,.03));min-width:0;}'
    + '.aa-ptitle{font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--text2);margin-bottom:8px;}'
    + '.aa-panel canvas{width:100%;display:block;}'
    + '.aa-struct{display:flex;flex-wrap:wrap;gap:6px;font-size:12.5px;color:var(--text);}'
    + '.aa-struct span{padding:5px 10px;border-radius:999px;background:var(--bg3,rgba(255,255,255,.06));border:1px solid var(--border);}'
    + '.aa-status{font-size:13px;color:var(--text2);min-height:16px;}'
    + '.aa-acts{display:flex;gap:10px;flex-wrap:wrap;}'
    + '.aa-acts .aa-btn-primary{flex:1 1 auto;}'
    + '.aa-note{font-size:11.5px;color:var(--text2);opacity:.75;}'
    + '@media(prefers-reduced-motion:reduce){.aa-card,.aa-btn{transition:none;animation:none;}}';

  var TPL =
    '<div class="aa-card" role="dialog" aria-modal="true" aria-label="Анализ аудио">'
    + '<div class="aa-head"><div class="aa-title">🎧 Анализ аудио</div><button type="button" class="aa-x" id="aaClose" aria-label="Закрыть">×</button></div>'
    + '<div class="aa-drop" id="aaDrop"><p class="aa-drop-t" id="aaDropT">Перетащите файл или нажмите «Выбрать файл»</p><button type="button" class="aa-btn aa-btn-ghost" id="aaPickBtn">Выбрать файл</button></div>'
    + '<input type="file" id="aaFileInp" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.webm" hidden>'
    + '<div id="aaBody" hidden>'
    + '<div class="aa-fileline"><span class="aa-name" id="aaName"></span><span class="aa-size" id="aaSize"></span></div>'
    + '<div class="aa-player"><button type="button" class="aa-play" id="aaPlay" aria-label="Воспроизвести">' + ICON_PLAY + '</button>'
    + '<div class="aa-seek" id="aaSeek"><i class="aa-seek-fill" id="aaSeekFill"></i><i class="aa-seek-thumb" id="aaThumb"></i></div>'
    + '<span class="aa-time" id="aaTime">0:00 / 0:00</span>'
    + '<a class="aa-dl" id="aaDl" download title="Скачать файл">↓</a></div>'
    + '<canvas class="aa-wave" id="aaWave" height="72"></canvas>'
    + '<div class="aa-chips" id="aaChips"></div>'
    + '<div class="aa-grid">'
    + '<div class="aa-panel"><div class="aa-ptitle">Частотный баланс</div><canvas id="aaSpec" height="150"></canvas></div>'
    + '<div class="aa-panel"><div class="aa-ptitle">Энергия по времени</div><canvas id="aaEnergy" height="150"></canvas></div>'
    + '</div>'
    + '<div class="aa-panel" id="aaStructWrap" hidden><div class="aa-ptitle">Структура (приблизительно)</div><div class="aa-struct" id="aaStruct"></div></div>'
    + '<div class="aa-status" id="aaStatus"></div>'
    + '<div class="aa-acts">'
    + '<button type="button" class="aa-btn aa-btn-primary" id="aaAIBtn" disabled>Анализировать с помощью ИИ</button>'
    + '<button type="button" class="aa-btn aa-btn-ghost" id="aaOtherBtn">Другой файл</button>'
    + '</div>'
    + '<div class="aa-note">Весь анализ идёт в вашем браузере. В чат уходят только метрики — не аудиофайл.</div>'
    + '</div>'
    + '</div>';

  function ensureDom() {
    if ($('aaOverlay')) return;
    if (!document.getElementById('aaCSS')) {
      var s = document.createElement('style');
      s.id = 'aaCSS';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    var ovl = document.createElement('div');
    ovl.className = 'aa-ovl';
    ovl.id = 'aaOverlay';
    ovl.hidden = true;
    ovl.innerHTML = TPL;
    document.body.appendChild(ovl);

    var audio = document.createElement('audio');
    audio.id = 'aaAudio';
    audio.preload = 'metadata';
    audio.setAttribute('playsinline', '');
    document.body.appendChild(audio);

    ui.overlay = ovl; ui.audio = audio;
    ui.body = $('aaBody'); ui.drop = $('aaDrop');
    ui.name = $('aaName'); ui.size = $('aaSize');
    ui.play = $('aaPlay'); ui.seek = $('aaSeek');
    ui.seekFill = $('aaSeekFill'); ui.thumb = $('aaThumb');
    ui.time = $('aaTime'); ui.dl = $('aaDl');
    ui.wave = $('aaWave'); ui.chips = $('aaChips');
    ui.spec = $('aaSpec'); ui.energyCv = $('aaEnergy');
    ui.structWrap = $('aaStructWrap'); ui.struct = $('aaStruct');
    ui.status = $('aaStatus'); ui.aiBtn = $('aaAIBtn');

    $('aaClose').addEventListener('click', function () { close(); });
    $('aaPickBtn').addEventListener('click', function () { $('aaFileInp').click(); });
    $('aaOtherBtn').addEventListener('click', function () { $('aaFileInp').click(); });
    $('aaFileInp').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) openWithFile(f);
    });
    $('aaAIBtn').addEventListener('click', analyzeWithAI);

    ovl.addEventListener('click', function (ev) { if (ev.target === ovl) close(); });

    var drop = ui.drop;
    ['dragover', 'dragenter'].forEach(function (t) {
      drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add('aa-over'); });
    });
    drop.addEventListener('dragleave', function () { drop.classList.remove('aa-over'); });
    drop.addEventListener('drop', function (ev) {
      ev.preventDefault();
      drop.classList.remove('aa-over');
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) openWithFile(f);
    });

    document.addEventListener('keydown', onEsc);
    bindPlayer();
  }
  function onEsc(ev) {
    if (ev.key === 'Escape' && ui.overlay && !ui.overlay.hidden) close();
  }

  /* ==================== открытие / закрытие ==================== */

  function show(on) { if (ui.overlay) ui.overlay.hidden = !on; }
  function openPicker() { ensureDom(); show(true); $('aaFileInp').click(); }
  function close() {
    if (!ui.overlay || ui.overlay.hidden) return;
    if (ui.audio) { ui.audio.pause(); ui.audio.removeAttribute('src'); try { ui.audio.load(); } catch (e) {} }
    if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) {} st.url = null; }
    st.token++;
    ui.overlay.hidden = true;
  }

  /* ==================== загрузка и декодирование файла ==================== */

  var audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      audioCtx = AC ? new AC() : null;
    }
    return audioCtx;
  }

  async function openWithFile(file) {
    ensureDom();
    show(true);
    if (!file) return;
    var okType = /^audio\//.test(file.type || '') ||
      /\.(mp3|wav|m4a|mp4|ogg|oga|flac|aac|opus|webm|aiff?|wma)$/i.test(file.name || '');
    if (!okType) {
      ui.body.hidden = false;
      setStatus('Это не похоже на аудиофайл. Поддерживаются MP3, WAV, M4A, OGG, FLAC и другие форматы, которые умеет браузер.');
      return;
    }
    getCtx(); // создаём AudioContext в жесте пользователя (важно для iOS)
    st.token++;
    var myToken = st.token;

    st.file = file;
    if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) {} st.url = null; }
    st.url = URL.createObjectURL(file);
    ui.audio.src = st.url;
    ui.dl.href = st.url;
    ui.dl.download = file.name || 'audio';

    ui.body.hidden = false;
    ui.drop.classList.add('aa-drop--mini');
    $('aaDropT').textContent = 'Заменить файл:';
    ui.name.textContent = file.name || 'audio';
    ui.size.textContent = fmtBytes(file.size);

    ui.chips.innerHTML = '';
    ui.structWrap.hidden = true;
    clearCanvases();
    disableAI(true);
    setStatus('Декодирую…');

    st.buf = null; st.mono = null; st.result = null; st.energy = null; st.wave = null; st.quick = null;

    try {
      var ab = await file.arrayBuffer();
      var c = getCtx();
      if (!c) throw new Error('Web Audio API недоступен');
      var buf = await new Promise(function (resolve, reject) {
        var p = c.decodeAudioData(ab.slice(0), resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      if (myToken !== st.token) return;
      st.buf = buf;
      st.sr = buf.sampleRate;
      st.meta = { channels: buf.numberOfChannels, duration: buf.duration };
      st.mono = mixToMono(buf);
    } catch (e) {
      if (myToken !== st.token) return;
      setStatus('Браузер не смог декодировать этот файл. Попробуйте MP3 или WAV.');
      return;
    }

    computeQuick();
    drawWave();
    renderChips();
    startWorkerAnalysis(myToken);
  }

  function mixToMono(buf) {
    var n = buf.length, ch = buf.numberOfChannels;
    var out = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i];
    }
    var k = 1 / Math.max(1, ch);
    for (var i2 = 0; i2 < n; i2++) out[i2] *= k;
    var factor = Math.max(1, Math.round(buf.sampleRate / SR_TARGET));
    st.aSr = Math.round(buf.sampleRate / factor);
    if (factor === 1) return out;
    var m = Math.floor(n / factor);
    var res = new Float32Array(m);
    for (var i3 = 0; i3 < m; i3++) {
      var s = 0;
      for (var j = 0; j < factor; j++) s += out[i3 * factor + j];
      res[i3] = s / factor;
    }
    return res;
  }

  /* ==================== быстрые метрики и waveform (main thread) ==================== */

  function computeQuick() {
    var mono = st.mono, sr = st.aSr;
    var peak = 0, sum = 0, i, j;
    for (i = 0; i < mono.length; i++) {
      var v = Math.abs(mono[i]);
      if (v > peak) peak = v;
      sum += mono[i] * mono[i];
    }
    st.quick = { peak: peak, rms: Math.sqrt(sum / Math.max(1, mono.length)) };

    var win = Math.max(1, Math.round(sr));
    var per = Math.ceil(mono.length / win);
    var energy = new Float32Array(per);
    var maxE = 0;
    for (i = 0; i < per; i++) {
      var s = 0;
      var end = Math.min(mono.length, (i + 1) * win);
      for (j = i * win; j < end; j++) s += mono[j] * mono[j];
      energy[i] = Math.sqrt(s / win);
      if (energy[i] > maxE) maxE = energy[i];
    }
    for (i = 0; i < per; i++) energy[i] = maxE > 0 ? energy[i] / maxE : 0;
    st.energy = energy;

    var buckets = Math.min(480, Math.max(80, Math.round(mono.length / sr)));
    var bp = Math.max(1, Math.ceil(mono.length / buckets));
    var wave = new Float32Array(buckets);
    var wmax = 0;
    for (i = 0; i < buckets; i++) {
      var mx = 0;
      var e2 = Math.min(mono.length, (i + 1) * bp);
      for (j = i * bp; j < e2; j++) { var a = Math.abs(mono[j]); if (a > mx) mx = a; }
      wave[i] = mx;
      if (mx > wmax) wmax = mx;
    }
    if (wmax > 0) for (i = 0; i < buckets; i++) wave[i] /= wmax;
    st.wave = wave;
  }

  /* ==================== воркер ==================== */

  function startWorkerAnalysis(token) {
    if (!st.mono) return;
    st.wToken++;
    var wt = st.wToken;
    st.analyzing = true;
    st.result = null;
    var copy = new Float32Array(st.mono); // копия: transfer заберёт буфер
    var longNote = '';
    if (st.meta.duration && st.meta.duration > MAX_ANALYZE_SEC) {
      longNote = ' Файл длинный — анализ первых ' + (MAX_ANALYZE_SEC / 60) + ' минут.';
    }
    setStatus('Анализирую: спектр, ритм, тональность…' + longNote);
    var w = getWorker();
    w.onmessage = function (ev) {
      if (wt !== st.wToken) return;
      var d = ev.data || {};
      if (d.type === 'progress') { setStatus('Анализирую… ' + Math.round((d.fraction || 0) * 100) + '%'); return; }
      if (d.type === 'error') { st.analyzing = false; setStatus('Анализ не удался: ' + d.message); return; }
      if (d.type === 'result') {
        st.analyzing = false;
        st.result = d.result;
        renderChips();
        drawSpec();
        drawEnergy();
        renderStructure();
        disableAI(false);
        setStatus('Готово. Можно отправить результаты ИИ.' + longNote);
      }
    };
    w.onerror = function () {
      if (wt !== st.wToken) return;
      st.analyzing = false;
      setStatus('Анализ не удался (ошибка воркера).');
    };
    w.postMessage({ type: 'analyze', samples: copy, sampleRate: st.aSr }, [copy.buffer]);
  }

  /* ==================== отрисовка ==================== */

  function setStatus(t) { if (ui.status) ui.status.textContent = t || ''; }
  function disableAI(on) { if (ui.aiBtn) ui.aiBtn.disabled = Boolean(on); }

  function clearCanvases() {
    [ui.wave, ui.spec, ui.energyCv].forEach(function (cv) {
      if (!cv) return;
      var c = cv.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
    });
  }

  function chipHtml(k, v) {
    return '<div class="aa-chip"><span>' + esc(k) + '</span><b class="aa-chip-v">' + esc(v) + '</b></div>';
  }
  function renderChips() {
    if (!ui.chips) return;
    var r = st.result;
    var m = st.meta;
    var rows = [];
    rows.push(chipHtml('Длительность', fmt(m.duration || 0)));
    rows.push(chipHtml('Формат', (st.aSr ? Math.round(st.aSr / 100) / 10 : 0) + ' кГц · ' + (m.channels || 0) + ' канал(а)'));
    if (st.quick) rows.push(chipHtml('Громкость', 'RMS ' + db(st.quick.rms) + ' · Peak ' + db(st.quick.peak) + ' dBFS'));
    if (r && r.bpm && r.bpm.value) {
      rows.push(chipHtml('BPM', r.bpm.value + (r.bpm.confidence >= 0.7 ? ' · высокая' : r.bpm.confidence >= 0.4 ? ' · средняя' : ' · низкая') + ' уверенность'));
    }
    if (r && r.key && r.key.name) {
      rows.push(chipHtml('Тональность', r.key.name + ' · ' + Math.round(r.key.confidence * 100) + '%'));
    }
    ui.chips.innerHTML = rows.join('');
  }

  function renderStructure() {
    var r = st.result;
    if (!r || !r.boundaries || r.boundaries.length < 2) { ui.structWrap.hidden = true; return; }
    ui.structWrap.hidden = false;
    var parts = ['0:00'];
    r.boundaries.forEach(function (b) { parts.push(fmt(b.time)); });
    ui.struct.innerHTML =
      '<span>≈ ' + (r.boundaries.length + 1) + ' частей</span>' +
      parts.map(function (p) { return '<span>' + esc(p) + '</span>'; }).join('');
  }

  function fit(cv, h) {
    var dpr = global.devicePixelRatio || 1;
    var cssW = cv.clientWidth || 320;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: h };
  }

  function drawWave() {
    if (!ui.wave) return;
    var g = fit(ui.wave, 72);
    var ctx = g.ctx;
    ctx.clearRect(0, 0, g.w, g.h);
    var w = st.wave || [];
    var n = w.length;
    if (!n) return;
    var bw = g.w / n;
    ctx.fillStyle = 'rgba(127,127,150,.35)';
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var bh = Math.max(2, w[i] * g.h * 0.9);
      ctx.rect(i * bw + bw * 0.15, (g.h - bh) / 2, bw * 0.7, bh);
    }
    ctx.fill();
  }

  function drawSpec() {
    var r = st.result;
    if (!r || !r.bands) return;
    var g = fit(ui.spec, 150);
    var ctx = g.ctx;
    ctx.clearRect(0, 0, g.w, g.h);
    var labels = ['Суб 20–60', 'Бас 60–250', 'Середина 0.25–0.5', 'Середина 0.5–2к', 'Середина 2–6к', 'Высокие 6к+'];
    var colors = ['#7c6cf0', '#5b8cff', '#8e9dff', '#34bfa3', '#e8a13c', '#ef6a6a'];
    var x0 = 104, xw = g.w - x0 - 34;
    var max = 1;
    for (var i = 0; i < 6; i++) if (r.bands[i] > max) max = r.bands[i];
    var rowH = g.h / 6;
    ctx.font = '10px Inter, sans-serif';
    for (var k = 0; k < 6; k++) {
      var y = k * rowH + rowH * 0.25;
      var bh = rowH * 0.5;
      ctx.fillStyle = 'rgba(127,127,140,.22)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x0, y, xw, bh, 4) : ctx.rect(x0, y, xw, bh);
      ctx.fill();
      var v = r.bands[k] / max;
      ctx.fillStyle = colors[k];
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x0, y, Math.max(3, xw * v), bh, 4) : ctx.rect(x0, y, Math.max(3, xw * v), bh);
      ctx.fill();
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || '#888';
      ctx.fillText(labels[k], 0, y + bh);
      var pct = r.bands[k];
      ctx.fillStyle = 'rgba(127,127,140,.9)';
      ctx.fillText(pct + '%', g.w - 30, y + bh);
    }
  }

  function drawEnergy() {
    var e = st.energy;
    if (!e || !e.length) return;
    var g = fit(ui.energyCv, 150);
    var ctx = g.ctx;
    ctx.clearRect(0, 0, g.w, g.h);
    var pad = 6, W = g.w, H = g.h - pad * 2;
    ctx.strokeStyle = 'rgba(127,127,140,.18)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (f) {
      var y = pad + H * (1 - f);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });
    var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) || '#2f8fff';
    ctx.beginPath();
    var n = e.length;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1 || 1)) * W;
      var y = pad + H * (1 - e[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(W, pad + H); ctx.lineTo(0, pad + H); ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(127,127,140,.9)';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText('0:00', 0, g.h - 1);
    var durTxt = fmt(st.meta.duration || 0);
    ctx.fillText(durTxt, W - 26, g.h - 1);
  }

  /* ==================== плеер ==================== */

  function bindPlayer() {
    var a = ui.audio;
    ui.play.addEventListener('click', function () {
      if (!a.src) return;
      if (a.paused) a.play(); else a.pause();
    });
    a.addEventListener('play', function () { ui.play.innerHTML = ICON_PAUSE; });
    a.addEventListener('pause', function () { ui.play.innerHTML = ICON_PLAY; });
    a.addEventListener('timeupdate', function () {
      if (st.seeking) return;
      var d = a.duration || 0;
      var p = d ? (a.currentTime / d * 100) : 0;
      ui.seekFill.style.width = p + '%';
      ui.thumb.style.left = p + '%';
      ui.time.textContent = fmt(a.currentTime) + ' / ' + fmt(d);
    });
    a.addEventListener('ended', function () { try { a.currentTime = 0; } catch (e) {} });

    var drag = false;
    function ratio(ev) {
      var r = ui.seek.getBoundingClientRect();
      var x = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX) - r.left;
      return Math.max(0, Math.min(1, r.width ? x / r.width : 0));
    }
    function seekTo(ev) {
      if (!isFinite(a.duration) || !a.duration) return;
      a.currentTime = ratio(ev) * a.duration;
    }
    ui.seek.addEventListener('pointerdown', function (ev) {
      drag = true; st.seeking = true; seekTo(ev);
      try { ui.seek.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    ui.seek.addEventListener('pointermove', function (ev) { if (drag) seekTo(ev); });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      ui.seek.addEventListener(t, function () { drag = false; st.seeking = false; });
    });
    ui.wave.addEventListener('click', function (ev) {
      if (!isFinite(a.duration) || !a.duration) return;
      var r = ui.wave.getBoundingClientRect();
      a.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * a.duration;
    });
  }

  /* ==================== отправка ИИ ==================== */

  function buildPayload() {
    var r = st.result || {};
    var d = st.meta || {};
    var energy = [], e = st.energy || [];
    var step = Math.max(1, Math.ceil(e.length / 20));
    for (var i = 0; i < e.length; i += step) {
      var mx = 0;
      for (var j = i; j < Math.min(e.length, i + step); j++) if (e[j] > mx) mx = e[j];
      energy.push(Math.round(mx * 100) / 100);
    }
    var dur = d.duration || 0;
    var bounds = (r.boundaries && r.boundaries.length >= 2) ? r.boundaries : null;
    var sections = [];
    if (bounds && st.energy) {
      var starts = [0].concat(bounds.map(function (b) { return b.time; }));
      for (var s = 0; s < starts.length; s++) {
        var a = starts[s];
        var b2 = (s + 1 < starts.length) ? starts[s + 1] : dur;
        var sum = 0, cn = 0;
        for (var i2 = Math.floor(a); i2 < Math.min(st.energy.length, Math.ceil(b2)); i2++) { sum += st.energy[i2]; cn++; }
        sections.push({
          start: Math.round(a * 10) / 10,
          end: Math.round(b2 * 10) / 10,
          avgEnergy: cn ? Math.round(sum / cn * 100) / 100 : null
        });
      }
    }
    return {
      file: {
        name: (st.file && st.file.name) || '',
        durationSec: Math.round(dur * 10) / 10,
        sampleRate: st.aSr || st.sr || 0,
        channels: d.channels || 0
      },
      loudness: { rmsDbfs: db(st.quick ? st.quick.rms : 0), peakDbfs: db(st.quick ? st.quick.peak : 0) },
      bpm: r.bpm || null,
      key: r.key || null,
      bandBalance: r.bands || null,
      energyTimeline: energy,
      structure: bounds
        ? { boundaryTimesSec: bounds.map(function (b) { return b.time; }), confidence: null, sections: sections }
        : { detected: false }
    };
  }

  function analyzeWithAI() {
    if (!st.file) return;
    var send = global.__hmSendAudioAnalysis;
    if (typeof send !== 'function') { setStatus('Чат недоступен — попробуйте позже.'); return; }
    var payload = buildPayload();
    var name = st.file.name || 'аудио';
    close();
    send(payload, name);
  }

  /* ==================== экспорт ==================== */

  global.AudioAnalyzer = {
    openPicker: openPicker,
    openWithFile: openWithFile,
    isOpen: function () { return Boolean(ui.overlay && !ui.overlay.hidden); }
  };

})(typeof window !== 'undefined' ? window : globalThis);
