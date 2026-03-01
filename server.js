/**
 * YTDL API - Servidor de download do YouTube
 * Deploy gratuito no Render.com
 * 
 * Este servidor roda FORA do Google Cloud, usando IPs que o YouTube não bloqueia.
 * O Firebase Cloud Function chama este servidor para obter info e fazer download.
 */

const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

const app = express();
app.use(cors());
app.use(express.json());

// Chave de API simples para proteger o serviço
const API_KEY = process.env.API_KEY || 'seven7scala-ytdl-2024';

// Limite de duração (7 minutos = 420 segundos)
const MAX_DURATION = 420;

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
  res.json({ status: 'ok', service: 'ytdl-api', version: '1.0.0' });
});

// ============================================================
// GET /api/info - Buscar informações do vídeo
// Query params: url (YouTube URL), key (API key)
// ============================================================
app.get('/api/info', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[INFO] Buscando: ${url}`);
    const info = await ytdl.getInfo(url);

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
// Query params: url, itag, format (mp3/mp4), key
// ============================================================
app.get('/api/download', authenticate, async (req, res) => {
  try {
    const { url, itag, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    console.log(`[DOWNLOAD] Iniciando: ${url} (itag=${itag}, format=${format})`);
    const info = await ytdl.getInfo(url);

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
        // Pegar melhor formato com vídeo + áudio
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

    // Nome do arquivo
    const title = info.videoDetails.title.replace(/[^\w\s\-\u00C0-\u024F]/g, '').trim() || 'video';
    const isAudio = !selectedFormat.hasVideo;
    const ext = isAudio ? 'mp3' : (selectedFormat.container || 'mp4');

    console.log(`[DOWNLOAD] Streaming: "${title}.${ext}" (itag=${selectedFormat.itag})`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.${ext}"`);
    res.setHeader('Content-Type', selectedFormat.mimeType || (isAudio ? 'audio/mpeg' : 'video/mp4'));
    if (selectedFormat.contentLength) {
      res.setHeader('Content-Length', selectedFormat.contentLength);
    }

    const stream = ytdl.downloadFromInfo(info, { format: selectedFormat });

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
  console.log(`✅ YTDL API rodando na porta ${PORT}`);
  console.log(`   API Key: ${API_KEY}`);
});

