# Homelabv4 Script Refactor Roadmap

## Amaç
Homelabv4’ü v3.1.x kalıntılarından net şekilde ayırmak ve tüm görevleri modüler,
tek sorumluluk ilkesine göre yönetmek.

## Hedef mimari
- `agent/core/backend/v4/` altında çalışan v4.x script seti.
- `agent/core/backend/v3.0/` yalnızca legacy compatibility ve geri dönüş/karşılaştırma için.
- `agent/core/tasks/*` sadece birer hedef çalıştırma katmanı olsun.
- UI ve manifest akışı script kimliğini bu iki katman ayrımına göre takip etsin.

## Faz 1 — Ayırma ve Güvenli Geçiş
- v4 klasörü altında dizin haritasını tamamla:
  - `bootstrap`, `vm`, `services`, `config`, `truenas`, `maintenance`, `health`, `flows`.
- Script kontratını standardize et:
  - Girdi/çıkışları net loglanan `start_log` başlığı.
  - `set -Eeuo pipefail`.
- `agent/core/backend/v4` için migration manifesti hazırla.
- Akışları kademeli olarak v4 endpointlerine taşırken, v3.0 fallback bırak.

Durum:
- `backend/v4/lib/task.sh` eklendi.
- VM, servis, config, health, repair ve support için v4 giriş noktaları oluşturuldu.
- `backend/v4/migration-map.json` eski hedefe delegasyon yapan tüm ilk dalga v4
  scriptlerini listeliyor.
- Agent panel wrapper'ları `run_v4_core` üzerinden v4 hedeflerine bağlandı.

## Faz 2 — Tam Ayrıştırma
- Çoklu adım yapan scriptleri böl:
  - "VM kur + servis yükle + konfigürasyon" gibi karma adımlar tek scriptte kalmasın.
- Her adım:
  - kendi task ID’sini alsın,
  - tek bir amaca odaklansın,
  - gerektiğinde durdurulup tekrar çalıştırılsın.
- `script-catalog.json` ve `guided-steps.json` ile bire bir eşleme kurulacak.

## Faz 3 — UI Refaktör
- Script center’da filtreler:
  - `version: v4`, `type: service/config/vm/truenas/health`.
- "Full install" ile "tek tek script" davranışı aynı hedef setini kullansın.
- İstatistik: her adımın başarı/başarısızlık metrikleri tekil script bazlı tutulsun.

## Kontrol listesi (kapanış ölçütü)
- `bin/homelab list` içinde v4 hedefleri görünür olmalı.
- v3.1.x akışları çalışır durumda kalmalı ama v4 manifesti varsayılan olsun.
- Yeni ekleme/çıkarma scriptlerinde tek dosya, tek görev kuralı bozulmamalı.
- Type-check + dist başarılı.
