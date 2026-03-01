/**
 * YTDL API v3.2 - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Estratégia anti-bloqueio (4 fases):
 * F1: ytdl-core com cookies (rápido)
 * F2: yt-dlp com cookies
 * F3: Innertube API (ANDROID/IOS) via proxy gratuito (HTTP nativo, sem deps)
 * F4: yt-dlp com proxy gratuito
 */

const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.API_KEY || 'seven7scala-ytdl-2024';
const MAX_DURATION = 420;

// ============================================================
// COOKIES
// ============================================================
const COOKIES_JSON = path.join('/tmp', 'youtube-cookies.json');
const COOKIES_TXT = path.join('/tmp', 'youtube-cookies.txt');
let ytAgent = null;

function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_JSON)) {
      const data = JSON.parse(fs.readFileSync(COOKIES_JSON, 'utf8'));
      if (data.cookies && data.cookies.length > 0) {
        ytAgent = ytdl.createAgent(data.cookies);
        console.log(`[COOKIES] ${data.cookies.length} cookies carregados`);
        return true;
      }
    }
  } catch (e) { console.error(`[COOKIES] Erro: ${e.message}`); }
  ytAgent = null;
  return false;
}

function saveCookies(cookies) {
  try {
    fs.writeFileSync(COOKIES_JSON, JSON.stringify({ cookies, savedAt: new Date().toISOString(), count: cookies.length }, null, 2));
    ytAgent = ytdl.createAgent(cookies);
    if (!fs.existsSync(COOKIES_TXT)) {
      let txt = '# Netscape HTTP Cookie File\n';
      for (const c of cookies) txt += `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${c.expires || 0}\t${c.name}\t${c.value}\n`;
      fs.writeFileSync(COOKIES_TXT, txt);
    }
    return true;
  } catch (e) { return false; }
}

function saveRawCookiesTxt(rawText) {
  try {
    fs.writeFileSync(COOKIES_TXT, rawText);
    const parsed = parseCookiesTxt(rawText);
    if (parsed.length > 0) {
      fs.writeFileSync(COOKIES_JSON, JSON.stringify({ cookies: parsed, savedAt: new Date().toISOString(), count: parsed.length }, null, 2));
      ytAgent = ytdl.createAgent(parsed);
    }
    console.log(`[COOKIES] Raw: ${parsed.length} cookies`);
    return parsed.length;
  } catch (e) { return 0; }
}

loadCookies();
function getYtdlOptions() { return ytAgent ? { agent: ytAgent } : {}; }
function hasCookiesTxt() { return fs.existsSync(COOKIES_TXT); }
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(403).json({ error: 'Chave inválida' });
  next();
}

function parseCookiesTxt(text) {
  const cookies = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || (t.startsWith('#') && !t.startsWith('#HttpOnly_'))) continue;
    const clean = t.startsWith('#HttpOnly_') ? t.replace('#HttpOnly_', '') : t;
    const p = clean.split('\t');
    if (p.length >= 7) cookies.push({ domain: p[0], httpOnly: t.startsWith('#HttpOnly_'), path: p[2], secure: p[3].toLowerCase() === 'true', expires: parseInt(p[4]) || 0, name: p[5], value: p[6] });
  }
  return cookies;
}

// ============================================================
// PROXY GRATUITO
// ============================================================
let cachedProxies = [];
let lastProxyFetch = 0;
let workingProxy = null;
let workingProxyTime = 0;

async function fetchFreeProxies() {
  if (Date.now() - lastProxyFetch < 300000 && cachedProxies.length > 0) return cachedProxies;
  const sources = [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=&ssl=all&anonymity=elite',
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=&ssl=all&anonymity=anonymous',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
  ];
  const proxies = new Set();
  for (const source of sources) {
    try {
      const resp = await fetch(source, { signal: AbortSignal.timeout(8000) });
      const text = await resp.text();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(t)) proxies.add(t);
      }
    } catch (e) { /* skip */ }
  }
  cachedProxies = [...proxies];
  lastProxyFetch = Date.now();
  for (let i = cachedProxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cachedProxies[i], cachedProxies[j]] = [cachedProxies[j], cachedProxies[i]];
  }
  console.log(`[PROXY] ${cachedProxies.length} proxies`);
  return cachedProxies;
}

