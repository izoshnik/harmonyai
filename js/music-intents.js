/* ============================================================================
   HarmonyAI — клиентский детектор музыкальных намерений.

   ЭТО ГЛАВНАЯ ОПТИМИЗАЦИЯ СКОРОСТИ ВО ВСЁМ ПРОЕКТЕ.

   Работает в браузере до любого сетевого запроса:
     «пауза» / «следующий» / «продолжи»  → 0 мс, 0 запросов, 0 токенов
     «включи believer»                  → сразу в /api/music, мимо LLM
     всё остальное                       → старый путь чата без изменений

   КРИТИЧНО: HarmonyAI — музыкальный АИ с музлитературой и нотами.
   Слова «трек», «альбом», «музыка» часто встречаются в УЧЕБНЫХ вопросах.
   Поэтому сначала работают СТОП-ФИЛЬТРЫ: любой признак вопроса,
   анализа, теории или нотации — и мы НЕ перехватываем фразу.
   Ложное срабатывание хуже пропуска: пропуск подхватит серверный intent.
   ========================================================================== */

(function (global) {
  'use strict';

  /* -------------------------------------------------------- стоп-фильтры */

  // Учебный / аналитический запрос — это НЕ команда плееру.
  var BLOCKERS = [
    /\b(расскажи|расскажешь|объясни|опиши|сравни|проанализируй|разбери|разбор)\b/i,
    /\b(что такое|кто такой|кто такая|почему|зачем|какие|какой|какая|сколько|чем отлич)/i,
    /\b(ноты|нотный|нотаци|аккорд|табы|партитур|гармони|тональност|интервал|лад|сольфеджио)/i,
    /\b(теори|истори|биограф|эпох|стиль |жанре|реферат|конспект|урок|экзамен)/i,
    /\b(напиши|сочини|создай|сгенерируй|нарисуй|переведи|перескажи)\b/i,
    /\b(what|why|how|explain|analyz|analys|history|theory|compare)\b/i,
    /\?\s*$/                       // вопросительный знак в конце
  ];

  function blocked(text) {
    for (var i = 0; i < BLOCKERS.length; i++) {
      if (BLOCKERS[i].test(text)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------ команды плеера */

  // Порядок важен: более специфичные шаблоны идут раньше.
  var CONTROLS = [
    ['previous', /^(?:предыдущ(?:ий|ая|ее|ёе)?|назад|предыдущий трек|вернись|prev(?:ious)?|back)$/i],
    ['next',     /^(?:следующ(?:ий|ая|ее|ёе)?|далее|дальше|переключи|следующий трек|пропусти|next|skip)$/i],
    ['pause',    /^(?:пауза|паузу|поставь на паузу|останови|остановить|стоп|тише пожалуйста|pause|stop)$/i],
    ['resume',   /^(?:продолжи|продолжай|возобнови|играй|дальше играй|resume|continue|unpause)$/i],
    ['shuffle',  /^(?:шафл|перемешай|вперемешку|случайный порядок|shuffle|random)$/i],
    ['repeat',   /^(?:повтор|повтори|повторяй|зацикли|на повторе|repeat|loop)$/i],
    ['louder',   /^(?:громче|сделай громче|прибавь звук|louder|volume up)$/i],
    ['quieter',  /^(?:тише|сделай тише|убавь звук|quieter|volume down)$/i],
    ['mute',     /^(?:выключи звук|без звука|мут|mute)$/i],
    ['like',     /^(?:лайк|нравится|в избранное|like)$/i],
    ['close',    /^(?:закрой плеер|выключи музыку|хватит музыки|close player)$/i]
  ];

  /* -------------------------------------------------------- запуск музыки */

  // Глаголы запуска. После них обязательно должен идти предмет запроса.
  var PLAY_VERB = '(?:включи(?:те)?|вкл|поставь(?:те)?|запусти|играй|сыграй|давай|хочу послушать|хочу услышать|послушаем|включай|play|put on)';
  var FIND_VERB = '(?:найди|поищи|поиск|search|find)';

  // Квалификаторы типа сущности.
  var KIND_WORDS = [
    ['playlist', /^(?:плейлист|плэйлист|подборку|подборка|playlist)\s+/i],
    ['album',    /^(?:альбом|пластинку|диск|album)\s+/i],
    ['artist',   /^(?:артиста|исполнителя|группу|певца|певицу|artist|band)\s+/i],
    ['track',    /^(?:трек|песню|песня|композицию|song|track)\s+/i]
  ];

  // Мусорные хвосты/головы в запросе.
  var NOISE = /^(?:мне|нам|пожалуйста|плиз|пж|что-нибудь|что нибудь|песню|музыку|трек)\s+/i;
  var TAIL = /[\s,\.\!]+(?:пожалуйста|плиз|пж|спасибо|please)\s*$/i;

  function cleanQuery(raw) {
    var q = String(raw || '').trim();
    q = q.replace(TAIL, '');
    // Снимаем шум с начала максимум два раза («мне песню X»).
    for (var i = 0; i < 2; i++) {
      var next = q.replace(NOISE, '');
      if (next === q) break;
      q = next;
    }
    q = q.replace(/^[«"'\s]+|[»"'\s\.\!,]+$/g, '');
    return q.trim();
  }

  /**
   * Главная функция.
   * @returns {null | {type:'control',command:string} | {type:'play',kind:string,query:string}}
   */
  function detect(rawText) {
    var text = String(rawText || '').trim();
    if (!text || text.length > 200) return null;

    // Нормализация для сравнения с командами.
    var norm = text.toLowerCase().replace(/ё/g, 'е').replace(/[\.\!]+$/, '').trim();

    /* --- 1. Команды плеера: только точное совпадение всей фразы.
           Короткое сообщение — это команда, длинное — всегда вопрос. --- */
    if (norm.length <= 40) {
      for (var i = 0; i < CONTROLS.length; i++) {
        if (CONTROLS[i][1].test(norm)) {
          return { type: 'control', command: CONTROLS[i][0] };
        }
      }
    }

    /* --- 2. Стоп-фильтры для всего остального. --- */
    if (blocked(norm)) return null;

    /* --- 3. Запуск / поиск музыки. --- */
    var playRe = new RegExp('^' + PLAY_VERB + '\\s+(.{2,120})$', 'i');
    var findRe = new RegExp('^' + FIND_VERB + '\\s+(.{2,120})$', 'i');

    var m = playRe.exec(norm) || findRe.exec(norm);
    if (!m) return null;

    var rest = m[1].trim();

    // Определяем тип сущности и отрезаем квалификатор.
    var kind = 'track';
    for (var k = 0; k < KIND_WORDS.length; k++) {
      if (KIND_WORDS[k][1].test(rest)) {
        kind = KIND_WORDS[k][0];
        rest = rest.replace(KIND_WORDS[k][1], '');
        break;
      }
    }

    var query = cleanQuery(rest);

    // Слишком короткий или пустой остаток — не рискуем.
    if (query.length < 2) return null;

    // «включи музыку» без уточнения — нет предмета поиска.
    if (/^(?:музыка|музыку|music|что-нибудь|что нибудь)$/i.test(query)) {
      return { type: 'control', command: 'resume_or_random' };
    }

    // Возвращаем запрос в ИСХОДНОМ регистре — поиск Яндекса к нему чувствителен.
    var originalQuery = recoverCase(text, query);

    return { type: 'play', kind: kind, query: originalQuery };
  }

  /** Ищет подстроку в исходном тексте, чтобы вернуть оригинальный регистр. */
  function recoverCase(original, lowered) {
    var idx = original.toLowerCase().replace(/ё/g, 'е').indexOf(lowered);
    if (idx < 0) return lowered;
    return original.substr(idx, lowered.length).trim();
  }

  /** Быстрая проверка без разбора — есть ли вообще музыкальный намёк. */
  function hasMusicHint(text) {
    return /(включ|поставь|запусти|плейлист|трек|песн|альбом|пауз|следующ|предыдущ|продолж|шафл|повтор|play|pause|next|shuffle|repeat|track|song|album|playlist)/i
      .test(String(text || ''));
  }

  global.MusicIntents = {
    detect: detect,
    hasMusicHint: hasMusicHint,
    cleanQuery: cleanQuery
  };

})(typeof window !== 'undefined' ? window : globalThis);
