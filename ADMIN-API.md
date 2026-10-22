# Admin API: şəhərlər, regional adminlər, ofis yazışması

Bütün sorğular `Authorization: Bearer <accessToken>` ilə göndərilir (admin `/auth/login` ilə daxil olur).

## Admin növləri

| Növ | `User.adminCityId` | Nə edə bilər |
|---|---|---|
| Baş admin | `null` | Hər şey: bütün şəhərlər, adminlər, ayarlar, tariflər, promo kodlar, sərnişinlər, şikayətlər. |
| Regional admin | şəhər id-si | Yalnız öz şəhərinin sürücüləri: siyahı, təsdiq/blok, balans artırma, sifarişləri, yazışma, "hamıya mesaj", öz ofisinin ünvan/telefon/iş saatı. |

- Mövcud bütün adminlər avtomatik **baş admin** sayılır.
- Regional admin başqa şəhərin sürücüsünə sorğu göndərsə, **404** alır.
- Regional admin baş adminə aid bölməyə sorğu göndərsə, **403** alır.
- `/auth/login` cavabında `user.isSuperAdmin` və `user.adminCityId` gəlir. Panel bölmələri buna görə göstərməlidir.

`GET /admin/me` → `{ user, isSuperAdmin, city }`

## Şəhərlər

İlk qalxışda Azərbaycanın əsas şəhərləri avtomatik əlavə olunur.

| Sorğu | Kim | Qeyd |
|---|---|---|
| `GET /admin/cities` | hamı | Regional admin yalnız öz şəhərini görür. Hər şəhərdə `driverCount` var. |
| `POST /admin/cities` | baş | Body: `{ name, officeAddress?, officePhone?, workHours?, sortOrder?, isActive? }` |
| `PATCH /admin/cities/:id` | baş / öz şəhəri | Regional admin yalnız `officeAddress`, `officePhone`, `workHours` sahələrini dəyişə bilər. |

`officeAddress`, `officePhone` və `workHours` sürücünün tətbiqində "Ofislə əlaqə" ekranında göstərilir.

Açıq endpoint: `GET /auth/cities` (qeydiyyat forması üçün, yalnız aktiv şəhərlər).

## Adminlər (yalnız baş admin)

| Sorğu | Body |
|---|---|
| `GET /admin/admins` | — |
| `POST /admin/admins` | `{ phone, password (min 8), firstName?, lastName?, cityId? }` (`cityId` boşdursa baş admin yaradılır) |
| `PATCH /admin/admins/:id` | `{ cityId?, isActive?, password?, firstName?, lastName? }` |

## Sürücülər

| Sorğu | Qeyd |
|---|---|
| `GET /admin/drivers?q=&online=1&cityId=` | `cityId` filtri yalnız baş admin üçündür: şəhər id-si və ya `none` (şəhəri olmayanlar). |
| `GET /admin/drivers/:id` | |
| `PATCH /admin/drivers/:id` | `{ isVerified?, isActive?, priority?, radiusMeters?, cityId? }`. `cityId` sahəsini yalnız baş admin dəyişə bilər. |
| `POST /admin/drivers/:id/wallet/top-up` | `{ amountMinor, note? }` |
| `POST /admin/drivers/:id/wallet/adjustment` | `{ amountMinor, note?, reason? }` |
| `POST /admin/users/:userId/disable` | Hesabı tam bağlayır. |
| `POST /admin/users/:userId/enable` | Hesabı geri açır. |

## Ofis ↔ sürücü yazışması

| Sorğu | Qeyd |
|---|---|
| `GET /admin/support/threads?unread=1&cityId=` | Son mesaja görə sıralanır. Cavabda hər yazışma üçün `unreadForAdmin`, üstündə isə ümumi `unreadTotal` var. |
| `GET /admin/support/:driverId/messages?before=<ISO>` | Yenidən köhnəyə doğru, 50-lik səhifələrlə. |
| `POST /admin/support/:driverId/messages` | `{ text }`. Sürücü əvvəl yazmayıbsa da göndərmək olar. Sürücüyə push bildirişi gedir. |
| `POST /admin/support/:driverId/read` | Yazışmanı oxunmuş kimi qeyd edir. |
| `POST /admin/support/broadcast` | `{ text, cityId?, onlyActive? }`. Regional admin göndərəndə mesaj həmişə öz şəhərinə gedir. |

## Socket.IO (admin paneli)

- Admin qoşulanda otağa avtomatik əlavə olunur:
  - baş admin → `admin:operations`;
  - regional admin → `admin:city:<id>`.
- Hadisələr:
  - `support_message` → `{ message, driver, unreadForAdmin }`;
  - `trip_stopped` → `{ orderId, driverId, reason, chargedMinor, traveledMeters, stopsToday, warning, newOrderId }`.

## Sürücü tərəfi (məlumat üçün)

- `POST /auth/register` → sürücü üçün `cityId` məcburidir.
- `GET /drivers/me` → `city` (ofis məlumatı ilə) və `supportUnread`.
- `PATCH /drivers/me/city` → yalnız şəhəri olmayan köhnə sürücülər üçün, bir dəfəlik.
- Yazışma: `GET /drivers/support`, `POST /drivers/support/messages`, `POST /drivers/support/read`.
- Socket hadisəsi: `support_message`.
