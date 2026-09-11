/* ============================================================
   KatyaFit · Личный кабинет — подключение к Supabase (Фаза 1)

   URL и publishable-ключ ПУБЛИЧНЫЕ — им место в коде. Доступ к данным
   ограничивает RLS на стороне базы, не секретность этого ключа.
   Секретный ключ (sb_secret_...) сюда НИКОГДА не попадает.

   Грузится после CDN-скрипта @supabase/supabase-js (глобал `supabase`),
   но до program-data.js / app.js. Экспортирует глобал `sb`.
   ============================================================ */

const SUPABASE_URL = 'https://sxktnpupxcslzjrhisyw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3OvhvHbVOpbmq3UscBRoWw_PcloJHp6';

// Библиотека supabase-js зашита локально (js/vendor/supabase.js, грузится в <head>
// строкой выше). Если она не поднялась — файл не докачался при выкладке зеркала,
// устаревший кэш SW, обрыв сети — НЕ роняем кабинет криптовой связкой
// «createClient of undefined» + каскадом «sb is not defined» (ловили такое в момент
// переезда на GitHub Pages, 0.6.34). Даём одну понятную диагностику; `sb` остаётся
// определён как null, чтобы гварды `typeof sb === 'undefined' || !sb` (error-report,
// boot) отработали мягко, а не кидали ReferenceError.
let sb = null;
if (window.supabase && typeof window.supabase.createClient === 'function') {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            persistSession: true,       // сессия в localStorage — вход не слетает
            autoRefreshToken: true,
            detectSessionInUrl: true,   // подхватить токен из ссылки в письме
        },
    });
} else {
    var _sbErr = 'KatyaFit: supabase-js не загрузился (js/vendor/supabase.js) — обновите страницу';
    try { console.error('[KatyaFit] ' + _sbErr); } catch (e) {}
    try { if (window.Sentry && window.Sentry.captureMessage) window.Sentry.captureMessage(_sbErr, 'fatal'); } catch (e) {}
}
