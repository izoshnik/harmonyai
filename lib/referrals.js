/* ============================================================================
   РЕФЕРАЛЬНАЯ ПРОГРАММА И ПРОДЛЕНИЕ PRO.

   Правила:
     • пригласить могут подписчики Pro, которые хотя бы раз ОПЛАЧИВАЛИ подписку
       (и сотрудники: developer / admin / moderator) — не больше 2 приглашений
       на аккаунт за всё время;
     • приглашённый получает Pro на 3 дня сразу и скидку 10 % на первый месяц
       (на недельную подписку скидка не действует — см. lib/pricing.js);
     • активировать можно одно приглашение и только если у аккаунта ещё не было
       оплаченного Pro и нет активного Pro сейчас; своё приглашение — нельзя.

   Хранилище — таблица public.referral_invites (supabase/2026-10-22-referrals.sql).
   Пока таблицы нет, все функции честно отвечают «программа недоступна» и ничего
   не ломают: платежи, чат и настройки работают как раньше.

   Доступ к таблице — только service-role (RLS включён, политик нет): клиент не
   может ни прочитать чужие коды, ни выдать себе пробный Pro.
   ============================================================================ */
import crypto from 'node:crypto';
import { supabaseRest, hasProAccess, isUnlimitedApiRole } from './auth.js';
import { siteUrl } from './origin.js';
import { REFERRAL_DISCOUNT_PERCENT } from './pricing.js';

export const INVITES_PER_USER = 2;
export const TRIAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function normalizeInviteCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{8,16}$/.test(code) ? code : '';
}
function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
export function inviteUrl(code) {
  return `${siteUrl()}/chat?invite=${encodeURIComponent(code)}`;
}

/* Таблица ещё не создана: PostgREST отвечает 404/PGRST205 или 42P01. */
function isMissingTable(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return error?.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(text);
}
export class ReferralUnavailableError extends Error {}

async function invites(path, init) {
  try {
    return await supabaseRest('/rest/v1/referral_invites' + path, init);
  } catch (error) {
    if (isMissingTable(error)) throw new ReferralUnavailableError('Реферальная программа скоро будет доступна');
    throw error;
  }
}

/* ---------------------------------------------------------------- профиль */
export async function readProfile(userId) {
  const rows = await supabaseRest(
    `/rest/v1/profiles?select=id,role,plan,plan_expires_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

/* Был ли у аккаунта хоть один зачисленный платёж за подписку. */
export async function hasPaidSubscription(userId) {
  const rows = await supabaseRest(
    `/rest/v1/payments?select=id&user_id=eq.${encodeURIComponent(userId)}&type=eq.subscription&credited=eq.true&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) && rows.length > 0;
}

/* ============================================================================
   ПРОДЛЕНИЕ: Pro до max(сейчас, текущий срок) + days.
   Бессрочный Pro (plan_expires_at = null) не трогаем — иначе покупка или
   приглашение сократили бы доступ, выданный навсегда.
   ============================================================================ */
export function extendedExpiry(profile, days, now = Date.now()) {
  const current = profile && String(profile.plan || '').toLowerCase() === 'pro' && profile.plan_expires_at
    ? Date.parse(profile.plan_expires_at) : 0;
  const base = Math.max(now, Number.isFinite(current) ? current : 0);
  return new Date(base + days * DAY_MS).toISOString();
}
export function isPerpetualPro(profile) {
  return Boolean(profile && String(profile.plan || '').toLowerCase() === 'pro' && !profile.plan_expires_at);
}
export async function setProExpiry(userId, expiresAtIso) {
  await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ plan: 'pro', plan_expires_at: expiresAtIso, updated_at: new Date().toISOString() })
  });
}

/* ============================================================================
   СОСТОЯНИЕ ДЛЯ НАСТРОЕК: свои приглашения, право приглашать, своя скидка.
   ============================================================================ */
function publicInvite(row) {
  return {
    code: row.code,
    url: inviteUrl(row.code),
    createdAt: row.created_at || null,
    used: Boolean(row.redeemed_by),
    usedAt: row.redeemed_at || null
  };
}

export async function referralState(userId) {
  const profile = await readProfile(userId).catch(() => null);
  let rows;
  let mine = null;
  try {
    [rows, mine] = await Promise.all([
      invites(`?select=code,created_at,redeemed_by,redeemed_at&inviter_id=eq.${encodeURIComponent(userId)}&order=created_at.asc&limit=10`, { method: 'GET' }),
      invites(`?select=code,trial_until,discount_used_at&redeemed_by=eq.${encodeURIComponent(userId)}&limit=1`, { method: 'GET' })
    ]);
  } catch (error) {
    if (error instanceof ReferralUnavailableError) return { available: false, message: error.message };
    throw error;
  }
  const list = (Array.isArray(rows) ? rows : []).map(publicInvite);
  const staff = isUnlimitedApiRole(profile?.role);
  const canInvite = hasProAccess(profile) && (staff || await hasPaidSubscription(userId).catch(() => false));
  const redeemed = Array.isArray(mine) ? mine[0] : null;
  const discount = redeemed && !redeemed.discount_used_at && !(await hasPaidMonth(userId));
  return {
    available: true,
    canInvite,
    limit: INVITES_PER_USER,
    left: Math.max(0, INVITES_PER_USER - list.length),
    invites: list,
    trialDays: TRIAL_DAYS,
    discountPercent: REFERRAL_DISCOUNT_PERCENT,
    redeemed: Boolean(redeemed),
    discountAvailable: Boolean(discount)
  };
}

