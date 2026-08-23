export const config = {
  maxDuration: 30
};

const ALLOWED_ROLES = new Set(['developer', 'moderator', 'admin']);

function buildSupabaseHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

async function supabaseRequest(path, init = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const headers = { ...buildSupabaseHeaders(), ...(init.headers || {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || data?.error || `Supabase error ${response.status}`);
  }
  return data;
}

async function fetchProfile(userId) {
  if (!userId) return null;
  const rows = await supabaseRequest(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,nickname,role&limit=1`
  );
  return rows?.[0] || null;
}

// Сообщения из «Сообщить о проблеме в приложении» доступны только ролям
// developer / moderator / admin — это проверяется на сервере по userId,
// который передаёт клиент (тот же паттерн доверия, что и в api/chat.js).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Метод не поддерживается' } });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: { message: 'SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не настроены' } });
  }

  try {
    const userId = String(req.query?.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: { message: 'Не передан userId' } });
    }

    const profile = await fetchProfile(userId);
    const role = profile?.role || 'user';
    if (!ALLOWED_ROLES.has(role)) {
      return res.status(403).json({ error: { message: 'Доступ только для developer/moderator/admin' } });
    }

    const reports = await supabaseRequest(
      '/rest/v1/app_reports?select=id,user_id,email,message,created_at&order=created_at.desc&limit=300'
    );

    // Подтягиваем имена авторов (если есть профиль) — отдельным запросом, без JOIN на REST API.
    const userIds = Array.from(new Set((reports || []).map(r => r.user_id).filter(Boolean)));
    let nicknames = {};
    if (userIds.length) {
      const idsParam = userIds.map(id => `"${id}"`).join(',');
      const profiles = await supabaseRequest(
        `/rest/v1/profiles?id=in.(${idsParam})&select=id,nickname`
      );
      nicknames = Object.fromEntries((profiles || []).map(p => [p.id, p.nickname || '']));
    }

    const result = (reports || []).map(r => ({
      id: r.id,
      email: r.email || '',
      name: nicknames[r.user_id] || '',
      message: r.message || '',
      createdAt: r.created_at
    }));

    return res.status(200).json({ reports: result });
  } catch (error) {
    return res.status(500).json({ error: { message: error?.message || 'Внутренняя ошибка сервера' } });
  }
}
