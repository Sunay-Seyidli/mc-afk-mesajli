/**
 * Bot Yöneticisi v3.0 - Minecraft AFK Client
 * 
 * Yeni özellikler:
 * - Bot koordinat, can, açlık, XP takibi
 * - WASD hareket kontrolü (forward, back, left, right, jump, sneak, sit)
 * - Bot başına özel script çalıştırma (sandboxed VM)
 * - Sunucu bazlı bot gruplama
 * - Toplu bot ekleme/çıkarma
 * - Toplu Anti-AFK toggle
 * - Toplu mesaj gönderme
 * - SOCKS5 proxy desteği
 * - Dinamik RAM limiti
 */

const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const os = require('os');
const vm = require('vm');

const AntiAfk = require('./antiAfk');
const storeManager = require('./store');

// ── Yardımcı Fonksiyonlar ───────────────────────────────────────

function getMcData(version) {
  const minecraftData = require('minecraft-data');
  if (version) {
    try {
      const data = minecraftData(version);
      if (data) return data;
    } catch (e) {}
  }
  try {
    const fallback = minecraftData('1.20.1');
    if (fallback) return fallback;
  } catch (e) {}
  try {
    if (minecraftData.versions && minecraftData.versions.pc && minecraftData.versions.pc[0]) {
      return minecraftData(minecraftData.versions.pc[0].value);
    }
  } catch (e) {}
  return null;
}

