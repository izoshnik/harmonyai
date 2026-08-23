/* ============================================================================
   МОСТ «ANTHROPIC MESSAGES API» ⇄ «OPENAI CHAT COMPLETIONS».

   ЗАЧЕМ.
   Наружу шлюз HarmonyAI говорит на формате Anthropic Messages — именно его
   ждут Claude Code, Cline, Roo Code, OpenCode и другие популярные клиенты.
   Внутри у нас OpenAI-совместимый апстрим. Этот файл переводит запрос в одну
   сторону и ответ (в том числе поток) в другую.

   ЧТО ЗДЕСЬ ВАЖНО.

   1. НАРУЖУ НЕ УТЕКАЕТ НИЧЕГО ВНУТРЕННЕГО. В ответе поле model — это всегда
      публичный id (dynatos / adanatos). Имя модели апстрима, адрес апстрима и
      его ключ не попадают ни в ответ, ни в текст ошибки.

   2. ПОТОК — НАСТОЯЩИЙ. Мы не собираем ответ модели целиком, чтобы потом
      отдать одним куском: каждый чанк апстрима сразу превращается в
      content_block_delta. Иначе Claude Code показывал бы пустой экран
      минуту, а на длинных ответах отваливался по таймауту.

   3. PING ОБЯЗАТЕЛЕН. Клиенты Anthropic рвут соединение после ~300 секунд
      тишины. Пока модель думает и не отдала ни одного токена, мы каждые 15
      секунд отправляем event: ping — это часть протокола, а не костыль.

   4. THINKING НЕ ПРОБРАСЫВАЕТСЯ ДОСЛОВНО. Клиент может прислать
      thinking:{type:'enabled',budget_tokens:N}. Мы переводим это в
      reasoning_effort апстрима, но скрытую цепочку рассуждений модели наружу
      не отдаём — только текстовые блоки ответа.
   ============================================================================ */

import { randomBytes } from 'node:crypto';

/* ============================================================================
   ИДЕНТИФИКАТОРЫ.
   Форма msg_/toolu_ — часть публичного контракта Anthropic: клиенты по ней
   валидируют ответ и связывают tool_use с tool_result.
   ============================================================================ */
export function newMessageId() {
  return 'msg_' + randomBytes(12).toString('hex');
}

function newToolUseId() {
  return 'toolu_' + randomBytes(12).toString('hex');
}

/* ============================================================================
   ОШИБКИ В ФОРМАТЕ ANTHROPIC.
   Клиенты разбирают именно эту структуру, поэтому свои сообщения об ошибках
   мы тоже оформляем так. Текст всегда наш собственный: сообщение апстрима
   может содержать имя внутренней модели.
   ============================================================================ */
export const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'invalid_request_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  529: 'overloaded_error'
};

export function anthropicError(status, message, type) {
  return {
    type: 'error',
    error: {
      type: type || ERROR_TYPES[status] || 'api_error',
      message: String(message || 'Ошибка шлюза')
    }
  };
}

/* ============================================================================
   ОЦЕНКА ЧИСЛА ТОКЕНОВ.

   Апстрим не отдаёт токенизатор, а тянуть tiktoken нельзя: в проекте ноль
   npm-зависимостей. Поэтому считаем сами, и считаем честно — это оценка, а не
   выдуманное число, и она так и описана в документации.

   Модель оценки: латиница ≈ 4 знака на токен, кириллица ≈ 2.2 (в BPE-словарях
   моделей русские слова режутся мельче), цифры и пунктуация ≈ 2.5. Плюс
   постоянные накладные на каждое сообщение (роль, разделители) и на схемы
   инструментов. На реальных диалогах даёт расхождение в пределах ~10%.

   Оценка используется ТОЛЬКО для:
     • ответа /v1/messages/count_tokens;
     • проверки баланса ДО запроса;
     • страховки, если апстрим не вернул usage.
   Списание всегда идёт по фактическому usage апстрима, когда он есть.
   ============================================================================ */
export function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cyrillic = 0;
  let latin = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0500 && code <= 0x052f)) cyrillic++;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin++;
    else other++;
  }
  const tokens = cyrillic / 2.2 + latin / 4 + other / 2.5;
  return Math.max(1, Math.ceil(tokens));
}

/* Токены одного блока контента. Картинки считаем по площади: примерная
   формула Anthropic — (ширина × высота) / 750. Размеров у base64 мы не знаем,
   поэтому берём консервативную константу для типичного скриншота. */
