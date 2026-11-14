// Creator Signal 后端（Cloudflare Worker，单文件）
// 作用：收到一条视频链接，取公开数据和评论，交给 Claude 逐条判断，把结果返回给网站。
// 两把密钥只存在 Cloudflare 的加密变量里，网站和访客都看不到。
//
// 需要在 Cloudflare 后台配置：
//   加密变量（Secret）：YOUTUBE_API_KEY、ANTHROPIC_API_KEY
//   KV 绑定：CACHE
//   可选普通变量：
//     USER_BUDGET_USD   每位访客的免费额度，默认 5（美元）
//     DAILY_BUDGET_USD  所有访客加起来每天最多花多少，默认 10（美元），这是保护你钱包的总闸
//     MODEL             默认 claude-sonnet-5-5
//     ALLOWED_ORIGIN    只允许哪个网址调用，多个用逗号隔开，默认不限制
//     ACCESS_PASSWORD   可选。设了就需要密码才能分析新视频；不设就是公开可用
// 访客不用登录。用访客网络地址的加密摘要来区分人，不保存原始地址。

// 给模型的说明，和 labels.py 里的 PROMPT 保持一致
const PROMPT = "You label YouTube comments left under a SPONSORED video about a video game.\nJudge only from the comment text and the video context given.\n\nReturn ONLY a JSON array. Each element is itself an array of exactly 10 values, in this order:\n[i, attitude, barrier1, barrier2, layer, competitor, ad, controversy, evidence, conf]\n\nattitude = stance toward THE GAME (not the creator):\n- \"want\": wants to play or buy, already plays and is positive, OR clearly praises the game itself (its features, look, setting, details) even without saying \"I will buy\".\n- \"hesitant\": interested but states a condition, wish, worry or reason for waiting.\n- \"critical\": negative or sceptical about the game itself.\n- \"offtopic\": about the creator, a joke, a meme, a timestamp, the video being funny. Praise for the creator or the video alone is offtopic.\n- \"unclear\": talks about the game (a neutral fact, a question, a comparison) but shows no stance.\nIf a comment both praises and lists wishes, use \"want\" when the praise dominates and nothing is stated as a condition; use \"hesitant\" when buying or liking \"depends on\" something.\n\nbarrier1 = main reason they are not playing yet. Use \"none\" unless attitude is \"hesitant\" or \"critical\".\n- \"awareness\": did not know the game or studio, or confused about what it is\n- \"theme\": setting, genre, art style or subject is not for them\n- \"skill\": too hard or complex\n- \"device\": their own PC, console or platform cannot run it; performance worries about their hardware\n- \"price\": cost, waiting for a sale, value for money\n- \"time\": too long, no time, backlog\n- \"prior\": has not played earlier games in the series\n- \"emotion\": too scary or stressful\n- \"social\": no one to play with\n- \"product\": missing features, bugs, quality, early-access state, wishes about what the game should include\n- \"loyal\": already committed to a competing game\n- \"none\"\nbarrier2 = a clearly separate second barrier, else \"none\". Do not repeat the same idea in two barriers.\n\nlayer = who the commenter is, when the text reveals it:\n- \"fan\": played earlier games in THIS series or by THIS studio\n- \"competitor\": names another game or series, or uses its vocabulary, in a way that shows they know or play it (for example \"I spent hours in CAS\", \"this is what I wanted Sims 5 to be\", \"a British Stalker\")\n- \"newcomer\": says they do not normally play this kind of game\n- \"unknown\": not revealed (most common)\ncompetitor = name of that other game, else \"\".\n\nad = reaction to the sponsorship:\n- \"accept\": explicitly fine with it or praises it\n- \"dislike\": complains about the ad, or doubts the creator's honesty because it is paid\n- \"neutral\": mentions the sponsor or sponsorship without judging it\n- \"none\": not mentioned\n\ncontroversy = 1 if the comment refers to a scandal, accusation or serious controversy about the CREATOR as a person, else 0. Jokes about in-game behaviour are 0.\n\nevidence = up to 8 words copied from the comment that drove the labels. Use \"\" when attitude is \"offtopic\".\nconf = \"h\" or \"l\". Use \"l\" for sarcasm you are unsure about, mixed signals, or text you cannot read well.\n\nSarcasm: label the real meaning. Do not invent a layer or barrier the text does not support.\n";

