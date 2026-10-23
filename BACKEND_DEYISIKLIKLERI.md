# Backend dəyişiklikləri (müştəri tətbiqi üçün, geriyə uyğun)

Bütün dəyişikliklər əlavə xarakterlidir: köhnə müştəri və sürücü tətbiqləri əvvəlki kimi işləyir.
Testlər: mövcud 96 test + yeni 6 test (`test/customer-app-compat.test.js`) — **102/102 keçir**.

| # | Fayl | Dəyişiklik | Niyə |
|---|---|---|---|
| 1 | `src/services/order.service.js` | `order_cancelled` hadisəsi sərnişinə `{orderId, status, reason}` ilə göndərilir (əvvəl yalnız `orderId`) | Tətbiq kimin ləğv etdiyini (sürücü / ofis) dərhal göstərsin |
| 2 | `src/services/location.service.js` | `order:<id>` otağına gedən `driver_location_updated` hadisəsinə `orderId` əlavə olundu | Köhnə sifarişin konumu yeni sifarişə tətbiq olunmasın |
| 3 | `src/models/Customer.js` | `language` sahəsi (`az`/`ru`/`en`/`tr`, standart `az`) | Push bildirişləri müştərinin dilində |
| 4 | `src/routes/customer.routes.js` | `PATCH /customers/me` → `language` qəbul edir; cavaba `customer` əlavə olundu | Tətbiq dil seçimini serverə bildirir |
| 5 | `src/routes/customer.routes.js` | `GET /customers/orders` və `/orders/active` → `deletedAt: null` | Admin tərəfindən silinmiş sifarişlər tarixçədə görünməsin |
| 6 | `src/services/customerNotify.js` | Push mətnləri 4 dildə; dil `Customer.language`-dən; tapılmasa `az` | Çoxdilli bildirişlər |
| 7 | `src/middleware/auth.js` | Bloklanmış **sərnişin** üçün `403 USER_DISABLED` (sürücü üçün əvvəlki kimi `401`) | Tətbiq "Hesabınız bloklanıb" izahını göstərsin |
| 8 | `src/routes/admin.extra.routes.js` | Sərnişin bloklananda `account_blocked` socket hadisəsi + 1 san sonra bağlantının qırılması | Açıq tətbiq dərhal xəbər tutsun |
| 9 | `.env.example` | Nümunə konfiqurasiya | `.env` təhvil paketinə daxil edilməyib |

## Deploy

```bash
npm ci
npm test
git push heroku main   # və ya mövcud deploy üsulunuz
```

Miqrasiya lazım deyil: `language` sahəsi olmayan köhnə sənədlər üçün standart `az` istifadə olunur.

## Təhlükəsizlik qeydi

Təqdim olunan arxivdəki `.env` faylında MongoDB şifrəsi, SMS API açarı və JWT açarları açıq şəkildə idi.
Bu fayl paketə daxil edilməyib, lakin açarları dəyişdirmək (rotate) tövsiyə olunur.
