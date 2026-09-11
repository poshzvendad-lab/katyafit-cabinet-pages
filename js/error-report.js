/* ============================================================
   KatyaFit · Личный кабинет — автосбор багов (Фаза 1)

   Ловит ошибки кабинета и шлёт их в Supabase (RPC report_error), откуда
   Telegram-бот уведомляет владельца. Три источника:
     • window.onerror            — JS-ошибки (что/где/строка)
     • unhandledrejection        — упавшие промисы (часто сбои Supabase)
     • KFErr.report / .feedback  — ручные вызовы (сбой записи {ok:false},
                                    кнопка «Сообщить о проблеме»)

   Грузится сразу после supabase.js (нужен глобал `sb`), но ДО program-data.js /
   app.js — чтобы ловить ошибки и в них. Экспортирует глобал `KFErr`.

   Принципы:
     • никогда не мешает работе кабинета — все отправки в try/catch, тихо;
     • дедуп на клиенте (одна и та же ошибка за загрузку шлётся один раз) +
       лимит на загрузку (защита от цикла, заваливающего сеть);
     • на localhost/preview не шлём (не шумим в разработке);
     • личные данные (email) проставляет СЕРВЕР по auth.uid(), не клиент.
   ============================================================ */

(function () {
    'use strict';

    // На локалке/превью не шлём — иначе дев-ошибки летят владельцу.
    var host = location.hostname;
    var IS_LOCAL = host === 'localhost' || host === '127.0.0.1' || host === '';

    var sent = {};          // дедуп за загрузку: { fingerprint: true }
    var budget = 12;        // максимум отправок за одну загрузку страницы

    // Текущая страница кабинета (index/dashboard/day/pending) — для группировки.
    function pageName() {
        var m = (location.pathname.split('/').pop() || 'index').replace(/\.html?$/i, '');
        return m || 'index';
    }

    // Контекст участницы (если KF уже загружен и забутстрапан) — день и тариф.
    // KF объявлен `const` в app.js — это ЛЕКСИЧЕСКИЙ глобал, его НЕТ на window
    // (потому проверяем `typeof KF`, а не `window.KF`). Всё под try: KF может ещё
    // не существовать (ошибка до загрузки app.js) или быть не booted.
    function context() {
        var ctx = { day: null, tier: null };
        try { if (typeof KF !== 'undefined' && typeof KF.activeDay === 'function') ctx.day = KF.activeDay(); } catch (e) {}
        try { if (typeof KF !== 'undefined' && KF.tier) ctx.tier = KF.tier; } catch (e) {}
        return ctx;
    }

    // Единая отправка в БД. kind: 'js'|'promise'|'db'|'user'.
    function send(kind, message, opts) {
        opts = opts || {};
        try {
            if (IS_LOCAL) return;
            // sb объявлен `const` в supabase.js — это ЛЕКСИЧЕСКИЙ глобал, его НЕТ
            // на window (как и KF). Потому проверяем сам `sb` через typeof, а не window.sb.
            if (typeof sb === 'undefined' || !sb || !sb.rpc) return; // supabase не поднялся — некуда слать
            message = String(message || '').slice(0, 1000);
            if (!message) return;

            // Ручные жалобы (user) не дедупим — каждая важна. Остальное — по отпечатку.
            if (kind !== 'user') {
                var fp = kind + '|' + message + '|' + (opts.source || '') + '|' + (opts.line || '');
                if (sent[fp]) return;                 // уже слали эту ошибку за загрузку
                sent[fp] = true;
            }
            if (budget <= 0) return;
            budget--;

            var ctx = context();
            var ua = (navigator.userAgent || '').slice(0, 300);
            sb.rpc('report_error', {
                p_kind: kind,
                p_message: message,
                p_source: opts.source ? String(opts.source).slice(0, 300) : null,
                p_line: opts.line || null,
                p_col: opts.col || null,
                p_page: pageName(),
                p_day: ctx.day,
                p_tier: ctx.tier,
                p_ua: ua
            }).then(function () {}, function () {}); // тихо: сбой репорта не наша забота
        } catch (e) { /* репортер не должен ронять страницу */ }
    }

    // ─── Публичный API ───
    window.KFErr = {
        // Произвольная ошибка из кода (например, сбой записи {ok:false}).
        report: function (message, opts) { send((opts && opts.kind) || 'db', message, opts); },
        // Сбой сохранения в БД — кабинет «поздравил», а данные не легли. Самое больное.
        dbFailure: function (where, reason) {
            send('db', 'Сбой сохранения: ' + (where || '?') + (reason ? ' (' + reason + ')' : ''),
                 { kind: 'db', source: where });
        },
        // Ручная жалоба участницы из шторки «Сообщить о проблеме».
        feedback: function (text) {
            text = String(text || '').trim();
            if (!text) return false;
            send('user', text, { kind: 'user' });
            return true;
        }
    };

    // ─── Глобальные перехватчики ───
    window.addEventListener('error', function (e) {
        // e.error есть у JS-исключений; у ошибок загрузки ресурсов (img/script) — нет.
        var msg = (e && (e.message || (e.error && e.error.message))) || 'Unknown error';
        send('js', msg, {
            source: e && (e.filename || ''),
            line: e && e.lineno,
            col: e && e.colno
        });
    });

    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        var msg = (r && (r.message || r.error_description || r.msg)) || (typeof r === 'string' ? r : 'Unhandled promise rejection');
        send('promise', msg, { source: (r && (r.stack || '').split('\n')[1]) || '' });
    });
})();
