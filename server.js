/**
 * YTDL API v3.0 - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Estratégia anti-bloqueio:
 * 1) ytdl-core com cookies (rápido)
 * 2) yt-dlp com cookies + múltiplos clients
 * 3) yt-dlp com cookies + proxy gratuito rotativo
 * 
 * O proxy gratuito contorna o bloqueio de IP do datacenter.
 */

const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
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
    console.error(`[COOKIES] Erro ao carregar: ${e.message}`);
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
    console.log(`[COOKIES] Salvos ${cookies.length} cookies`);
    return true;
  } catch (e) {
    console.error(`[COOKIES] Erro: ${e.message}`);
    return false;
  }
}

function saveRawCookiesTxt(rawText) {
  try {
    fs.writeFileSync(COOKIES_TXT, rawText);
    console.log(`[COOKIES] Salvo cookies.txt original (${rawText.length} chars)`);
    const parsed = parseCookiesTxt(rawText);
    if (parsed.length > 0) {
      fs.writeFileSync(COOKIES_JSON, JSON.stringify({ cookies: parsed, savedAt: new Date().toISOString(), count: parsed.length }, null, 2));
      ytAgent = ytdl.createAgent(parsed);
      console.log(`[COOKIES] ytdl-core agent: ${parsed.length} cookies`);
    }
    return parsed.length;
  } catch (e) {
    console.error(`[COOKIES] Erro raw: ${e.message}`);
    return 0;
  }
}

loadCookies();

function getYtdlOptions() {
  return ytAgent ? { agent: ytAgent } : {};
}

function hasCookiesTxt() {
  return fs.existsSync(COOKIES_TXT);
}

function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(403).json({ error: 'Chave de API inválida' });
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
// PROXY GRATUITO
// ============================================================
let cachedProxies = [];
let lastProxyFetch = 0;
let workingProxy = null;
let workingProxyTime = 0;

async function fetchFreeProxies() {
  // Se buscou há menos de 5 minutos, usar cache
  if (Date.now() - lastProxyFetch < 300000 && cachedProxies.length > 0) {
    return cachedProxies;
  }

  const sources = [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=&ssl=all&anonymity=elite',
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=&ssl=all&anonymity=anonymous',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
  ];

  const proxies = new Set();
  
  for (const source of sources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(source, { signal: controller.signal });
      clearTimeout(timeout);
      const text = await resp.text();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(trimmed)) {
          proxies.add(trimmed);
        }
      }
    } catch (e) {
      console.log(`[PROXY] Fonte ${source.substring(0, 40)}... falhou: ${e.message?.substring(0, 30)}`);
    }
  }

  cachedProxies = [...proxies];
  lastProxyFetch = Date.now();
  console.log(`[PROXY] ${cachedProxies.length} proxies carregados`);
  
  // Embaralhar
  for (let i = cachedProxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cachedProxies[i], cachedProxies[j]] = [cachedProxies[j], cachedProxies[i]];
  }
  
  return cachedProxies;
}

