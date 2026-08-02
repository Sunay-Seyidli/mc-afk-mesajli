/**
 * Minecraft AFK Client v3.0 - Ana Sunucu
 * 
 * Yeni özellikler:
 * - Bot koordinat, can, açlık takibi
 * - WASD hareket kontrolü (jump, sneak, sit)
 * - Bot başına özel script çalıştırma paneli
 * - Server Browser + Bot Kontrol Paneli
 * - mcstatus.io API ile sunucu ikonu, MOTD, oyuncu sayısı
 * - SOCKS5 proxy desteği
 * - Dinamik RAM limiti
 * 
 * @version 3.0.0
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const BotManager = require('./src/botManager');

// ── Express & HTTP Sunucu Kurulumu ──────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

// Server-side API Proxy for Minecraft Server Info/Icon (MCSrvStat) to avoid CORS issues
app.get('/api/server-info', async (req, res) => {
  try {
    const { ip, port } = req.query;
    if (!ip) {
      return res.status(400).json({ error: 'IP is required' });
    }
    const targetPort = port || '25565';
    
    // First attempt: mcstatus.io (very fast and reliable, contains full base64 image URL)
    try {
      const resp = await fetch(`https://api.mcstatus.io/v2/status/java/${ip}:${targetPort}`);
      if (resp.ok) {
        const mcData = await resp.json();
        if (mcData && mcData.online) {
          const cleanMotd = mcData.motd?.clean || mcData.motd?.raw || '';
          const rawMotd = mcData.motd?.raw || '';
          return res.json({
            online: true,
            motd: {
              clean: [cleanMotd],
              raw: [rawMotd]
            },
            players: {
              online: mcData.players?.online || 0,
              max: mcData.players?.max || 0
            },
            version: mcData.version?.name_clean || mcData.version?.name_raw || '1.20.1',
            icon: mcData.icon || null
          });
        }
      }
    } catch (err) {
      console.warn('[API Proxy mcstatus.io failed, trying fallback]', err.message);
    }

    // Fallback: api.mcsrvstat.us
    try {
      const resp = await fetch(`https://api.mcsrvstat.us/3/${ip}:${targetPort}`);
      if (resp.ok) {
        const mcsrvData = await resp.json();
        if (mcsrvData && mcsrvData.online) {
          const cleanArray = Array.isArray(mcsrvData.motd?.clean) 
            ? mcsrvData.motd.clean 
            : [mcsrvData.motd?.clean || ''];
          const rawArray = Array.isArray(mcsrvData.motd?.raw)
            ? mcsrvData.motd.raw
            : [mcsrvData.motd?.raw || ''];
          
          return res.json({
            online: true,
            motd: {
              clean: cleanArray,
              raw: rawArray
            },
            players: {
              online: mcsrvData.players?.online || 0,
              max: mcsrvData.players?.max || 0
            },
            version: typeof mcsrvData.version === 'string' ? mcsrvData.version : (mcsrvData.version?.name_clean || mcsrvData.version?.name || '1.20.1'),
            icon: mcsrvData.icon || null
          });
        }
      }
    } catch (err) {
      console.error('[API Proxy fallback mcsrvstat.us failed]', err.message);
    }

    // If both offline or failed
    res.json({ online: false });
  } catch (err) {
    console.error('[API Proxy General Error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Statik dosyalar
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Keep Alive / Ping endpoint for 7/24 hosting wake-ups (e.g. cron-job.org or uptime monitor)
app.get('/api/keep-alive', (req, res) => {
  const uptime = process.uptime();
  const formatUptime = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}s ${m}d ${s}sn`;
  };
  
  console.log(`[Keep-Alive] Ping received at ${new Date().toISOString()} from ${req.ip}. Uptime: ${formatUptime(uptime)}`);
  res.json({
    status: "alive",
    message: "Minecraft AFK Client keeps running! 🚀",
    timestamp: new Date().toISOString(),
    uptime: formatUptime(uptime),
    memory: botManager.getRamUsage()
  });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Bot Yöneticisi ──────────────────────────────────────────────
const botManager = new BotManager(io);

// ── Socket.io Olayları ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] İstemci bağlandı: ${socket.id}`);

  // Mevcut botları ve RAM kullanımını gönder
  socket.emit('ram-usage', botManager.getRamUsage());
  socket.emit('bot-update', botManager.getAllBots());

  // ── Bot Ekle ────────────────────────────────────────────────
  socket.on('add-bot', async (data) => {
    try {
      const result = await botManager.addBot(data);
      if (!result.success) {
        socket.emit('system-message', { type: 'error', text: result.message });
        return;
      }
      socket.emit('system-message', { type: 'success', text: result.message });
    } catch (err) {
      console.error('[Socket] add-bot hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Bot eklenirken beklenmeyen hata oluştu.' });
    }
  });

  // ── Toplu Bot Ekle (Server Browser'dan) ───────────────────
  socket.on('add-bots-batch', async (data) => {
    try {
      const { serverIp, port, version, proxy, botNames, joinMessage, joinMessageDelay } = data;
      const results = [];

      for (const botName of botNames) {
        const result = await botManager.addBot({
          ip: serverIp,
          port,
          botName,
          version,
          proxy,
          joinMessage,
          joinMessageDelay
        });
        results.push(result);
        await new Promise(r => setTimeout(r, 500));
      }

      const successCount = results.filter(r => r.success).length;
      socket.emit('system-message', { 
        type: 'success', 
        text: `${successCount}/${botNames.length} bot eklendi.` 
      });
    } catch (err) {
      console.error('[Socket] add-bots-batch hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Toplu ekleme hatası.' });
    }
  });

  // ── Oto Giriş Mesaj Ayarları Güncelle ──────────────────────
  socket.on('update-join-config', ({ botId, serverKey, joinMessage, joinMessageDelay, applyToAll }) => {
    try {
      const result = botManager.updateJoinConfig({ botId, serverKey, joinMessage, joinMessageDelay, applyToAll });
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      console.error('[Socket] update-join-config hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Giriş ayarları güncellenemedi.' });
    }
  });

  // ── Bot Çıkar ───────────────────────────────────────────────
  socket.on('remove-bot', (botId) => {
    try {
      const result = botManager.removeBot(botId);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] remove-bot hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Bot çıkarılırken hata oluştu.' });
    }
  });

  // ── Sunucudaki Tüm Botları Çıkar ────────────────────────────
  socket.on('remove-server-bots', (serverKey) => {
    try {
      const result = botManager.removeServerBots(serverKey);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] remove-server-bots hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Sunucu botları çıkarılırken hata.' });
    }
  });

  // ── Mesaj Gönder ────────────────────────────────────────────
  socket.on('send-message', ({ botId, message }) => {
    try {
      const result = botManager.sendMessage(botId, message);
      if (!result.success) {
        socket.emit('system-message', { type: 'error', text: result.message });
      }
    } catch (err) {
      console.error('[Socket] send-message hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Mesaj gönderilemedi.' });
    }
  });

  // ── Oyuncu Listesi İste ─────────────────────────────────────
  socket.on('request-player-list', (botId) => {
    try {
      const result = botManager.getPlayerList(botId);
      if (result.success) {
        socket.emit('player-list', { botId, players: result.players });
      } else {
        socket.emit('system-message', { type: 'error', text: result.message });
      }
    } catch (err) {
      console.error('[Socket] request-player-list hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Oyuncu listesi alınamadı.' });
    }
  });

  // ── Oyuncu Takip Et / Durdur ─────────────────────────────
  socket.on('follow-player', ({ botId, targetUsername }) => {
    try {
      const result = botManager.followPlayer(botId, targetUsername);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      console.error('[Socket] follow-player hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Takip başlatılamadı.' });
    }
  });

  socket.on('stop-follow', (botId) => {
    try {
      const result = botManager.stopFollow(botId);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      console.error('[Socket] stop-follow hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Takip durdurulamadı.' });
    }
  });

  // ── Anti-AFK Toggle ─────────────────────────────────────────
  socket.on('toggle-antiafk', ({ botId, enabled }) => {
    try {
      const result = botManager.toggleAntiAfk(botId, enabled);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] toggle-antiafk hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Anti-AFK ayarı değiştirilemedi.' });
    }
  });

  // ── Otomatik Yeniden Bağlanma Toggle ────────────────────────
  socket.on('toggle-autoreconnect', ({ botId, enabled }) => {
    try {
      const result = botManager.toggleAutoReconnect(botId, enabled);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] toggle-autoreconnect hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Otomatik yeniden bağlanma ayarı değiştirilemedi.' });
    }
  });

  // ── Tüm Botlarda Anti-AFK Toggle ──────────────────────────
  socket.on('toggle-all-antiafk', ({ serverKey, enabled }) => {
    try {
      const result = botManager.toggleAllAntiAfk(serverKey, enabled);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] toggle-all-antiafk hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Toplu Anti-AFK hatası.' });
    }
  });

  // ── Tüm Botlara Mesaj Gönder ──────────────────────────────
  socket.on('broadcast-message', ({ serverKey, message }) => {
    try {
      const result = botManager.broadcastMessage(serverKey, message);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
    } catch (err) {
      console.error('[Socket] broadcast-message hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Toplu mesaj hatası.' });
    }
  });

  // ── Bot Hareket Kontrolü ──────────────────────────────────
  socket.on('bot-move', ({ botId, action, state: moveState }) => {
    try {
      const result = botManager.handleBotMove(botId, action, moveState);
      if (!result.success) {
        socket.emit('system-message', { type: 'error', text: result.message });
      }
    } catch (err) {
      console.error('[Socket] bot-move hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Hareket komutu hatası.' });
    }
  });

  // ── Bot Script Çalıştır ───────────────────────────────────
  socket.on('run-bot-script', ({ botId, script }) => {
    try {
      const result = botManager.runBotScript(botId, script);
      socket.emit('system-message', { 
        type: result.success ? 'success' : 'error', 
        text: result.message 
      });
      if (result.output) {
        socket.emit('chat-message', { 
          botId, 
          type: 'system', 
          text: `[Script Output] ${result.output}`, 
          timestamp: new Date().toLocaleTimeString('tr-TR') 
        });
      }
    } catch (err) {
      console.error('[Socket] run-bot-script hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'Script çalıştırma hatası.' });
    }
  });

  // ── Bot Script Durdur ────────────────────────────────────
  socket.on('stop-bot-script', (botId) => {
    try {
      const result = botManager.stopBotScript(botId);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      socket.emit('system-message', { type: 'error', text: 'Script durdurulamadı.' });
    }
  });

  // ── Yapı İnşaatı Başlat / Durdur (Builder) ───────────────────
  socket.on('start-builder', ({ botId, structure, rotation, origin }) => {
    try {
      const result = botManager.startBuilder(botId, structure, rotation, origin);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      console.error('[Socket] start-builder hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'İnşaat başlatılamadı.' });
    }
  });

  socket.on('stop-builder', ({ botId }) => {
    try {
      const result = botManager.stopBuilder(botId);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.message
      });
    } catch (err) {
      console.error('[Socket] stop-builder hatası:', err);
      socket.emit('system-message', { type: 'error', text: 'İnşaat durdurulamadı.' });
    }
  });

  // ── Envanter İste ────────────────────────────────────────
  socket.on('get-inventory', (botId) => {
    try {
      const result = botManager.getInventory(botId);
      socket.emit('inventory-data', { botId, ...result });
    } catch (err) {
      socket.emit('inventory-data', { botId, success: false, message: 'Envanter alınamadı.' });
    }
  });

  // ── Envanter Aksiyonu ────────────────────────────────────
  socket.on('inventory-action', ({ botId, action, slot }) => {
    try {
      const result = botManager.doInventoryAction(botId, action, slot);
      socket.emit('system-message', {
        type: result.success ? 'success' : 'error',
        text: result.success ? 'Eylem gerçekleştirildi.' : result.message
      });
      // Güncel envanteri gönder
      setTimeout(() => {
        const inv = botManager.getInventory(botId);
        socket.emit('inventory-data', { botId, ...inv });
      }, 300);
    } catch (err) {
      socket.emit('system-message', { type: 'error', text: 'Envanter aksiyonu hatası.' });
    }
  });



  // ── Bağlantı Kopması ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] İstemci ayrıldı: ${socket.id}`);
  });
});

// ── RAM Kullanımı & Bot Durumu Periyodik Yayını ────────────────
setInterval(() => {
  io.emit('ram-usage', botManager.getRamUsage());
}, 3000);

// Bot durumlarını periyodik güncelle (koordinat, can, açlık)
setInterval(() => {
  const botData = botManager.getAllBotsWithStats();
  io.emit('bot-stats-update', botData);
}, 500);

// ── Sunucuyu Başlat ─────────────────────────────────────────────
const PORT = process.env.PORT || 7860;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   Minecraft AFK Client v3.0.0            ║`);
  console.log(`║   Port: ${PORT.toString().padEnd(33)}║`);
  console.log(`║   Mode: ${(process.env.PORT ? 'Render.com' : 'Local').padEnd(33)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

// Graceful shutdown and global protocol error handling
const isProtocolError = (err) => {
  if (!err) return false;
  const errStr = String(err.stack || err.message || err);
  const errName = String(err.name || err.constructor?.name || '');
  return (
    errName === 'PartialReadError' ||
    errStr.includes('PartialReadError') ||
    errStr.includes('Read error for') ||
    errStr.includes('protodef') ||
    errStr.includes('minecraft-protocol') ||
    errStr.includes('Deserialization error')
  );
};

process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err) || 'Uncaught Error';
  if (isProtocolError(err)) {
    console.log(`[Protocol Warning] Paket ayrıştırma uyarısı: ${msg}`);
    try {
      if (botManager && botManager.bots) {
        for (const [id, botData] of botManager.bots.entries()) {
          if (botData.status === 'connecting' || botData.status === 'online') {
            botData.status = 'error';
            botManager.emitChatMessage(id, 'error', `❌ Protokol Hatası: Sunucu paket yapısı uyumsuz (${msg}).`);
            botManager.emitBotUpdate();
            if (botData.connectTimeout) {
              clearTimeout(botData.connectTimeout);
            }
          }
        }
      }
    } catch (e) {}
    return;
  }
  console.log(`[Uncaught Exception Handled]: ${msg}`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason) || 'Unhandled Rejection';
  if (isProtocolError(reason)) {
    console.log(`[Protocol Promise Warning]: ${msg}`);
    return;
  }
  console.log(`[Unhandled Rejection Handled]: ${msg}`);
});

process.on('SIGTERM', () => {
  console.log('\n[SIGTERM] Sunucu kapatılıyor...');
  botManager.destroyAll();
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('\n[SIGINT] Sunucu kapatılıyor...');
  botManager.destroyAll();
  httpServer.close(() => process.exit(0));
});
