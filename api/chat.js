export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'GEMINI_API_KEY не настроен в Vercel' } });
  }

  try {
    const { messages } = req.body;

    let systemText = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText = typeof msg.content === 'string' ? msg.content : '';
        continue;
      }
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text') {
            parts.push({ text: item.text });
          } else if (item.type === 'image_url') {
            const url = item.image_url.url;
            const match = url.match(/^data:(.+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          }
        }
      }
      contents.push({ role, parts });
    }

    const body = { contents };
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    if (data.error) {
      return res.status(response.status).json({ error: { message: data.error.message } });
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Нет ответа';
    res.status(200).json({ choices: [{ message: { content: replyText } }] });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
}
