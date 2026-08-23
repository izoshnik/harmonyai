/* ============================================================================
   ЕДИНАЯ КОНФИГУРАЦИЯ ЦЕН И ЦЕЛОЧИСЛЕННАЯ ДЕНЕЖНАЯ АРИФМЕТИКА.

   Здесь лежат ВСЕ цены проекта. Ни один другой файл не должен хардкодить
   стоимость подписки, тарифы моделей, курс доллара или лимиты пополнения —
   только импортировать отсюда. Поменять цену = поменять одну строку тут
   (или переменную окружения).

   ПОЧЕМУ BigInt, А НЕ ЧИСЛА.
   Деньги нельзя считать во float: 0.1 + 0.2 !== 0.3, а при накоплении баланса
   ошибка растёт. Поэтому все суммы — целые числа в минимальных единицах:

     копейка   (1 ₽ = 100 коп.)      — для платежей: ЮKassa работает с копейками
     микрорубль (1 ₽ = 1 000 000 µ₽) — для баланса API и списаний

   Микрорубли нужны потому, что один запрос к модели может стоить сотые доли
   копейки: округлять такое до копейки — значит либо не списывать ничего, либо
   завышать цену в разы. 1 µ₽ = 0.0001 копейки, этого запаса хватает.

   ФОРМУЛА СТОИМОСТИ ЗАПРОСА (input и output тарифицируются по-разному):
     цена = input_tokens / 1M × цена_input + output_tokens / 1M × цена_output
   Никаких «токенов за рубль» — только реальные тарифы за миллион токенов.
   ============================================================================ */

/* -------- Масштабы единиц -------- */
export const MICRO_PER_RUBLE = 1000000n;   // 1 ₽  = 1 000 000 µ₽
export const MICRO_PER_KOPECK = 10000n;    // 1 коп = 10 000 µ₽
export const KOPECKS_PER_RUBLE = 100n;     // 1 ₽  = 100 коп

/* Делитель формулы стоимости: 1e6 (тариф задан за миллион токенов)
   × 1e6 (тариф хранится в микродолларах). */
const COST_DIVISOR = 1000000000000n;       // 1e12

/* ============================================================================
   РАЗБОР И ВЫВОД ДЕСЯТИЧНЫХ СТРОК БЕЗ FLOAT.
   parseFloat здесь недопустим: '0.60' → 0.6 → уже приблизительное значение.
   Работаем со строкой посимвольно и получаем точный BigInt.
   ============================================================================ */

/* '299.00' + decimals=2 → 29900n. Лишние знаки отбрасываются (усечение). */
export function decimalToScaled(value, decimals) {
  const raw = String(value == null ? '' : value).trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [intPart, fracRaw = ''] = body.split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const scaled = BigInt(intPart || '0') * (10n ** BigInt(decimals)) + BigInt(frac || '0');
  return negative ? -scaled : scaled;
}

/* 29900n + decimals=2 → '299.00'. Ровно то, что ждёт ЮKassa в amount.value. */
export function scaledToDecimal(scaled, decimals) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals > 0 ? '.' + frac.toString().padStart(decimals, '0') : '';
  return (negative ? '-' : '') + whole.toString() + fracStr;
}

/* -------- Переводы между единицами -------- */
export function kopecksToMicro(kopecks) { return BigInt(kopecks) * MICRO_PER_KOPECK; }
export function rublesStringToKopecks(value) { return decimalToScaled(value, 2); }
export function kopecksToRublesString(kopecks) { return scaledToDecimal(BigInt(kopecks), 2); }

/* Микрорубли → копейки с округлением вверх (не занижаем списание). */
export function microToKopecksCeil(micro) {
  const m = BigInt(micro);
  if (m <= 0n) return 0n;
  return (m + MICRO_PER_KOPECK - 1n) / MICRO_PER_KOPECK;
}

/* ============================================================================
   КУРС ДОЛЛАРА.
   Фиксированный, без обращения к внешнему API: для биллинга предсказуемость
   важнее актуальности. Меняется переменной окружения USD_RUB_RATE.
   ============================================================================ */
export const DEFAULT_USD_RUB_RATE = '95.00';

export function usdRubRateString() {
  const raw = String(process.env.USD_RUB_RATE || '').trim();
  return decimalToScaled(raw, 6) ? raw : DEFAULT_USD_RUB_RATE;
}