function estimateBlockTokens(block) {
  if (typeof block === 'string') return estimateTextTokens(block);
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'image':
      return 1600;
    case 'document':
      return 2000;
    case 'thinking':
      return estimateTextTokens(block.thinking);
    case 'tool_use':
      return estimateTextTokens(block.name) + estimateTextTokens(safeJson(block.input)) + 8;
    case 'tool_result':
      return estimateContentTokens(block.content) + 8;
    default:
      return estimateTextTokens(safeJson(block));
  }
}

function estimateContentTokens(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) total += estimateBlockTokens(block);
    return total;
  }
  return estimateBlockTokens(content);
}

function safeJson(value) {
  try { return JSON.stringify(value == null ? '' : value); } catch (e) { return ''; }
}

/* Полная оценка входа запроса: система + сообщения + описания инструментов. */
export function estimateRequestTokens(body) {
  let total = 0;
  total += estimateContentTokens(body?.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    total += 4;                                   // накладные на роль и разделители
    total += estimateContentTokens(message?.content);
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    total += estimateTextTokens(tool?.name) + estimateTextTokens(tool?.description);
    total += estimateTextTokens(safeJson(tool?.input_schema)) + 10;
  }
  return total;
}

/* ============================================================================
   ВАЛИДАЦИЯ ЗАПРОСА.
   Проверяем ровно то, что требует контракт Anthropic, и ничего лишнего:
   лишняя строгость сломает клиентов, которые присылают свои расширения.
   ============================================================================ */
export function validateMessagesRequest(body) {
  if (!body || typeof body !== 'object') {
    return 'Тело запроса должно быть JSON-объектом';
  }
  if (!body.model || typeof body.model !== 'string') {
    return 'Поле model обязательно';
  }
  const maxTokens = Number(body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return 'Поле max_tokens обязательно и должно быть положительным числом';
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'Поле messages обязательно и не может быть пустым';
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') return 'Каждый элемент messages должен быть объектом';
    if (message.role !== 'user' && message.role !== 'assistant') {
      return 'Роль сообщения должна быть user или assistant';
    }
    if (message.content == null) return 'У сообщения отсутствует content';
  }
  return null;
}

/* ============================================================================
   ПЕРЕВОД ЗАПРОСА: ANTHROPIC → OPENAI.
   ============================================================================ */

/* Anthropic-блоки контента → части OpenAI. Возвращает { parts, toolCalls,
   toolResults }: tool_result в формате OpenAI живёт отдельным сообщением с
   ролью tool, поэтому его нельзя оставить внутри user-сообщения. */
function convertContentBlocks(content) {
  const parts = [];
  const toolCalls = [];
  const toolResults = [];

  if (content == null) return { parts, toolCalls, toolResults };
  if (typeof content === 'string') {
    if (content) parts.push({ type: 'text', text: content });
    return { parts, toolCalls, toolResults };
  }

  const blocks = Array.isArray(content) ? content : [content];
  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: 'text', text: block });
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: String(block.text) });
      continue;
    }

    if (block.type === 'image') {
      const source = block.source || {};
      if (source.type === 'base64' && source.data) {
        const media = String(source.media_type || 'image/png');
        parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
      } else if (source.type === 'url' && source.url) {
        parts.push({ type: 'image_url', image_url: { url: String(source.url) } });
      }
      continue;
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || newToolUseId()),
        type: 'function',
        function: {
          name: String(block.name || ''),
          arguments: safeJson(block.input == null ? {} : block.input)
        }
      });
      continue;
    }

    if (block.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: String(block.tool_use_id || ''),
        content: flattenToolResult(block.content, block.is_error)
      });
      continue;
    }

    /* thinking / redacted_thinking из истории наружу не пробрасываем: это
       внутренняя цепочка рассуждений, апстрим её всё равно не примет. */
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;

    // Незнакомый тип блока сериализуем как текст — лучше, чем потерять данные.
    const dump = safeJson(block);
    if (dump && dump !== '{}') parts.push({ type: 'text', text: dump });
  }

  return { parts, toolCalls, toolResults };
}

/* Содержимое tool_result у Anthropic — массив блоков, у OpenAI — строка. */
function flattenToolResult(content, isError) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return String(block.text || '');
        return safeJson(block);
      })
      .filter(Boolean)
      .join('\n');
  } else if (content != null) {
    text = safeJson(content);
  }
  if (isError && text) return `[ошибка инструмента] ${text}`;
  return text || '';
}

/* Уровень размышления апстрима из блока thinking клиента.
   budget_tokens — бюджет в токенах; переводим его в три ступени, потому что
   OpenAI-совместимый параметр дискретный. */
