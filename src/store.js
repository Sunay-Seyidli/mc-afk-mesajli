/**
 * JSON tabanlı yerel veri saklama yöneticisi (Veritabanı gerektirmeden çalışır)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

class StoreManager {
  constructor() {
    this.ensureDirectory();
    this.data = this.loadData();
  }

  ensureDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadData() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          adminPassword: parsed.adminPassword || 'admin123',
          proxyMappings: Array.isArray(parsed.proxyMappings) ? parsed.proxyMappings : [],
          accessKeys: Array.isArray(parsed.accessKeys) ? parsed.accessKeys : []
        };
      }
    } catch (err) {
      console.error('[StoreManager] Veri yükleme hatası:', err.message);
    }
    return {
      adminPassword: 'admin123',
      proxyMappings: [],
      accessKeys: []
    };
  }

  saveData() {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[StoreManager] Veri kaydetme hatası:', err.message);
    }
  }

  // ── Admin Şifresi İşlemleri ────────────────────────────────────
  getAdminPassword() {
    return this.data.adminPassword;
  }

  setAdminPassword(newPassword) {
    if (!newPassword || typeof newPassword !== 'string') return false;
    this.data.adminPassword = newPassword.trim();
    this.saveData();
    return true;
  }

  verifyAdminPassword(password) {
    return this.data.adminPassword === password;
  }

  // ── Bot-Proxy Eşleme İşlemleri ─────────────────────────────────
  getProxyMappings() {
    return this.data.proxyMappings;
  }

  getProxyForBot(botName) {
    if (!botName) return null;
    const cleanName = String(botName).trim().toLowerCase();
    const found = this.data.proxyMappings.find(
      m => m.botName.trim().toLowerCase() === cleanName
    );
    return found ? found.proxy : null;
  }

  saveProxyMapping(botName, proxy) {
    if (!botName || !proxy) return null;
    const cleanName = String(botName).trim();
    const cleanProxy = String(proxy).trim();

    const existingIndex = this.data.proxyMappings.findIndex(
      m => m.botName.toLowerCase() === cleanName.toLowerCase()
    );

    const mapping = {
      id: existingIndex >= 0 ? this.data.proxyMappings[existingIndex].id : `map_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      botName: cleanName,
      proxy: cleanProxy,
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      this.data.proxyMappings[existingIndex] = mapping;
    } else {
      this.data.proxyMappings.push(mapping);
    }

    this.saveData();
    return mapping;
  }

  deleteProxyMapping(id) {
    if (!id) return false;
    const targetId = String(id).trim();
    const initialLen = this.data.proxyMappings.length;
    this.data.proxyMappings = this.data.proxyMappings.filter(m => String(m.id).trim() !== targetId);
    if (this.data.proxyMappings.length !== initialLen) {
      this.saveData();
      return true;
    }
    return false;
  }

  // ── Müşteri Erişim Linkleri (Access Keys) İşlemleri ──────────
  getAccessKeys() {
    return this.data.accessKeys;
  }

  getAccessKey(id) {
    if (!id) return null;
    const targetId = String(id).trim();
    return this.data.accessKeys.find(k => String(k.id).trim() === targetId) || null;
  }

  createAccessKey({ label, botLimit, customId }) {
    const keyId = customId
      ? customId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
      : `afk_${Math.random().toString(36).substring(2, 9)}`;

    if (!keyId) return { success: false, message: 'Geçersiz Link ID.' };

    // Key id benzersiz mi kontrol et
    if (this.data.accessKeys.some(k => String(k.id).trim() === keyId)) {
      return { success: false, message: 'Bu ID/Link zaten kullanılıyor.' };
    }

    const newKey = {
      id: keyId,
      label: label || 'Müşteri AFK Paketi',
      botLimit: parseInt(botLimit, 10) || 1,
      active: true, // Aktif mi
      createdBots: [], // bu link üzerinden açılan bot id'leri
      createdAt: new Date().toISOString()
    };

    this.data.accessKeys.push(newKey);
    this.saveData();
    return { success: true, key: newKey };
  }

  updateAccessKey(id, updates) {
    const key = this.getAccessKey(id);
    if (!key) return { success: false, message: 'Bağlantı bulunamadı.' };

    if (updates.newCustomId) {
      const cleanNewId = String(updates.newCustomId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (cleanNewId && cleanNewId !== String(key.id).trim()) {
        if (this.data.accessKeys.some(k => String(k.id).trim() === cleanNewId)) {
          return { success: false, message: 'Bu yeni Link ID zaten başka bir müşteride kullanılıyor.' };
        }
        key.id = cleanNewId;
      }
    }

    if (typeof updates.active === 'boolean') key.active = updates.active;
    if (updates.label !== undefined && updates.label !== null) key.label = String(updates.label).trim();
    if (updates.botLimit !== undefined) key.botLimit = parseInt(updates.botLimit, 10) || 1;

    this.saveData();
    return { success: true, key };
  }

  deleteAccessKey(id) {
    if (!id) return false;
    const targetId = String(id).trim();
    const initialLen = this.data.accessKeys.length;
    this.data.accessKeys = this.data.accessKeys.filter(k => String(k.id).trim() !== targetId);
    if (this.data.accessKeys.length !== initialLen) {
      this.saveData();
      return true;
    }
    return false;
  }

  addBotToAccessKey(keyId, botId) {
    const key = this.getAccessKey(keyId);
    if (key && !key.createdBots.includes(botId)) {
      key.createdBots.push(botId);
      this.saveData();
    }
  }

  removeBotFromAccessKey(keyId, botId) {
    const key = this.getAccessKey(keyId);
    if (key) {
      key.createdBots = key.createdBots.filter(id => id !== botId);
      this.saveData();
    }
  }
}

module.exports = new StoreManager();