// ============================================================
// CORE: Buscar info do vídeo
// ============================================================
async function getVideoData(url) {
  const errors = [];

  // FASE 1: ytdl-core direto (mais rápido, usa cookies se disponível)
  try {
    console.log(`[CORE] FASE 1: ytdl-core direto (cookies: ${ytAgent ? 'SIM' : 'NAO'})...`);
    const info = await Promise.race([
      ytdl.getInfo(url, getYtdlOptions()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
    ]);
    const playable = info.formats.filter(f => f.url);
    if (playable.length === 0) throw new Error('No playable formats');
    console.log(`[CORE] ✅ ytdl-core OK: ${playable.length} formatos`);
    return { source: 'ytdl-core', info, formats: info.formats };
  } catch (e1) {
    const msg = (e1.message || '').substring(0, 200);
    console.log(`[CORE] ❌ ytdl-core falhou: ${msg}`);
    errors.push(`ytdl-core: ${msg}`);
  }

  // FASE 2: yt-dlp direto com cookies + múltiplos clients
  const ytdlpClients = ['web', 'mweb', 'default'];
  for (const client of ytdlpClients) {
    try {
      console.log(`[CORE] FASE 2: yt-dlp client=${client} (cookies: ${hasCookiesTxt() ? 'SIM' : 'NAO'})...`);
      const opts = buildYtdlpOpts(client);
      const info = await Promise.race([
        youtubedl(url, opts),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 25s')), 25000))
      ]);
      const fmtsWithUrl = (info.formats || []).filter(f => f.url);
      if (fmtsWithUrl.length === 0) throw new Error('Sem formatos com URL');
      console.log(`[CORE] ✅ yt-dlp OK (client=${client}): "${info.title}" - ${fmtsWithUrl.length} formatos`);
      return convertYtdlpResult(info);
    } catch (e2) {
      const msg = ((e2.stderr || e2.message || String(e2))).substring(0, 300);
      console.log(`[CORE] ❌ yt-dlp client=${client}: ${msg.substring(0, 150)}`);
      errors.push(`yt-dlp(${client}): ${msg.substring(0, 80)}`);
    }
  }

  // FASE 3: yt-dlp com PROXY GRATUITO (contorna bloqueio de IP do datacenter)
  try {
    console.log(`[CORE] FASE 3: yt-dlp + proxy gratuito...`);
    
    // Se temos um proxy que funcionou recentemente (< 10 min), tenta ele primeiro
    if (workingProxy && Date.now() - workingProxyTime < 600000) {
      try {
        console.log(`[CORE] Tentando proxy cached: ${workingProxy}`);
        const opts = buildYtdlpOpts('web', `http://${workingProxy}`);
        const info = await Promise.race([
          youtubedl(url, opts),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
        ]);
        const fmtsWithUrl = (info.formats || []).filter(f => f.url);
        if (fmtsWithUrl.length === 0) throw new Error('Sem formatos');
        console.log(`[CORE] ✅ Proxy cached OK: "${info.title}" - ${fmtsWithUrl.length} formatos`);
        workingProxyTime = Date.now();
        return convertYtdlpResult(info);
      } catch (ce) {
        console.log(`[CORE] Proxy cached falhou: ${(ce.message || '').substring(0, 60)}`);
        workingProxy = null;
      }
    }
    
    // Buscar proxies frescos
    const proxies = await fetchFreeProxies();
    if (proxies.length === 0) throw new Error('Nenhum proxy disponível');
    
    // Testar até 15 proxies em lotes de 5 (3 lotes)
    const maxProxies = Math.min(15, proxies.length);
    const batchSize = 5;
    
    for (let batch = 0; batch < Math.ceil(maxProxies / batchSize); batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, maxProxies);
      const batchProxies = proxies.slice(start, end);
      
      console.log(`[CORE] Proxy lote ${batch + 1}: testando ${batchProxies.length} proxies...`);
      
      const promises = batchProxies.map(async (proxy) => {
        try {
          const opts = buildYtdlpOpts('web', `http://${proxy}`);
          const info = await Promise.race([
            youtubedl(url, opts),
            new Promise((_, reject) => setTimeout(() => reject(new Error('proxy timeout')), 20000))
          ]);
          const fmtsWithUrl = (info.formats || []).filter(f => f.url);
          if (fmtsWithUrl.length === 0) throw new Error('Sem formatos');
          return { proxy, info };
        } catch (e) {
          return { proxy, error: e.message?.substring(0, 80) };
        }
      });
      
      const results = await Promise.all(promises);
      const success = results.find(r => r.info);
      
      if (success) {
        console.log(`[CORE] ✅ Proxy ${success.proxy} funcionou: "${success.info.title}"`);
        workingProxy = success.proxy;
        workingProxyTime = Date.now();
        return convertYtdlpResult(success.info);
      }
      
      // Logar falhas
      results.forEach(r => {
        if (r.error) console.log(`[CORE] Proxy ${r.proxy}: ${r.error.substring(0, 60)}`);
      });
    }
    
    errors.push('proxy: Nenhum dos 15 proxies funcionou');
  } catch (proxyErr) {
    console.log(`[CORE] ❌ Fase proxy falhou: ${proxyErr.message?.substring(0, 100)}`);
    errors.push(`proxy: ${(proxyErr.message || '').substring(0, 80)}`);
  }

  const detailedError = `Todos os métodos falharam. ${errors.join(' | ')}`;
  console.log(`[CORE] ❌❌ ${detailedError}`);
  throw new Error(detailedError);
}

