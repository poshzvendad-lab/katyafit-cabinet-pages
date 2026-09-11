/* ============================================================
   KatyaFit · Личный кабинет — Service Worker (PWA)

   Делает кабинет устанавливаемым на телефон и быстрым при повторных
   заходах. Стратегии подобраны под закрытый кабинет на Supabase:

   - НАВИГАЦИИ (HTML) — network-first: свежий деплой подхватывается сразу,
     а офлайн отдаём последнюю кэшированную страницу (или вход).
   - СТАТИКА (css/js/иконки/шрифты) — stale-while-revalidate: мгновенно из
     кэша, в фоне тихо обновляем.
   - SUPABASE и любая ДИНАМИКА — мимо кэша: данные участницы, авторизация и
     подписанные URL фото всегда живые (и не оседают в кэше — RLS/приватность).

   Версию кэша поднимать ТОЛЬКО при смене логики SW (не на каждый ?v=):
   network-first для HTML и так отдаёт свежий код, а SWR обновляет ассеты
   в фоне. При смене CACHE старые кэши чистятся в activate.
   ============================================================ */

// v2 (09.07.2026, аудит N4): разовая чистка накопленных старых версий ассетов
// (кэш v1 копил ?v= всех прошлых релизов) + ниже в SWR — удаление прошлых
// версий файла при кэшировании новой, чтобы кэш снова не пух.
const CACHE = 'kf-cache-v2';

// Базовый каркас — прогреваем при установке, чтобы первый офлайн уже работал.
const PRECACHE = [
  './',
  'index.html',
  'dashboard.html',
  'day.html',
  'pending.html',
  'privacy.html',
  'oferta.html',
  'offline.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Прогрев «по возможности»: один сбойный ресурс не должен валить установку.
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Кэшируемая ли это статика по расширению.
function isStaticAsset(url) {
  return /\.(?:css|js|png|svg|webp|jpg|jpeg|gif|ico|woff2?|ttf)$/i.test(url.pathname);
}

// Шрифты Google — кросс-доменные, но безопасно кэшировать для офлайна.
function isFontHost(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Supabase, CDN supabase-js, аналитика и прочая кросс-динамика — мимо SW.
  // (Шрифты Google — исключение, их кэшируем ниже.)
  if (!sameOrigin && !isFontHost(url)) return;

  // Навигации (открытие страниц) — network-first с офлайн-фолбэком.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          // Фолбэки строго по очереди через then: `hit || caches.match(...)` не
          // работает — caches.match возвращает Promise, он truthy даже без находки.
          caches.match(req)
            .then((hit) => hit || caches.match('index.html'))
            .then((hit) => hit || caches.match('offline.html'))
        )
    );
    return;
  }

  // Статика и шрифты — stale-while-revalidate.
  if (isStaticAsset(url) || isFontHost(url)) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const fetching = fetch(req)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) {
                cache.put(req, res.clone());
                // Закэшировали новую версию файла (?v=X.Y.Z) → выкидываем его
                // прошлые версии (тот же путь, другой query), иначе кэш пухнет
                // на каждый бамп версии (аудит 09.07.2026, N4). Тихо, в фоне.
                if (url.searchParams.has('v')) {
                  cache.keys().then((keys) => keys.forEach((k) => {
                    const ku = new URL(k.url);
                    if (ku.origin === url.origin && ku.pathname === url.pathname &&
                        ku.search !== url.search) cache.delete(k);
                  })).catch(() => {});
                }
              }
              return res;
            })
            .catch(() => hit);
          return hit || fetching;
        })
      )
    );
  }
});