/* Курс в микрорублях за 1 USD: 95.00 ₽ → 95 000 000 µ₽. */
export function usdRateMicroRubles() {
  return decimalToScaled(usdRubRateString(), 6) ?? decimalToScaled(DEFAULT_USD_RUB_RATE, 6);
}

/* ============================================================================
   ТАРИФЫ ПУБЛИЧНЫХ МОДЕЛЕЙ.
   Цены заданы в долларах за миллион токенов и хранятся в микродолларах,
   чтобы вся дальнейшая арифметика оставалась целочисленной.
   Ключи — ТОЛЬКО публичные идентификаторы: внутренние имена моделей апстрима
   наружу не выходят никогда.
   ============================================================================ */
export const MODEL_PRICING = {
  dynatos: {
    label: 'Dynatos',
    inputUsdPerMillion: '0.60',
    outputUsdPerMillion: '7.00'
  },
  adanatos: {
    label: 'Adanatos',
    inputUsdPerMillion: '0.50',
    outputUsdPerMillion: '5.00'
  }
};

export const PUBLIC_MODEL_IDS = Object.keys(MODEL_PRICING);

/* Тариф в микродолларах за миллион токенов. */
export function modelPricing(publicModel) {
  const id = String(publicModel || '').trim().toLowerCase();
  const row = MODEL_PRICING[id];
  if (!row) return null;
  return {
    id,
    label: row.label,
    inputMicroUsdPerMillion: decimalToScaled(row.inputUsdPerMillion, 6),
    outputMicroUsdPerMillion: decimalToScaled(row.outputUsdPerMillion, 6),
    inputUsdPerMillion: row.inputUsdPerMillion,
    outputUsdPerMillion: row.outputUsdPerMillion
  };
}

/* ============================================================================
   СТОИМОСТЬ ЗАПРОСА В МИКРОРУБЛЯХ.
     µ₽ = токены × µUSD_за_1M × µ₽_за_USD / 1e12
   Сначала складываем числители, потом одно деление с округлением ВВЕРХ —
   так мы не спишем меньше фактической стоимости, и погрешность не превышает
   1 µ₽ (одна десятитысячная копейки) на весь запрос.

   Проверка на контрольном примере: 1 000 000 output-токенов Dynatos при курсе
   95 ₽/$ → 1e6 × 7e6 × 95e6 / 1e12 = 665 000 000 µ₽ = ровно 665,00 ₽.
   ============================================================================ */
export function usageCostMicroRubles(publicModel, inputTokens, outputTokens) {
  const pricing = modelPricing(publicModel);
  if (!pricing) return null;
  const inTok = toTokenCount(inputTokens);
  const outTok = toTokenCount(outputTokens);
  const rate = usdRateMicroRubles();
  const numerator =
    inTok * pricing.inputMicroUsdPerMillion * rate +
    outTok * pricing.outputMicroUsdPerMillion * rate;
  if (numerator <= 0n) return 0n;
  return (numerator + COST_DIVISOR - 1n) / COST_DIVISOR;
}

function toTokenCount(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.trunc(n));
}

/* Грубая оценка стоимости ДО запроса — для проверки баланса на входе.
   Считаем по выходному (дорогому) тарифу с запасом: если денег не хватает
   даже на пессимистичную оценку, запрос до модели не доходит. */
export function estimateCostMicroRubles(publicModel, inputTokens, maxOutputTokens) {
  const out = toTokenCount(maxOutputTokens);
  return usageCostMicroRubles(publicModel, inputTokens, out > 0n ? out : 1024n);
}

/* ============================================================================
   PRO-ПОДПИСКА.
   Цена не менялась и меняться не должна — 299 ₽ в месяц.
   ============================================================================ */
export const PRO_PLAN = {
  priceRublesString: '299.00',
  periodDays: 30,
  description: 'Подписка HarmonyAI Pro на 30 дней'
};

export function proPriceKopecks() {
  const fromEnv = rublesStringToKopecks(String(process.env.PRO_PRICE_RUB || '').trim());
  return fromEnv && fromEnv > 0n ? fromEnv : rublesStringToKopecks(PRO_PLAN.priceRublesString);
}

