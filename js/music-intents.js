/* ============================================================================
   HarmonyAI — клиентский детектор музыкальных намерений.

   ЭТО ГЛАВНАЯ ОПТИМИЗАЦИЯ СКОРОСТИ ВО ВСЁМ ПРОЕКТЕ.

   Работает в браузере до любого сетевого запроса:
     «пауза» / «следующий» / «продолжи»   → 0 мс, 0 запросов, 0 токенов
     «включи believer»                    → сразу в /api/music, мимо LLM
     «найди believer и расскажи, кто автор» → трек + текстовый ответ
     всё остальное                        → обычный путь чата

   КРИТИЧНО: HarmonyAI — музыкальный ИИ с музлитературой и нотами.
   Слова «трек», «альбом», «музыка» часто встречаются в УЧЕБНЫХ вопросах.
   Поэтому для фраз БЕЗ явного глагола действия работают стоп-фильтры:
   любой признак вопроса, анализа, теории или нотации — и мы не перехватываем.

   А вот если глагол(«найди», «включи»), фраза разбирается ДАЖЕ когда
   в ней сидит вторая просьба. Раньше «найди и опиши, как был написан трек
   Believer» умирало на стоп-слове «опиши» и трек не показывался вообще.
   Теперь такие фразы режутся на две части: поисковый запрос и вопрос.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ВНИМАНИЕ: \b в JavaScript опирается на \w, а \w — это только ASCII.
     Для кириллицы граница слова не работает вообще, поэтому границы
     задаём явно через классы символов. */
  var LTR = 'a-zа-яё0-9';

  /** Целое слово: «лад» совпадёт, «ладно» и «склад» — нет. */
  function wordRe(alts) {
    return new RegExp('(?:^|[^' + LTR + '])(?:' + alts + ')(?![' + LTR + '])', 'i');
  }
  /** Начало слова: «гармони» поймает и «гармонию», и «гармонический». */
  function stemRe(alts) {
    return new RegExp('(?:^|[^' + LTR + '])(?:' + alts + ')', 'i');
  }
  /** Целое слово в начале строки вместе с хвостовыми пробелами и запятыми. */
  function headRe(alts) {
    return new RegExp('^(?:' + alts + ')(?![' + LTR + '])[\\s,]*', 'i');
  }

  /** Одна нормализация на весь модуль: регистр, ё→е, хвостовая пунктуация.
      Длину строки не меняет (кроме краёв), поэтому по ней потом можно
      восстановить исходный регистр запроса. */
  function normalize(raw) {
    return String(raw || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s.!]+$/, '').trim();
  }

  /* -------------------------------------------------------- стоп-фильтры */

  /* Применяются ТОЛЬКО к фразам без явного глагола действия. */
  var BLOCKERS = [
    wordRe('расскажи|расскажешь|расскажите|объясни|объясните|опиши|опишите|сравни|проанализируй|разбери|разбор|перечисли'),
    stemRe('что такое|что за |кто такой|кто такая|кто такие|почему|зачем|какие|какой|какая|сколько|чем отлич|в чем разниц'),
    wordRe('ноты|нотка|нотный|аккорд|аккорды|табы|лад|лады|сольфеджио|такт|такты'),
    stemRe('нотаци|партитур|гармони|тональност|интервал|модуляц|каденц|полифон'),
    stemRe('теори|истори|биограф|эпох|реферат|конспект|доклад'),
    wordRe('урок|уроки|экзамен|зачет|домашка|домашнее задание|жанр|жанре|стиль|стиля|стиле'),
    wordRe('напиши|напишите|сочини|создай|сгенерируй|нарисуй|переведи|перескажи|составь|реши|помоги'),
    /\b(what|why|how|explain|analyz|analys|history|theory|compare|difference)\b/i,
    /\?\s*$/
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

  /* ------------------------------------------------------------- глаголы */

  /* Вежливая приставка: «а можешь…», «слушай, …», «пожалуйста, …». */
  var POLITE_HEAD = headRe('а|ну|эй|слушай|окей|ок|ok|hey|пожалуйста|плиз|пж|можешь ли|можешь|можете|сможешь|сможете|не мог бы ты|не могли бы вы|прошу|будь добр|будьте добры|давай-ка');

  /* Запуск: пользователь хочет СРАЗУ слушать. */
  var PLAY_ALTS = ''
    + 'включи(?:те|-ка)?|включить|включай(?:те)?|вкл|'
    + 'поставь(?:те|-ка)?|поставить|ставь|'
    + 'запусти(?:те)?|запустить|'
    + 'скинь(?:те)?|скинуть|кинь(?:те)?|швырни|'
    + 'отправь(?:те)?|отправить|пришли|прислать|'
    + 'дай(?:те)?(?:\\s+послушать)?|'
    + 'врубай|вруби(?:те)?|врубить|замути|заряди|'
    + 'играй|сыграй|давай|зацени|'
    + 'хочу\\s+(?:послушать|услышать)|хочется\\s+послушать|послушаем|послушать|'
    + 'play|put\\s+on|turn\\s+on|start';

  /* Поиск: показать карточку, но не обязательно включать. */
  var FIND_ALTS = 'найди(?:те)?|найти|найд[её]шь|поищи(?:те)?|поискать|поиск|отыщи|ищи|подбери|подобрать|search|find|look\\s+up';

  var PLAY_HEAD = headRe(PLAY_ALTS);
  var FIND_HEAD = headRe(FIND_ALTS);

  /* --------------------------------------------- вторая просьба во фразе */

  var CONNECTOR_ALTS = 'и|а\\s+также|также|потом|затем|плюс|еще|а';

  var EXTRA_VERB_ALTS = ''
    + 'расскажи(?:те)?|рассказать|расскажешь|'
    + 'опиши(?:те)?|описать|'
    + 'объясни(?:те)?|объяснить|поясни(?:те)?|'
    + 'разбери|разобрать|подскажи(?:те)?|'
    + 'напиши(?:те)?|переведи|перевести|поведай|уточни|'
    + 'скажи(?:те)?|'
    + 'tell\\s+me|explain|describe';

  /* Вопросительные обороты. Намеренно многословные: одиночные «смысл» или
     «перевод» встречаются в реальных названиях песен, их трогать нельзя. */
  var QUESTION_ALTS = ''
    + 'как\\s+(?:был|была|было|были)\\s+[a-zа-яё]+|'
    + 'как\\s+(?:создавал|писал|записывал|появил|сочинял|придумал)[a-zа-яё]*|'
    + 'кто\\s+(?:написал|автор|поет|исполняет|исполнил|спел|сочинил|создал)|'
    + 'что\\s+значит|о\\s+ч[её]м|про\\s+что|'
    + 'когда\\s+(?:вышел|вышла|вышло|выпустили|записали|написали)|'
    + 'в\\s+каком\\s+году|'
    + 'истори(?:ю|я|и|ей)\\s+(?:создания|песни|трека|написания|этой)|'
    + 'смысл\\s+(?:песни|трека|этой|слов)|'
    + 'перевод\\s+(?:песни|трека|текста|этой)|'
    + 'текст\\s+песни|'
    + 'who\\s+(?:wrote|sings)|what\\s+(?:is|does)';

  var CONNECTOR_HEAD = new RegExp('^(?:[,;+\\-—.]+\\s*|(?:' + CONNECTOR_ALTS + ')(?![' + LTR + '])[\\s,]*)', 'i');
  var EXTRA_VERB_HEAD = headRe(EXTRA_VERB_ALTS);
  var QUESTION_HEAD = headRe(QUESTION_ALTS);
  var OBJ_HEAD = headRe('про|об|обо|о');

  /* «скажи» — это и просьба, и начало песни «Скажи не молчи». Поэтому глагол
     считается второй просьбой только после союза или если за ним идёт вопрос. */
  var REQUEST_FOLLOW = new RegExp('^(?:про|об|обо|о|как|кто|что|когда|почему|зачем|где|чем|чей|истори|смысл|перевод|значение|факт)(?![' + LTR + ']*[a-zа-яё]{6})', 'i');

  /* Квалификаторы типа сущности. */
  var KIND_HEAD = [
    ['playlist', headRe('плейлист(?:ы)?|плэйлист|подборку|подборка|playlist')],
    ['album',    headRe('альбом(?:а|е)?|пластинку|диск|album')],
    ['artist',   headRe('артиста|исполнителя|группу|группы|певца|певицу|artist|band')],
    ['track',    headRe('трек(?:а|и)?|песню|песня|песни|песенку|композицию|композиция|сингл|саундтрек|song|track')]
  ];

  /* Мусор в начале запроса и вежливый хвост. */
  var NOISE_HEAD = headRe('мне|нам|мою|мой|пожалуйста|плиз|пж|там|вот|эту|этот|ту|тот|из|у');

  /* Неопределённые местоимения — пользователь НЕ называет конкретную запись.
     «Включи что-нибудь бодрое», «давай что-нибудь другое» — выбирать должна
     модель, а не подстановка голого прилагательного в поиск Яндекса. */
  var INDEF_HEAD = headRe('какую-нибудь|какой-нибудь|какое-нибудь|что-нибудь|что\\s+нибудь|ч[её]-нибудь|чего-нибудь|что-то|чего-то');

  /* Остаток без собственного имени: «другую песню», «похожее», «ещё». */
  var GENERIC_ONLY = /^(?:друг(?:ое|ую|ой|ого|ая)|еще|получше|поинтереснее|повеселее|похож(?:ее|ую|ий)|нов(?:ое|ую)|свеж(?:ее|ую)|случайн(?:ое|ую)|люб(?:ое|ую)|такое же|такую же)(?:\s+(?:песню|песня|трек|трека|музыку|композицию|альбом|такое|же))*$/i;
  var TAIL = /[\s,.!]+(?:пожалуйста|плиз|пж|спасибо|please)\s*$/i;

  /* «Включи музыку» — предмета поиска нет, это просьба продолжить/включить что угодно. */
  var RANDOM_RE = /^(?:музык[ауие]|music|что-нибудь|что нибудь|ч[её]-нибудь|любую музыку|песню|песенку|трек|any music|something)$/i;

  /* Остаток, который заведомо не название: местоимения и указатели. */
  var QUERY_STOP = /^(?:его|ее|е[её]|их|это|этой|этот|эту|тот|та|то|нее|не[её]|нем|н[её]м|ней|них|он|она|они|там|тут|здесь|мне|нам|меня|нас|песня|песню|трек|альбом|музыка|музыку)$/i;

  /* Остаток, который выглядит как учебный запрос, а не как название записи. */
  var QUERY_BAD = [
    stemRe('теори|нотаци|аккорд|гармони|сольфеджио|партитур|тональност|интервал|модуляц|каденц|полифон|реферат|конспект|доклад'),
    wordRe('информацию|инфу|материал|материалы|статью|видео|картинку|фото|рецепт|погоду|новости|ноты')
  ];

  function cleanQuery(raw) {
    var q = String(raw || '').trim();
    q = q.replace(TAIL, '');
    q = q.replace(/^[«"'\s]+|[»"'\s.!,]+$/g, '');
    return q.trim();
  }

  /**
   * Разбирает остаток фразы после глагола на предмет поиска и вторую просьбу.
   * @returns {null|{kind:string,query:string,wantAnswer:boolean,answerRequest:string,random:boolean}}
   */
  function parseObject(rest) {
    var text = cleanQuery(rest);
    if (!text) return null;

    if (RANDOM_RE.test(text)) {
      return { kind: 'track', query: '', wantAnswer: false, answerRequest: '', random: true };
    }

    var kind = 'track';
    var kindFound = false;
    var wantAnswer = false;
    var indefinite = false;
    var request = [];

    /* --- Шаг 1. Снимаем всё, что стоит ПЕРЕД названием.
           «и опиши как был написан трек beliver» → «beliver» --- */
    for (var i = 0; i < 8; i++) {
      var before = text;
      var m;
      var afterConnector = false;

      m = CONNECTOR_HEAD.exec(text);
      if (m) { text = text.slice(m[0].length); afterConnector = true; }

      m = EXTRA_VERB_HEAD.exec(text);
      if (m) {
        var tail = text.slice(m[0].length);
        if (afterConnector || REQUEST_FOLLOW.test(tail)) {
          wantAnswer = true;
          request.push(m[0].trim());
          text = tail;
          var mo = OBJ_HEAD.exec(text);
          if (mo) text = text.slice(mo[0].length);
        }
      }

      m = QUESTION_HEAD.exec(text);
      if (m) {
        wantAnswer = true;
        request.push(m[0].trim());
        text = text.slice(m[0].length);
        var mo2 = OBJ_HEAD.exec(text);
        if (mo2) text = text.slice(mo2[0].length);
      }

      if (!kindFound) {
        for (var k = 0; k < KIND_HEAD.length; k++) {
          var mk = KIND_HEAD[k][1].exec(text);
          if (mk) {
            kind = KIND_HEAD[k][0];
            kindFound = true;
            text = text.slice(mk[0].length);
            break;
          }
        }
      }

      m = INDEF_HEAD.exec(text);
      if (m) { indefinite = true; text = text.slice(m[0].length); }

      m = NOISE_HEAD.exec(text);
      if (m) text = text.slice(m[0].length);

      if (text === before) break;
    }

    /* --- Шаг 2. Отрезаем вторую просьбу ПОСЛЕ названия.
           «believer и расскажи, кто его написал» → «believer» --- */
    var cutRe = new RegExp(
      '[\\s,;]+(?:(?:' + CONNECTOR_ALTS + ')[\\s,]+)?(?:' + EXTRA_VERB_ALTS + '|' + QUESTION_ALTS + ')(?![' + LTR + '])',
      'i'
    );
    var cut = text.search(cutRe);
    if (cut > 0) {
      request.push(text.slice(cut).trim());
      text = text.slice(0, cut);
      wantAnswer = true;
    }

    var query = cleanQuery(text);

    if (RANDOM_RE.test(query)) {
      return { kind: kind, query: '', wantAnswer: wantAnswer, answerRequest: '', random: true };
    }

    /* --- Шаг 3. Проверки здравого смысла. --- */
    if (indefinite) return null;
    if (GENERIC_ONLY.test(query)) return null;
    if (query.length < 2) return null;
    if (QUERY_STOP.test(query)) return null;
    if (query.split(/\s+/).length > 8) return null;
    for (var b = 0; b < QUERY_BAD.length; b++) {
      if (QUERY_BAD[b].test(query)) return null;
    }

    return {
      kind: kind,
      query: query,
      wantAnswer: wantAnswer,
      answerRequest: cleanQuery(request.join(' ')).slice(0, 200),
      random: false
    };
  }

  /* ------------------------------------------------- голое название трека */

  var BARE_STOP = new RegExp('^(?:' +
    'да|нет|ок|окей|ага|угу|хорошо|ладно|понятно|точно|верно|' +
    'привет|здравствуй(?:те)?|добрый день|спасибо|благодарю|пока|' +
    'тест|проверка|помощь|приветик|еще|дальше|продолжай|' +
    'hi|hello|ok|okay|yes|no|thanks|thank you|test|help' +
    ')$', 'i');

  var BARE_OK = /^[a-zа-яё0-9][a-zа-яё0-9\s'’\-–—&.,!:()+]*$/i;

  /**
   * Голое название без глагола: «believer», «imagine dragons».
   *
   * Самый рискованный путь, поэтому confidence:'low' — если Яндекс ничего
   * не нашёл, фраза тихо уходит обычному чату, будто музыки тут и нет.
   */
  function bareName(norm) {
    if (norm.length < 3 || norm.length > 60) return null;
    if (BARE_STOP.test(norm)) return null;
    if (norm.indexOf('?') >= 0) return null;
    if (!BARE_OK.test(norm)) return null;
    if (/^[0-9\s]+$/.test(norm)) return null;
    if (norm.split(/\s+/).length > 6) return null;
    return norm;
  }

  /* ------------------------------------------- гейт для LLM-классификатора */

  var ACTION_VERB = stemRe('включ|поставь|поставить|запусти|запуст|врубай|врубани|врубить|сыграй|играй|найди|найти|найдешь|поищи|поискать|ищи|подбери|подобрать|включай|дай послушать|хочу послушать|хочется послушать|отыщи|замути|заряди');
  var ACTION_VERB_EN = /\b(play|turn on|put on|find|search|queue|look up)\b/i;

  var MUSIC_SURFACE = stemRe('песн|трек|альбом|плейлист|музык|композиц|саундтрек|мелоди|исполнител|певец|певиц|послуша|слуша|напев|хит|сингл');
  var MUSIC_SURFACE_EN = /\b(song|track|album|playlist|music|listen|artist|band|tune|single)\b/i;

  var EXTRA_REQUEST = [
    wordRe('расскажи|расскажите|объясни|объясните|опиши|опишите|разбери|переведи|сравни|подскажи|поясни|напомни'),
    stemRe('кто написал|кто автор|кто поет|кто исполн|что значит|о чем|о чём|почему|зачем|когда вышл|в каком году|перевод|историю|смысл'),
    /\?/,
    /\b(who|what|why|when|explain|tell me|translate|meaning)\b/i
  ];

  /** Есть ли во фразе вторая, немузыкальная просьба. */
  function hasExtraRequest(text) {
    var t = String(text || '');
    for (var i = 0; i < EXTRA_REQUEST.length; i++) {
      if (EXTRA_REQUEST[i].test(t)) return true;
    }
    return false;
  }

  /** Стоит ли будить серверный LLM-классификатор.

      Это НЕ решение «музыка или нет» — решает модель. Здесь только отсев,
      чтобы не платить задержкой на каждой реплике. */
  function looksMusicRelated(rawText) {
    var text = String(rawText || '').trim();
    if (!text || text.length > 300) return false;

    var norm = normalize(text);

    if (ACTION_VERB.test(norm) || ACTION_VERB_EN.test(norm)) return true;
    if (blocked(norm)) return false;
    if (MUSIC_SURFACE.test(norm) || MUSIC_SURFACE_EN.test(norm)) return true;

    return Boolean(bareName(norm));
  }

  /** Ищет подстроку в исходном тексте, чтобы вернуть оригинальный регистр. */
  function recoverCase(original, lowered) {
    var idx = String(original).toLowerCase().replace(/ё/g, 'е').indexOf(lowered);
    if (idx < 0) return lowered;
    return String(original).substr(idx, lowered.length).trim();
  }

  /**
   * Главная функция.
   * @returns {null
   *   | {type:'control', command:string}
   *   | {type:'play', kind:string, query:string, confidence:'high'|'low',
   *      autoplay:boolean, wantAnswer:boolean, answerRequest:string, explicit:boolean}}
   */
  function detect(rawText) {
    var text = String(rawText || '').trim();
    if (!text || text.length > 300) return null;

    var norm = normalize(text);

    /* --- 1. Команды плеера: только точное совпадение всей фразы. --- */
    if (norm.length <= 40) {
      for (var i = 0; i < CONTROLS.length; i++) {
        if (CONTROLS[i][1].test(norm)) {
          return { type: 'control', command: CONTROLS[i][0] };
        }
      }
    }

    /* --- 2. Явный глагол действия (можно с вежливой приставкой). --- */
    var head = norm;
    for (var p = 0; p < 3; p++) {
      var mp = POLITE_HEAD.exec(head);
      if (!mp) break;
      head = head.slice(mp[0].length);
    }

    var mode = null;
    var rest = null;
    var mv = FIND_HEAD.exec(head);
    if (mv) {
      mode = 'find';
      rest = head.slice(mv[0].length);
    } else if ((mv = PLAY_HEAD.exec(head))) {
      mode = 'play';
      rest = head.slice(mv[0].length);
    }

    if (mode) {
      var parsed = parseObject(rest);
      /* Глагол есть, но предмет не вытащили («включи что-нибудь бодрое под утро»)
         — молча отдаём фразу серверному классификатору, он умнее. */
      if (!parsed) return null;

      if (parsed.random) return { type: 'control', command: 'resume_or_random' };

      return {
        type: 'play',
        kind: parsed.kind,
        query: recoverCase(text, parsed.query),
        /* Составную просьбу помечаем low: если Яндекс ничего не найдёт,
           обработчик тихо вернёт фразу обычному чату вместо «Не нашёл». */
        confidence: parsed.wantAnswer ? 'low' : 'high',
        autoplay: mode === 'play',
        wantAnswer: parsed.wantAnswer,
        answerRequest: parsed.answerRequest,
        explicit: true
      };
    }

    /* --- 3. Без глагола — строгие стоп-фильтры и только голое название. --- */
    if (blocked(norm)) return null;

    var bare = bareName(norm);
    if (!bare) return null;

    var bareKind = 'track';
    for (var k = 0; k < KIND_HEAD.length; k++) {
      var mk = KIND_HEAD[k][1].exec(bare);
      if (mk) {
        bareKind = KIND_HEAD[k][0];
        bare = bare.slice(mk[0].length);
        break;
      }
    }

    var bareQuery = cleanQuery(bare);
    if (bareQuery.length < 2) return null;
    if (QUERY_STOP.test(bareQuery)) return null;
    if (RANDOM_RE.test(bareQuery)) return { type: 'control', command: 'resume_or_random' };

    return {
      type: 'play',
      kind: bareKind,
      query: recoverCase(text, bareQuery),
      confidence: 'low',
      autoplay: true,
      wantAnswer: false,
      answerRequest: '',
      explicit: false
    };
  }

  /** Быстрая проверка без разбора — есть ли вообще музыкальный намёк. */
  function hasMusicHint(text) {
    return /(включ|поставь|запусти|плейлист|трек|песн|альбом|пауз|следующ|предыдущ|продолж|шафл|повтор|play|pause|next|shuffle|repeat|track|song|album|playlist)/i
      .test(String(text || ''));
  }

  global.MusicIntents = {
    detect: detect,
    hasMusicHint: hasMusicHint,
    looksMusicRelated: looksMusicRelated,
    hasExtraRequest: hasExtraRequest,
    cleanQuery: cleanQuery,
    parseObject: parseObject
  };

})(typeof window !== 'undefined' ? window : globalThis);
