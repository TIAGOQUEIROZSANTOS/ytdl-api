/**
 * YTDL API v2.1 - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Usa ytdl-core + yt-dlp com cookies para autenticação.
 * 1) Tenta ytdl-core com cookies
 * 2) Se falhar, usa yt-dlp com cookies (mais robusto)
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
    // Salvar JSON para ytdl-core
    fs.writeFileSync(COOKIES_JSON, JSON.stringify({ cookies, savedAt: new Date().toISOString(), count: cookies.length }, null, 2));
    ytAgent = ytdl.createAgent(cookies);

    // Salvar formato Netscape para yt-dlp
    let txt = '# Netscape HTTP Cookie File\n';
    for (const c of cookies) {
      const httpOnly = c.httpOnly ? '#HttpOnly_' : '';
      txt += `${httpOnly}${c.domain}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${c.expires || 0}\t${c.name}\t${c.value}\n`;
    }
    fs.writeFileSync(COOKIES_TXT, txt);

    console.log(`[COOKIES] Salvos ${cookies.length} cookies (JSON + TXT)`);
    return true;
  } catch (e) {
    console.error(`[COOKIES] Erro ao salvar: ${e.message}`);
    return false;
  }
}

loadCookies();

function getYtdlOptions() {
  return ytAgent ? { agent: ytAgent } : {};
}

function hasCookiesTxt() {
  return fs.existsSync(COOKIES_TXT);
}

// Auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(403).json({ error: 'Chave de API inválida' });
  next();
}

// ============================================================
// Parser cookies.txt (Netscape)
// ============================================================
function parseCookiesTxt(text) {
  const cookies = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) continue;
    const clean = trimmed.startsWith('#HttpOnly_') ? trimmed.replace('#HttpOnly_', '') : trimmed;
    const parts = clean.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0],
        httpOnly: trimmed.startsWith('#HttpOnly_'),
        path: parts[2],
        secure: parts[3].toLowerCase() === 'true',
        expires: parseInt(parts[4]) || 0,
        name: parts[5],
        value: parts[6]
      });
    }
  }
  return cookies;
}

// ============================================================
// CORE: Buscar info via ytdl-core, fallback yt-dlp
// ============================================================
async function getVideoData(url) {
  // 1) Tentar ytdl-core
  try {
    console.log(`[CORE] Tentando ytdl-core (cookies: ${ytAgent ? 'SIM' : 'NAO'})...`);
    const info = await ytdl.getInfo(url, getYtdlOptions());
    const playable = info.formats.filter(f => f.url);
    if (playable.length === 0) throw new Error('No playable formats found');
    console.log(`[CORE] ytdl-core OK: ${playable.length} formatos`);
    return { source: 'ytdl-core', info, formats: info.formats };
  } catch (e1) {
    console.log(`[CORE] ytdl-core falhou: ${e1.message.substring(0, 100)}`);
  }

  // 2) Fallback: yt-dlp
  try {
    console.log(`[CORE] Tentando yt-dlp (cookies: ${hasCookiesTxt() ? 'SIM' : 'NAO'})...`);
    const opts = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      addHeader: ['referer:https://www.youtube.com', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
    };
    if (hasCookiesTxt()) {
      opts.cookies = COOKIES_TXT;
    }

    const info = await youtubedl(url, opts);
    console.log(`[CORE] yt-dlp OK: "${info.title}" - ${(info.formats || []).length} formatos`);

    // Converter formatos yt-dlp para formato compatível
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
  } catch (e2) {
    console.error(`[CORE] yt-dlp falhou: ${e2.message?.substring(0, 150) || e2}`);
    throw new Error(e2.message || 'Todos os métodos falharam');
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ytdl-api', version: '2.1.0', cookies: ytAgent ? 'configurados' : 'nao_configurados' });
});

// POST /api/cookies
app.post('/api/cookies', authenticate, (req, res) => {
  try {
    let cookies = req.body.cookies;
    if (req.body.cookiesTxt) cookies = parseCookiesTxt(req.body.cookiesTxt);
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'Cookies inválidos.' });
    }
    const ytCookies = cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
    if (ytCookies.length === 0) return res.status(400).json({ error: 'Nenhum cookie do YouTube/Google encontrado.' });
    if (saveCookies(ytCookies)) {
      res.json({ success: true, message: `${ytCookies.length} cookies salvos!`, count: ytCookies.length });
    } else {
      res.status(500).json({ error: 'Erro ao salvar cookies.' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cookies/status', authenticate, (req, res) => {
  loadCookies();
  res.json({ configured: !!ytAgent, file: fs.existsSync(COOKIES_JSON) });
});

app.delete('/api/cookies', authenticate, (req, res) => {
  try {
    if (fs.existsSync(COOKIES_JSON)) fs.unlinkSync(COOKIES_JSON);
    if (fs.existsSync(COOKIES_TXT)) fs.unlinkSync(COOKIES_TXT);
    ytAgent = null;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/info (aceita cookies inline) e GET /api/info
app.post('/api/info', authenticate, async (req, res) => {
  try {
    const url = req.body.url || req.query.url;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    // Se recebeu cookies inline, salvar para uso
    if (req.body.cookies && Array.isArray(req.body.cookies) && req.body.cookies.length > 0) {
      const ytCookies = req.body.cookies.filter(c => c.domain && (c.domain.includes('youtube.com') || c.domain.includes('google.com')));
      if (ytCookies.length > 0) {
        saveCookies(ytCookies);
        console.log(`[INFO] Cookies inline recebidos: ${ytCookies.length}`);
      }
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
        itag: f.itag,
        mimeType: f.mimeType || 'video/mp4',
        qualityLabel: f.qualityLabel || `${f.height}p`,
        container: f.container || 'mp4',
        contentLength: f.contentLength || '0',
        fps: f.fps || 30,
        hasAudio: true,
        hasVideo: true
      }));

    const audioFormats = data.formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
      .slice(0, 4)
      .map(f => ({
        itag: f.itag,
        mimeType: f.mimeType || 'audio/mp4',
        bitrate: f.audioBitrate || 0,
        quality: `${f.audioBitrate || 128}kbps`,
        container: f.container || 'mp4',
        contentLength: f.contentLength || '0',
        hasAudio: true,
        hasVideo: false
      }));

    const thumbnails = data.info.videoDetails.thumbnails || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';

    console.log(`[INFO] OK (${data.source}): "${data.info.videoDetails.title}" - ${videoFormats.length} video, ${audioFormats.length} audio`);

    return res.json({
      title: data.info.videoDetails.title,
      duration: data.info.videoDetails.lengthSeconds,
      thumbnail,
      author: data.info.videoDetails.author?.name || '',
      videoFormats,
      audioFormats,
      source: data.source
    });
  } catch (e) {
    console.error(`[INFO] ERRO FINAL: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[INFO] Buscando: ${url}`);
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
        itag: f.itag,
        mimeType: f.mimeType || 'video/mp4',
        qualityLabel: f.qualityLabel || `${f.height}p`,
        container: f.container || 'mp4',
        contentLength: f.contentLength || '0',
        fps: f.fps || 30,
        hasAudio: true,
        hasVideo: true
      }));

    const audioFormats = data.formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
      .slice(0, 4)
      .map(f => ({
        itag: f.itag,
        mimeType: f.mimeType || 'audio/mp4',
        bitrate: f.audioBitrate || 0,
        quality: `${f.audioBitrate || 128}kbps`,
        container: f.container || 'mp4',
        contentLength: f.contentLength || '0',
        hasAudio: true,
        hasVideo: false
      }));

    const thumbnails = data.info.videoDetails.thumbnails || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';

    console.log(`[INFO] OK (${data.source}): "${data.info.videoDetails.title}" - ${videoFormats.length} video, ${audioFormats.length} audio`);

    res.json({
      title: data.info.videoDetails.title,
      duration: data.info.videoDetails.lengthSeconds,
      thumbnail,
      author: data.info.videoDetails.author?.name || '',
      videoFormats,
      audioFormats,
      source: data.source
    });
  } catch (e) {
    console.error(`[INFO] ERRO FINAL: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/download
app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[DOWNLOAD] ${url} (itag=${itag}, format=${format})`);
    const data = await getVideoData(url);

    const duration = parseInt(data.info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) {
      return res.status(400).json({ error: 'Vídeo muito longo.' });
    }

    // Selecionar formato
    let selectedFormat;
    if (itag) {
      selectedFormat = data.formats.find(f => f.itag === parseInt(itag) && f.url);
    }
    if (!selectedFormat) {
      if (format === 'mp3' || format === 'audio') {
        selectedFormat = data.formats
          .filter(f => f.hasAudio && !f.hasVideo && f.url)
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
      } else {
        selectedFormat = data.formats
          .filter(f => f.hasAudio && f.hasVideo && f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      }
    }
    if (!selectedFormat) {
      // Fallback: pega qualquer formato disponível
      selectedFormat = data.formats.filter(f => f.url)[0];
    }
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
      // Stream via ytdl-core
      const stream = ytdl.downloadFromInfo(data.info, { format: selectedFormat, ...getYtdlOptions() });
      stream.on('error', (err) => {
        console.error(`[DOWNLOAD] ytdl-core stream error: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      stream.pipe(res);
    } else {
      // Stream via fetch direto da URL do yt-dlp
      const fetchResponse = await fetch(selectedFormat.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.youtube.com'
        }
      });
      if (!fetchResponse.ok) throw new Error(`HTTP ${fetchResponse.status}`);

      // Converter ReadableStream para Node stream
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
  console.log(`✅ YTDL API v2.1 na porta ${PORT}`);
  console.log(`   Cookies: ${ytAgent ? 'ATIVOS' : 'NÃO CONFIGURADOS'}`);
  console.log(`   Cookies TXT: ${hasCookiesTxt() ? 'SIM' : 'NÃO'}`);
});