function buildYtdlpOpts(client, proxy) {
  const opts = {
    dumpSingleJson: true,
    noCheckCertificates: true,
    skipDownload: true,
    noPlaylist: true,
    geoBypass: true,
    addHeader: [
      'referer:https://www.youtube.com',
      'origin:https://www.youtube.com',
      'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ]
  };
  if (client && client !== 'default') {
    opts.extractorArgs = `youtube:player_client=${client}`;
  }
  if (hasCookiesTxt()) {
    opts.cookies = COOKIES_TXT;
  }
  if (proxy) {
    opts.proxy = proxy;
  }
  return opts;
}

function convertYtdlpResult(info) {
  const formats = (info.formats || [])
    .filter(f => f.url)
    .map(f => ({
      itag: f.format_id ? parseInt(f.format_id) || 0 : 0,
      url: f.url,
      mimeType: f.vcodec !== 'none' ? `video/${f.ext || 'mp4'}` : `audio/${f.ext || 'mp4'}`,
      qualityLabel: f.format_note || (f.height ? `${f.height}p` : ''),
      hasVideo: f.vcodec !== 'none',
      hasAudio: f.acodec !== 'none',
      height: f.height || 0,
      audioBitrate: f.abr || 0,
      contentLength: f.filesize ? String(f.filesize) : '0',
      container: f.ext || 'mp4',
      fps: f.fps || 30
    }));

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
    formats
  };
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', service: 'ytdl-api', version: '3.0.0',
    cookies: ytAgent ? 'configurados' : 'nao_configurados', 
    cookieFile: fs.existsSync(COOKIES_TXT),
    proxyCached: workingProxy || null,
    proxiesLoaded: cachedProxies.length
  });
});