const BATCH = 25, MAX_COMMENTS = 300, CONCURRENCY = 6, CACHE_DAYS = 7, VERSION = 'v2';
const RESERVE_USD = 0.3;   // 开始分析前先预扣这么多，结束后按实际花费结算
const PRICE = m => /haiku/.test(m) ? [0.10, 0.50] : /opus/.test(m) ? [10, 50] : [2, 10];   // 每百万 token 的输入、输出价格（美元）
const SETS = {
  a: ['want', 'hesitant', 'critical', 'offtopic', 'unclear'],
  b: ['awareness', 'theme', 'skill', 'device', 'price', 'time', 'prior', 'emotion', 'social', 'product', 'loyal', 'none'],
  l: ['fan', 'competitor', 'newcomer', 'unknown'],
  ad: ['none', 'accept', 'neutral', 'dislike'],
};

class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }

// ---------- 平台适配器：以后加 TikTok、Twitch 只需要在这里加一项 ----------
const youtube = {
  name: 'youtube',
  id(url) {
    for (const p of [/[?&]v=([\w-]{11})/, /youtu\.be\/([\w-]{11})/, /\/shorts\/([\w-]{11})/, /\/live\/([\w-]{11})/]) { const m = String(url).match(p); if (m) return m[1]; }
    return null;
  },
  async api(env, path, params) {
    const q = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
    const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + q);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, 'youtube_error', (j.error && j.error.message) || ('YouTube ' + r.status));
    return j;
  },
  async fetch(id, env) {
    const v = await this.api(env, 'videos', { part: 'snippet,statistics,paidProductPlacementDetails', id });
    if (!v.items || !v.items.length) throw new HttpError(404, 'video_not_found', 'Video not found or not public');
    const it = v.items[0], st = it.statistics || {}, channelId = it.snippet.channelId;
    const ch = await this.api(env, 'channels', { part: 'statistics', id: channelId });
    const num = x => (x == null || isNaN(parseInt(x, 10))) ? null : parseInt(x, 10);
    const video = {
      id, platform: 'youtube', title: it.snippet.title, channel: it.snippet.channelTitle, published: (it.snippet.publishedAt || '').slice(0, 10),
      views: num(st.viewCount), likes: num(st.likeCount), commentCount: num(st.commentCount),
      subs: ch.items && ch.items[0] ? num(ch.items[0].statistics.subscriberCount) : null,
      paid: !!(it.paidProductPlacementDetails && it.paidProductPlacementDetails.hasPaidProductPlacement),
    };
    const comments = []; let token = null;
    while (comments.length < MAX_COMMENTS) {
      const params = { part: 'snippet', videoId: id, maxResults: '100', order: 'relevance', textFormat: 'plainText' };
      if (token) params.pageToken = token;
      let c;
      try { c = await this.api(env, 'commentThreads', params); }
      catch (e) { if (!comments.length) throw new HttpError(422, 'no_comments', 'Comments are turned off or unavailable for this video'); break; }
      for (const x of c.items || []) {
        const s = x.snippet.topLevelComment.snippet;
        if (s.authorChannelId && s.authorChannelId.value === channelId) continue; // 频道主自己的评论不算观众
        comments.push({ t: s.textDisplay, k: s.likeCount || 0 });                 // 不保存评论者的名字
      }
      token = c.nextPageToken; if (!token) break;
    }
    if (!comments.length) throw new HttpError(422, 'no_comments', 'This video has no comments to analyse');
    return { video, comments: comments.slice(0, MAX_COMMENTS) };
  },
};
// 预留：TikTok、Twitch、Instagram 走 Apify。接入前需要法务确认，所以现在只占位。
const apify = { name: 'apify', id() { return null; }, async fetch() { throw new HttpError(501, 'not_supported', 'This platform is not supported yet'); } };
const ADAPTERS = [youtube, apify];

