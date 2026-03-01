/**
 * YTDL API v3.1 - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Estratégia anti-bloqueio:
 * FASE 1: ytdl-core com cookies (rápido, direto)
 * FASE 2: yt-dlp com cookies + clients web/mweb
 * FASE 3: Innertube API (ANDROID) via proxy gratuito (contorna bloqueio IP)
 * FASE 4: yt-dlp com proxy gratuito (fallback final)
 * 
 * A FASE 3 é a mais eficiente: faz chamadas HTTP diretas à API interna
 * do YouTube via proxy, sem spawnar processos.
 */

const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.API_KEY || 'seven7scala-ytdl-2024';
const MAX_DURATION = 420; // 7 minutos

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
        console.log(`[COOKIES] Carregados ${data.cookies.length} cookies`);
        return true;
      }
    }
  } catch (e) {
    console.error(`[COOKIES] Erro: ${e.message}`);
  }
  ytAgent = null;
  return false;
}

function saveCookies(cookies) {
  try {
    fs.writeFileSync(COOKIES_JSON, JSON.stringify({ cookies, savedAt: new Date().toISOString(), count: cookies.length }, null, 2));
    ytAgent = ytdl.createAgent(cookies);
    if (!fs.existsSync(COOKIES_TXT)) {
      let txt = '# Netscape HTTP Cookie File\n';
      for (const c of cookies) {
        const httpOnly = c.httpOnly ? '#HttpOnly_' : '';
        txt += `${httpOnly}${c.domain}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${c.expires || 0}\t${c.name}\t${c.value}\n`;
      }
      fs.writeFileSync(COOKIES_TXT, txt);
    }
    console.log(`[COOKIES] Salvos ${cookies.length}`);
    return true;
  } catch (e) {
    console.error(`[COOKIES] Erro: ${e.message}`);
    return false;
  }
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
  } catch (e) {
    console.error(`[COOKIES] Erro raw: ${e.message}`);
    return 0;
  }
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
    const trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) continue;
    const clean = trimmed.startsWith('#HttpOnly_') ? trimmed.replace('#HttpOnly_', '') : trimmed;
    const parts = clean.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0], httpOnly: trimmed.startsWith('#HttpOnly_'),
        path: parts[2], secure: parts[3].toLowerCase() === 'true',
        expires: parseInt(parts[4]) || 0, name: parts[5], value: parts[6]
      });
    }
  }
  return cookies;
}

// ============================================================
// PROXIES GRATUITOS
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
    } catch (e) { /* ignore */ }
  }

  cachedProxies = [...proxies];
  lastProxyFetch = Date.now();
  // Embaralhar
  for (let i = cachedProxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cachedProxies[i], cachedProxies[j]] = [cachedProxies[j], cachedProxies[i]];
  }
  console.log(`[PROXY] ${cachedProxies.length} proxies carregados`);
  return cachedProxies;
}

// ============================================================
// INNERTUBE API - Chamada direta à API interna do YouTube
// ============================================================
const INNERTUBE_CLIENTS = {
  ANDROID: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    clientId: 3
  },
  IOS: {
    clientName: 'IOS',
    clientVersion: '19.09.3',
    deviceMake: 'Apple',
    deviceModel: 'iPhone14,3',
    userAgent: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
    clientId: 5
  },
  TV: {
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5)',
    clientId: 85
  }
};

async function innertubeRequest(videoId, clientKey, proxyUrl) {
  const client = INNERTUBE_CLIENTS[clientKey];
  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: 'pt', gl: 'BR',
        ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
        ...(client.deviceMake ? { deviceMake: client.deviceMake, deviceModel: client.deviceModel } : {})
      }
    },
    videoId,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    contentCheckOk: true, racyCheckOk: true
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': client.userAgent,
    'X-YouTube-Client-Name': String(client.clientId),
    'X-YouTube-Client-Version': client.clientVersion,
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/'
  };

  const fetchOpts = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  };

  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    fetchOpts.dispatcher = agent;
    // Para Node 18+, usar o agent como dispatcher não funciona com fetch nativo
    // Usar https module em vez disso
  }

  // Para proxies, usamos node-fetch ou https module
  if (proxyUrl) {
    return await innertubeRequestWithProxy(videoId, body, headers, proxyUrl);
  }

  const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