export function effortFromThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return '';
  if (thinking.type === 'disabled') return '';
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return 'medium';
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'medium';
  return 'high';
}

/* Главный переводчик запроса. internalModel — имя модели апстрима, оно
   приходит снаружи и в публичном ответе не появляется. */
export function anthropicToOpenAI(body, internalModel) {
  const messages = [];

  // system у Anthropic — отдельное поле, у OpenAI — первое сообщение.
  const systemText = flattenToolResult(body?.system, false);
  if (systemText) messages.push({ role: 'system', content: systemText });

  const source = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of source) {
    const { parts, toolCalls, toolResults } = convertContentBlocks(message?.content);

    /* tool_result должны идти ДО сообщения, в котором они пришли: у OpenAI это
       ответы на предыдущий tool_call ассистента. */
    for (const result of toolResults) messages.push(result);

    if (message.role === 'assistant') {
      const entry = { role: 'assistant' };
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
      entry.content = text || null;
      if (toolCalls.length) entry.tool_calls = toolCalls;
      if (entry.content || entry.tool_calls) messages.push(entry);
      continue;
    }

    if (!parts.length) continue;
    // Если в сообщении только текст — отдаём строкой: так понимают все апстримы.
    const onlyText = parts.every(p => p.type === 'text');
    messages.push({
      role: 'user',
      content: onlyText ? parts.map(p => p.text).join('') : parts
    });
  }

  const request = {
    model: internalModel,
    messages
  };

  const maxTokens = Number(body?.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.max_tokens = Math.trunc(maxTokens);

  const temperature = Number(body?.temperature);
  if (Number.isFinite(temperature)) request.temperature = temperature;

  const topP = Number(body?.top_p);
  if (Number.isFinite(topP)) request.top_p = topP;

  // top_k у OpenAI-совместимого API нет — молча опускаем, это не ошибка.

  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) {
    request.stop = body.stop_sequences.slice(0, 4).map(String);
  }

  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const functionTools = tools
    .filter(tool => tool && typeof tool === 'object' && tool.name && !String(tool.type || '').startsWith('computer'))
    .map(tool => ({
      type: 'function',
      function: {
        name: String(tool.name),
        description: String(tool.description || ''),
        parameters: tool.input_schema && typeof tool.input_schema === 'object'
          ? tool.input_schema
          : { type: 'object', properties: {} }
      }
    }));
  if (functionTools.length) {
    request.tools = functionTools;
    const choice = body?.tool_choice;
    if (choice && typeof choice === 'object') {
      if (choice.type === 'any') request.tool_choice = 'required';
      else if (choice.type === 'none') request.tool_choice = 'none';
      else if (choice.type === 'tool' && choice.name) {
        request.tool_choice = { type: 'function', function: { name: String(choice.name) } };
      } else request.tool_choice = 'auto';
    }
  }

  const effort = effortFromThinking(body?.thinking);
  if (effort) request.reasoning_effort = effort;

  return request;
}

/* ============================================================================
   ПЕРЕВОД ОТВЕТА: OPENAI → ANTHROPIC (без потока).
   ============================================================================ */

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn'
};

export function stopReasonFor(finishReason) {
  const key = String(finishReason || '').toLowerCase();
  return STOP_REASON[key] || 'end_turn';
}

export function openAIToAnthropic(data, publicModelId, messageId) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  let text = message.content;
  if (Array.isArray(text)) text = text.map(part => part?.text || '').join('');
  if (typeof text === 'string' && text) content.push({ type: 'text', text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    let input = {};
    try { input = JSON.parse(call?.function?.arguments || '{}'); } catch (e) { input = {}; }
    content.push({
      type: 'tool_use',
      id: String(call?.id || newToolUseId()),
      name: String(call?.function?.name || ''),
      input
    });
  }

  // Пустой content недопустим по контракту — отдаём пустой текстовый блок.
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: messageId || newMessageId(),
    type: 'message',
    role: 'assistant',
    model: publicModelId,
    content,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: toInt(data?.usage?.prompt_tokens),
      output_tokens: toInt(data?.usage?.completion_tokens)
    }
  };
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/* ============================================================================
   ПОТОК: OPENAI SSE → ANTHROPIC SSE.

   Последовательность событий Anthropic жёстко задана протоколом:
     message_start
       content_block_start (index 0, text)
       content_block_delta × N
       content_block_stop
       [content_block_start/delta/stop для каждого tool_use]
     message_delta (stop_reason + usage.output_tokens)
     message_stop

   Текстовый блок открываем лениво — по первому непустому чанку. Если модель
   сразу пошла в инструмент, лишний пустой текстовый блок клиенту не нужен.
   ============================================================================ */

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeAnthropicError(res, status, message, type) {
  writeEvent(res, 'error', anthropicError(status, message, type));
}

