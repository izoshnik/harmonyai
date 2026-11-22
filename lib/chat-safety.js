const OVERRIDE = [
  /(?:игнорируй|забудь|отмени|отключи|обойди)\s+(?:(?:все|любые)\s+)?(?:предыдущ[\p{L}]*\s+|прошл[\p{L}]*\s+|системн[\p{L}]*\s+|сво[\p{L}]*\s+)?(?:инструкци|правил|ограничени|защит|промпт)/iu,
  /\b(?:ignore|disregard|override|forget|bypass)\s+(?:(?:all|the|your)\s+)*(?:previous\s+|prior\s+|above\s+|system\s+|safety\s+)?(?:instructions?|rules?|polic(?:y|ies)|safeguards?|restrictions?)\b/iu,
  /(?:покажи|выведи|раскрой|повтори|скопируй|напечатай)\s+(?:(?:свой|твой|весь)\s+)?(?:скрыт[\p{L}]*|системн[\p{L}]*)\s+(?:промпт|инструкци)/iu,
  /\b(?:show|reveal|print|repeat|dump|disclose)\s+(?:(?:me|the|your|original|hidden)\s+)*(?:system|developer)\s+(?:prompt|instructions?)\b/iu,
  /(?:включи|активируй|перейди\s+в)\s+режим\s+(?:без\s+(?:ограничени|правил|цензур)|dan\b|jailbreak\b)/iu,
  /\b(?:enable|activate|enter)\s+(?:the\s+)?(?:unrestricted|jailbreak|dan)\s+mode\b/iu,
  /(?:<\|(?:im_start|start_header_id)\|>\s*(?:system|developer)\b|^\[(?:system|developer)\]\s*[:\n])/iu
];
const MALWARE = /(?:^|[^\p{L}\p{N}])(?:ратк[\p{L}]*|кейлоггер[\p{L}]*|руткит[\p{L}]*|\bransomware\b|\bkeylogger\b|\brootkit\b|\bmalware\b|\bremote\s+access\s+trojan\b|троян[\p{L}]*|шифровальщик[\p{L}]*|стилер[\p{L}]*)(?![\p{L}\p{N}])/iu;
const MAKE = /созда[йть]|сдела[йть]|напиши|напечатай|сгенерируй|реализуй|допиши|собери|\b(?:create|write|make|generate|implement|build|finish|develop)\b/iu;
const DEFENSE = /(?:обнаружени[ея]|детектор|поиск признаков|отчёт о|статью о|как (?:обнаружить|удалить|защититься)|\b(?:detect(?:ion|or)?|scanner|defend(?:ing)?|remove|report on|article on)\b)/iu;
const CONTINUE = /^(?:(?:да[, ]+)?(?:продолжи|допиши|законч[иь]|давай дальше|continue|finish)(?:[.!?\s]|$))/iu;

export const GUARD_REPLIES = {
  override: 'Я не могу отключить правила HarmonyAI или раскрыть скрытые инструкции. Напиши, с какой задачей нужна помощь.',
  malware: 'Я не могу создавать вредоносное ПО или инструменты скрытого доступа. Могу помочь с обнаружением, защитой или настройкой легитимного удалённого доступа.'
};

export function chatGuardReason(input) {
  const normalized = String(input || '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24000);
  if (MAKE.test(normalized)) {
    const target = MALWARE.exec(normalized) || /\bRAT\b.{0,35}(?:C\+\+|\b(?:reverse|payload|trojan|malware)\b)|(?:C\+\+|\b(?:payload|trojan|malware)\b).{0,35}\bRAT\b/i.exec(normalized);
    if (target && !DEFENSE.test(normalized.slice(0, target.index))) return 'malware';
  }
  if (OVERRIDE.some(pattern => pattern.test(normalized))) return 'override';
  return '';
}

export function latestUserInstruction(messages) {
  return instruction(messages.findLast(item => item?.role === 'user'));
}

function instruction(message) {
  const raw = Array.isArray(message?.content)
    ? message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n')
    : message?.content;
  return String(raw || '').split(/\[(?:ФАЙЛ\s+\d+:|ДОСЛОВНАЯ РАСШИФРОВКА)/iu, 1)[0];
}

export function conversationGuardReason(messages) {
  const current = latestUserInstruction(messages);
  const reason = chatGuardReason(current);
  if (reason || !CONTINUE.test(current.trim())) return reason;
  const preceding = messages.filter(item => item?.role === 'user').slice(0, -1);
  return chatGuardReason(instruction(preceding.findLast(item => !CONTINUE.test(instruction(item).trim()))));
}

export function withUntrustedChatContext(messages, sources) {
  const sanitized = [];
  let refused;
  for (const message of messages) {
    if (message?.role === 'user') {
      refused = chatGuardReason(instruction(message));
      if (!refused) sanitized.push(message);
    } else if (message?.role === 'assistant' && !refused) {
      sanitized.push(message);
    }
  }
  const last = sanitized.findLastIndex(message => message.role === 'user');
  if (last < 0) return sanitized;
  const context = Object.fromEntries(Object.entries(sources).filter(([, value]) => typeof value === 'string' && value));
  if (!Object.keys(context).length) return sanitized;
  const original = sanitized[last].content;
  const data = 'Справочные данные (JSON)\n' + JSON.stringify(context);
  sanitized[last] = {
    role: 'user',
    content: Array.isArray(original) ? [{ type: 'text', text: data }, ...original] :
      data + '\n\nЗапрос пользователя:\n' + String(original || '')
  };
  return sanitized;
}
