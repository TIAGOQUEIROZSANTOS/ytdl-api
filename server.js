/**
 * YTDL API - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Usa @distube/ytdl-core com cookies do YouTube para autenticação.
 * O admin exporta os cookies do navegador e envia via /api/cookies.
 * Os cookies são usados em todas as requisições ao YouTube.
 */

const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Chave de API simples para proteger o serviço
const API_KEY = process.env.API_KEY || 'seven7scala-ytdl-2024';

// Limite de duração (7 minutos = 420 segundos)
const MAX_DURATION = 420;

// ============================================================
// COOKIES - Gerenciamento de cookies do YouTube
// ============================================================
const COOKIES_FILE = path.join('/tmp', 'youtube-cookies.json');
let ytAgent = null;

function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      if (data.cookies && data.cookies.length > 0) {
        ytAgent = ytdl.createAgent(data.cookies);
        console.log(`[COOKIES] Carregados ${data.cookies.length} cookies (salvos em ${data.savedAt || 'desconhecido'})`);
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
    const data = { cookies, savedAt: new Date().toISOString(), count: cookies.length };
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(data, null, 2));
    ytAgent = ytdl.createAgent(cookies);
    console.log(`[COOKIES] Salvos ${cookies.length} cookies`);
    return true;
  } catch (e) {
    console.error(`[COOKIES] Erro ao salvar: ${e.message}`);
    return false;
  }
}

// Carregar cookies ao iniciar
loadCookies();

// Opções para ytdl com ou sem cookies
function getYtdlOptions() {
  if (ytAgent) {
    return { agent: ytAgent };
  }
  return {};
}

// Middleware de autenticação
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Chave de API inválida' });
  }
  next();
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ytdl-api',
    version: '2.0.0',
    cookies: ytAgent ? 'configurados' : 'nao_configurados'
  });
});

// ============================================================
// POST /api/cookies - Salvar cookies do YouTube
// Body: { cookies: [...] } ou { cookiesTxt: "..." }
// ============================================================
app.post('/api/cookies', authenticate, (req, res) => {
  try {
    let cookies = req.body.cookies;

    // Se veio no formato cookies.txt (Netscape), converter
    if (req.body.cookiesTxt) {
      cookies = parseCookiesTxt(req.body.cookiesTxt);
    }

    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'Cookies inválidos. Envie um array de cookies ou cookiesTxt no formato Netscape.' });
    }

    // Filtrar apenas cookies do YouTube/Google
    const ytCookies = cookies.filter(c =>
      c.domain && (
        c.domain.includes('youtube.com') ||
        c.domain.includes('google.com') ||
        c.domain.includes('.youtube.com') ||
        c.domain.includes('.google.com')
      )
    );

    if (ytCookies.length === 0) {
      return res.status(400).json({ error: 'Nenhum cookie do YouTube/Google encontrado.' });
    }

    if (saveCookies(ytCookies)) {
      res.json({ success: true, message: `${ytCookies.length} cookies salvos com sucesso!`, count: ytCookies.length });
    } else {
      res.status(500).json({ error: 'Erro ao salvar cookies.' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cookies/status - Verificar se cookies estão configurados
app.get('/api/cookies/status', authenticate, (req, res) => {
  loadCookies(); // Recarregar
  res.json({
    configured: !!ytAgent,
    file: fs.existsSync(COOKIES_FILE)
  });
});

// DELETE /api/cookies - Remover cookies
app.delete('/api/cookies', authenticate, (req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    ytAgent = null;
    res.json({ success: true, message: 'Cookies removidos.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Parser de cookies.txt (formato Netscape)
// ============================================================
function parseCookiesTxt(text) {
  const cookies = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0],
        httpOnly: parts[0].startsWith('#HttpOnly_') ? true : false,
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
// GET /api/info - Buscar informações do vídeo
// ============================================================
app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[INFO] Buscando: ${url} (cookies: ${ytAgent ? 'SIM' : 'NAO'})`);

    const options = getYtdlOptions();
    const info = await ytdl.getInfo(url, options);

    const duration = parseInt(info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) {
      return res.status(400).json({
        error: `Vídeo muito longo (${Math.ceil(duration / 60)} min). Limite: ${Math.ceil(MAX_DURATION / 60)} minutos.`
      });
    }

    // Formatos de vídeo com áudio (para download MP4)
    const videoFormats = info.formats
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

    // Formatos de áudio (para download MP3)
    const audioFormats = info.formats
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

    const thumbnail = info.videoDetails.thumbnails?.length > 0
      ? info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url
      : '';

    console.log(`[INFO] OK: "${info.videoDetails.title}" - ${videoFormats.length} video, ${audioFormats.length} audio`);

    res.json({
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds,
      thumbnail,
      author: info.videoDetails.author?.name || '',
      videoFormats,
      audioFormats
    });
  } catch (e) {
    console.error(`[INFO] ERRO: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/download - Fazer download/stream do vídeo
// ============================================================
app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[DOWNLOAD] Iniciando: ${url} (itag=${itag}, format=${format}, cookies: ${ytAgent ? 'SIM' : 'NAO'})`);

    const options = getYtdlOptions();
    const info = await ytdl.getInfo(url, options);

    const duration = parseInt(info.videoDetails.lengthSeconds);
    if (duration > MAX_DURATION) {
      return res.status(400).json({
        error: `Vídeo muito longo (${Math.ceil(duration / 60)} min). Limite: ${Math.ceil(MAX_DURATION / 60)} minutos.`
      });
    }

    // Selecionar formato
    let selectedFormat;
    if (itag) {
      selectedFormat = info.formats.find(f => f.itag === parseInt(itag));
    }
    if (!selectedFormat) {
      if (format === 'mp3' || format === 'audio') {
        selectedFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      } else {
        selectedFormat = info.formats
          .filter(f => f.hasAudio && f.hasVideo && f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (!selectedFormat) {
          selectedFormat = ytdl.chooseFormat(info.formats, { quality: 'highest' });
        }
      }
    }

    if (!selectedFormat) {
      return res.status(404).json({ error: 'Formato não encontrado' });
    }

    const title = info.videoDetails.title.replace(/[^\w\s\-\u00C0-\u024F]/g, '').trim() || 'video';
    const isAudio = !selectedFormat.hasVideo;
    const ext = isAudio ? 'mp3' : (selectedFormat.container || 'mp4');

    console.log(`[DOWNLOAD] Streaming: "${title}.${ext}" (itag=${selectedFormat.itag})`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.${ext}"`);
    res.setHeader('Content-Type', selectedFormat.mimeType || (isAudio ? 'audio/mpeg' : 'video/mp4'));
    if (selectedFormat.contentLength) {
      res.setHeader('Content-Length', selectedFormat.contentLength);
    }

    const downloadOptions = { format: selectedFormat, ...options };
    const stream = ytdl.downloadFromInfo(info, downloadOptions);

    stream.on('error', (err) => {
      console.error(`[DOWNLOAD] Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    stream.pipe(res);
  } catch (e) {
    console.error(`[DOWNLOAD] ERRO: ${e.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YTDL API v2.0 rodando na porta ${PORT}`);
  console.log(`   API Key: ${API_KEY}`);
  console.log(`   Cookies: ${ytAgent ? 'CONFIGURADOS' : 'NÃO CONFIGURADOS'}`);
});
