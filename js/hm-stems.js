/* ============================================================================
   РАЗБОР ТРЕКА НА ПАРТИИ («убери вокал», «оставь только голос», «без баса»).
   Нейросеть HTDemucs работает в браузере пользователя (js/hm-stems-worker.js):
   бесплатно, без сервера и без лимитов. Партии: ударные, бас, вокал и
   «остальное» (все прочие инструменты вместе). Отдельно убрать флейту,
   скрипку или гитару эта нейросеть не умеет — честно говорим об этом.

   Готовый трек хранится только на устройстве (Cache Storage), в истории чата —
   ссылка на него; скачать можно кнопкой «Скачать».
   ========================================================================== */
(function (global) {
  'use strict';

  var TRACKS = ['drums', 'bass', 'other', 'vocals'];
  var NAMES = { drums: 'ударные', bass: 'бас', other: 'остальные инструменты', vocals: 'вокал' };
  var GEN = { drums: 'ударных', bass: 'баса', other: 'остальных инструментов', vocals: 'вокала' };
  var MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
  var MODEL_CACHE = 'hm-stems-model-v1';
  var RESULT_CACHE = 'hm-stems-results-v1';
  var MODEL_MB = 200; // нейросеть + движок WebAssembly
  var MAX_MIN_PHONE = 7, MAX_MIN_DESKTOP = 12;

  var STEM_RE = [
    { t: 'vocals', re: /(вокал|голос|пени[ея]|(^|[^а-я])слов(а|о|у)?($|[^а-я])|акапелл|a\s?cappella|vocal|voice|речь)/i },
    { t: 'drums', re: /(ударн|барабан|драм|drum|перкусс|(^|[^а-я])бит($|[^а-я])|beat)/i },
    { t: 'bass', re: /((^|[^а-я])бас(а|у|ом|ы|ов|овую|овые|овый)?($|[^а-я])|басов|bass)/i },
    { t: 'other', re: /(остальн\S*\s+инструмент|музык[ауи]\b|аккомпанемент|instrumental\s+only)/i }
  ];
  var UNSUPPORTED_RE = /(флейт\S*|скрипк\S*|скрипичн\S*|гитар\S*|пианино|фортепиано|рояль?\S*|синт\S*|клавиш\S*|саксофон\S*|трубу|труба|трубы|виолончел\S*|струнн\S*|духов\S*|орган\S*|аккордеон\S*|баян\S*|арф\S*|хор\S*|кларнет\S*|гобой\S*|фагот\S*|валторн\S*|тромбон\S*|контрабас\S*|укулеле|балалайк\S*|домр\S*|бэк[-\s]?вокал\S*)/gi;
  var REMOVE_RE = /(убер[иеё]|убрать|удал[иья]|вырежи|вырезать|без\s|выключи|приглуши|сотри|минус|избав|почисти\s+от|очисти\s+от|заглуши)/i;
  var KEEP_RE = /(оставь\s+только|оставить\s+только|только\s|выдели|извлеки|вытащи|отдели|изолируй|достань|сделай\s+(отдельн|дорожк)|получи)/i;

  function low(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }

  /* Что сделать с треком. null — это не просьба о разделении. */
  function parse(text) {
    var s = low(text);
    if (!s.trim()) return null;
    var mentioned = [];
    STEM_RE.forEach(function (x) { if (x.re.test(s)) mentioned.push(x.t); });
    var unsupported = [];
    (s.match(UNSUPPORTED_RE) || []).forEach(function (w) { if (unsupported.indexOf(w) < 0) unsupported.push(w); });
    if (/контрабас/.test(s)) mentioned = mentioned.filter(function (t) { return t !== 'bass'; });
    if (/бэк[-\s]?вокал/.test(s)) mentioned = mentioned.filter(function (t) { return t !== 'vocals'; });
    var karaoke = /(минусовк|караоке|инструментал|без\s+слов|минус\s+(от|к|для)|сделай\s+минус)/.test(s);
    var acapella = /(акапелл|a\s?cappella|чист\S*\s+(вокал|голос))/.test(s);
    var keep = [1, 1, 1, 1];
    if (acapella) keep = [0, 0, 0, 1];
    else if (karaoke && !mentioned.length) keep = [1, 1, 1, 0];
    else if (mentioned.length && KEEP_RE.test(s) && !(REMOVE_RE.test(s) && s.search(REMOVE_RE) < s.search(KEEP_RE))) {
      keep = TRACKS.map(function (t) { return mentioned.indexOf(t) >= 0 ? 1 : 0; });
    } else if (mentioned.length && (REMOVE_RE.test(s) || karaoke)) {
      keep = TRACKS.map(function (t) { return mentioned.indexOf(t) >= 0 ? 0 : 1; });
    } else if (!unsupported.length || !(REMOVE_RE.test(s) || KEEP_RE.test(s))) {
      return null;
    }
    var changed = keep.some(function (k) { return !k; });
    if (!changed && !unsupported.length) return null;
    if (keep.every(function (k) { return !k; })) return null;
    return { keep: changed ? keep : null, label: changed ? label(keep) : '', unsupported: unsupported };
  }

  function label(keep) {
    var kept = TRACKS.filter(function (t, i) { return keep[i]; });
    var gone = TRACKS.filter(function (t, i) { return !keep[i]; });
    if (kept.length === 1) return 'только ' + NAMES[kept[0]];
    return 'без ' + joinRu(gone.map(function (t) { return GEN[t]; }));
  }
  function joinRu(a) { return a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' и ' + a[a.length - 1]; }

  function supported() {
    return Boolean(global.Worker && global.WebAssembly && (global.OfflineAudioContext || global.webkitOfflineAudioContext) && global.caches);
  }
  function isPhone() { try { return matchMedia('(max-width:768px),(hover:none) and (pointer:coarse)').matches; } catch (e) { return false; } }

  function isModelCached() {
    if (!global.caches) return Promise.resolve(false);
    return caches.open(MODEL_CACHE).then(function (c) { return c.match(MODEL_URL); }).then(function (r) { return Boolean(r); }).catch(function () { return false; });
  }

  /* Раскодировать файл в стерео 44,1 кГц (частота нейросети). */
  function decode(file) {
    return file.arrayBuffer().then(function (ab) {
      var Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      var ctx = new Ctx(2, 1, 44100);
      return new Promise(function (resolve, reject) {
        var p = ctx.decodeAudioData(ab, resolve, function () { reject(new Error('Не получилось прочитать аудиофайл — пришлите mp3, wav, m4a или flac.')); });
        if (p && p.then) p.then(resolve, function () { reject(new Error('Не получилось прочитать аудиофайл — пришлите mp3, wav, m4a или flac.')); });
      });
    }).then(function (buf) {
      var l = buf.getChannelData(0);
      var r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      // Копии: исходный буфер отдаём воркеру целиком (transfer), без лишней памяти.
      return { left: new Float32Array(l), right: r === l ? new Float32Array(l) : new Float32Array(r), duration: buf.duration };
    });
  }

  /* Разделить трек. cb: onStage(stage, backend), onDownload(loaded,total), onProgress(p 0..1). */
  function separate(file, keep, cb) {
    cb = cb || {};
    var lock = null;
    return decode(file).then(function (a) {
      var maxMin = isPhone() ? MAX_MIN_PHONE : MAX_MIN_DESKTOP;
      if (a.duration > maxMin * 60) throw new Error('Трек длиннее ' + maxMin + ' минут — на этом устройстве не хватит памяти. Пришлите фрагмент покороче.');
      try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); } catch (e) {}
      return new Promise(function (resolve, reject) {
        var w;
        try { w = new Worker('/js/hm-stems-worker.js?v=1', { type: 'module' }); }
        catch (e) { reject(new Error('Браузер не поддерживает разбор треков. Обновите браузер.')); return; }
        var t0 = 0;
        w.onmessage = function (e) {
          var m = e.data || {};
          if (m.type === 'download' && cb.onDownload) cb.onDownload(m.loaded, m.total);
          else if (m.type === 'stage') { if (m.stage === 'separate') t0 = Date.now(); if (cb.onStage) cb.onStage(m.stage, m.backend); }
          else if (m.type === 'progress' && cb.onProgress) {
            var el = (Date.now() - t0) / 1000;
            cb.onProgress(m.p, m.p > 0.02 ? Math.max(0, el / m.p - el) : null);
          }
          else if (m.type === 'done') { w.terminate(); resolve({ blob: new Blob([m.wav], { type: 'audio/wav' }), duration: a.duration, backend: m.backend }); }
          else if (m.type === 'error') { w.terminate(); reject(new Error(m.message || 'Не удалось разобрать трек')); }
        };
        w.onerror = function (e) { w.terminate(); reject(new Error('Не удалось запустить нейросеть' + (e && e.message ? ': ' + e.message : ''))); };
        w.postMessage({ type: 'run', left: a.left, right: a.right, keep: keep }, [a.left.buffer, a.right.buffer]);
      });
    }).finally(function () { try { if (lock) lock.release(); } catch (e) {} });
  }

  /* Готовые треки — только на этом устройстве (последние 12). */
  function saveResult(id, blob) {
    if (!global.caches) return Promise.resolve();
    return caches.open(RESULT_CACHE).then(function (c) {
      return c.put('/hm-stems/' + id + '.wav', new Response(blob, { headers: { 'content-type': 'audio/wav' } }))
        .then(function () { return c.keys(); })
        .then(function (keys) { return Promise.all(keys.slice(0, Math.max(0, keys.length - 12)).map(function (k) { return c.delete(k); })); });
    }).catch(function () {});
  }
  function loadResult(id) {
    if (!global.caches) return Promise.resolve(null);
    return caches.open(RESULT_CACHE).then(function (c) { return c.match('/hm-stems/' + id + '.wav'); })
      .then(function (r) { return r ? r.blob() : null; }).catch(function () { return null; });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function baseName(name) { return String(name || 'трек').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 80) || 'трек'; }
  function fileName(name, lbl) { return baseName(name) + ' (' + lbl + ').wav'; }

  /* Карточка результата: название, плеер, «Скачать». blob может быть null — файл
     был только на другом устройстве / очищен. */
  function card(opts) {
    var box = document.createElement('div');
    box.className = 'hm-stems-card';
    var title = baseName(opts.name);
    box.innerHTML =
      '<div class="hm-stems-head"><span class="hm-stems-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>' +
      '<span class="hm-stems-meta"><b>' + esc(title) + '</b><i>' + esc(opts.label || '') + '</i></span></div>';
    if (opts.blob) {
      var url = URL.createObjectURL(opts.blob);
      var au = document.createElement('audio');
      au.controls = true; au.preload = 'metadata'; au.src = url; au.className = 'hm-stems-audio';
      box.appendChild(au);
      var a = document.createElement('a');
      a.className = 'hm-stems-dl'; a.href = url; a.download = fileName(opts.name, opts.label || 'разбор');
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Скачать</span>';
      box.appendChild(a);
    } else {
      var n = document.createElement('div');
      n.className = 'hm-stems-gone';
      n.textContent = 'Файл хранился только на устройстве, где его сделали. Пришлите трек ещё раз, чтобы разобрать заново.';
      box.appendChild(n);
    }
    return box;
  }

  /* Кнопка «Скачать нейросеть и разобрать» — перед первым разбором. */
  function confirmDownload(slot) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.className = 'hm-stems-confirm';
      box.innerHTML = '<div>Для разбора нужна нейросеть (~' + MODEL_MB + ' МБ). Она скачается один раз и будет работать прямо на этом устройстве — бесплатно и без ограничений. Лучше через Wi-Fi.</div>' +
        '<div class="hm-stems-btns"><button type="button" class="hm-stems-go">Скачать и разобрать</button><button type="button" class="hm-stems-no">Отмена</button></div>';
      slot.appendChild(box);
      box.querySelector('.hm-stems-go').onclick = function () { box.remove(); resolve(true); };
      box.querySelector('.hm-stems-no').onclick = function () { box.remove(); resolve(false); };
    });
  }

  global.HmStems = {
    parse: parse, label: label, supported: supported, isModelCached: isModelCached,
    separate: separate, saveResult: saveResult, loadResult: loadResult, card: card,
    confirmDownload: confirmDownload, baseName: baseName, NAMES: NAMES
  };
})(typeof window !== 'undefined' ? window : globalThis);
