/* ============================================================
   KatyaFit · Личный кабинет — Sentry (детальная диагностика ошибок)

   Зачем, если уже есть error-report.js (KFErr -> Telegram)?
     • KFErr — короткое УВЕДОМЛЕНИЕ владельцу в Telegram («был баг, вот текст»).
     • Sentry — детальная ДИАГНОСТИКА для разработки: полный стек, хлебные крошки
       (что нажимали до падения), устройство/браузер, версия релиза, группировка
       одинаковых ошибок и их тренды. Дополняют друг друга, не конфликтуют
       (оба слушают window.onerror/unhandledrejection — это нормально).

   Грузится сразу после CDN-бандла Sentry и ДО supabase.js / error-report.js /
   app.js — чтобы ловить ошибки во всех скриптах кабинета с самого начала.

   Принципы (как в error-report.js):
     • никогда не мешает кабинету — всё в try/catch, при любой осечке тихо выходит;
     • на localhost / preview НЕ шлём (не шумим дев-ошибками);
     • контекст (день/тариф/страница) добавляется к каждой ошибке через beforeSend,
       читается «вживую» из KF — без правок app.js;
     • DSN публичный (как и ключ Supabase) — ему место в коде; он лишь открывает
       приём событий в проект, доступа к данным Sentry не даёт.
   ============================================================ */

(function () {
    'use strict';

    // ┌────────────────────────────────────────────────────────────────────┐
    // │  ВСТАВЬ СЮДА DSN ИЗ SENTRY                                           │
    // │  Вид: https://abc123...@o000000.ingest.de.sentry.io/000000          │
    // │  Где взять: sentry.io -> Settings -> Projects -> (проект) ->         │
    // │  Client Keys (DSN). Пусто = Sentry выключен, код безопасен и так.    │
    // └────────────────────────────────────────────────────────────────────┘
    var SENTRY_DSN = 'https://326fe8673c0c4a4456ff6b8b079fed3a@o4511613490102272.ingest.de.sentry.io/4511613510811728';

    try {
        if (!SENTRY_DSN) return;                                    // DSN ещё не вставлен
        if (typeof Sentry === 'undefined' || !Sentry.init) return; // CDN-бандл не загрузился

        var host = location.hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host === '') return; // дев — мимо

        // Релиз = версия кеша ?v= ЭТОГО ЖЕ скрипта (тянем из его src, чтобы не
        // держать версию в двух местах — bump-version.ps1 правит только ?v= в HTML).
        var release = 'unknown';
        try {
            var src = (document.currentScript && document.currentScript.src) || '';
            var m = src.match(/[?&]v=([^&]+)/);
            if (m) release = m[1];
        } catch (e) {}

        // Имя страницы — для группировки (index/dashboard/day/pending).
        function pageName() {
            var p = (location.pathname.split('/').pop() || 'index').replace(/\.html?$/i, '');
            return p || 'index';
        }

        Sentry.init({
            dsn: SENTRY_DSN,
            release: 'katyafit-cabinet@' + release,
            environment: 'production',
            // Только ошибки: ни трейсинга производительности, ни записи экрана (Replay).
            tracesSampleRate: 0,
            // Отсекаем известный безвредный шум браузеров.
            ignoreErrors: [
                'ResizeObserver loop limit exceeded',
                'ResizeObserver loop completed with undelivered notifications.',
                'Non-Error promise rejection captured',
            ],
            beforeSend: function (event) {
                try {
                    event.tags = event.tags || {};
                    event.tags.page = pageName();
                    // Контекст участницы — «вживую» из KF (как в error-report.js).
                    // KF объявлен const в app.js -> лексический глобал, его НЕТ на window,
                    // потому проверяем typeof. Всё под try: KF может ещё не существовать.
                    try { if (typeof KF !== 'undefined' && typeof KF.activeDay === 'function') event.tags.day = KF.activeDay(); } catch (e) {}
                    try { if (typeof KF !== 'undefined' && KF.tier) event.tags.tier = KF.tier; } catch (e) {}
                } catch (e) {}
                return event;
            },
        });
    } catch (e) { /* инициализатор не должен ронять страницу */ }
})();