// ============================================================
// HTTP REQUEST VIA PROXY (Node nativo, sem dependências)
// ============================================================
function httpsViaProxy(targetUrl, proxyHost, proxyPort, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('proxy timeout')); }, timeoutMs || 12000);
    
    // CONNECT tunnel
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${new URL(targetUrl).hostname}:443`,
      timeout: 8000
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`CONNECT ${res.statusCode}`));
      }

      // TLS handshake over the proxy tunnel
      const tlsSocket = tls.connect({
        socket,
        servername: new URL(targetUrl).hostname,
        rejectUnauthorized: false
      }, () => {
        const u = new URL(targetUrl);
        const reqHeaders = {
          ...headers,
          'Host': u.hostname,
          'Connection': 'close'
        };
        if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body);
        
        let reqLine = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) reqLine += `${k}: ${v}\r\n`;
        reqLine += '\r\n';
        
        tlsSocket.write(reqLine);
        if (body) tlsSocket.write(body);
        
        let rawData = '';
        tlsSocket.on('data', chunk => rawData += chunk.toString());
        tlsSocket.on('end', () => {
          clearTimeout(timer);
          // Parse HTTP response
          const bodyStart = rawData.indexOf('\r\n\r\n');
          if (bodyStart === -1) return reject(new Error('Invalid response'));
          const respBody = rawData.substring(bodyStart + 4);
          
          // Handle chunked encoding
          const headersSection = rawData.substring(0, bodyStart).toLowerCase();
          let finalBody = respBody;
          if (headersSection.includes('transfer-encoding: chunked')) {
            finalBody = parseChunked(respBody);
          }
          
          try {
            resolve(JSON.parse(finalBody));
          } catch (e) {
            reject(new Error(`JSON parse: ${finalBody.substring(0, 80)}`));
          }
        });
        tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
      });

      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    connectReq.on('error', (e) => { clearTimeout(timer); reject(e); });
    connectReq.on('timeout', () => { clearTimeout(timer); connectReq.destroy(); reject(new Error('connect timeout')); });
    connectReq.end();
  });
}

function parseChunked(data) {
  let result = '';
  let pos = 0;
  while (pos < data.length) {
    const lineEnd = data.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const chunkSize = parseInt(data.substring(pos, lineEnd), 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    pos = lineEnd + 2;
    result += data.substring(pos, pos + chunkSize);
    pos += chunkSize + 2;
  }
  return result || data;
}

// ============================================================
// INNERTUBE API - YouTube internal API
// ============================================================
const INNERTUBE_CONFIGS = {
  ANDROID: {
    clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, clientId: '3',
    userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
  },
  IOS: {
    clientName: 'IOS', clientVersion: '19.09.3', deviceMake: 'Apple', deviceModel: 'iPhone14,3', clientId: '5',
    userAgent: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)'
  },
  TV: {
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', clientId: '85',
    userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5)'
  }
};

function buildInnertubeBody(videoId, clientKey) {
  const c = INNERTUBE_CONFIGS[clientKey];
  return JSON.stringify({
    context: {
      client: {
        clientName: c.clientName, clientVersion: c.clientVersion, hl: 'pt', gl: 'BR',
        ...(c.androidSdkVersion ? { androidSdkVersion: c.androidSdkVersion } : {}),
        ...(c.deviceMake ? { deviceMake: c.deviceMake, deviceModel: c.deviceModel } : {})
      }
    },
    videoId,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    contentCheckOk: true, racyCheckOk: true
  });
}

function buildInnertubeHeaders(clientKey) {
  const c = INNERTUBE_CONFIGS[clientKey];
  return {
    'Content-Type': 'application/json',
    'User-Agent': c.userAgent,
    'X-YouTube-Client-Name': c.clientId,
    'X-YouTube-Client-Version': c.clientVersion,
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/'
  };
}

async function innertubeDirectRequest(videoId, clientKey) {
  const body = buildInnertubeBody(videoId, clientKey);
  const headers = buildInnertubeHeaders(clientKey);
  const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const resp = await fetch(url, {
    method: 'POST', headers, body,
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

async function innertubeViaProxy(videoId, clientKey, proxyStr) {
  const [proxyHost, proxyPort] = proxyStr.split(':');
  const body = buildInnertubeBody(videoId, clientKey);
  const headers = buildInnertubeHeaders(clientKey);
  const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  return await httpsViaProxy(url, proxyHost, parseInt(proxyPort), 'POST', headers, body, 12000);
}

function parseInnertubeFormats(data) {
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') throw new Error(`YouTube: ${data?.playabilityStatus?.reason || status || 'unknown'}`);
  const sd = data.streamingData;
  if (!sd) throw new Error('No streaming data');
  const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  const playable = all.filter(f => f.url);
  if (playable.length === 0) throw new Error('No playable (signatureCipher)');
  const d = data.videoDetails || {};
  return {
    source: 'innertube', info: {
      videoDetails: {
        title: d.title || 'video', lengthSeconds: d.lengthSeconds || '0',
        thumbnails: d.thumbnail?.thumbnails || [],
        author: { name: d.author || '' }
      }
    },
    formats: playable.map(f => ({
      itag: f.itag || 0, url: f.url, mimeType: f.mimeType || 'video/mp4',
      qualityLabel: f.qualityLabel || '', hasVideo: (f.mimeType || '').startsWith('video/'),
      hasAudio: !!(f.audioQuality || f.audioSampleRate),
      height: f.height || 0, audioBitrate: f.averageBitrate ? Math.round(f.averageBitrate / 1000) : 0,
      contentLength: f.contentLength || '0', container: (f.mimeType || '').includes('webm') ? 'webm' : 'mp4',
      fps: f.fps || 30
    }))
  };
}

// ============================================================
// CORE: Buscar info do vídeo (4 fases)
// ============================================================
async function getVideoData(url) {
  const errors = [];
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  // ===== F1: ytdl-core =====
  try {
    console.log(`[F1] ytdl-core (cookies: ${ytAgent ? 'Y' : 'N'})...`);
    const info = await Promise.race([
      ytdl.getInfo(url, getYtdlOptions()),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))
    ]);
    const p = info.formats.filter(f => f.url);
    if (p.length === 0) throw new Error('No formats');
    console.log(`[F1] ✅ ${p.length} formatos`);
    return { source: 'ytdl-core', info, formats: info.formats };
  } catch (e) {
    console.log(`[F1] ❌ ${(e.message || '').substring(0, 120)}`);
    errors.push(`ytdl-core: ${(e.message || '').substring(0, 60)}`);
  }

  // ===== F2: yt-dlp direto =====
  for (const client of ['web', 'mweb']) {
    try {
      console.log(`[F2] yt-dlp(${client})...`);
      const info = await Promise.race([
        youtubedl(url, buildYtdlpOpts(client)),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 25000))
      ]);
      const fmts = (info.formats || []).filter(f => f.url);
      if (fmts.length === 0) throw new Error('No formats');
      console.log(`[F2] ✅ yt-dlp(${client}): "${info.title}" ${fmts.length}f`);
      return convertYtdlpResult(info);
    } catch (e) {
      console.log(`[F2] ❌ yt-dlp(${client}): ${((e.stderr || e.message || '')).substring(0, 100)}`);
      errors.push(`yt-dlp(${client}): ${((e.stderr || e.message || '')).substring(0, 50)}`);
    }
  }

  // ===== F3: Innertube via proxy =====
  if (videoId) {
    // 3a: Innertube direto (sem proxy)
    for (const ck of ['ANDROID', 'IOS', 'TV']) {
      try {
        console.log(`[F3] Innertube direto ${ck}...`);
        const data = await innertubeDirectRequest(videoId, ck);
        const result = parseInnertubeFormats(data);
        console.log(`[F3] ✅ Innertube ${ck}: ${result.formats.length}f`);
        return result;
      } catch (e) {
        console.log(`[F3] Innertube ${ck}: ${(e.message || '').substring(0, 60)}`);
      }
    }

    // 3b: Innertube via proxy cached
    if (workingProxy && Date.now() - workingProxyTime < 600000) {
      try {
        const data = await innertubeViaProxy(videoId, 'ANDROID', workingProxy);
        const result = parseInnertubeFormats(data);
        console.log(`[F3] ✅ Proxy cached ${workingProxy}: ${result.formats.length}f`);
        workingProxyTime = Date.now();
        return result;
      } catch (e) {
        console.log(`[F3] Proxy cached falhou`);
        workingProxy = null;
      }
    }

    // 3c: Innertube via proxy rotation (paralelo)
    try {
      const proxies = await fetchFreeProxies();
      const maxTest = Math.min(30, proxies.length);
      const batchSize = 10;

      for (let b = 0; b < Math.ceil(maxTest / batchSize); b++) {
        const batch = proxies.slice(b * batchSize, (b + 1) * batchSize);
        console.log(`[F3] Proxy lote ${b + 1}: ${batch.length} proxies...`);

        const result = await new Promise((resolve) => {
          let resolved = false, done = 0;
          batch.forEach(async (proxy) => {
            try {
              const data = await innertubeViaProxy(videoId, 'ANDROID', proxy);
              const result = parseInnertubeFormats(data);
              if (!resolved && result.formats.length > 0) {
                resolved = true;
                console.log(`[F3] ✅ Proxy ${proxy}: ${result.formats.length}f`);
                workingProxy = proxy;
                workingProxyTime = Date.now();
                resolve(result);
              }
            } catch (e) { /* skip */ }
            finally {
              done++;
              if (done === batch.length && !resolved) resolve(null);
            }
          });
          setTimeout(() => { if (!resolved) resolve(null); }, 15000);
        });

        if (result) return result;
      }
    } catch (e) { /* skip */ }

    errors.push('innertube+proxy: sem sucesso');
  }

  // ===== F4: yt-dlp + proxy =====
  try {
    console.log(`[F4] yt-dlp + proxy...`);
    const proxies = cachedProxies.length > 0 ? cachedProxies : await fetchFreeProxies();
    for (const proxy of proxies.slice(0, 5)) {
      try {
        const info = await Promise.race([
          youtubedl(url, buildYtdlpOpts('web', `http://${proxy}`)),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 25000))
        ]);
        const fmts = (info.formats || []).filter(f => f.url);
        if (fmts.length === 0) throw new Error('No formats');
        console.log(`[F4] ✅ yt-dlp proxy ${proxy}`);
        workingProxy = proxy; workingProxyTime = Date.now();
        return convertYtdlpResult(info);
      } catch (e) { /* continue */ }
    }
    errors.push('yt-dlp+proxy: sem sucesso');
  } catch (e) { errors.push(`yt-dlp+proxy: ${(e.message || '').substring(0, 40)}`); }

  throw new Error(`Todos falharam. ${errors.join(' | ')}`);
}

