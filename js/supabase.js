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
// Чтения с таймаутом и повтором (09.11.2026, старт марафона). У части участниц на
// мобильном интернете запрос к Supabase уходит и «висит» минутами: в журнале видно,
// что страница открыта, мелкие записи журнала доходят, а загрузка кабинета так и не
// завершается — участница смотрит на пустую страницу и уходит («не открывается»).
// У fetch своего таймаута нет. Здесь: ЧТЕНИЯ базы (GET /rest/v1/) и подпись ссылок на
// фото (POST /storage/v1/object/sign/ — ничего не меняет) обрываем через 8 с и
// повторяем на новом соединении (ещё 2 раза). Тело читаем внутри таймаута — зависнуть
// может и середина ответа. Записи, вход и обновление сессии НЕ трогаем: их повтор
// может задвоить данные или сжечь одноразовый токен обновления.
const KF_READ_TIMEOUT = 8000;
const KF_READ_WAITS = [500, 1200];
function kfFetch(input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const isRead = ((method === 'GET' || method === 'HEAD') && url.indexOf('/rest/v1/') !== -1)
        || (method === 'POST' && url.indexOf('/storage/v1/object/sign/') !== -1);
    if (!isRead || init.signal || typeof AbortController === 'undefined') return fetch(input, init);
    let i = 0;
    const attempt = () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), KF_READ_TIMEOUT);
        return fetch(input, Object.assign({}, init, { signal: ctl.signal }))
            .then(r => r.text().then(body => {
                clearTimeout(timer);
                const noBody = method === 'HEAD' || r.status === 204 || r.status === 205 || r.status === 304;
                return new Response(noBody ? null : body, { status: r.status, statusText: r.statusText, headers: r.headers });
            }))
            .catch(e => {
                clearTimeout(timer);
                if (i >= KF_READ_WAITS.length) throw e;
                return new Promise(res => setTimeout(res, KF_READ_WAITS[i++])).then(attempt);
            });
    };
    return attempt();
}

let sb = null;
if (window.supabase && typeof window.supabase.createClient === 'function') {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            persistSession: true,       // сессия в localStorage — вход не слетает
            autoRefreshToken: true,
            detectSessionInUrl: true,   // подхватить токен из ссылки в письме
        },
        global: { fetch: kfFetch },
    });
} else {
    var _sbErr = 'KatyaFit: supabase-js не загрузился (js/vendor/supabase.js) — обновите страницу';
    try { console.error('[KatyaFit] ' + _sbErr); } catch (e) {}
    try { if (window.Sentry && window.Sentry.captureMessage) window.Sentry.captureMessage(_sbErr, 'fatal'); } catch (e) {}
}
