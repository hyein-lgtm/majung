// 마중 · 오행 리포트 — 정적 서빙 + AI 프록시 (Railway)
// /api 로 들어온 요청을 ANTHROPIC_API_KEY를 붙여 Anthropic Messages API로 중계한다.
// 키는 코드가 아니라 Railway 환경변수(ANTHROPIC_API_KEY)에 보관한다.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── AI 프록시 ──────────────────────────────────────────────
app.post('/api', async (req, res) => {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[AI 프록시] Anthropic 오류', upstream.status, JSON.stringify(data));
    }
    res.status(upstream.status).json(data); // Anthropic 응답을 그대로 전달
  } catch (e) {
    console.error('[AI 프록시] 호출 실패', String(e));
    res.status(502).json({ error: 'proxy_failed', detail: String(e) });
  }
});

// ── 정적 파일 ──────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('마중 listening on ' + PORT));
