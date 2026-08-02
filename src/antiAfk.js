/**
 * Sunucu Tabanlı AFK Algılama & Anti-Cheat Sistemlerini Atlatma Modülü
 * İNSANSI & PÜRÜZSÜZ AKILLI ANTI-AFK SİSTEMİ (v6.0.0)
 * 
 * Özellikler:
 * - Doğal, insansı bakış açısı değişimleri (S-Curve Cosine Interpolation)
 * - Rastgele ve makul zaman aralıkları (15-35 saniye)
 * - Bot gibi kafa sallama / saçma sapan blok yumruklama / slot spamı YAPMAZ
 * - Yakındaki oyunculara doğal bakış atma
 * - Güvenli mikro adımlama ve pozisyon değişimi
 * - Akıllı Türkçe sohbet ve fısıltı yanıtlayıcı (5-10 sn insansı yazma gecikmesi)
 * - Sıvı/boğulma koruması
 */

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class AntiAfk {
  constructor(bot) {
    this.bot = bot;
    this.isRunning = false;
    this.abortController = null;
    this.activeTimeouts = new Set();
    this.originalSlot = 0;
    this.originalPosition = null;
    
    // Gerçekçi Türkçe Yanıt Eşleşmeleri
    this.chatReplies = [
      { keys: ['afk', 'bot', 'burda mi', 'aktif mi'], replies: ['efendim?', 'burdayım', 'noldu ?', 'burdayım knk', 'burdayım canım', 'efendim'] },
      { keys: ['selam', 'slm', 'sa', 's.a'], replies: ['as', 'aleykum selam', 'as canım', 'as hoşgeldin'] },
      { keys: ['naber', 'nbr', 'nasılsın'], replies: ['iyi panpa senden', 'iyi valla takılıyorum öyle', 'iyidir senden nbr'] },
      { keys: ['hey', 'alo', 'baksana', 'hi'], replies: ['efendim?', 'noldu?', 'burdayım buyur?'] }
    ];

    this.lastRepliedWhispers = new Map();
  }

  /**
   * Anti-AFK Motorunu Başlatır
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    if (this.bot.quickbarSlot !== undefined) {
      this.originalSlot = this.bot.quickbarSlot;
    }

    if (this.bot.entity && this.bot.entity.position) {
      this.originalPosition = this.bot.entity.position.clone();
    }

    console.log(`[AntiAfk] ${this.bot.username} için insansı Anti-AFK aktif!`);

    this._attachChatListeners();
    this._startMainLoop(signal);
    this._startSafetyLoop(signal);
  }

  /**
   * Anti-AFK Motorunu Durdurur
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    for (const timeout of this.activeTimeouts) {
      clearTimeout(timeout);
    }
    this.activeTimeouts.clear();

    this._detachChatListeners();

    try {
      if (this.bot.entity) {
        this.bot.setControlState('sneak', false);
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('jump', false);
      }
      if (typeof this.bot.setQuickbarSlot === 'function') {
        this.bot.setQuickbarSlot(this.originalSlot);
      }
    } catch (_) {}

    console.log(`[AntiAfk] ${this.bot.username} için Anti-AFK durduruldu.`);
  }

  // ── SOHBET & FISILTI DINLEYICI ─────────────────────────────

  _attachChatListeners() {
    this._whisperHandler = (username, message) => {
      if (!this.isRunning || !username || username === this.bot.username) return;
      this._handleInboundMessage(username, message, true);
    };

    this._chatHandler = (username, message) => {
      if (!this.isRunning || !username || username === this.bot.username) return;
      const myName = this.bot.username ? this.bot.username.toLowerCase() : '';
      if (myName && message && message.toLowerCase().includes(myName)) {
        this._handleInboundMessage(username, message, false);
      }
    };

    try {
      this.bot.on('whisper', this._whisperHandler);
      this.bot.on('chat', this._chatHandler);
    } catch (_) {}
  }

  _detachChatListeners() {
    try {
      if (this._whisperHandler) this.bot.removeListener('whisper', this._whisperHandler);
      if (this._chatHandler) this.bot.removeListener('chat', this._chatHandler);
    } catch (_) {}
  }

  async _handleInboundMessage(sender, message, isWhisper) {
    if (!sender || sender.toLowerCase() === 'system' || sender === this.bot.username) return;

    const now = Date.now();
    const lastTime = this.lastRepliedWhispers.get(sender.toLowerCase()) || 0;
    if (now - lastTime < 25000) return; // 25 saniye flood koruması

    const cleanMsg = String(message).toLowerCase();
    let replyText = null;

    for (const pattern of this.chatReplies) {
      if (pattern.keys.some(k => cleanMsg.includes(k))) {
        replyText = pattern.replies[randomInt(0, pattern.replies.length - 1)];
        break;
      }
    }

    if (!replyText && isWhisper) {
      if (Math.random() < 0.5) {
        const fallbacks = ['efendim?', 'noldu?', 'efendim knk?', 'az afkım', 'burdayım buyur'];
        replyText = fallbacks[randomInt(0, fallbacks.length - 1)];
      }
    }

    if (replyText) {
      this.lastRepliedWhispers.set(sender.toLowerCase(), now);
      
      // İnsansı yazma/tepki gecikmesi (5.5 - 10 saniye)
      const delay = randomInt(5500, 10000);
      console.log(`[AntiAfk] Gelen mesaj (${sender}): "${message}" -> Cevap: "${replyText}" (${Math.round(delay/1000)} sn sonra)`);

      setTimeout(() => {
        if (!this.isRunning || !this.bot) return;
        try {
          if (isWhisper) {
            this.bot.chat(`/msg ${sender} ${replyText}`);
          } else {
            this.bot.chat(replyText);
          }
        } catch (_) {}
      }, delay);
    }
  }

  // ── ANA DÖNGÜ (DÜZENLİ & İNSANSI) ──────────────────────────

  _startMainLoop(signal) {
    const loop = async () => {
      if (signal.aborted || !this.isRunning) return;

      try {
        if (this.bot && this.bot.entity && this.bot.entity.position) {
          const randAction = Math.random();

          if (randAction < 0.60) {
            // %60 İhtimal: Doğal bakış açısı değiştirme
            await this._performNaturalLook();
          } else if (randAction < 0.85) {
            // %25 İhtimal: Küçük insansı adım / pozisyon tazeleme
            await this._performSmallStep();
          } else {
            // %15 İhtimal: Küçük duruş değişimi (Slot değiştirme veya kısa çömelme)
            await this._performStanceChange();
          }
        }
      } catch (err) {
        // Sessizce geç
      }

      // Her eylem arasında 18 - 38 saniye bekleme (Çok doğal, insan gibi)
      const nextDelay = randomInt(18000, 38000);
      if (this.isRunning && !signal.aborted) {
        const timeout = setTimeout(loop, nextDelay);
        this.activeTimeouts.add(timeout);
      }
    };

    // İlk eylem için 5-10 saniye bekle
    const initialTimeout = setTimeout(loop, randomInt(5000, 10000));
    this.activeTimeouts.add(initialTimeout);
  }

  /**
   * Doğal Bakış Açısı (Pürüzsüz & İnsansı)
   */
  async _performNaturalLook() {
    if (!this.bot.entity) return;

    // Yakında duran bir oyuncu var mı bak
    const nearbyPlayer = this._findNearbyPlayer();

    if (nearbyPlayer && nearbyPlayer.position && Math.random() < 0.45) {
      // Yakındaki oyuncuya doğru yumuşakça bak
      const eyePos = nearbyPlayer.position.offset(0, nearbyPlayer.height || 1.6, 0);
      await this._lookAtSmoothly(eyePos, randomInt(1200, 2000));
      await sleep(randomInt(1500, 3000));
    } else {
      // Boş alana hafif doğal bakış
      const currentYaw = this.bot.entity.yaw;
      const currentPitch = this.bot.entity.pitch;

      // Maksimum +- 45 derece yaw değişimi
      const yawDelta = (Math.random() - 0.5) * (Math.PI / 2);
      const targetYaw = currentYaw + yawDelta;
      // Pitch -0.3 ile +0.3 radyan arası (gökyüzüne/yere dik bakmama)
      const targetPitch = Math.max(-0.4, Math.min(0.4, currentPitch + (Math.random() - 0.5) * 0.4));

      await this._lookAtAnglesSmoothly(targetYaw, targetPitch, randomInt(1000, 2200));
    }
  }

  /**
   * Küçük İnsansı Adım / Konum Değişimi
   */
  async _performSmallStep() {
    if (!this.bot.entity || !this.bot.entity.onGround) return;

    // Pathfinder varsa orijinal konuma yakın 2 blok öteye yürü
    if (this.bot.pathfinder && typeof this.bot.pathfinder.setGoal === 'function') {
      try {
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        const base = this.originalPosition || this.bot.entity.position;
        const dx = randomFloat(-2, 2);
        const dz = randomFloat(-2, 2);
        const target = base.offset(dx, 0, dz);

        this.bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, 0.8));
        await sleep(randomInt(2000, 3500));
        return;
      } catch (_) {}
    }

    // Pathfinder yoksa manuel mikro adım at
    const dirs = ['forward', 'back', 'left', 'right'];
    const dir = dirs[randomInt(0, dirs.length - 1)];

    try {
      this.bot.setControlState(dir, true);
      await sleep(randomInt(200, 450));
      this.bot.setControlState(dir, false);

      if (Math.random() < 0.3) {
        this.bot.setControlState('sneak', true);
        await sleep(randomInt(400, 1000));
        this.bot.setControlState('sneak', false);
      }
    } catch (_) {}
  }

  /**
   * Duruş / Slot Tazeleme
   */
  async _performStanceChange() {
    if (!this.bot.entity) return;

    if (Math.random() < 0.5 && typeof this.bot.setQuickbarSlot === 'function') {
      const nextSlot = (this.originalSlot + randomInt(1, 3)) % 9;
      this.bot.setQuickbarSlot(nextSlot);
      await sleep(randomInt(1500, 3500));
      this.bot.setQuickbarSlot(this.originalSlot);
    } else if (this.bot.setControlState) {
      this.bot.setControlState('sneak', true);
      await sleep(randomInt(300, 800));
      this.bot.setControlState('sneak', false);
    }
  }

  // ── SIVI & FİZİK KORUMASI ──────────────────────────────────

  _startSafetyLoop(signal) {
    const loop = async () => {
      if (signal.aborted || !this.isRunning) return;

      try {
        if (this.bot && this.bot.entity) {
          // Suya/Lava düşerse yüzme komutu ver
          if (this._isInLiquid()) {
            this.bot.setControlState('jump', true);
            await sleep(500);
            this.bot.setControlState('jump', false);
          }
        }
      } catch (_) {}

      if (this.isRunning && !signal.aborted) {
        const timeout = setTimeout(loop, 3000);
        this.activeTimeouts.add(timeout);
      }
    };

    const initialTimeout = setTimeout(loop, 3000);
    this.activeTimeouts.add(initialTimeout);
  }

  _isInLiquid() {
    try {
      if (!this.bot.entity || !this.bot.blockAt) return false;
      const pos = this.bot.entity.position;
      const blockFoot = this.bot.blockAt(pos);
      const blockHead = this.bot.blockAt(pos.offset(0, 1.2, 0));

      return (blockFoot && (blockFoot.name === 'water' || blockFoot.name === 'lava')) ||
             (blockHead && (blockHead.name === 'water' || blockHead.name === 'lava'));
    } catch (_) {
      return false;
    }
  }

  _findNearbyPlayer() {
    try {
      if (!this.bot.entities) return null;
      let closest = null;
      let minDistance = 12;

      for (const id in this.bot.entities) {
        const e = this.bot.entities[id];
        if (e && e.type === 'player' && e !== this.bot.entity) {
          const dist = this.bot.entity.position.distanceTo(e.position);
          if (dist < minDistance) {
            minDistance = dist;
            closest = e;
          }
        }
      }
      return closest;
    } catch (_) {
      return null;
    }
  }

  // ── PÜRÜZSÜZ BAKIŞ INTERPOLASYONU (COSINE SMOOTH) ──────────

  async _lookAtAnglesSmoothly(targetYaw, targetPitch, durationMs) {
    try {
      if (!this.bot || !this.bot.entity) return;

      const startYaw = this.bot.entity.yaw;
      const startPitch = this.bot.entity.pitch;

      let diffYaw = targetYaw - startYaw;
      while (diffYaw < -Math.PI) diffYaw += Math.PI * 2;
      while (diffYaw > Math.PI) diffYaw -= Math.PI * 2;

      const diffPitch = targetPitch - startPitch;

      const steps = Math.max(8, Math.floor(durationMs / 60));
      const interval = durationMs / steps;

      for (let i = 1; i <= steps; i++) {
        if (!this.isRunning) break;
        const progress = i / steps;
        // Ease-In-Out Cosine Interpolation
        const smoothProgress = (1 - Math.cos(progress * Math.PI)) / 2;

        const currentYaw = startYaw + diffYaw * smoothProgress;
        const currentPitch = startPitch + diffPitch * smoothProgress;

        this.bot.look(currentYaw, currentPitch, true);
        await sleep(interval);
      }
    } catch (_) {}
  }

  async _lookAtSmoothly(targetPos, durationMs) {
    try {
      if (!this.bot || !this.bot.entity) return;
      const selfPos = this.bot.entity.position.offset(0, this.bot.entity.height || 1.62, 0);
      const dx = targetPos.x - selfPos.x;
      const dy = targetPos.y - selfPos.y;
      const dz = targetPos.z - selfPos.z;

      const distanceXZ = Math.sqrt(dx * dx + dz * dz);
      const targetYaw = Math.atan2(-dx, -dz);
      const targetPitch = Math.atan2(dy, distanceXZ);

      await this._lookAtAnglesSmoothly(targetYaw, targetPitch, durationMs);
    } catch (_) {}
  }
}

module.exports = AntiAfk;