// ---------- 交给 Claude 判断 ----------
function parseArray(text) {
  const m = text.match(/\[[\s\S]*\]/); if (!m) return null;
  try { const j = JSON.parse(m[0]); return Array.isArray(j) ? j : null; } catch (e) { return null; }
}
const pick = (set, x, d) => SETS[set].includes(x) ? x : d;
async function readBatch(env, model, video, chunk, budget) {
  const listing = chunk.map((c, i) => i + '. ' + c.t).join('\n');
  const body = JSON.stringify({ model, max_tokens: 6000, system: PROMPT,
    messages: [{ role: 'user', content: `Video title: "${video.title}"\nChannel: ${video.channel}\n\nComments:\n${listing}` }] });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt && budget.retries-- <= 0) break;
    if (attempt) await new Promise(r => setTimeout(r, 2000 * attempt));
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body,
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    } catch (e) { continue; }
    if (r.status === 401 || r.status === 403) throw new HttpError(500, 'model_auth', 'The model key was rejected');
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    const text = j && j.content ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
    if (j && j.usage) { budget.tin += j.usage.input_tokens || 0; budget.tout += j.usage.output_tokens || 0; }
    const arr = parseArray(text);
    if (!arr || arr.length !== chunk.length || !arr.every(x => Array.isArray(x) && x.length >= 7)) continue;
    return chunk.map((c, i) => {
      const x = arr[i];
      return { t: c.t, k: c.k, a: pick('a', x[1], 'unclear'), b1: pick('b', x[2], 'none'), b2: pick('b', x[3], 'none'), l: pick('l', x[4], 'unknown'),
        c: typeof x[5] === 'string' ? x[5].slice(0, 60) : '', ad: pick('ad', x[6], 'none'), cv: (x[7] === 1 || x[7] === true || x[7] === '1') ? 1 : 0,
        ev: typeof x[8] === 'string' ? x[8].slice(0, 120) : '', cf: x[9] === 'l' ? 'low' : 'high' };
    });
  }
  return null;
}
async function readAll(env, model, video, comments, onProgress) {
  const chunks = []; for (let i = 0; i < comments.length; i += BATCH) chunks.push(comments.slice(i, i + BATCH));
  const out = new Array(chunks.length), budget = { retries: 20, tin: 0, tout: 0 }; let next = 0, done = 0;
  async function worker() {
    while (next < chunks.length) { const i = next++; out[i] = await readBatch(env, model, video, chunks[i], budget); done++; await onProgress(done, chunks.length); }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  const labelled = out.filter(Boolean).flat();
  const [pi, po] = PRICE(model);
  return { labelled, failed: comments.length - labelled.length, cost: budget.tin / 1e6 * pi + budget.tout / 1e6 * po };
}

// ---------- 请求处理 ----------
function corsHeaders(env, req) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean), origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
async function userKey(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + (env.SALT || 'creator-signal')));
  return 'u:' + [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
const money = async (env, key) => parseFloat(await env.CACHE.get(key) || '0') || 0;
const addMoney = async (env, key, delta, ttl) => { const v = Math.max(0, await money(env, key) + delta); await env.CACHE.put(key, v.toFixed(4), { expirationTtl: ttl }); return v; };
const round2 = x => Math.round(x * 100) / 100;
function samePassword(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(env, req), url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, version: VERSION }, 200, cors);
      if (!env.YOUTUBE_API_KEY || !env.ANTHROPIC_API_KEY || !env.CACHE) throw new HttpError(500, 'not_configured', 'The server is missing a key or the KV binding');
      const userLimit = parseFloat(env.USER_BUDGET_USD || '5'), dayLimit = parseFloat(env.DAILY_BUDGET_USD || '10');
      const uKey = await userKey(req, env), day = new Date().toISOString().slice(0, 10), dKey = 'day:' + day;
      if (url.pathname === '/api/quota') return json({ spent: round2(await money(env, uKey)), limit: userLimit }, 200, cors);
      if (url.pathname !== '/api/analyze' || req.method !== 'POST') throw new HttpError(404, 'not_found');
      if (env.ACCESS_PASSWORD) {
        const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (!samePassword(given, env.ACCESS_PASSWORD)) throw new HttpError(401, 'bad_password', 'Wrong password');
      }
      const input = await req.json().catch(() => ({}));
      if (typeof input.url !== 'string' || input.url.length > 500) throw new HttpError(400, 'bad_link');
      let adapter = null, id = null;
      for (const a of ADAPTERS) { id = a.id(input.url); if (id) { adapter = a; break; } }
      if (!adapter) throw new HttpError(400, 'bad_link', 'Not a supported video link');
      const model = env.MODEL || 'claude-sonnet-5-5';

      const key = `${VERSION}:${adapter.name}:${id}:${model}`;
      const cached = input.refresh ? null : await env.CACHE.get(key);
      if (cached) return new Response(JSON.stringify({ type: 'done', cached: true, video: JSON.parse(cached), quota: { spent: round2(await money(env, uKey)), limit: userLimit } }) + '\n', { headers: { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8' } });

      if (await money(env, uKey) + RESERVE_USD > userLimit) throw new HttpError(429, 'user_limit', 'Your free credit is used up');
      if (await money(env, dKey) + RESERVE_USD > dayLimit) throw new HttpError(429, 'daily_limit', 'The site has reached its daily budget');
      await addMoney(env, uKey, RESERVE_USD, 90 * 86400); await addMoney(env, dKey, RESERVE_USD, 172800);   // 先预扣，防止同时发很多请求绕过额度

      const { readable, writable } = new TransformStream(), w = writable.getWriter(), enc = new TextEncoder();
      const send = obj => w.write(enc.encode(JSON.stringify(obj) + '\n'));
      ctx.waitUntil((async () => {
        let cost = 0;
        try {
          await send({ type: 'progress', stage: 'fetch' });
          const { video, comments } = await adapter.fetch(id, env);
          await send({ type: 'progress', stage: 'read', done: 0, total: Math.ceil(comments.length / BATCH) });
          const { labelled, failed, cost: c } = await readAll(env, model, video, comments, (d, t) => send({ type: 'progress', stage: 'read', done: d, total: t }));
          cost = c;
          if (!labelled.length) throw new HttpError(502, 'model_failed', 'The model could not read the comments');
          const result = { ...video, model, analyzed: day, failed, comments: labelled };
          if (!failed) await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: CACHE_DAYS * 86400 });
          const spent = await addMoney(env, uKey, cost - RESERVE_USD, 90 * 86400); await addMoney(env, dKey, cost - RESERVE_USD, 172800); cost = null;
          await send({ type: 'done', cached: false, video: result, quota: { spent: round2(spent), limit: userLimit, cost: round2(result.cost = c) } });
        } catch (e) {
          if (cost !== null) { await addMoney(env, uKey, cost - RESERVE_USD, 90 * 86400).catch(() => {}); await addMoney(env, dKey, cost - RESERVE_USD, 172800).catch(() => {}); }   // 失败也只按实际花掉的算
          await send({ type: 'error', code: e.code || 'server_error', message: e instanceof HttpError ? e.message : 'Something went wrong' });
        } finally { await w.close().catch(() => {}); }
      })());
      return new Response(readable, { headers: { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status, cors);
      return json({ error: 'server_error', message: 'Something went wrong' }, 500, cors);
    }
  },
};