/* ============================================================================
   ЛИМИТЫ ПОПОЛНЕНИЯ БАЛАНСА API.
   Фронтенд присылает ТОЛЬКО сумму в рублях; сервер сам решает, допустима ли
   она, и сам начисляет баланс. Никаких «кредитов» от клиента.
   ============================================================================ */
export const TOPUP_LIMITS = {
  minRublesString: '100.00',
  maxRublesString: '100000.00',
  presetRubles: [500, 1000, 2500, 5000]
};

export function topupMinKopecks() {
  const fromEnv = rublesStringToKopecks(String(process.env.API_TOPUP_MIN_RUB || '').trim());
  return fromEnv && fromEnv > 0n ? fromEnv : rublesStringToKopecks(TOPUP_LIMITS.minRublesString);
}

export function topupMaxKopecks() {
  const fromEnv = rublesStringToKopecks(String(process.env.API_TOPUP_MAX_RUB || '').trim());
  return fromEnv && fromEnv > 0n ? fromEnv : rublesStringToKopecks(TOPUP_LIMITS.maxRublesString);
}

/* Проверка суммы пополнения. Принимает и число, и строку — но всегда
   превращает во целые копейки и требует, чтобы дробная часть была не мельче
   копейки. Возвращает { ok, kopecks, error }. */
export function validateTopupAmount(amount) {
  const raw = typeof amount === 'number'
    ? (Number.isFinite(amount) ? amount.toFixed(2) : '')
    : String(amount == null ? '' : amount).trim();

  const kopecks = rublesStringToKopecks(raw);
  if (kopecks === null) {
    return { ok: false, kopecks: null, error: 'Некорректная сумма' };
  }
  if (kopecks <= 0n) {
    return { ok: false, kopecks: null, error: 'Сумма должна быть больше нуля' };
  }
  const min = topupMinKopecks();
  const max = topupMaxKopecks();
  if (kopecks < min) {
    return { ok: false, kopecks: null, error: `Минимальная сумма пополнения — ${kopecksToRublesString(min)} ₽` };
  }
  if (kopecks > max) {
    return { ok: false, kopecks: null, error: `Максимальная сумма пополнения — ${kopecksToRublesString(max)} ₽` };
  }
  return { ok: true, kopecks, error: null };
}

/* ============================================================================
   ФОРМАТИРОВАНИЕ ДЛЯ ИНТЕРФЕЙСА.
   ============================================================================ */

/* Микрорубли → «500,00 ₽» (без знака валюты, знак добавляет вызывающий).
   Микрорубль — это масштаб 1e6, поэтому чтобы показать N знаков после запятой,
   делим на 10^(6-N) и округляем к ближайшему. */
export function formatMicroRubles(micro, decimals = 2) {
  const places = Math.min(6, Math.max(0, Math.trunc(Number(decimals) || 0)));
  const m = BigInt(micro || 0n);
  const negative = m < 0n;
  const abs = negative ? -m : m;
  const divisor = 10n ** BigInt(6 - places);
  const rounded = (abs + divisor / 2n) / divisor;   // округление к ближайшему
  const text = scaledToDecimal(rounded, places).replace('.', ',');
  return (negative ? '−' : '') + text;
}

/* Публичная выжимка тарифов для страницы документации и /api/dashboard.
   Отдаём и доллары (как в тарифной сетке), и рубли по текущему курсу. */
export function publicPricingTable() {
  const rate = usdRateMicroRubles();
  return {
    usdRubRate: usdRubRateString(),
    proPriceRub: kopecksToRublesString(proPriceKopecks()),
    topup: {
      minRub: kopecksToRublesString(topupMinKopecks()),
      maxRub: kopecksToRublesString(topupMaxKopecks()),
      presets: TOPUP_LIMITS.presetRubles
    },
    models: PUBLIC_MODEL_IDS.map(id => {
      const p = modelPricing(id);
      return {
        id,
        label: p.label,
        inputUsdPerMillion: p.inputUsdPerMillion,
        outputUsdPerMillion: p.outputUsdPerMillion,
        inputRubPerMillion: formatMicroRubles((p.inputMicroUsdPerMillion * rate) / 1000000n),
        outputRubPerMillion: formatMicroRubles((p.outputMicroUsdPerMillion * rate) / 1000000n)
      };
    })
  };
}