function buildYtdlpOpts(client, proxy) {
  const opts = {
    dumpSingleJson: true, noCheckCertificates: true, skipDownload: true,
    noPlaylist: true, geoBypass: true,
    addHeader: ['referer:https://www.youtube.com', 'origin:https://www.youtube.com',
      'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36']
  };
  if (client && client !== 'default') opts.extractorArgs = `youtube:player_client=${client}`;
  if (hasCookiesTxt()) opts.cookies = COOKIES_TXT;
  if (proxy) opts.proxy = proxy;
  return opts;
}

function convertYtdlpResult(info) {
  return {
    source: 'yt-dlp', info: {
      videoDetails: {
        title: info.title || 'video', lengthSeconds: String(info.duration || 0),
        thumbnails: info.thumbnail ? [{ url: info.thumbnail }] : [],
        author: { name: info.uploader || info.channel || '' }
      }
    },
    formats: (info.formats || []).filter(f => f.url).map(f => ({
      itag: parseInt(f.format_id) || 0, url: f.url,
      mimeType: f.vcodec !== 'none' ? `video/${f.ext || 'mp4'}` : `audio/${f.ext || 'mp4'}`,
      qualityLabel: f.format_note || (f.height ? `${f.height}p` : ''),
      hasVideo: f.vcodec !== 'none', hasAudio: f.acodec !== 'none',
      height: f.height || 0, audioBitrate: f.abr || 0,
      contentLength: f.filesize ? String(f.filesize) : '0',
      container: f.ext || 'mp4', fps: f.fps || 30
    }))
  };
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'ytdl-api', version: '3.2.0',
    cookies: ytAgent ? 'configurados' : 'nao_configurados',
    cookieFile: fs.existsSync(COOKIES_TXT),
    proxyCached: workingProxy, proxiesLoaded: cachedProxies.length
  });
});