async function innertubeRequestWithProxy(videoId, body, headers, proxyUrl) {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');
  
  const agent = new HttpsProxyAgent(proxyUrl);
  const targetUrl = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('proxy timeout 12s')), 12000);
    
    const req = https.request(targetUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
      agent
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function parseInnertubeFormats(data) {
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    const reason = data?.playabilityStatus?.reason || status || 'unknown';
    throw new Error(`YouTube: ${reason}`);
  }

  const streaming = data.streamingData;
  if (!streaming) throw new Error('No streaming data');

  const allFormats = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])];
  const playable = allFormats.filter(f => f.url);
  if (playable.length === 0) throw new Error('No playable formats (signatureCipher)');

  const details = data.videoDetails || {};

  return {
    source: 'innertube',
    info: {
      videoDetails: {
        title: details.title || 'video',
        lengthSeconds: details.lengthSeconds || '0',
        thumbnails: details.thumbnail?.thumbnails || [],
        author: { name: details.author || '' }
      }
    },
    formats: playable.map(f => ({
      itag: f.itag || 0,
      url: f.url,
      mimeType: f.mimeType || 'video/mp4',
      qualityLabel: f.qualityLabel || '',
      hasVideo: (f.mimeType || '').startsWith('video/'),
      hasAudio: !!(f.audioQuality || f.audioSampleRate),
      height: f.height || 0,
      audioBitrate: f.averageBitrate ? Math.round(f.averageBitrate / 1000) : (f.bitrate ? Math.round(f.bitrate / 1000) : 0),
      contentLength: f.contentLength || '0',
      container: (f.mimeType || '').includes('webm') ? 'webm' : 'mp4',
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

  // ===== FASE 1: ytdl-core direto =====
  try {
    console.log(`[F1] ytdl-core (cookies: ${ytAgent ? 'SIM' : 'NAO'})...`);
    const info = await Promise.race([
      ytdl.getInfo(url, getYtdlOptions()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]);
    const playable = info.formats.filter(f => f.url);
    if (playable.length === 0) throw new Error('No playable formats');
    console.log(`[F1] ✅ ${playable.length} formatos`);
    return { source: 'ytdl-core', info, formats: info.formats };
  } catch (e) {
    console.log(`[F1] ❌ ${(e.message || '').substring(0, 120)}`);
    errors.push(`ytdl-core: ${(e.message || '').substring(0, 80)}`);
  }

  // ===== FASE 2: yt-dlp direto com cookies =====
  for (const client of ['web', 'mweb']) {
    try {
      console.log(`[F2] yt-dlp client=${client}...`);
      const opts = buildYtdlpOpts(client);
      const info = await Promise.race([
        youtubedl(url, opts),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))
      ]);
      const fmts = (info.formats || []).filter(f => f.url);
      if (fmts.length === 0) throw new Error('No formats');
      console.log(`[F2] ✅ yt-dlp(${client}): "${info.title}" - ${fmts.length} formatos`);
      return convertYtdlpResult(info);
    } catch (e) {
      console.log(`[F2] ❌ yt-dlp(${client}): ${((e.stderr || e.message || '')).substring(0, 120)}`);
      errors.push(`yt-dlp(${client}): ${((e.stderr || e.message || '')).substring(0, 60)}`);
    }
  }

  // ===== FASE 3: Innertube API via proxy gratuito =====
  if (videoId) {
    try {
      console.log(`[F3] Innertube via proxy (videoId: ${videoId})...`);

      // Primeiro: tentar Innertube direto (sem proxy), client ANDROID
      for (const clientKey of ['ANDROID', 'IOS', 'TV']) {
        try {
          console.log(`[F3] Innertube direto ${clientKey}...`);
          const data = await innertubeRequest(videoId, clientKey, null);
          const result = parseInnertubeFormats(data);
          console.log(`[F3] ✅ Innertube direto ${clientKey}: ${result.formats.length} formatos`);
          return result;
        } catch (ie) {
          console.log(`[F3] Innertube direto ${clientKey}: ${(ie.message || '').substring(0, 80)}`);
        }
      }

      // Se o proxy cached funciona, tenta ele primeiro
      if (workingProxy && Date.now() - workingProxyTime < 600000) {
        try {
          const data = await innertubeRequest(videoId, 'ANDROID', `http://${workingProxy}`);
          const result = parseInnertubeFormats(data);
          console.log(`[F3] ✅ Proxy cached ${workingProxy}: ${result.formats.length} formatos`);
          workingProxyTime = Date.now();
          return result;
        } catch (e) {
          console.log(`[F3] Proxy cached falhou: ${(e.message || '').substring(0, 60)}`);
          workingProxy = null;
        }
      }

      // Buscar proxies e testar em lotes paralelos
      const proxies = await fetchFreeProxies();
      if (proxies.length > 0) {
        const maxTest = Math.min(30, proxies.length);
        const batchSize = 10;

        for (let b = 0; b < Math.ceil(maxTest / batchSize); b++) {
          const batch = proxies.slice(b * batchSize, (b + 1) * batchSize);
          console.log(`[F3] Lote ${b + 1}: ${batch.length} proxies...`);

          // Race: primeiro proxy que funcionar ganha
          const result = await new Promise((resolve) => {
            let resolved = false;
            let finished = 0;

            batch.forEach(async (proxy) => {
              try {
                const data = await innertubeRequest(videoId, 'ANDROID', `http://${proxy}`);
                const result = parseInnertubeFormats(data);
                if (!resolved && result.formats.length > 0) {
                  resolved = true;
                  console.log(`[F3] ✅ Proxy ${proxy} OK: ${result.formats.length} formatos`);
                  workingProxy = proxy;
                  workingProxyTime = Date.now();
                  resolve(result);
                }
              } catch (e) {
                // Silencioso - muitos proxies vão falhar
              } finally {
                finished++;
                if (finished === batch.length && !resolved) {
                  resolve(null);
                }
              }
            });

            // Timeout do lote: 15 segundos
            setTimeout(() => { if (!resolved) resolve(null); }, 15000);
          });

          if (result) return result;
        }
      }

      errors.push('innertube+proxy: Nenhum proxy funcionou');
    } catch (e) {
      console.log(`[F3] ❌ ${(e.message || '').substring(0, 100)}`);
      errors.push(`innertube: ${(e.message || '').substring(0, 60)}`);
    }
  }

  // ===== FASE 4: yt-dlp com proxy (fallback final) =====
  try {
    console.log(`[F4] yt-dlp + proxy...`);
    const proxies = cachedProxies.length > 0 ? cachedProxies : await fetchFreeProxies();
    const testProxies = proxies.slice(0, 5);
    
    for (const proxy of testProxies) {
      try {
        const opts = buildYtdlpOpts('web', `http://${proxy}`);
        const info = await Promise.race([
          youtubedl(url, opts),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))
        ]);
        const fmts = (info.formats || []).filter(f => f.url);
        if (fmts.length === 0) throw new Error('No formats');
        console.log(`[F4] ✅ yt-dlp proxy ${proxy}: "${info.title}"`);
        workingProxy = proxy;
        workingProxyTime = Date.now();
        return convertYtdlpResult(info);
      } catch (e) {
        // continue
      }
    }
    errors.push('yt-dlp+proxy: Nenhum funcionou');
  } catch (e) {
    errors.push(`yt-dlp+proxy: ${(e.message || '').substring(0, 60)}`);
  }

  throw new Error(`Todos os métodos falharam. ${errors.join(' | ')}`);
}