export async function streamOpenAIAsAnthropic(options) {
  const {
    res,
    upstream,
    publicModelId,
    messageId,
    inputTokensFallback = 0,
    pingIntervalMs = 15000
  } = options;

  const id = messageId || newMessageId();
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finishReason = '';

  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: publicModelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokensFallback, output_tokens: 0 }
    }
  });

  /* Пинги. Клиент Anthropic обрывает соединение после долгой тишины, а модель
     на сложном запросе легко молчит минуту. Таймер сбрасывается при любой
     отправке, чтобы не мешать реальным данным. */
  let lastWriteAt = Date.now();
  const pingTimer = setInterval(() => {
    if (Date.now() - lastWriteAt < pingIntervalMs) return;
    try {
      writeEvent(res, 'ping', { type: 'ping' });
      lastWriteAt = Date.now();
    } catch (e) { /* соединение уже закрыто — остановимся ниже */ }
  }, Math.max(2000, Math.floor(pingIntervalMs / 3)));

  const emit = (event, payload) => {
    writeEvent(res, event, payload);
    lastWriteAt = Date.now();
  };

  // Состояние блоков контента.
  let nextIndex = 0;
  let textIndex = -1;
  let textOpen = false;
  let outputChars = 0;
  const toolBlocks = new Map();   // индекс tool_call апстрима → { index, id, name, argsLen }

  function openText() {
    if (textOpen) return;
    textIndex = nextIndex++;
    textOpen = true;
    emit('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' }
    });
  }

  function closeText() {
    if (!textOpen) return;
    textOpen = false;
    emit('content_block_stop', { type: 'content_block_stop', index: textIndex });
  }

  try {
    const reader = upstream.body?.getReader?.();
    if (!reader) throw new Error('Апстрим не отдал поток');
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { finished = true; break; }

        let parsed = null;
        try { parsed = JSON.parse(payload); } catch (e) { continue; }
        if (!parsed || typeof parsed !== 'object') continue;

        if (parsed.usage) {
          usage = {
            input_tokens: toInt(parsed.usage.prompt_tokens) || usage.input_tokens,
            output_tokens: toInt(parsed.usage.completion_tokens) || usage.output_tokens
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};

        /* Скрытая цепочка рассуждений апстрима наружу не идёт: клиент её не
           запрашивал в виде thinking-блока, а пересылать её дословно нельзя. */

        let text = delta.content;
        if (Array.isArray(text)) text = text.map(part => part?.text || '').join('');
        if (typeof text === 'string' && text) {
          openText();
          outputChars += text.length;
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text }
          });
        }

        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const call of calls) {
          const slot = Number.isFinite(Number(call?.index)) ? Number(call.index) : 0;
          let block = toolBlocks.get(slot);
          if (!block) {
            // Первый фрагмент инструмента: текстовый блок обязан закрыться раньше.
            closeText();
            block = {
              index: nextIndex++,
              id: String(call?.id || newToolUseId()),
              name: String(call?.function?.name || '')
            };
            toolBlocks.set(slot, block);
            emit('content_block_start', {
              type: 'content_block_start',
              index: block.index,
              content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
            });
          }
          const fragment = call?.function?.arguments;
          if (typeof fragment === 'string' && fragment) {
            outputChars += fragment.length;
            emit('content_block_delta', {
              type: 'content_block_delta',
              index: block.index,
              delta: { type: 'input_json_delta', partial_json: fragment }
            });
          }
        }
      }
    }
  } finally {
    clearInterval(pingTimer);
  }

  closeText();
  for (const block of toolBlocks.values()) {
    emit('content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  /* Апстрим не всегда возвращает usage в потоке. Тогда берём собственную
     оценку по фактически отданному объёму текста — она посчитана на сервере,
     а не прислана клиентом. 3.2 знака на токен — середина между латиницей
     (≈4) и кириллицей (≈2.2), потому что язык ответа заранее неизвестен. */
  if (!usage.input_tokens) usage.input_tokens = inputTokensFallback;
  if (!usage.output_tokens) usage.output_tokens = Math.max(1, Math.ceil(outputChars / 3.2));

  const stopReason = toolBlocks.size ? 'tool_use' : stopReasonFor(finishReason);

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens }
  });
  emit('message_stop', { type: 'message_stop' });

  return { usage, stopReason, messageId: id };
}
