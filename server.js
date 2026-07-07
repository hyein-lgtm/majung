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

    // 스트리밍 요청이고 정상 응답이면 SSE를 버퍼링 없이 그대로 흘려보낸다
    if (req.body && req.body.stream && upstream.ok && upstream.body) {
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 중간 프록시 버퍼링 방지
      res.flushHeaders();
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        if (typeof res.flush === 'function') res.flush();
      }
      return res.end();
    }

    // 비스트리밍 또는 오류 응답은 JSON으로 그대로 전달
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

// ── 이미지 프록시 (cafe24 핫링크 우회) ─────────────────────
// wblbeauty 상품 썸네일은 외부 도메인에서 직접 부르면 cafe24가 막는다.
// 서버가 Referer를 wblbeauty로 붙여 대신 받아와 브라우저에 전달한다.
// 브라우저에서는 /img?u=<원본이미지주소> 형태로 호출한다.
app.get('/img', async (req, res) => {
  const u = (req.query.u || '').toString();
  if (!/^https:\/\/(www\.)?wblbeauty\.com\//i.test(u)) {
    return res.sendStatus(400); // 오픈 프록시 방지: wblbeauty 도메인만 허용
  }
  try {
    const r = await fetch(u, {
      headers: { 'Referer': 'https://www.wblbeauty.com/', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return res.sendStatus(502);
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // 하루 캐시
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('[이미지 프록시] 실패', String(e));
    res.sendStatus(502);
  }
});

// ── 궁합 링크 토큰 (메모리 임시 저장, 7일 TTL) ──────────────
// 개인정보 보호: A의 이름/생년월일은 URL·토큰에 절대 넣지 않는다.
// 서버는 오직 { 표시이름, 오행비율(5개), 관계 }만 잠깐 보관한다.
// 서버 재시작/재배포 시 메모리가 초기화되어 링크가 만료된다(MVP 허용).
const crypto = require('crypto');
const matchStore = new Map(); // token -> { voc, elems, relation, createdAt }
const MATCH_TTL = 7 * 24 * 60 * 60 * 1000; // 7일

function pruneMatch() {
  const now = Date.now();
  for (const [k, v] of matchStore) {
    if (now - v.createdAt > MATCH_TTL) matchStore.delete(k);
  }
}

app.post('/api/match/create', (req, res) => {
  try {
    const b = req.body || {};
    const voc = (b.voc || '').toString().slice(0, 24); // 표시 이름만 (최소)
    const relation = ['love', 'friend', 'family'].includes(b.relation) ? b.relation : 'friend';
    // 오행 비율: 정확히 목/화/토/금/수 5개 숫자만 허용
    const src = b.elems || {};
    const keys = ['목', '화', '토', '금', '수'];
    const elems = {};
    for (const k of keys) {
      const n = Number(src[k]);
      elems[k] = (isFinite(n) && n >= 0) ? Math.round(n * 1000) / 1000 : 0;
    }
    pruneMatch();
    const token = crypto.randomBytes(9).toString('base64url'); // 12자 내외 URL-safe
    matchStore.set(token, { voc, elems, relation, createdAt: Date.now() });
    res.json({ token });
  } catch (e) {
    console.error('[궁합] create 실패', String(e));
    res.status(400).json({ error: 'bad_request' });
  }
});

app.get('/api/match/:token', (req, res) => {
  pruneMatch();
  const rec = matchStore.get((req.params.token || '').toString());
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (Date.now() - rec.createdAt > MATCH_TTL) {
    matchStore.delete(req.params.token);
    return res.status(410).json({ error: 'expired' });
  }
  res.json({ voc: rec.voc, relation: rec.relation, elems: rec.elems });
});

// ── 정적 파일 ──────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('마중 listening on ' + PORT));