export async function createInvite(userId) {
  const profile = await readProfile(userId);
  const staff = isUnlimitedApiRole(profile?.role);
  if (!hasProAccess(profile)) return { error: 'Приглашать друзей могут подписчики Pro' };
  if (!staff && !(await hasPaidSubscription(userId))) return { error: 'Приглашения откроются после первой оплаты Pro' };
  const existing = await invites(`?select=code&inviter_id=eq.${encodeURIComponent(userId)}&limit=10`, { method: 'GET' });
  if (Array.isArray(existing) && existing.length >= INVITES_PER_USER) {
    return { error: `Можно отправить не больше ${INVITES_PER_USER} приглашений` };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    try {
      const rows = await invites('', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{ code, inviter_id: userId }])
      });
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row) return { invite: publicInvite(row) };
    } catch (error) {
      if (error instanceof ReferralUnavailableError) throw error;
      if (/duplicate|23505/i.test(`${error?.code} ${error?.message}`)) continue; // совпал код — ещё раз
      throw error;
    }
  }
  return { error: 'Не удалось создать приглашение, попробуйте ещё раз' };
}

/* ============================================================================
   АКТИВАЦИЯ ПРИГЛАШЕНИЯ: Pro на 3 дня + право на скидку 10 % на первый месяц.
   Захват кода атомарный: PATCH с условием redeemed_by IS NULL вернёт строку
   только одному из двух одновременных запросов; повторная активация тем же
   аккаунтом упирается в UNIQUE(redeemed_by).
   ============================================================================ */
export async function redeemInvite(userId, rawCode) {
  const code = normalizeInviteCode(rawCode);
  if (!code) return { error: 'Неверный код приглашения' };
  const found = await invites(`?select=code,inviter_id,redeemed_by&code=eq.${encodeURIComponent(code)}&limit=1`, { method: 'GET' });
  const invite = Array.isArray(found) ? found[0] : null;
  if (!invite) return { error: 'Приглашение не найдено' };
  if (invite.inviter_id === userId) return { error: 'Своё приглашение активировать нельзя' };
  if (invite.redeemed_by) return { error: invite.redeemed_by === userId ? 'Вы уже активировали это приглашение' : 'Это приглашение уже использовано' };

  const already = await invites(`?select=code&redeemed_by=eq.${encodeURIComponent(userId)}&limit=1`, { method: 'GET' });
  if (Array.isArray(already) && already.length) return { error: 'Вы уже активировали приглашение' };

  const profile = await readProfile(userId);
  if (hasProAccess(profile)) return { error: 'У вас уже есть Pro — приглашение для тех, у кого его ещё не было' };
  if (await hasPaidSubscription(userId)) return { error: 'Приглашение действует только для новых подписчиков Pro' };

  const trialUntil = extendedExpiry(profile, TRIAL_DAYS);
  let rows;
  try {
    rows = await invites(`?code=eq.${encodeURIComponent(code)}&redeemed_by=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ redeemed_by: userId, redeemed_at: new Date().toISOString(), trial_until: trialUntil })
    });
  } catch (error) {
    if (error instanceof ReferralUnavailableError) throw error;
    if (/duplicate|23505/i.test(`${error?.code} ${error?.message}`)) return { error: 'Вы уже активировали приглашение' };
    throw error;
  }
  if (!Array.isArray(rows) || !rows.length) return { error: 'Это приглашение уже использовано' };
  await setProExpiry(userId, trialUntil);
  return { ok: true, trialUntil, trialDays: TRIAL_DAYS, discountPercent: REFERRAL_DISCOUNT_PERCENT };
}

/* ============================================================================
   СКИДКА 10 % НА ПЕРВЫЙ МЕСЯЦ.
   Действует, пока у приглашённого нет ни одного оплаченного МЕСЯЦА и скидка
   не отмечена использованной. Отмечается вебхуком после успешной оплаты.
   ============================================================================ */
async function hasPaidMonth(userId) {
  try {
    const rows = await supabaseRest(
      `/rest/v1/payments?select=description&user_id=eq.${encodeURIComponent(userId)}&type=eq.subscription&credited=eq.true&limit=20`,
      { method: 'GET' }
    );
    return (Array.isArray(rows) ? rows : []).some((r) => !/7 дней/.test(String(r.description || '')));
  } catch (e) {
    return true; // не знаем — скидку не даём (fail-closed: это деньги)
  }
}

export async function referralDiscountCode(userId) {
  try {
    const rows = await invites(`?select=code,discount_used_at&redeemed_by=eq.${encodeURIComponent(userId)}&limit=1`, { method: 'GET' });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.discount_used_at) return '';
    if (await hasPaidMonth(userId)) return '';
    return row.code;
  } catch (e) {
    return ''; // таблицы нет или сбой — без скидки
  }
}

export async function markDiscountUsed(userId, code, paymentId) {
  const c = normalizeInviteCode(code);
  if (!c || !userId) return;
  try {
    await invites(`?code=eq.${encodeURIComponent(c)}&redeemed_by=eq.${encodeURIComponent(userId)}&discount_used_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ discount_used_at: new Date().toISOString(), discount_payment_id: String(paymentId || '') })
    });
  } catch (e) {
    console.warn('[referrals] не удалось отметить скидку использованной:', String(e?.message || e).slice(0, 200));
  }
}
