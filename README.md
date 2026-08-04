# MinePulse AFK Cloud

Minecraft sunucularınıza kolayca AFK botları ekleyin ve yönetin.

## Özellikler

✅ **Basit Arayüz** - Anlaşılması kolay ve kullanımı basit  
✅ **Toplu Bot Yönetimi** - Birden fazla botu aynı anda kontrol edin  
✅ **Gerçek Zamanlı Takip** - Bot koordinatlarını, canını ve açlığını canlı izleyin  
✅ **Anti-AFK Sistemi** - İnsan gibi hareket ve etkileşimler  
✅ **Proxy Desteği** - SOCKS5 proxy aracılığıyla bağlantı kurun  
✅ **Otomatik Yeniden Bağlanma** - Bağlantı koptuğunda otomatik olarak yeniden bağlan  
✅ **7/24 Çalışma** - Kesintisiz bot işletimi  

## Kurulum

### Gereksinimler
- Node.js 18+ 
- npm veya npm-uyumlu paket yöneticisi

### Adımlar

1. Projeyi klonla:
```bash
git clone https://github.com/yourusername/minecraft-afk-bot.git
cd minecraft-afk-bot
```

2. Bağımlılıkları yükle:
```bash
npm install
```

3. Sunucuyu başlat:
```bash
npm start
```

4. Web tarayıcında aç: `http://localhost:7860`

## Kullanım

1. **Bot Ekle**: "Yeni Sunucu" düğmesine tıkla veya mevcut sunucuya bot ekle
2. **Bot Kontrol Et**: 
   - Anti-AFK aç/kapat
   - Mesaj gönder
   - Hareket et
   - Malzeme topla
3. **Sunucu Ayarları**: Proxy, sürüm ve oto giriş mesajını yapılandır
4. **Müşteri Linki**: Admin panelinden müşterilere özel erişim linkileri oluştur

## Ortam Değişkenleri

`.env` dosyasını oluşturup aşağıdaki ayarları yap:

```bash
PORT=7860                  # Sunucunun dinleyeceği port
MAX_BOTS=20                # Maksimum bot sayısı (isteğe bağlı)
```

## Sorun Giderme

**"SOCKS5 proxy hatası"**
- Proxy adresinin doğru olduğundan emin ol
- Format: `IP:PORT` veya `IP:PORT:KULLANICI:ŞİFRE`

**"Bağlantı zaman aşımına uğradı"**
- Sunucu IP ve port'un doğru olduğundan emin ol
- Güvenlik duvarı ayarlarını kontrol et

**"Vanilla check failed"**
- Bu hata artık çözülmüştür, lütfen güncelleyin

## Lisans

MIT

## Destek

Sorularını ve bulduğun sorunları raporla.