// Debug
app.get('/api/debug', authenticate, async (req, res) => {
  try {
    const cookieFileExists = fs.existsSync(COOKIES_TXT);
    let cookieFileLines = 0, cookieFileHead = '';
    if (cookieFileExists) {
      const content = fs.readFileSync(COOKIES_TXT, 'utf8');
      cookieFileLines = content.split('\n').length;
      cookieFileHead = content.substring(0, 300);
    }
    let ytdlpVersion = 'unknown';
    try {
      const v = await youtubedl('--version');
      ytdlpVersion = typeof v === 'string' ? v.trim() : String(v).trim();
    } catch (e) { ytdlpVersion = 'error: ' + e.message?.substring(0, 100); }
    
    res.json({
      version: '3.0.0', ytdlpVersion, ytAgent: !!ytAgent,
      cookieFile: cookieFileExists, cookieFileLines,
      cookieFileHead,
      workingProxy, proxiesLoaded: cachedProxies.length,
      tmpFiles: fs.readdirSync('/tmp').filter(f => f.includes('cookie'))
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
    let cookies = req.body.cookies;
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'Cookies inválidos.' });
    }
    const ytCookies = cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
    if (ytCookies.length === 0) return res.status(400).json({ error: 'Nenhum cookie do YouTube/Google.' });
    if (saveCookies(ytCookies)) {
      res.json({ success: true, message: `${ytCookies.length} cookies salvos!`, count: ytCookies.length });
    } else {
      res.status(500).json({ error: 'Erro ao salvar cookies.' });
    }
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

// Info (POST - aceita cookies inline)
app.post('/api/info', authenticate, async (req, res) => {
  try {
    const url = req.body.url || req.query.url;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    if (req.body.cookiesTxt && typeof req.body.cookiesTxt === 'string') {
      const count = saveRawCookiesTxt(req.body.cookiesTxt);
      console.log(`[INFO] Cookies inline: ${count}`);
    } else if (req.body.cookies && Array.isArray(req.body.cookies) && req.body.cookies.length > 0) {
      const ytCookies = req.body.cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
      if (ytCookies.length > 0) { saveCookies(ytCookies); console.log(`[INFO] Cookies array: ${ytCookies.length}`); }
    }

    console.log(`[INFO] Buscando: ${url} (cookies: ${ytAgent ? 'SIM' : 'NAO'})`);
    const data = await getVideoData(url);

    const duration = parseInt(data.info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) {
      return res.status(400).json({ error: `Vídeo muito longo (${Math.ceil(duration / 60)} min). Limite: ${Math.ceil(MAX_DURATION / 60)} min.` });
    }

    const videoFormats = data.formats
      .filter(f => f.hasAudio && f.hasVideo && f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 6)
      .map(f => ({
        itag: f.itag, mimeType: f.mimeType || 'video/mp4',
        qualityLabel: f.qualityLabel || `${f.height}p`,
        container: f.container || 'mp4', contentLength: f.contentLength || '0',
        fps: f.fps || 30, hasAudio: true, hasVideo: true
      }));

    const audioFormats = data.formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
      .slice(0, 4)
      .map(f => ({
        itag: f.itag, mimeType: f.mimeType || 'audio/mp4',
        bitrate: f.audioBitrate || 0, quality: `${f.audioBitrate || 128}kbps`,
        container: f.container || 'mp4', contentLength: f.contentLength || '0',
        hasAudio: true, hasVideo: false
      }));

    const thumbnails = data.info.videoDetails.thumbnails || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';

    console.log(`[INFO] ✅ (${data.source}): "${data.info.videoDetails.title}" - ${videoFormats.length} video, ${audioFormats.length} audio`);

    return res.json({
      title: data.info.videoDetails.title, duration: data.info.videoDetails.lengthSeconds,
      thumbnail, author: data.info.videoDetails.author?.name || '',
      videoFormats, audioFormats, source: data.source
    });
  } catch (e) {
    console.error(`[INFO] ❌ FINAL: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// Info (GET)
app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[INFO] GET: ${url}`);
    const data = await getVideoData(url);

    const duration = parseInt(data.info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) {
      return res.status(400).json({ error: `Vídeo muito longo (${Math.ceil(duration / 60)} min). Limite: ${Math.ceil(MAX_DURATION / 60)} min.` });
    }

    const videoFormats = data.formats
      .filter(f => f.hasAudio && f.hasVideo && f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 6)
      .map(f => ({
        itag: f.itag, mimeType: f.mimeType || 'video/mp4',
        qualityLabel: f.qualityLabel || `${f.height}p`, container: f.container || 'mp4',
        contentLength: f.contentLength || '0', fps: f.fps || 30, hasAudio: true, hasVideo: true
      }));

    const audioFormats = data.formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
      .slice(0, 4)
      .map(f => ({
        itag: f.itag, mimeType: f.mimeType || 'audio/mp4', bitrate: f.audioBitrate || 0,
        quality: `${f.audioBitrate || 128}kbps`, container: f.container || 'mp4',
        contentLength: f.contentLength || '0', hasAudio: true, hasVideo: false
      }));

    const thumbnails = data.info.videoDetails.thumbnails || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';

    res.json({
      title: data.info.videoDetails.title, duration: data.info.videoDetails.lengthSeconds,
      thumbnail, author: data.info.videoDetails.author?.name || '',
      videoFormats, audioFormats, source: data.source
    });
  } catch (e) {
    console.error(`[INFO] ❌ FINAL: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Download
app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[DOWNLOAD] ${url} (itag=${itag}, format=${format})`);
    const data = await getVideoData(url);

    const duration = parseInt(data.info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) return res.status(400).json({ error: 'Vídeo muito longo.' });

    let selectedFormat;
    if (itag) selectedFormat = data.formats.find(f => f.itag === parseInt(itag) && f.url);
    if (!selectedFormat) {
      if (format === 'mp3' || format === 'audio') {
        selectedFormat = data.formats.filter(f => f.hasAudio && !f.hasVideo && f.url)
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
      } else {
        selectedFormat = data.formats.filter(f => f.hasAudio && f.hasVideo && f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      }
    }
    if (!selectedFormat) selectedFormat = data.formats.filter(f => f.url)[0];
    if (!selectedFormat) return res.status(404).json({ error: 'Formato não encontrado' });

    const title = (data.info.videoDetails.title || 'video').replace(/[^\w\s\-\u00C0-\u024F]/g, '').trim() || 'video';
    const isAudio = !selectedFormat.hasVideo;
    const ext = isAudio ? 'mp3' : (selectedFormat.container || 'mp4');

    console.log(`[DOWNLOAD] Streaming (${data.source}): "${title}.${ext}"`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.${ext}"`);
    res.setHeader('Content-Type', selectedFormat.mimeType || (isAudio ? 'audio/mpeg' : 'video/mp4'));
    if (selectedFormat.contentLength && selectedFormat.contentLength !== '0') {
      res.setHeader('Content-Length', selectedFormat.contentLength);
    }

    if (data.source === 'ytdl-core') {
      const stream = ytdl.downloadFromInfo(data.info, { format: selectedFormat, ...getYtdlOptions() });
      stream.on('error', (err) => {
        console.error(`[DOWNLOAD] stream error: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      stream.pipe(res);
    } else {
      // Stream via fetch da URL do yt-dlp
      const fetchResponse = await fetch(selectedFormat.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.youtube.com'
        }
      });
      if (!fetchResponse.ok) throw new Error(`HTTP ${fetchResponse.status}`);
      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(fetchResponse.body);
      nodeStream.pipe(res);
    }
  } catch (e) {
    console.error(`[DOWNLOAD] ERRO: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YTDL API v3.0 na porta ${PORT}`);
  console.log(`   Cookies: ${ytAgent ? 'ATIVOS' : 'NÃO CONFIGURADOS'}`);
  console.log(`   Cookies TXT: ${hasCookiesTxt() ? 'SIM' : 'NÃO'}`);
  // Pre-carregar proxies
  fetchFreeProxies().then(p => console.log(`   Proxies: ${p.length} carregados`)).catch(() => {});
});