app.get('/api/debug', authenticate, (req, res) => {
  const exists = fs.existsSync(COOKIES_TXT);
  let lines = 0, head = '';
  if (exists) { const c = fs.readFileSync(COOKIES_TXT, 'utf8'); lines = c.split('\n').length; head = c.substring(0, 300); }
  res.json({ version: '3.2.0', ytAgent: !!ytAgent, cookieFile: exists, cookieLines: lines, cookieHead: head, workingProxy, proxiesLoaded: cachedProxies.length });
});

app.post('/api/cookies', authenticate, (req, res) => {
  try {
    if (req.body.cookiesTxt && typeof req.body.cookiesTxt === 'string') {
      const c = saveRawCookiesTxt(req.body.cookiesTxt);
      if (c > 0) return res.json({ success: true, message: `${c} cookies salvos!`, count: c });
    }
    const cookies = req.body.cookies;
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return res.status(400).json({ error: 'Cookies inválidos.' });
    const yt = cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
    if (yt.length === 0) return res.status(400).json({ error: 'Nenhum cookie YouTube/Google.' });
    saveCookies(yt) ? res.json({ success: true, count: yt.length }) : res.status(500).json({ error: 'Erro.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cookies/status', authenticate, (req, res) => {
  loadCookies();
  res.json({ configured: !!ytAgent, file: fs.existsSync(COOKIES_TXT) });
});

app.delete('/api/cookies', authenticate, (req, res) => {
  try {
    if (fs.existsSync(COOKIES_JSON)) fs.unlinkSync(COOKIES_JSON);
    if (fs.existsSync(COOKIES_TXT)) fs.unlinkSync(COOKIES_TXT);
    ytAgent = null; res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function formatResponse(data) {
  const dur = parseInt(data.info.videoDetails.lengthSeconds);
  if (dur > MAX_DURATION) return { error: `Vídeo muito longo (${Math.ceil(dur / 60)}min). Max: ${Math.ceil(MAX_DURATION / 60)}min.`, status: 400 };
  const vf = data.formats.filter(f => f.hasAudio && f.hasVideo && f.url).sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 6).map(f => ({
    itag: f.itag, mimeType: f.mimeType || 'video/mp4', qualityLabel: f.qualityLabel || `${f.height}p`,
    container: f.container || 'mp4', contentLength: f.contentLength || '0', fps: f.fps || 30, hasAudio: true, hasVideo: true
  }));
  const af = data.formats.filter(f => f.hasAudio && !f.hasVideo && f.url).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0)).slice(0, 4).map(f => ({
    itag: f.itag, mimeType: f.mimeType || 'audio/mp4', bitrate: f.audioBitrate || 0, quality: `${f.audioBitrate || 128}kbps`,
    container: f.container || 'mp4', contentLength: f.contentLength || '0', hasAudio: true, hasVideo: false
  }));
  const th = data.info.videoDetails.thumbnails || [];
  return { title: data.info.videoDetails.title, duration: data.info.videoDetails.lengthSeconds,
    thumbnail: th.length > 0 ? th[th.length - 1].url : '', author: data.info.videoDetails.author?.name || '',
    videoFormats: vf, audioFormats: af, source: data.source };
}

app.post('/api/info', authenticate, async (req, res) => {
  try {
    const url = req.body.url || req.query.url;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    if (req.body.cookiesTxt) saveRawCookiesTxt(req.body.cookiesTxt);
    else if (req.body.cookies && Array.isArray(req.body.cookies)) {
      const yt = req.body.cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
      if (yt.length > 0) saveCookies(yt);
    }
    console.log(`[INFO] POST: ${url} (cookies: ${ytAgent ? 'Y' : 'N'})`);
    const data = await getVideoData(url);
    const r = formatResponse(data);
    if (r.error) return res.status(r.status || 500).json({ error: r.error });
    console.log(`[INFO] ✅ (${data.source}): "${r.title}" ${r.videoFormats.length}V ${r.audioFormats.length}A`);
    res.json(r);
  } catch (e) { console.error(`[INFO] ❌ ${e.message}`); res.status(500).json({ error: e.message }); }
});

app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    const data = await getVideoData(url);
    const r = formatResponse(data);
    if (r.error) return res.status(r.status || 500).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    const data = await getVideoData(url);
    const dur = parseInt(data.info.videoDetails.lengthSeconds);
    if (dur > MAX_DURATION) return res.status(400).json({ error: 'Muito longo.' });
    let sel;
    if (itag) sel = data.formats.find(f => f.itag === parseInt(itag) && f.url);
    if (!sel) sel = (format === 'mp3' || format === 'audio')
      ? data.formats.filter(f => f.hasAudio && !f.hasVideo && f.url).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0]
      : data.formats.filter(f => f.hasAudio && f.hasVideo && f.url).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!sel) sel = data.formats.filter(f => f.url)[0];
    if (!sel) return res.status(404).json({ error: 'Formato não encontrado' });
    const title = (data.info.videoDetails.title || 'video').replace(/[^\w\s\-\u00C0-\u024F]/g, '').trim() || 'video';
    const isAudio = !sel.hasVideo;
    const ext = isAudio ? 'mp3' : (sel.container || 'mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.${ext}"`);
    res.setHeader('Content-Type', sel.mimeType || (isAudio ? 'audio/mpeg' : 'video/mp4'));
    if (sel.contentLength && sel.contentLength !== '0') res.setHeader('Content-Length', sel.contentLength);
    if (data.source === 'ytdl-core') {
      const stream = ytdl.downloadFromInfo(data.info, { format: sel, ...getYtdlOptions() });
      stream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      stream.pipe(res);
    } else {
      const r2 = await fetch(sel.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com' } });
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      const { Readable } = require('stream');
      Readable.fromWeb(r2.body).pipe(res);
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YTDL API v3.2 porta ${PORT} | Cookies: ${ytAgent ? 'Y' : 'N'} | TXT: ${hasCookiesTxt() ? 'Y' : 'N'}`);
  fetchFreeProxies().then(p => console.log(`   ${p.length} proxies carregados`)).catch(() => {});
});