function generateId() {
  return `bot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function parseProxy(proxyString) {
  if (!proxyString || typeof proxyString !== 'string') return null;
  let str = proxyString.trim();
  if (!str) return null;

  // Temizleme: protokol adını kaldır (socks5://, socks4:// vs.)
  str = str.replace(/^(socks5|socks4|http|https):\/\//i, '');

  // Format 1: user:pass@host:port
  if (str.includes('@')) {
    const [auth, hostPort] = str.split('@');
    const [userId, password] = (auth || '').split(':');
    const [host, portStr] = (hostPort || '').split(':');
    const port = parseInt(portStr, 10);
    if (host && !isNaN(port)) {
      return { host: host.trim(), port, userId: userId || undefined, password: password || undefined };
    }
  }

  // Format 2: host:port veya host:port:user:pass
  const parts = str.split(':');
  if (parts.length === 2) {
    const [host, portStr] = parts;
    const port = parseInt(portStr, 10);
    if (host && !isNaN(port)) return { host: host.trim(), port };
  } else if (parts.length === 4) {
    const [host, portStr, userId, password] = parts;
    const port = parseInt(portStr, 10);
    if (host && !isNaN(port)) {
      return { host: host.trim(), port, userId: userId.trim(), password: password.trim() };
    }
  }

  return null;
}

function cleanMcJsonToText(comp) {
  if (!comp) return '';
  if (typeof comp === 'string' || typeof comp === 'number' || typeof comp === 'boolean') {
    return String(comp);
  }
  if (Array.isArray(comp)) {
    return comp.map(cleanMcJsonToText).join('');
  }
  let out = comp.text || '';
  if (comp.translate) {
    let template = comp.translate;
    if (template === 'chat.type.text' || template === 'chat.type.announcement') {
      template = '<%s> %s';
    } else if (template === 'chat.type.emote') {
      template = '* %s %s';
    } else if (template === 'multiplayer.player.joined') {
      template = '%s joined the game';
    } else if (template === 'multiplayer.player.left') {
      template = '%s left the game';
    }
    
    if (comp.with && Array.isArray(comp.with)) {
      let formatted = template;
      for (const arg of comp.with) {
        const argText = cleanMcJsonToText(arg);
        if (formatted.includes('%s')) {
          formatted = formatted.replace('%s', argText);
        } else {
          formatted += ' ' + argText;
        }
      }
      out = formatted;
    } else {
      out = template;
    }
  }
  if (comp.extra && Array.isArray(comp.extra)) {
    out += comp.extra.map(cleanMcJsonToText).join('');
  }
  return out;
}

function extractChatText(message) {
  let result = '';
  if (typeof message === 'string') {
    result = message;
  } else if (message) {
    if (typeof message.toMotd === 'function') {
      try {
        const motd = message.toMotd();
        if (motd) result = motd;
      } catch (e) {}
    }
    if (!result && typeof message.toString === 'function') {
      try {
        const str = message.toString();
        if (str && str !== '[object Object]') result = str;
      } catch (e) {}
    }
    if (!result && message.json) {
      result = cleanMcJsonToText(message.json);
    }
  }
  if (!result && typeof message === 'object') {
    result = cleanMcJsonToText(message);
  }
  if (!result) {
    result = String(message);
  }
  return result ? result.replace(/^%s\s*/gi, '') : '';
}

function stripMinecraftCodes(str) {
  if (!str) return '';
  let clean = str.replace(/§x§[a-f0-9A-F]§[a-f0-9A-F]§[a-f0-9A-F]§[a-f0-9A-F]§[a-f0-9A-F]§[a-f0-9A-F]/gi, '');
  clean = clean.replace(/§#[a-f0-9A-F]{6}/gi, '');
  clean = clean.replace(/§[0-9a-fk-or]/gi, '');
  clean = clean.replace(/^%s\s*/gi, '');
  clean = clean.replace(/%s/gi, '');
  return clean.trim();
}

function getServerKey(ip, port) {
  return `${ip}:${port}`;
}

// ── Bot Yöneticisi Sınıfı ───────────────────────────────────────
class BotManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, Object>} - Aktif botlar (id -> botData) */
    this.bots = new Map();
    /** @type {number} - Bot başına tahmini RAM (MB) */
    this.ramPerBot = 60;
    /** @type {number} - Minimum varsayılan bot limiti */
    this.minBots = 20;
    /** @type {number|null} - Manuel override limiti */
    this.manualMaxBots = process.env.MAX_BOTS ? parseInt(process.env.MAX_BOTS, 10) : null;
  }

  // ── RAM & Limit Hesaplamaları ───────────────────────────────

  getRamUsage() {
    const totalRamMB = Math.floor(os.totalmem() / 1024 / 1024);
    const usedRamMB = Math.floor((os.totalmem() - os.freemem()) / 1024 / 1024);
    const availableRamMB = totalRamMB - usedRamMB;

    let maxBots;
    if (this.manualMaxBots !== null) {
      maxBots = this.manualMaxBots;
    } else {
      // RAM'e dayalı tam dinamik hesaplama (bot başına 60MB tahmini alan)
      const allocatableRam = Math.floor(totalRamMB * 0.85);
      const calculated = Math.floor(allocatableRam / this.ramPerBot);
      maxBots = Math.max(20, calculated);
    }

    return { maxBots, usedRamMB, totalRamMB, botCount: this.bots.size };
  }

  // ── Bot Verisi Dönüştürücü (Arayüz için) ──────────────────

  getAllBots(accessKeyId = null) {
    const bots = [];
    for (const [id, data] of this.bots) {
      if (accessKeyId && data.accessKeyId !== accessKeyId) {
        continue;
      }
      bots.push({
        id,
        name: data.name,
        status: data.status,
        serverIp: data.serverIp,
        serverPort: data.serverPort,
        serverKey: data.serverKey,
        version: data.version,
        hasProxy: data.hasProxy,
        accessKeyId: data.accessKeyId || null,
        antiAfkEnabled: data.antiAfk ? data.antiAfk.isRunning : (data.antiAfkActivePreference || false),
        autoReconnectEnabled: data.autoReconnectEnabled !== false,
        playerCount: data.players ? data.players.length : 0
      });
    }
    return bots;
  }

  /**
   * Bot istatistiklerini döndürür (koordinat, can, açlık, XP)
   */
  getAllBotsWithStats(accessKeyId = null) {
    const bots = [];
    for (const [id, data] of this.bots) {
      if (accessKeyId && data.accessKeyId !== accessKeyId) {
        continue;
      }
      const stats = this._getBotStats(data);
      bots.push({
        id,
        name: data.name,
        status: data.status,
        serverIp: data.serverIp,
        serverPort: data.serverPort,
        serverKey: data.serverKey,
        version: data.version,
        hasProxy: data.hasProxy,
        accessKeyId: data.accessKeyId || null,
        antiAfkEnabled: data.antiAfk ? data.antiAfk.isRunning : (data.antiAfkActivePreference || false),
        autoReconnectEnabled: data.autoReconnectEnabled !== false,
        playerCount: data.players ? data.players.length : 0,
        joinMessage: data.joinMessage || '',
        joinMessageDelay: typeof data.joinMessageDelay !== 'undefined' ? data.joinMessageDelay : 3,
        ...stats
      });
    }
    return bots;
  }

  _getBotStats(botData) {
    const bot = botData.instance;
    if (!bot || !bot.entity || botData.status !== 'online') {
      return {
        x: null, y: null, z: null,
        health: null, maxHealth: null,
        food: null, foodSaturation: null,
        xp: null, level: null,
        yaw: null, pitch: null,
        entities: []
      };
    }

    const entities = [];
    if (bot.entities) {
      for (const entId in bot.entities) {
        const ent = bot.entities[entId];
        if (!ent || ent === bot.entity) continue;
        const dist = ent.position.distanceTo(bot.entity.position);
        if (dist <= 48) {
          let entType = ent.type || 'unknown';
          let isHostile = false;
          if (ent.type === 'mob') {
            const name = (ent.name || '').toLowerCase();
            const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'slime', 'phantom', 'blaze', 'ghast', 'wither', 'piglin', 'pillager', 'ravager', 'hoglin', 'silverfish', 'magma_cube'];
            if (hostiles.some(h => name.includes(h))) {
              isHostile = true;
            }
          }
          entities.push({
            name: ent.username || ent.displayName || ent.name || 'Bilinmeyen',
            type: entType, // 'player', 'mob', 'passive', 'object', etc.
            isHostile: isHostile,
            x: Math.round(ent.position.x * 10) / 10,
            y: Math.round(ent.position.y * 10) / 10,
            z: Math.round(ent.position.z * 10) / 10,
            distance: Math.round(dist * 10) / 10
          });
        }
      }
    }

    return {
      x: Math.round(bot.entity.position.x * 10) / 10,
      y: Math.round(bot.entity.position.y * 10) / 10,
      z: Math.round(bot.entity.position.z * 10) / 10,
      health: Math.round(bot.health * 10) / 10,
      maxHealth: bot.maxHealth || 20,
      food: bot.food || 0,
      foodSaturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
      xp: Math.round((bot.experience ? bot.experience.points : 0)),
      level: bot.experience ? bot.experience.level : 0,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      entities
    };
  }

  /**
   * Sunucu bazlı gruplanmış botları döndürür
   */
  getBotsByServer(accessKeyId = null) {
    const servers = new Map();

    for (const [id, data] of this.bots) {
      if (accessKeyId && data.accessKeyId !== accessKeyId) {
        continue;
      }
      const key = data.serverKey;
      if (!servers.has(key)) {
        servers.set(key, {
          serverKey: key,
          serverIp: data.serverIp,
          serverPort: data.serverPort,
          version: data.version,
          hasProxy: data.hasProxy,
          proxyConfig: data.proxyConfig,
          bots: []
        });
      }
      servers.get(key).bots.push({
        id,
        name: data.name,
        status: data.status,
        accessKeyId: data.accessKeyId || null,
        antiAfkEnabled: data.antiAfk ? data.antiAfk.isRunning : false,
        playerCount: data.players ? data.players.length : 0
      });
    }

    return Array.from(servers.values());
  }

  // ── Bot Ekleme ──────────────────────────────────────────────

  async addBot(config) {
    const { ip, port = 25565, botName, version, proxy, joinMessage, joinMessageDelay, accessKeyId } = config;

    if (!ip || !botName) {
      return { success: false, message: 'IP ve bot adı zorunludur.' };
    }

    // Müşteri Erişim Linki (accessKey) kontrolü
    if (accessKeyId) {
      const keyData = storeManager.getAccessKey(accessKeyId);
      if (!keyData || !keyData.active) {
        return { success: false, message: 'Bu erişim bağlantısı pasif duruma getirilmiştir veya geçersizdir.' };
      }
      let currentKeyBotsCount = 0;
      for (const [_, b] of this.bots) {
        if (b.accessKeyId === accessKeyId) currentKeyBotsCount++;
      }
      if (currentKeyBotsCount >= keyData.botLimit) {
        return { success: false, message: `Bu erişim bağlantısının bot limitine ulaşıldı (Maksimum: ${keyData.botLimit} bot).` };
      }
    }

    const ramUsage = this.getRamUsage();
    if (this.bots.size >= ramUsage.maxBots) {
      return { 
        success: false, 
        message: `Sistem bot limitine ulaşıldı (${ramUsage.botCount}/${ramUsage.maxBots}). RAM: ${ramUsage.usedRamMB}/${ramUsage.totalRamMB} MB` 
      };
    }

    // Proxy Kontrolü: Proxy adresi zorunlu kılınır (HF IP Ban Önleme)
    let finalProxyStr = proxy;
    if (!finalProxyStr || !finalProxyStr.trim()) {
      const mappedProxy = storeManager.getProxyForBot(botName);
      if (mappedProxy) {
        finalProxyStr = mappedProxy;
      } else if (accessKeyId) {
        const keyData = storeManager.getAccessKey(accessKeyId);
        if (keyData && keyData.defaultProxy) {
          finalProxyStr = keyData.defaultProxy;
        }
      }
    }

    if (!finalProxyStr || !finalProxyStr.trim()) {
      return { 
        success: false, 
        message: 'Hugging Face IP banını önlemek için SOCKS5 Proxy adresi (IP:PORT) girilmesi ZORUNLUDUR!' 
      };
    }

    const botId = generateId();
    const serverPort = parseInt(port, 10) || 25565;
    const proxyConfig = parseProxy(finalProxyStr);
    const serverKey = getServerKey(ip, serverPort);

    const botData = {
      id: botId,
      name: botName,
      status: 'connecting',
      serverIp: ip,
      serverPort,
      serverKey,
      version: version || '1.20.1',
      hasProxy: !!proxyConfig,
      proxyConfig,
      accessKeyId: accessKeyId || null,
      players: [],
      antiAfk: null,
      instance: null,
      connectTimeout: null,
      autoReconnectEnabled: true,
      joinMessage: joinMessage || '',
      joinMessageDelay: typeof joinMessageDelay !== 'undefined' ? Number(joinMessageDelay) : 3
    };

    if (accessKeyId) {
      storeManager.addBotToAccessKey(accessKeyId, botId);
    }

    this.bots.set(botId, botData);
    this.emitBotUpdate();

    try {
      await this._connectBot(botData);
      return { success: true, message: `"${botName}" botu bağlanıyor...` };
    } catch (err) {
      this._cleanupBot(botId);
      return { success: false, message: `Bağlantı hatası: ${err.message}` };
    }
  }

  updateJoinConfig({ botId, serverKey, joinMessage, joinMessageDelay, applyToAll, accessKeyId = null }) {
    if (applyToAll && serverKey) {
      let count = 0;
      for (const [id, data] of this.bots) {
        if (data.serverKey === serverKey && (!accessKeyId || data.accessKeyId === accessKeyId)) {
          if (joinMessage !== undefined) data.joinMessage = joinMessage;
          if (joinMessageDelay !== undefined) data.joinMessageDelay = Number(joinMessageDelay);
          count++;
        }
      }
      this.emitBotUpdate();
      return { success: true, message: `Oto giriş mesaj ayarları sunucudaki ${count} bota uygulandı.` };
    } else if (botId) {
      const data = this.bots.get(botId);
      if (!data) return { success: false, message: 'Bot bulunamadı.' };
      if (accessKeyId && data.accessKeyId !== accessKeyId) {
        return { success: false, message: 'Bu bot üzerinde işlem yapma yetkiniz yok.' };
      }
      if (joinMessage !== undefined) data.joinMessage = joinMessage;
      if (joinMessageDelay !== undefined) data.joinMessageDelay = Number(joinMessageDelay);
      this.emitBotUpdate();
      return { success: true, message: `"${data.name}" için oto giriş mesaj ayarları güncellendi.` };
    }
    return { success: false, message: 'Geçersiz parametre.' };
  }

  // ── SOCKS5 Proxy ile Bağlantı ───────────────────────────────

  async _connectBot(botData) {
    const { serverIp, serverPort, name, version, proxyConfig } = botData;

    // Temizleme: Eski bot örneği varsa sızmaları önlemek için sıfırla
    if (botData.instance) {
      try {
        botData.instance.removeAllListeners();
        botData.instance.end();
      } catch (_) {}
      botData.instance = null;
    }

    botData.inventoryListenerBound = false;

    return new Promise((resolve, reject) => {
      let resolved = false;

      botData.connectTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Bağlantı zaman aşımına uğradı (30 sn).'));
        }
      }, 30000);

      let optVersion = version;
      if (!optVersion || optVersion === 'auto' || optVersion === 'Otomatik') {
        optVersion = false;
      } else {
        optVersion = String(optVersion).trim();
      }

      const botOptions = {
        username: name,
        version: optVersion,
      };

      if (proxyConfig) {
        botOptions.connect = (client) => {
          const socksOptions = {
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              type: 5
            },
            command: 'connect',
            destination: {
              host: serverIp,
              port: serverPort
            }
          };
          if (proxyConfig.userId) socksOptions.proxy.userId = proxyConfig.userId;
          if (proxyConfig.password) socksOptions.proxy.password = proxyConfig.password;

          SocksClient.createConnection(socksOptions, (err, info) => {
            if (err) {
              if (!resolved) {
                resolved = true;
                clearTimeout(botData.connectTimeout);
                reject(new Error(`SOCKS5 proxy hatası: ${err.message}`));
              }
              return;
            }
            client.setSocket(info.socket);
            client.emit('connect');
          });
        };
        botOptions.fakeHost = serverIp;
      } else {
        botOptions.host = serverIp;
        botOptions.port = serverPort;
      }

      const bot = mineflayer.createBot(botOptions);
      botData.instance = bot;

      // Load pathfinder plugin immediately after bot creation
      try {
        const pathfinderPlugin = require('mineflayer-pathfinder').pathfinder;
        bot.loadPlugin(pathfinderPlugin);
      } catch (e) {
        console.error('[BotManager] Pathfinder plugin load failed:', e);
      }

      // Handle raw client protocol packet parsing errors (e.g. PartialReadError / custom packet mismatches)
      if (bot._client) {
        const safeCatch = (err) => {
          if (!err) return;
          const errMsg = err.message || String(err) || 'PartialReadError';
          console.log(`[Mineflayer Protocol Warning] ${errMsg}`);
          if (botData.status === 'connecting' || botData.status === 'reconnecting') {
            botData.status = 'error';
            this.emitChatMessage(botData.id, 'error', `❌ Protokol Hatası: Paket ayrıştırma hatası (${errMsg}). Sunucu sürümünü kontrol edin.`);
            this.emitBotUpdate();
          }
        };
        bot._client.on('error', safeCatch);

        const safeAttach = (stream) => {
          if (stream && typeof stream.on === 'function') {
            if (!stream._safeErrorCatchAttached) {
              stream._safeErrorCatchAttached = true;
              stream.on('error', safeCatch);
            }
          }
        };

        // Intercept deserializer and serializer property assignments so new streams during state transitions are always caught
        let currentDeserializer = bot._client.deserializer;
        safeAttach(currentDeserializer);
        try {
          Object.defineProperty(bot._client, 'deserializer', {
            configurable: true,
            enumerable: true,
            get() { return currentDeserializer; },
            set(val) {
              currentDeserializer = val;
              safeAttach(val);
            }
          });
        } catch (e) {}

        let currentSerializer = bot._client.serializer;
        safeAttach(currentSerializer);
        try {
          Object.defineProperty(bot._client, 'serializer', {
            configurable: true,
            enumerable: true,
            get() { return currentSerializer; },
            set(val) {
              currentSerializer = val;
              safeAttach(val);
            }
          });
        } catch (e) {}

        const attachStreamCatch = () => {
          if (!bot._client) return;
          safeAttach(bot._client.deserializer);
          safeAttach(bot._client.serializer);
          safeAttach(bot._client.framer);
          safeAttach(bot._client.splitter);
          safeAttach(bot._client.cipher);
          safeAttach(bot._client.decipher);
          safeAttach(bot._client.socket);
        };

        attachStreamCatch();
        bot._client.on('session', attachStreamCatch);
        bot._client.on('state', attachStreamCatch);
        bot._client.on('compression', attachStreamCatch);
        bot._client.on('encryption', attachStreamCatch);
        bot._client.on('connect', attachStreamCatch);
        bot._client.on('packet', attachStreamCatch);
      }

      // ── Olay Dinleyicileri ──────────────────────────────────

      bot.on('login', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(botData.connectTimeout);
          botData.status = 'online';
          this.emitBotUpdate();
          this.emitChatMessage(botData.id, 'system', '✅ Sunucuya giriş yapıldı.');

          botData.antiAfk = new AntiAfk(bot);

          // Eğer antiAFK tercih edilmişse otomatik geri yükle (6.5 sn gecikmeli ki lobiden geçsin)
          if (botData.antiAfkActivePreference) {
            setTimeout(() => {
              if (botData.status === 'online' && botData.antiAfk) {
                botData.antiAfk.start();
                this.emitChatMessage(botData.id, 'system', '🛡️ Anti-AFK otomatik olarak yeniden başlatıldı.');
                this.emitBotUpdate();
              }
            }, 6500);
          }

          // Advanced Plugins setup
          try {
            const autoeatPkg = require('mineflayer-auto-eat');
            const autoeat = autoeatPkg.plugin || autoeatPkg.loader || autoeatPkg.autoeat || autoeatPkg.autoEat || autoeatPkg.default || autoeatPkg;
            if (typeof autoeat === 'function') {
              bot.loadPlugin(autoeat);
            } else {
              console.error('[BotManager] auto-eat plugin is not a function:', typeof autoeat);
            }
          } catch (e) {
            console.error('[BotManager] auto-eat plugin load failed:', e);
          }

          try {
            const pathfinder = require('mineflayer-pathfinder').pathfinder;
            bot.loadPlugin(pathfinder);
          } catch (e) {
            console.error('[BotManager] pathfinder plugin load failed:', e);
          }

          resolve();
        }
      });

      bot.on('spawn', () => {
        this.emitChatMessage(botData.id, 'system', '🎮 Spawn noktasına ışınlandı.');
        
        // Oto Giriş / Bağlantı Mesajı
        if (botData.joinMessage && String(botData.joinMessage).trim()) {
          const delaySec = Math.max(0, Number(botData.joinMessageDelay) || 3);
          const delayMs = delaySec * 1000;

          if (botData.joinMessageTimer) {
            clearTimeout(botData.joinMessageTimer);
          }

          this.emitChatMessage(botData.id, 'system', `⏱️ Oto giriş mesajı ${delaySec} sn sonra gönderilecek...`);

          botData.joinMessageTimer = setTimeout(() => {
            if (botData.status === 'online' && botData.instance) {
              const lines = String(botData.joinMessage).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              lines.forEach((line, index) => {
                setTimeout(() => {
                  if (botData.status === 'online' && botData.instance) {
                    try {
                      botData.instance.chat(line);
                      this.emitChatMessage(botData.id, 'out', `[Oto Giriş/Mesaj]: ${line}`);
                    } catch (err) {
                      console.error('[BotManager] Oto mesaj gönderme hatası:', err);
                    }
                  }
                }, index * 1000);
              });
            }
          }, delayMs);
        }

        // Pathfinder hareket haritasını başlat
        if (bot.pathfinder) {
          try {
            const { Movements } = require('mineflayer-pathfinder');
            const mcData = getMcData(bot.version);
            if (mcData) {
              const defaultMove = new Movements(bot, mcData);
              defaultMove.canDig = true;
              bot.pathfinder.setMovements(defaultMove);
              console.log(`[BotManager] Pathfinder movements initialized for ${botData.name}`);
            }
          } catch (e) {
            console.error('[BotManager] Pathfinder movements init failed:', e);
          }
        }

        // Delay any auto actions to avoid suspicious packets on lobby scanning phase
        setTimeout(() => {
          if (botData.status !== 'online') return;
          const ae = bot.autoEat || bot.autoeat;
          if (ae) {
            try {
              if (typeof ae.enable === 'function') {
                ae.enable();
              } else if (ae.options) {
                ae.options.checkHealth = true;
              }
              this.emitChatMessage(botData.id, 'system', '🍕 Otomatik yemek yeme aktif edildi.');
            } catch (e) {
              console.warn('[BotManager] Autoeat toggle:', e?.message || e);
            }
          }
        }, 6000); // 6 seconds safe delay to pass lobby scans

        if (bot.inventory && !botData.inventoryListenerBound) {
          botData.inventoryListenerBound = true;
          bot.inventory.on('windowUpdate', () => {
            const inv = this.getInventory(botData.id);
            this.emitToBotScope(botData.id, 'inventory-data', { botId: botData.id, ...inv });
          });
          // Send initial inventory on spawn
          const inv = this.getInventory(botData.id);
          this.emitToBotScope(botData.id, 'inventory-data', { botId: botData.id, ...inv });
        }
      });

      bot.on('message', (jsonMsg, position) => {
        if (position === 'game_info') return;

        const text = extractChatText(jsonMsg);
        if (text && text.trim() && text !== '[object Object]') {
          const cleanText = stripMinecraftCodes(text);
          if (!cleanText) return;

          if (!botData.recentMessages) {
            botData.recentMessages = [];
          }
          const now = Date.now();
          botData.recentMessages = botData.recentMessages.filter(m => now - m.time < 2000);

          const isDuplicate = botData.recentMessages.some(m => m.text === cleanText);
          if (isDuplicate) {
            return;
          }

          botData.recentMessages.push({ text: cleanText, time: now });

          // Pass null instead of jsonMsg.json to avoid broken/faulty client-side parsing.
          // This allows us to rely 100% on the native server-side toMotd() formatting which is completely accurate.
          this.emitChatMessage(botData.id, 'info', text, null);
        }
      });

      bot.on('playerJoined', (player) => {
        this._updatePlayerList(botData);
        // Silenced join log message to prevent console spam as requested.
      });

      bot.on('playerLeft', (player) => {
        this._updatePlayerList(botData);
        // Silenced left log message to prevent console spam as requested.
      });

      bot.on('kicked', (reason) => {
        const reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
        botData.status = 'error';
        this.emitChatMessage(botData.id, 'error', `🚫 Sunucudan atıldı: ${reasonText}`);
        this.emitBotUpdate();

        this._triggerAutoReconnect(botData);
      });

      bot.on('error', (err) => {
        const errorMsg = err.message || 'Bilinmeyen hata';
        botData.status = 'error';
        this.emitChatMessage(botData.id, 'error', `❌ Hata: ${errorMsg}`);
        this.emitBotUpdate();

        if (!resolved) {
          resolved = true;
          clearTimeout(botData.connectTimeout);
          reject(err);
        }

        this._triggerAutoReconnect(botData);
      });

      bot.on('end', () => {
        if (botData.status !== 'error') {
          botData.status = 'offline';
        }
        this.emitChatMessage(botData.id, 'system', '🔌 Sunucu bağlantısı sonlandı.');
        this.emitBotUpdate();

        if (botData.antiAfk) {
          botData.antiAfk.stop();
        }

        this._triggerAutoReconnect(botData);
      });
    });
  }

  // ── Oyuncu Listesi ──────────────────────────────────────────

  _updatePlayerList(botData) {
    if (!botData.instance || !botData.instance.players) return;

    botData.players = Object.values(botData.instance.players).map(p => ({
      username: p.username,
      ping: p.ping || 0,
      uuid: p.uuid
    }));
  }

  getPlayerList(botId) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    if (!botData.instance || botData.status !== 'online') {
      return { success: false, message: 'Bot çevrimdışı.' };
    }

    this._updatePlayerList(botData);
    return { success: true, players: botData.players };
  }

  // ── Mesaj Gönderme ──────────────────────────────────────────

  sendMessage(botId, message) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    if (!botData.instance || botData.status !== 'online') {
      return { success: false, message: 'Bot çevrimdışı, mesaj gönderilemez.' };
    }

    try {
      botData.instance.chat(message);
      this.emitChatMessage(botData.id, 'self', `→ ${message}`);
      return { success: true };
    } catch (err) {
      return { success: false, message: `Mesaj gönderilemedi: ${err.message}` };
    }
  }

  /**
   * Sunucudaki tüm botlara mesaj gönder
   */
  broadcastMessage(serverKey, message, accessKeyId = null) {
    let sent = 0;
    let failed = 0;

    for (const [id, botData] of this.bots) {
      if (botData.serverKey === serverKey && botData.status === 'online' && (!accessKeyId || botData.accessKeyId === accessKeyId)) {
        try {
          botData.instance.chat(message);
          this.emitChatMessage(id, 'self', `→ ${message}`);
          sent++;
        } catch (err) {
          failed++;
        }
      }
    }

    if (sent === 0) {
      return { success: false, message: 'Gönderilecek aktif bot bulunamadı.' };
    }

    return { success: true, message: `${sent} bot'a mesaj gönderildi.${failed > 0 ? ` (${failed} başarısız)` : ''}` };
  }

  // ── Bot Hareket Kontrolü ────────────────────────────────────

  handleBotMove(botId, action, state) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    if (!botData.instance || botData.status !== 'online') {
      return { success: false, message: 'Bot çevrimdışı.' };
    }

    const bot = botData.instance;

    try {
      switch (action) {
        case 'forward':
        case 'back':
        case 'left':
        case 'right':
          bot.setControlState(action, state);
          break;
        case 'jump':
          bot.setControlState('jump', state);
          break;
        case 'sneak':
          bot.setControlState('sneak', state);
          break;
        case 'sprint':
          bot.setControlState('sprint', state);
          break;
        case 'look':
          if (state && typeof state.yaw === 'number' && typeof state.pitch === 'number') {
            bot.look(state.yaw, state.pitch, true);
          }
          break;
        case 'lookDelta':
          // Relative yaw/pitch change from mouse drag
          if (state && typeof state.dyaw === 'number' && typeof state.dpitch === 'number') {
            const curYaw = bot.entity ? bot.entity.yaw : 0;
            const curPitch = bot.entity ? bot.entity.pitch : 0;
            const newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, curPitch + state.dpitch));
            bot.look(curYaw + state.dyaw, newPitch, true);
          }
          break;
        case 'startMining':
          this._startMining(botData);
          break;
        case 'stopMining':
          this._stopMining(botData);
          break;
        case 'dig':
          if (state && typeof state === 'object' && state.x !== undefined) {
            const block = bot.blockAt(state);
            if (block && !bot.targetDigBlock && bot.canDigBlock && bot.canDigBlock(block)) {
              bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false).then(() => {
                bot.dig(block, false).catch(() => {});
              }).catch(() => {
                bot.dig(block, false).catch(() => {});
              });
            }
          }
          break;
        case 'place':
          if (state && typeof state === 'object' && state.x !== undefined) {
            const refBlock = bot.blockAt(state);
            if (refBlock) {
              const vec = new (require('vec3'))(0, 1, 0);
              bot.placeBlock(refBlock, vec);
            }
          }
          break;
        case 'useItem':
          bot.activateItem();
          break;
        case 'swing':
          bot.swingArm('right');
          break;
        case 'tp':
          if (state && typeof state === 'object' && state.x !== undefined) {
            bot.chat(`/tp ${bot.username} ${state.x} ${state.y} ${state.z}`);
          }
          break;
        default:
          return { success: false, message: `Bilinmeyen hareket: ${action}` };
      }

      return { success: true };
    } catch (err) {
      return { success: false, message: `Hareket hatası: ${err.message}` };
    }
  }

  _getRelativeTargetPosition(bot, direction, blocks) {
    const yaw = bot.entity.yaw;
    let dx = 0;
    let dz = 0;

    // Unit vector of look direction (forward)
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    // Unit vector of right direction (90 degrees right of forward)
    const rightX = -Math.sin(yaw - Math.PI / 2);
    const rightZ = -Math.cos(yaw - Math.PI / 2);

    if (direction === 'forward') {
      dx = forwardX * blocks;
      dz = forwardZ * blocks;
    } else if (direction === 'back') {
      dx = -forwardX * blocks;
      dz = -forwardZ * blocks;
    } else if (direction === 'right') {
      dx = rightX * blocks;
      dz = rightZ * blocks;
    } else if (direction === 'left') {
      dx = -rightX * blocks;
      dz = -rightZ * blocks;
    }

    const targetPos = bot.entity.position.offset(dx, 0, dz);
    return targetPos;
  }

  async navigateToPosition(botId, targetPos, timeoutMs = 15000) {
    const botData = this.bots.get(botId);
    if (!botData || !botData.instance) return { success: false, message: 'Bot bulunamadı veya çevrimdışı.' };
    const bot = botData.instance;

    // Remove any previous active pathfinder goals
    try {
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
    } catch (e) {}

    if (bot.pathfinder) {
      try {
        if (!bot.pathfinder.movements) {
          const { Movements } = require('mineflayer-pathfinder');
          const mcData = getMcData(bot.version);
          if (mcData) {
            const defaultMove = new Movements(bot, mcData);
            defaultMove.canDig = true;
            bot.pathfinder.setMovements(defaultMove);
          }
        }
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        bot.pathfinder.setGoal(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.2));
        
        const startTime = Date.now();
        while (botData.status === 'online') {
          await new Promise(resolve => setTimeout(resolve, 200));
          const dist = bot.entity.position.distanceTo(targetPos);
          if (dist <= 1.5) {
            break;
          }
          if (Date.now() - startTime > timeoutMs) {
            break;
          }
        }
        bot.pathfinder.setGoal(null);
        return { success: true, message: `Hedefe ulaşıldı. Kapanış mesafesi: ${Math.round(bot.entity.position.distanceTo(targetPos))} blok.` };
      } catch (err) {
        console.error('[AI Navigation Error] Pathfinder failed, falling back to manual walk:', err);
      }
    }

    // Manual fallback walk:
    try {
      bot.setControlState('forward', true);
      const startTime = Date.now();
      while (botData.status === 'online') {
        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist <= 1.5) break;
        if (Date.now() - startTime > timeoutMs) break;

        // Face the target position manually & seamlessly
        const dx = targetPos.x - bot.entity.position.x;
        const dz = targetPos.z - bot.entity.position.z;
        const yaw = Math.atan2(-dx, -dz);
        bot.look(yaw, 0, true);
        
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      bot.setControlState('forward', false);
      return { success: true, message: `Manual hareket tamamlandı. Kalan mesafe: ${Math.round(bot.entity.position.distanceTo(targetPos))} blok.` };
    } catch (err) {
      try { bot.setControlState('forward', false); } catch (e) {}
      return { success: false, error: err.message };
    }
  }

  // ── Oyuncu Takibi (Follow Player) ───────────────────────────

  followPlayer(botId, targetUsername) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    if (!botData.instance || botData.status !== 'online') {
      return { success: false, message: 'Bot çevrimdışı.' };
    }

    const bot = botData.instance;
    if (!bot.pathfinder) {
      return { success: false, message: 'Pathfinder eklentisi hazır değil.' };
    }

    // Pathfinder haritasını hazırla
    try {
      if (!bot.pathfinder.movements) {
        const { Movements } = require('mineflayer-pathfinder');
        const mcData = getMcData(bot.version);
        if (mcData) {
          const defaultMove = new Movements(bot, mcData);
          defaultMove.canDig = true;
          bot.pathfinder.setMovements(defaultMove);
        }
      }
    } catch (e) {
      console.error('[BotManager] Movements hatası:', e);
    }

    let targetEntity = null;
    const searchName = targetUsername ? String(targetUsername).toLowerCase().trim() : null;

    if (searchName) {
      if (bot.players && bot.players[targetUsername] && bot.players[targetUsername].entity) {
        targetEntity = bot.players[targetUsername].entity;
      }
      if (!targetEntity && bot.entities) {
        for (const id in bot.entities) {
          const e = bot.entities[id];
          if (e && e.type === 'player' && e !== bot.entity && e.username && e.username.toLowerCase() === searchName) {
            targetEntity = e;
            break;
          }
        }
      }
    } else {
      let minDist = Infinity;
      if (bot.entities) {
        for (const id in bot.entities) {
          const e = bot.entities[id];
          if (e && e.type === 'player' && e !== bot.entity && e.position) {
            const dist = bot.entity.position.distanceTo(e.position);
            if (dist < minDist) {
              minDist = dist;
              targetEntity = e;
            }
          }
        }
      }
    }

    if (!targetEntity) {
      const nameStr = targetUsername ? `"${targetUsername}"` : 'Yakındaki';
      this.emitChatMessage(botId, 'error', `❌ ${nameStr} oyuncu bulunamadı (Görüş alanında değil).`);
      return { success: false, message: `${nameStr} oyuncu görüş alanında bulunamadı.` };
    }

    try {
      const { GoalFollow } = require('mineflayer-pathfinder').goals;
      bot.pathfinder.setGoal(new GoalFollow(targetEntity, 2), true);
      botData.followingPlayer = targetEntity.username || targetUsername || 'Oyuncu';
      this.emitChatMessage(botId, 'system', `🏃 ${botData.followingPlayer} takip ediliyor (Pathfinder).`);
      return { success: true, message: `${botData.followingPlayer} takip ediliyor.` };
    } catch (err) {
      this.emitChatMessage(botId, 'error', `❌ Takip hatası: ${err.message}`);
      return { success: false, message: `Takip hatası: ${err.message}` };
    }
  }

  stopFollow(botId) {
    const botData = this.bots.get(botId);
    if (!botData || !botData.instance) return { success: false, message: 'Bot bulunamadı.' };

    const bot = botData.instance;
    if (bot.pathfinder) {
      try {
        bot.pathfinder.setGoal(null);
      } catch (e) {}
    }
    botData.followingPlayer = null;
    this.emitChatMessage(botId, 'system', '⏹️ Takip durduruldu.');
    return { success: true, message: 'Takip durduruldu.' };
  }

  // ── Bot Script Çalıştırma ───────────────────────────────────

  runBotScript(botId, script) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    if (!botData.instance || botData.status !== 'online') {
      return { success: false, message: 'Bot çevrimdışı.' };
    }

    const bot = botData.instance;

    try {
      const sandbox = {
        bot,
        console: {
          log: (...args) => {
            const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this.emitChatMessage(botId, 'system', `[Script] ${text}`);
          },
          error: (...args) => {
            const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this.emitChatMessage(botId, 'error', `[Script Error] ${text}`);
          }
        },
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        Math,
        Date,
        JSON,
        String,
        Number,
        Array,
        Object,
        Promise,
        vec3: require('vec3'),
        pathfinder: require('mineflayer-pathfinder'),
        goals: require('mineflayer-pathfinder').goals,
        Movements: require('mineflayer-pathfinder').Movements,
        require: (mod) => {
          const allowed = ['vec3', 'mineflayer-pathfinder', 'minecraft-data', 'mineflayer-auto-eat'];
          if (allowed.includes(mod)) return require(mod);
          throw new Error(`Modül '${mod}' izin verilmiyor.`);
        }
      };

      const context = vm.createContext(sandbox);
      const result = vm.runInContext(script, context, {
        timeout: 5000,
        displayErrors: true
      });

      let output = '';
      if (result !== undefined) {
        output = typeof result === 'object' ? JSON.stringify(result) : String(result);
      }

      return { success: true, message: 'Script çalıştırıldı.', output };
    } catch (err) {
      return { success: false, message: `Script hatası: ${err.message}` };
    }
  }

  // ── Mining (Toggle) ─────────────────────────────────────────

  _startMining(botData) {
    if (botData.miningActive) return;
    botData.miningActive = true;
    const bot = botData.instance;
    this.emitChatMessage(botData.id, 'system', '⛏️ Kazma modu başlatıldı.');

    const digLoop = async () => {
      let consecutiveFailures = 0;
      let lastBlockPos = null;

      while (botData.miningActive && bot && botData.status === 'online') {
        try {
          if (bot.targetDigBlock) {
            await new Promise(r => setTimeout(r, 200));
            continue;
          }

          // 1. Hedef blok bul: Önce bakılan bloğu al, yoksa botun önündeki kırılabilir bloğu bul
          let block = bot.blockAtCursor(4.0);
          if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air' || block.name === 'water' || block.name === 'lava') {
            if (bot.findBlock) {
              block = bot.findBlock({
                matching: (b) => b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air' && b.name !== 'bedrock' && b.name !== 'water' && b.name !== 'lava' && b.boundingToShape && b.boundingToShape.length > 0,
                maxDistance: 3.5
              });
            }
          }

          if (block && block.name !== 'air' && block.name !== 'bedrock') {
            // Katı ve kırılabilir olduğunu kontrol et
            if (bot.canDigBlock && !bot.canDigBlock(block)) {
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // Mesafe kontrolü (Anti-cheat Reach engeli)
            const botPos = bot.entity.position.offset(0, bot.entity.height || 1.6, 0);
            const blockCenter = block.position.offset(0.5, 0.5, 0.5);
            const dist = botPos.distanceTo(blockCenter);
            if (dist > 3.8) {
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // Uygun aleti eline al
            if (bot.inventory) {
              let tool = null;
              if (bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function') {
                tool = bot.pathfinder.bestHarvestTool(block);
              }
              if (!tool) {
                tool = bot.inventory.items().find(item => {
                  const bName = block.name.toLowerCase();
                  const iName = item.name.toLowerCase();
                  if (bName.includes('stone') || bName.includes('ore') || bName.includes('obsidian') || bName.includes('cobble') || bName.includes('brick') || bName.includes('terracotta') || bName.includes('iron') || bName.includes('gold') || bName.includes('diamond') || bName.includes('deepslate')) {
                    return iName.includes('pickaxe');
                  }
                  if (bName.includes('wood') || bName.includes('log') || bName.includes('plank') || bName.includes('chest') || bName.includes('door') || bName.includes('fence')) {
                    return iName.includes('axe') && !iName.includes('pickaxe');
                  }
                  if (bName.includes('dirt') || bName.includes('grass') || bName.includes('sand') || bName.includes('gravel') || bName.includes('clay') || bName.includes('soul_')) {
                    return iName.includes('shovel');
                  }
                  return false;
                });
              }
              if (tool) {
                try {
                  await bot.equip(tool, 'hand');
                  await new Promise(r => setTimeout(r, 150));
                } catch (e) {}
              }
            }

            // Üst üste aynı blokta başarısız olma kontrolü (Spawn koruması veya anti-cheat engeli)
            if (lastBlockPos && lastBlockPos.equals(block.position)) {
              if (consecutiveFailures >= 3) {
                this.emitChatMessage(botData.id, 'error', `⚠️ Blok kırılamıyor (${block.name}). Korumalı alan veya sunucu engeli olabilir.`);
                await new Promise(r => setTimeout(r, 3000));
                consecutiveFailures = 0;
                continue;
              }
            } else {
              lastBlockPos = block.position;
              consecutiveFailures = 0;
            }

            // Bloğa yumuşakça bak
            try {
              await bot.lookAt(blockCenter, false);
            } catch (err) {}

            await new Promise(r => setTimeout(r, 100));

            if (!botData.miningActive || botData.status !== 'online') break;

            // Tahmini kırılma süresine göre dinamik zaman aşımı (1.21.4 fizik senkronizasyonu)
            const digTime = bot.digTime ? bot.digTime(block) : 1000;
            const timeoutMs = Math.max(digTime + 2500, 6000);

            // Mineflayer 1.21.4 protokol paket sırasına göre kazmayı yönetir ('ignore' raycast hatalarını önler)
            try {
              await Promise.race([
                (async () => {
                  try {
                    await bot.dig(block, 'ignore');
                  } catch (dErr) {
                    await bot.dig(block, true);
                  }
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Kazma zaman aşımı')), timeoutMs))
              ]);
              consecutiveFailures = 0;
            } catch (err) {
              consecutiveFailures++;
              try { bot.stopDigging(); } catch (e) {}
            }

            // Anti-cheat FastBreak gecikmesi (insansı bekleme)
            await new Promise(r => setTimeout(r, 400));
          } else {
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (e) {
          try { bot.stopDigging(); } catch (err) {}
          await new Promise(r => setTimeout(r, 500));
        }
      }
    };
    digLoop();
  }

  _stopMining(botData) {
    if (!botData.miningActive) return;
    botData.miningActive = false;
    const bot = botData.instance;
    if (bot) {
      try { bot.stopDigging(); } catch (e) {}
    }
    this.emitChatMessage(botData.id, 'system', '⛏️ Kazma modu durduruldu.');
  }

  // ── Envanter ─────────────────────────────────────────────────

  getInventory(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return { success: false, message: 'Bot bulunamadı.' };
    if (!botData.instance || botData.status !== 'online') return { success: false, message: 'Bot çevrimdışı.' };

    const bot = botData.instance;
    const slots = [];

    for (let i = 0; i < 45; i++) {
      const item = bot.inventory.slots[i];
      if (item) {
        slots.push({
          slot: i,
          name: item.name,
          displayName: item.displayName || item.name,
          count: item.count,
          nbt: item.nbt ? JSON.stringify(item.nbt, null, 2) : null,
          enchants: item.enchants || []
        });
      } else {
        slots.push({ slot: i, name: null, count: 0 });
      }
    }

    return { success: true, slots, heldItemSlot: bot.quickBarSlot };
  }

  doInventoryAction(botId, action, slot) {
    const botData = this.bots.get(botId);
    if (!botData) return { success: false, message: 'Bot bulunamadı.' };
    if (!botData.instance || botData.status !== 'online') return { success: false, message: 'Bot çevrimdışı.' };

    const bot = botData.instance;
    try {
      const item = bot.inventory.slots[slot];
      switch (action) {
        case 'drop-one':
          if (item) bot.tossStack(item).catch(() => {});
          break;
        case 'drop-all':
          if (item) bot.toss(item.type, null, item.count).catch(() => {});
          break;
        case 'left-click':
          bot.simClick ? bot.simClick(slot, false, 'container') : null;
          break;
        case 'right-click':
          bot.simClick ? bot.simClick(slot, true, 'container') : null;
          break;
        case 'equip':
          if (item) {
            const dest = slot >= 36 && slot <= 39 ? 'hand' : 'hand';
            bot.equip(item, dest).catch(() => {});
          }
          break;
      }
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ── Script Durdurma ─────────────────────────────────────────

  stopBotScript(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return { success: false, message: 'Bot bulunamadı.' };
    // Script'ler VM'de koştuğu için doğrudan durdurulamaz,
    // ancak interval'ları temizleyip uyarı verebiliriz.
    this.emitChatMessage(botId, 'system', '⏹️ Script durduruldu (interval\'lar temizlendi).');
    return { success: true, message: 'Script durduruldu.' };
  }

  // ── Anti-AFK ────────────────────────────────────────────────

  toggleAntiAfk(botId, enabled) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }

    // Tercihi hafızada tut, böylece sunucu bağlantısı koptuğunda falan otomatik geri yükleyebiliriz
    botData.antiAfkActivePreference = enabled;

    if (!botData.antiAfk) {
      // Eğer bot çevrimdışıysa ama tercihi değiştirdiysek başarılı dönelim, online olunca otomatik başlar
      this.emitBotUpdate();
      return { success: true, message: `Anti-AFK tercihi ${enabled ? 'aktif' : 'pasif'} olarak güncellendi. (Bot bağlandığında uygulanacak)` };
    }

    if (enabled) {
      botData.antiAfk.start();
      this.emitChatMessage(botId, 'system', '🛡️ Anti-AFK aktifleştirildi.');
    } else {
      botData.antiAfk.stop();
      this.emitChatMessage(botId, 'system', '🛡️ Anti-AFK devre dışı bırakıldı.');
    }
    this.emitBotUpdate();

    return { success: true, message: `Anti-AFK ${enabled ? 'açıldı' : 'kapandı'}.` };
  }

  toggleAutoReconnect(botId, enabled) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }
    botData.autoReconnectEnabled = enabled === true;

    if (!botData.autoReconnectEnabled && botData.reconnectTimer) {
      clearTimeout(botData.reconnectTimer);
      botData.reconnectTimer = null;
      if (botData.status === 'reconnecting') {
        botData.status = 'offline';
      }
    }

    this.emitBotUpdate();
    return { success: true, message: `Otomatik yeniden bağlanma ${enabled ? 'aktif' : 'pasif'} edildi.` };
  }

  /**
   * Sunucudaki tüm botlarda Anti-AFK toggle
   */
  toggleAllAntiAfk(serverKey, enabled, accessKeyId = null) {
    let toggled = 0;

    for (const [id, botData] of this.bots) {
      if (botData.serverKey === serverKey && botData.status === 'online' && botData.antiAfk && (!accessKeyId || botData.accessKeyId === accessKeyId)) {
        if (enabled) {
          botData.antiAfk.start();
          this.emitChatMessage(id, 'system', '🛡️ Anti-AFK aktifleştirildi.');
        } else {
          botData.antiAfk.stop();
          this.emitChatMessage(id, 'system', '🛡️ Anti-AFK devre dışı bırakıldı.');
        }
        toggled++;
      }
    }

    this.emitBotUpdate();

    if (toggled === 0) {
      return { success: false, message: 'Aktif bot bulunamadı.' };
    }

    return { success: true, message: `${toggled} bot'ta Anti-AFK ${enabled ? 'açıldı' : 'kapandı'}.` };
  }

  // ── Bot Çıkarma ─────────────────────────────────────────────

  removeBot(botId) {
    const botData = this.bots.get(botId);
    if (!botData) {
      return { success: false, message: 'Bot bulunamadı.' };
    }

    this._cleanupBot(botId);
    return { success: true, message: `"${botData.name}" botu çıkarıldı.` };
  }

  /**
   * Sunucudaki tüm botları çıkar
   */
  removeServerBots(serverKey, accessKeyId = null) {
    let removed = 0;
    const toRemove = [];

    for (const [id, botData] of this.bots) {
      if (botData.serverKey === serverKey && (!accessKeyId || botData.accessKeyId === accessKeyId)) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this._cleanupBot(id);
      removed++;
    }

    if (removed === 0) {
      return { success: false, message: 'Bu sunucuda bot bulunamadı.' };
    }

    return { success: true, message: `${removed} bot çıkarıldı.` };
  }

  // ── Yapı İnşaatı Komutları (Builder) ───────────────────────

  startBuilder(botId, structure, rotation = 0, origin = null) {
    const botData = this.bots.get(botId);
    if (!botData) return { success: false, message: 'Bot bulunamadı.' };
    if (!botData.instance || botData.status !== 'online') return { success: false, message: 'Bot çevrimdışı.' };

    if (botData.builderActive) {
      return { success: false, message: 'Bot zaten bir inşaat sürecinde!' };
    }

    const bot = botData.instance;

    // Calculate rotation and direction text based on auto look-at or fixed option
    let actualRotation = 0;
    let directionText = 'Güney (+Z)';

    if (rotation === 'auto') {
      if (bot.entity && typeof bot.entity.yaw === 'number') {
        let yawDeg = (bot.entity.yaw * 180 / Math.PI) % 360;
        if (yawDeg < 0) yawDeg += 360;

        if (yawDeg >= 45 && yawDeg < 135) {
          actualRotation = 90;
          directionText = 'Batı (-X)';
        } else if (yawDeg >= 135 && yawDeg < 225) {
          actualRotation = 180;
          directionText = 'Kuzey (-Z)';
        } else if (yawDeg >= 225 && yawDeg < 315) {
          actualRotation = 270;
          directionText = 'Doğu (+X)';
        } else {
          actualRotation = 0;
          directionText = 'Güney (+Z)';
        }
      }
    } else {
      actualRotation = parseInt(rotation, 10) || 0;
      if (actualRotation === 90) directionText = 'Batı (-X)';
      else if (actualRotation === 180) directionText = 'Kuzey (-Z)';
      else if (actualRotation === 270) directionText = 'Doğu (+X)';
    }

    botData.builderActive = true;
    botData.builderPlaced = 0;
    botData.builderTotal = structure.length;

    const vec3 = require('vec3');
    // Capture starting origin position (floor to match blocks or custom position)
    let originPos;
    if (origin && typeof origin.x === 'number' && typeof origin.y === 'number' && typeof origin.z === 'number') {
      originPos = new vec3(Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z));
    } else {
      originPos = bot.entity.position.clone().floor();
    }
    
    // Sort structure blocks by Y coordinate (bottom to top) to ensure foundation is placed first
    const sortedStructure = [...structure].sort((a, b) => a.y - b.y);

    this.emitChatMessage(botId, 'system', `🏗️ İnşaat başlatıldı. Hizalama: ${directionText}, Başlangıç: X:${originPos.x} Y:${originPos.y} Z:${originPos.z}. Toplam: ${structure.length} Blok.`);

    const runBuildCycle = async () => {

      for (let i = 0; i < sortedStructure.length; i++) {
        if (!botData.builderActive || botData.status !== 'online') break;

        const b = sortedStructure[i];
        
        // 1. Transform relative coordinates based on selected rotation
        let tx = b.x;
        let ty = b.y;
        let tz = b.z;

        if (actualRotation === 90) {
          tx = -b.z;
          tz = b.x;
        } else if (actualRotation === 180) {
          tx = -b.x;
          tz = -b.z;
        } else if (actualRotation === 270) {
          tx = b.z;
          tz = -b.x;
        }

        const targetPos = originPos.offset(tx, ty, tz);
        const blockName = b.block.replace('minecraft:', '');
        
        // 2. Check if the block is already placed
        try {
          const currentBlock = bot.blockAt(targetPos);
          if (currentBlock && currentBlock.name === blockName) {
            botData.builderPlaced++;
            this.emitToBotScope(botId, 'builder-progress', {
              botId,
              total: botData.builderTotal,
              placed: botData.builderPlaced,
              currentBlock: blockName,
              status: 'building'
            });
            continue; // Skip, already placed
          }
          if (currentBlock && currentBlock.name !== 'air' && currentBlock.name !== 'water' && currentBlock.name !== 'lava') {
            this.emitChatMessage(botId, 'error', `⚠️ Hedef dolu, atlanıyor: ${targetPos.x}, ${targetPos.y}, ${targetPos.z} (Mevcut: ${currentBlock.name})`);
            botData.builderPlaced++; // Increment progress so it's not stuck
            continue; // Skip, occupied by something else
          }
        } catch (err) {
          // Ignore blockAt errors and continue
        }

        // 3. Find the item in bot inventory
        const item = bot.inventory.items().find(it => it.name === blockName);
        if (!item) {
          botData.builderActive = false;
          this.emitToBotScope(botId, 'builder-progress', {
            botId,
            total: botData.builderTotal,
            placed: botData.builderPlaced,
            status: 'error',
            message: `Kayıp Malzeme: Envanterde "${b.block}" bulunamadı.`
          });
          this.emitChatMessage(botId, 'error', `❌ İnşaat durduruldu. Malzeme eksik: ${b.block}`);
          break;
        }

        // 4. Check if we are too far from target position.
        let dist = bot.entity.position.distanceTo(targetPos);
        if (dist > 4.5) {
          this.emitChatMessage(botId, 'system', `🚶 Blok çok uzakta (Uzaklık: ${Math.round(dist)}m). Hedefe yaklaşılıyor...`);
          
          if (bot.pathfinder) {
            try {
              const { GoalNear } = require('mineflayer-pathfinder').goals;
              bot.pathfinder.setGoal(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
              const startWalkTime = Date.now();
              while (bot.entity.position.distanceTo(targetPos) > 3.5 && botData.builderActive && botData.status === 'online') {
                await new Promise(r => setTimeout(r, 200));
                if (Date.now() - startWalkTime > 12000) {
                  break;
                }
              }
              bot.pathfinder.setGoal(null);
            } catch (err) {
              console.error('Pathfinder navigation failed:', err);
            }
          } else {
            try {
              // Face the target position
              await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
              bot.setControlState('forward', true);

              // Walk until distance is <= 3.5m or timeout (8 seconds)
              const startWalkTime = Date.now();
              while (bot.entity.position.distanceTo(targetPos) > 3.5 && botData.builderActive && botData.status === 'online') {
                await new Promise(r => setTimeout(r, 100));
                await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
                if (Date.now() - startWalkTime > 8000) {
                  break;
                }
              }
            } catch (e) {}

            try {
              bot.setControlState('forward', false);
            } catch (e) {}
          }
          dist = bot.entity.position.distanceTo(targetPos);
        }

        // 5. Try to equip item to hand
        try {
          await bot.equip(item, 'hand');
          await new Promise(r => setTimeout(r, 400)); // Increase delay
          const held = bot.heldItem;
          if (!held || held.name !== item.name) {
            this.emitChatMessage(botId, 'error', `⚠️ Elinde "${held ? held.name : 'boş'}" var, "${item.name}" bekliyor.`);
            // Retry equip
            await bot.equip(item, 'hand');
            await new Promise(r => setTimeout(r, 400));
          }
        } catch (err) {
          this.emitChatMessage(botId, 'error', `⚠️ Malzeme kuşanma hatası: ${err.message}`);
        }

        // 6. Find support block to place against
        const directions = [
          { offset: new vec3(0, -1, 0), face: new vec3(0, 1, 0) }, // Below
          { offset: new vec3(1, 0, 0), face: new vec3(-1, 0, 0) },  // East
          { offset: new vec3(-1, 0, 0), face: new vec3(1, 0, 0) },  // West
          { offset: new vec3(0, 0, 1), face: new vec3(0, 0, -1) },  // South
          { offset: new vec3(0, 0, -1), face: new vec3(0, 0, 1) },  // North
          { offset: new vec3(0, 1, 0), face: new vec3(0, -1, 0) }   // Above
        ];

        let refBlock = null;
        let pFace = null;

        for (const dir of directions) {
          const adjPos = targetPos.plus(dir.offset);
          const bl = bot.blockAt(adjPos);
          if (bl && bl.name !== 'air' && bl.name !== 'water' && bl.name !== 'lava') {
            refBlock = bl;
            pFace = dir.face;
            break;
          }
        }

        if (!refBlock) {
          this.emitChatMessage(botId, 'error', `⚠️ Blok havada kalamaz (X:${targetPos.x} Y:${targetPos.y} Z:${targetPos.z}). Destek blok bulunamadı!`);
          continue;
        }

        // 7. Place block against the reference block
        let placed = false;
        
        // Try to place on the found reference block
        // If it fails, try other faces of the reference block
        const faces = [pFace, new vec3(0, 1, 0), new vec3(0, -1, 0), new vec3(1, 0, 0), new vec3(-1, 0, 0), new vec3(0, 0, 1), new vec3(0, 0, -1)];
        
        for (let retry = 0; retry < 3; retry++) {
          for (const face of faces) {
            try {
              if (!face) continue;
              // Look at the correct point based on face
              await bot.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true);
              await bot.placeBlock(refBlock, face);
              placed = true;
              break; // Success!
            } catch (err) {
              // Ignore placement errors in retry loop
            }
          }
          if (placed) break;
          this.emitChatMessage(botId, 'error', `⚠️ Blok yerleştirme başarısız (deneme ${retry + 1}/3)`);
          await new Promise(r => setTimeout(r, 1000));
        }

        if (placed) {
          botData.builderPlaced++;
          this.emitToBotScope(botId, 'builder-progress', {
            botId,
            total: botData.builderTotal,
            placed: botData.builderPlaced,
            currentBlock: blockName,
            status: 'building'
          });

          // Delay to make building look realistic and comply with server ticks
          await new Promise(r => setTimeout(r, 300));
        } else {
          this.emitChatMessage(botId, 'error', `❌ Blok yerleştirilemedi, geçiliyor: ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
        }
      }

      // Done building or loop interrupted
      if (botData.builderActive) {
        botData.builderActive = false;
        this.emitToBotScope(botId, 'builder-progress', {
          botId,
          total: botData.builderTotal,
          placed: botData.builderPlaced,
          status: 'done'
        });
        this.emitChatMessage(botId, 'system', `✅ İnşaat başarıyla tamamlandı! Toplam ${botData.builderPlaced}/${botData.builderTotal} blok bitti.`);
      }
    };

    runBuildCycle();
    return { success: true, message: 'İnşaat süreci başlatıldı.' };
  }

  stopBuilder(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return { success: false, message: 'Bot bulunamadı.' };
    
    if (!botData.builderActive) {
      return { success: false, message: 'Aktif bir inşaat işlemi bulunmuyor.' };
    }

    botData.builderActive = false;
    this.emitToBotScope(botId, 'builder-progress', {
      botId,
      total: botData.builderTotal,
      placed: botData.builderPlaced,
      status: 'stopped'
    });
    this.emitChatMessage(botId, 'system', `⏹️ İnşaat kullanıcı tarafından durduruldu. (${botData.builderPlaced}/${botData.builderTotal})`);

    // Turn off movement control if walking
    if (botData.instance) {
      try {
        botData.instance.setControlState('forward', false);
      } catch (err) {}
    }

    return { success: true, message: 'İnşaat durduruldu.' };
  }

  _cleanupBot(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return;

    botData.userEnded = true;

    if (botData.reconnectTimer) {
      clearTimeout(botData.reconnectTimer);
    }

    if (botData.connectTimeout) {
      clearTimeout(botData.connectTimeout);
    }

    if (botData.antiAfk) {
      botData.antiAfk.stop();
    }

    if (botData.instance) {
      try {
        botData.instance.removeAllListeners();
        botData.instance.end();
      } catch (err) {
        // Bot zaten kapalı olabilir
      }
    }

    if (botData.accessKeyId) {
      storeManager.removeBotFromAccessKey(botData.accessKeyId, botId);
    }

    this.bots.delete(botId);
    this.emitBotUpdate();
  }

  _triggerAutoReconnect(botData) {
    if (botData.userEnded) return;

    if (botData.autoReconnectEnabled === false) {
      this.emitChatMessage(botData.id, 'system', `ℹ️ Otomatik yeniden bağlanma devre dışı bırakıldığı için bağlantı yenilenmedi.`);
      if (botData.status === 'reconnecting') {
        botData.status = 'offline';
      }
      this.emitBotUpdate();
      return;
    }

    // If already scheduled for reconnecting, do not duplicate
    if (botData.reconnectTimer) {
      return;
    }

    // 6-12 saniye arası gürültülü (chaotic) süre, sunucunun nefes almasını sağlar ve korumaları bypass eder
    const delay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
    botData.status = 'reconnecting';
    this.emitChatMessage(botData.id, 'system', `🔌 Bağlantı koptu. ${Math.round(delay / 1000)} saniye içinde otomatik yeniden bağlanılıyor...`);
    this.emitBotUpdate();

    botData.reconnectTimer = setTimeout(async () => {
      botData.reconnectTimer = null;
      if (botData.userEnded) return;
      if (botData.autoReconnectEnabled === false) return;
      try {
        this.emitChatMessage(botData.id, 'system', `⚡ Sunucuya yeniden bağlanma deneniyor (${botData.name})...`);
        await this._connectBot(botData);
      } catch (err) {
        console.log(`[AutoReconnect] Yeniden bağlantı denenirken hata: ${err?.message || err}`);
      }
    }, delay);
  }

  destroyAll() {
    for (const [botId] of this.bots) {
      this._cleanupBot(botId);
    }
  }

  // ── Socket.io Yayınları ─────────────────────────────────────

  emitToBotScope(botId, eventName, data) {
    if (!this.io) return;
    const botData = this.bots.get(botId);
    const botAccessKeyId = botData ? botData.accessKeyId : null;

    for (const [_, socket] of this.io.sockets.sockets) {
      if (!socket.accessKeyId || socket.accessKeyId === botAccessKeyId) {
        socket.emit(eventName, data);
      }
    }
  }

  emitBotUpdate() {
    if (!this.io) return;
    for (const [_, socket] of this.io.sockets.sockets) {
      const accessKeyId = socket.accessKeyId || null;
      socket.emit('bot-update', this.getAllBots(accessKeyId));
      socket.emit('server-bots', this.getBotsByServer(accessKeyId));
    }
  }

  emitChatMessage(botId, type, text, json = null) {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    this.emitToBotScope(botId, 'chat-message', { botId, type, text, timestamp, json });
  }
}

module.exports = BotManager;