function buildYtdlpOpts(client, proxy) {
  const opts = {
    dumpSingleJson: true, noCheckCertificates: true,
    skipDownload: true, noPlaylist: true, geoBypass: true,
    addHeader: [
      'referer:https://www.youtube.com', 'origin:https://www.youtube.com',
      'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ]
  };
  if (client && client !== 'default') opts.extractorArgs = `youtube:player_client=${client}`;
  if (hasCookiesTxt()) opts.cookies = COOKIES_TXT;
  if (proxy) opts.proxy = proxy;
  return opts;
}

function convertYtdlpResult(info) {
  return {
    source: 'yt-dlp',
    info: {
      videoDetails: {
        title: info.title || 'video',
        lengthSeconds: String(info.duration || 0),
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
    status: 'ok', service: 'ytdl-api', version: '3.1.0',
    cookies: ytAgent ? 'configurados' : 'nao_configurados',
    cookieFile: fs.existsSync(COOKIES_TXT),
    proxyCached: workingProxy, proxiesLoaded: cachedProxies.length
  });
});

app.get('/api/debug', authenticate, (req, res) => {
  try {
    const cookieFileExists = fs.existsSync(COOKIES_TXT);
    let lines = 0, head = '';
    if (cookieFileExists) {
      const c = fs.readFileSync(COOKIES_TXT, 'utf8');
      lines = c.split('\n').length;
      head = c.substring(0, 300);
    }
    res.json({
      version: '3.1.0', ytAgent: !!ytAgent,
      cookieFile: cookieFileExists, cookieLines: lines, cookieHead: head,
      workingProxy, proxiesLoaded: cachedProxies.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cookies
app.post('/api/cookies', authenticate, (req, res) => {
  try {
    if (req.body.cookiesTxt && typeof req.body.cookiesTxt === 'string') {
      const count = saveRawCookiesTxt(req.body.cookiesTxt);
      if (count > 0) return res.json({ success: true, message: `${count} cookies salvos!`, count });
    }
    const cookies = req.body.cookies;
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0)
      return res.status(400).json({ error: 'Cookies inválidos.' });
    const ytCookies = cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
    if (ytCookies.length === 0) return res.status(400).json({ error: 'Nenhum cookie YouTube/Google.' });
    saveCookies(ytCookies)
      ? res.json({ success: true, message: `${ytCookies.length} cookies salvos!`, count: ytCookies.length })
      : res.status(500).json({ error: 'Erro ao salvar.' });
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
    ytAgent = null;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Info endpoints
function formatResponse(data) {
  const duration = parseInt(data.info.videoDetails.lengthSeconds);
  if (duration > MAX_DURATION) {
    return { error: `Vídeo muito longo (${Math.ceil(duration / 60)} min). Limite: ${Math.ceil(MAX_DURATION / 60)} min.`, status: 400 };
  }

  const videoFormats = data.formats
    .filter(f => f.hasAudio && f.hasVideo && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 6)
    .map(f => ({
      itag: f.itag, mimeType: f.mimeType || 'video/mp4',
      qualityLabel: f.qualityLabel || `${f.height}p`,
      container: f.container || 'mp4', contentLength: f.contentLength || '0',
      fps: f.fps || 30, hasAudio: true, hasVideo: true
    }));

  const audioFormats = data.formats
    .filter(f => f.hasAudio && !f.hasVideo && f.url)
    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0)).slice(0, 4)
    .map(f => ({
      itag: f.itag, mimeType: f.mimeType || 'audio/mp4',
      bitrate: f.audioBitrate || 0, quality: `${f.audioBitrate || 128}kbps`,
      container: f.container || 'mp4', contentLength: f.contentLength || '0',
      hasAudio: true, hasVideo: false
    }));

  const thumbs = data.info.videoDetails.thumbnails || [];
  return {
    title: data.info.videoDetails.title, duration: data.info.videoDetails.lengthSeconds,
    thumbnail: thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '',
    author: data.info.videoDetails.author?.name || '',
    videoFormats, audioFormats, source: data.source
  };
}

app.post('/api/info', authenticate, async (req, res) => {
  try {
    const url = req.body.url || req.query.url;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });

    // Salvar cookies inline
    if (req.body.cookiesTxt && typeof req.body.cookiesTxt === 'string') {
      saveRawCookiesTxt(req.body.cookiesTxt);
    } else if (req.body.cookies && Array.isArray(req.body.cookies)) {
      const yt = req.body.cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
      if (yt.length > 0) saveCookies(yt);
    }

    console.log(`[INFO] POST: ${url} (cookies: ${ytAgent ? 'SIM' : 'NAO'})`);
    const data = await getVideoData(url);
    const resp = formatResponse(data);
    if (resp.error) return res.status(resp.status || 500).json({ error: resp.error });
    console.log(`[INFO] ✅ (${data.source}): "${resp.title}" - ${resp.videoFormats.length}V ${resp.audioFormats.length}A`);
    res.json(resp);
  } catch (e) {
    console.error(`[INFO] ❌ ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    console.log(`[INFO] GET: ${url}`);
    const data = await getVideoData(url);
    const resp = formatResponse(data);
    if (resp.error) return res.status(resp.status || 500).json({ error: resp.error });
    res.json(resp);
  } catch (e) {
    console.error(`[INFO] ❌ ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Download
app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });

    console.log(`[DL] ${url} (itag=${itag}, fmt=${format})`);
    const data = await getVideoData(url);

    const dur = parseInt(data.info.videoDetails.lengthSeconds);
    if (dur > MAX_DURATION) return res.status(400).json({ error: 'Vídeo muito longo.' });

    let sel;
    if (itag) sel = data.formats.find(f => f.itag === parseInt(itag) && f.url);
    if (!sel) {
      sel = (format === 'mp3' || format === 'audio')
        ? data.formats.filter(f => f.hasAudio && !f.hasVideo && f.url).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0]
        : data.formats.filter(f => f.hasAudio && f.hasVideo && f.url).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
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
      // Stream direto da URL (yt-dlp ou innertube)
      const resp2 = await fetch(sel.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.youtube.com' }
      });
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
      const { Readable } = require('stream');
      Readable.fromWeb(resp2.body).pipe(res);
    }
  } catch (e) {
    console.error(`[DL] ❌ ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YTDL API v3.1 porta ${PORT}`);
  console.log(`   Cookies: ${ytAgent ? 'ATIVOS' : 'NÃO'}`);
  console.log(`   CookiesTXT: ${hasCookiesTxt() ? 'SIM' : 'NÃO'}`);
  fetchFreeProxies().then(p => console.log(`   Proxies: ${p.length}`)).catch(() => {});
});
