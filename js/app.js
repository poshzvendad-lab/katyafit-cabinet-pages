/* ============================================================
   KatyaFit · Личный кабинет — ядро логики (ФАЗА 1)

   Модель прогресса: «день открывается выполнением».
   - Открыт ровно один день (progressDay).
   - Завершение дня (настроение + фото) открывает следующий.
   - Пропустил и не заходил 3+ дня → предложить продолжить/начать заново.

   M2: состояние участницы хранится в Supabase (таблицы profiles / day_logs /
   measurements, защита RLS). При входе всё грузится в память (KF._profile,
   _logs, _measure), поэтому ГЕТТЕРЫ остаются синхронными — рендер не меняется.
   ЗАПИСИ обновляют память сразу и асинхронно сохраняются в базу.
   Локально остаётся лишь мелочь интерфейса: пропуск замеров и имя со входа.
   ============================================================ */

const RESUME_GAP_DAYS = 3; // через сколько дней простоя спрашивать «продолжить/заново»

// ─── Тарифы доступа (M5) ────────────────────────────────────────────────────
// 'none' — доступа нет (экран «доступ скоро»); 'trial' — дни 1–3 (2 тренировки);
// 'nutrition' — все 28 дней меню, тренировки под замком; 'full' — всё.
// Меняет Катя в БД (см. миграцию 0006). Сама участница тариф не повышает.
const TIER_MAX_DAY = { none: 0, trial: 3, nutrition: 28, full: 28 }; // докуда открыты дни
// Куда ведёт «открыть полный доступ» (оплаты пока нет — пишем Кате в Telegram).
const KF_UPGRADE_URL = 'https://t.me/kkatyafit';
// Личный Telegram Кати — «Написать Кате» (вопросы) и отзыв на финише программы.
const KF_KATYA_TG = 'https://t.me/kkatyafit';

// Версия privacy.html/oferta.html, под которой участница даёт согласие (анкета).
// Поднимать при существенных изменениях текста — тогда согласие можно попросить заново.
const CONSENT_POLICY_VERSION = '1.0';

// ─── Локальный ПРЕВЬЮ без Supabase (только для разработки) ───────────────────
// Позволяет открыть dashboard.html / day.html без входа, на мок-данных — чтобы
// глазами проверить вёрстку (иначе requireAuth редиректит на index).
//   dashboard.html?preview        — старт (День 1, «Начинаем», карточка замеров)
//   dashboard.html?preview=12     — середина (открыт День 12, 11 пройдено)
//   dashboard.html?preview=done   — финал (все 28 пройдены)
//   &m=1                          — подставить мок-замеры (start+finish → сравнение)
// ⚠️ ДВОЙНАЯ защита: только на localhost И только с ?preview. На проде
// (lk.katyafit.ru) hostname-проверка не проходит → код полностью мёртв.
const KF_PREVIEW = (() => {
    const h = location.hostname;
    if (h !== 'localhost' && h !== '127.0.0.1') return null;
    const p = new URLSearchParams(location.search);
    if (!p.has('preview')) return null;
    const v = p.get('preview');
    const want = v === 'done' ? 29 : Math.min(29, Math.max(1, parseInt(v, 10) || 1));
    // &tier=trial|nutrition|full|none — проверка тарифов локально (по умолчанию full).
    const tier = TIER_MAX_DAY.hasOwnProperty(p.get('tier')) ? p.get('tier') : 'full';
    return { progress: want, seedMeasure: p.has('m'), tier };
})();

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysBetween(aISO, bISO) {
    return Math.floor((Date.parse(bISO) - Date.parse(aISO)) / 86400000);
}

const KF = {
    _session: null,
    _profile: null,
    _logs: {},     // { [day]: row } из day_logs
    _measure: {},  // { [phase]: row } из measurements
    _days: {},     // { [day]: row } из program_days (контент открытых дней, кэш)

    _uid() { return this._session && this._session.user.id; },

    // ─── Загрузка сессии и всех данных участницы (один раз при входе) ───
    async boot() {
        if (KF_PREVIEW) return this._bootPreview();
        // supabase-js не поднялся (см. js/supabase.js: sb === null) — не роняем
        // страницу TypeError'ом, а честно отвечаем «не вошла» → редирект на вход,
        // где показывается сообщение «обнови страницу».
        if (!sb) return false;
        const { data: { session } } = await sb.auth.getSession();
        this._session = session || null;
        this._profile = null; this._logs = {}; this._measure = {}; this._days = {};
        if (!session) return false;
        const uid = session.user.id;

        // Три чтения независимы (нужен только uid) → грузим ПАРАЛЛЕЛЬНО, а не друг за
        // другом: на мобильном это срезает вход с ~3 round-trip'ов до одного.
        const [profRes, logsRes, msRes] = await Promise.all([
            sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
            sb.from('day_logs').select('*').eq('user_id', uid),
            sb.from('measurements').select('*').eq('user_id', uid),
        ]);

        this._profile = profRes.data || null;
        // Само-восстановление: профиль мог не создаться (вход случился до того, как
        // появился триггер автосоздания). Заводим строку сами — тогда прогресс/имя
        // будет куда сохранять.
        if (!this._profile) {
            const { data: created } = await sb.from('profiles')
                .insert({ id: uid, email: session.user.email, name: '' }).select().maybeSingle();
            this._profile = created || null;
        }
        // Первый вход: имя (если не попало в профиль) + дата старта/активности — ОДНИМ
        // апдейтом, а не тремя подряд. На повторных входах patch пуст → записи нет.
        await this._initProfileFields(session);

        (logsRes.data || []).forEach(r => { this._logs[r.day] = r; });

        await this._healStuckProgress();   // апгрейд тарифа мог оставить прогресс на завершённом дне

        (msRes.data || []).forEach(r => { this._measure[r.phase] = r; });
        // Параллельно: (1) подписанные URL к фото прогресса (bucket приватный) — чтобы
        // синхронный рендер коллажа «до/после» имел готовую ссылку; (2) прогрев контента
        // активного дня — тогда карточка «Продолжаем» на дашборде рисуется из кэша, без
        // отдельного round-trip после boot.
        await Promise.all([
            ...Object.values(this._measure).map(r => this._signPhoto(r)),
            this.getDay(this.activeDay()).catch(() => null),
        ]);

        return true;
    },

    // Подписанный URL к фото прогресса (bucket приватный, ~1 ч). Кладёт row._photoUrl,
    // чтобы геттер getMeasurePhotoUrl() оставался синхронным (как остальной рендер).
    async _signPhoto(row) {
        if (!row || !row.photo_path) { if (row) row._photoUrl = null; return; }
        if (KF_PREVIEW) { row._photoUrl = row.photo_path; return; }
        const { data } = await sb.storage.from('progress').createSignedUrl(row.photo_path, 3600);
        row._photoUrl = (data && data.signedUrl) || null;
    },

    // Мок-загрузка для локального превью (см. KF_PREVIEW). Без сети.
    _bootPreview() {
        // Тариф ограничивает, докуда реально мог дойти прогресс (триал: день 3).
        // Если запросили дальше капа — считаем, что все доступные дни пройдены
        // (это и есть «стена» пробного: progress_day=3 И день 3 завершён).
        const cap = TIER_MAX_DAY[KF_PREVIEW.tier] || 28;
        const finished = KF_PREVIEW.progress >= 29;      // сентинел ?preview=done
        const req = Math.min(28, KF_PREVIEW.progress);   // 1..28 (29→28)
        const progress = Math.min(req, cap || 28);
        // сколько дней «пройдено»: вне тарифа → все доступные (стена); ?preview=done →
        // все 28 (иначе сентинел съедался клампом и финал не показывался); иначе req-1.
        const done = req > cap ? cap : (finished ? 28 : Math.min(28, req - 1));
        this._session = { user: { id: 'preview', email: 'preview@local', user_metadata: { name: 'Превью' } } };
        this._profile = { id: 'preview', name: 'Превью', access_tier: KF_PREVIEW.tier, progress_day: progress, start_date: todayISO(), last_active: todayISO() };
        this._logs = {}; this._measure = {}; this._days = {};
        // habits: отмечаем все — чтобы в превью были видны стрики задач на day.html.
        for (let i = 1; i <= done; i++) this._logs[i] = { day: i, completed: true, mood: 'great', habits: { 0: true, 1: true, 2: true }, completed_at: new Date().toISOString() };
        if (KF_PREVIEW.seedMeasure) {
            const ph = (c, t) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="' + c + '"/><text x="150" y="210" font-family="sans-serif" font-size="30" fill="#fff" text-anchor="middle">' + t + '</text></svg>');
            this._measure.start  = { phase: 'start',  age: 32, height: 168, weight: 72.4, chest: 96, waist: 78, belly: 84, hips: 101,  _photoUrl: ph('#b9c4ab', 'фото до') };
            // Финальные замеры в реальности появляются только ПОСЛЕ 28-го дня —
            // сеем так же, иначе график веса в середине программы показывал бы «финал».
            if (done >= 28) this._measure.finish = { phase: 'finish', weight: 69.2, chest: 94, waist: 72, belly: 79, hips: 98.5, _photoUrl: ph('#a7b594', 'фото после') };
            // Недельные взвешивания — для мини-графика веса. Порог «неделя + 1 день»:
            // ровно на границе (done=7) вес ещё не записан → в превью видна карточка
            // «Неделя 1 позади!» (dashboard.html?preview=8&m=1).
            if (done >= 8)  this._measure.w1 = { phase: 'w1', weight: 71.6 };
            if (done >= 15) this._measure.w2 = { phase: 'w2', weight: 70.8 };
            if (done >= 22) this._measure.w3 = { phase: 'w3', weight: 70.1 };
        }
        return true;
    },
    // Мок-контент дня для превью (форма как у program_days).
    // Задачи дня зеркалят логику миграции 0023 (движение по типу дня + забота
    // о себе по неделе) — превью показывает ту же вариативность, что и прод.
    _previewDay(n) {
        const meta = PROGRAM[n - 1];
        const move = meta.type === 'workout' ? '8 000 шагов'
            : meta.type === 'recovery' ? 'Растяжка 10 минут'
            : 'Прогулка на свежем воздухе 20+ минут';
        const care = [
            'Похвали себя за любое усилие сегодня',
            'Приготовь один приём пищи заранее — будет проще не сорваться',
            'Проверь осанку: расправь плечи, подтяни живот',
            'Отметь, что изменилось за месяц — в теле, в энергии, в привычках',
        ][meta.week - 1];
        const day = {
            day: n, week: meta.week, type: meta.type,
            title: 'Превью дня ' + n,
            focus: 'Демо-контент для локального просмотра вёрстки.',
            meals: [
                { when: 'Завтрак', name: 'Овсянка с ягодами', desc: 'Овсяные хлопья, горсть ягод, чайная ложка мёда.', kcal: 320 },
                { when: 'Обед', name: 'Куриная грудка с гречкой', desc: 'Запечённая грудка, гречка, свежие овощи.', kcal: 480 },
                { when: 'Ужин', name: 'Творог с зеленью', desc: 'Творог 5%, огурец, зелень.', kcal: 240 },
            ],
            habits: ['Выпить 1.5–2 л воды', 'Сон 7+ часов', move, care],
        };
        if (meta.type === 'workout') day.workout = { title: 'Силовая на всё тело', dur: '28 мин', yt: 'placeholder' };
        return day;
    },

    // Достраиваем профиль при первом входе ОДНИМ апдейтом:
    //  • имя — могло не попасть в профиль (вход без имени или юзер уже существовал;
    //    триггер заполняет имя только при регистрации). Берём со страницы входа
    //    (kf_pending_name) или из метаданных сессии.
    //  • start_date / last_active — проставляем в первый заход.
    // На повторных входах все условия пропускаются → patch пуст, запись не идёт.
    async _initProfileFields(session) {
        const patch = {};
        const current = (this._profile && this._profile.name || '').trim();
        if (!current) {
            const pending = (localStorage.getItem('kf_pending_name') || '').trim();
            const meta = (session.user.user_metadata && session.user.user_metadata.name || '').trim();
            if (pending || meta) patch.name = pending || meta;
        }
        if (this._profile && !this._profile.start_date) {
            const t = todayISO();
            patch.start_date = t;
            patch.last_active = this._profile.last_active || t;
        }
        if (Object.keys(patch).length) {
            const { error } = await sb.from('profiles').update(patch).eq('id', session.user.id);
            if (!error && this._profile) Object.assign(this._profile, patch);
        }
        // Имя теперь в профиле (было раньше или только что записали) → временное со входа не нужно.
        if (this._profile && this._profile.name) localStorage.removeItem('kf_pending_name');
    },

    get auth() { return !!this._session; },
    get name() {
        if (this._profile && this._profile.name) return this._profile.name;
        const meta = this._session && this._session.user.user_metadata;
        if (meta && meta.name) return meta.name;
        if (this._session && this._session.user.email) return this._session.user.email.split('@')[0];
        return 'Гостья';
    },
    get progressDay() { return Math.min(28, Math.max(1, (this._profile && this._profile.progress_day) || 1)); },

    // ─── Тариф доступа (M5) ───
    get tier() { return (this._profile && this._profile.access_tier) || 'none'; },
    get hasAccess() { return this.tier !== 'none'; },
    tierMaxDay() { return TIER_MAX_DAY[this.tier] || 0; },          // докуда открыты дни
    showsWorkouts() { return this.tier !== 'nutrition'; },           // в «питании» тренировки под замком
    dayBeyondTier(n) { return n > this.tierMaxDay(); },             // день вне тарифа (триал: 4+)
    // Пробный пройден: завершён последний доступный день (день 3) — дальше «стена».
    atTrialWall() { return this.tier === 'trial' && this.isCompleted(this.tierMaxDay()); },

    async logout() { await sb.auth.signOut(); this._session = null; this._profile = null; this._logs = {}; this._measure = {}; this._days = {}; },

    async touch() {
        const uid = this._uid(); if (!uid) return;
        const t = todayISO();
        if (this._profile) this._profile.last_active = t;
        if (KF_PREVIEW) return;
        await sb.from('profiles').update({ last_active: t }).eq('id', uid);
    },

    // ─── Прогресс / задачи дня ───
    dayLog(n) { return this._logs[n] || null; },
    isCompleted(n) { const l = this._logs[n]; return !!(l && l.completed); },

    getHabits(n) { const l = this._logs[n]; return (l && l.habits) || {}; },
    // Возвращает { ok } (правило «записи возвращают {ok}»). Ставки низкие, поэтому
    // при сбое БД просто откатываем память — вызывающий код возвращает чекбокс,
    // без сообщений (галочка «не взялась» — участница тапнет ещё раз).
    async setHabit(n, idx, val) {
        const uid = this._uid(); if (!uid) return { ok: false, reason: 'auth' };
        const l = this._logs[n] || (this._logs[n] = { user_id: uid, day: n, habits: {} });
        l.habits = l.habits || {};
        const prev = l.habits[idx];
        l.habits[idx] = val;
        if (KF_PREVIEW) return { ok: true };
        const { error } = await sb.from('day_logs').upsert({ user_id: uid, day: n, habits: l.habits }, { onConflict: 'user_id,day' });
        if (error) {
            if (prev == null) delete l.habits[idx]; else l.habits[idx] = prev;
            if (window.KFErr) KFErr.dbFailure('setHabit(' + n + ')', error.message);
            return { ok: false, reason: 'network', error };
        }
        return { ok: true };
    },
    // max (необязательно) — сколько задач у дня сейчас: считаем только валидные
    // индексы (< max). Иначе устаревшие ключи в day_logs (напр. удалённые задачи
    // 3/4) дали бы «5 из 3». Без max — считаем все отмеченные (старое поведение).
    habitsChecked(n, max) {
        const h = this.getHabits(n);
        return Object.keys(h).filter(k => h[k] && (max == null || +k < max)).length;
    },

    // Возвращает { ok:true } или { ok:false, reason:'auth'|'network' }. При сбое БД
    // ОТКАТЫВАЕТ оптимистичную память (иначе UI поздравит, а прогресс не сохранится —
    // ровно тот «тихий» сбой, что был у замеров). Вызывающий код обязан проверить ok.
    async completeDay(n, data) {
        const uid = this._uid(); if (!uid) return { ok: false, reason: 'auth' };
        const t = todayISO();
        // снимок для отката
        const prevLog = this._logs[n] ? Object.assign({}, this._logs[n]) : undefined;
        const prevProg = this._profile ? this._profile.progress_day : 1;
        const prevActive = this._profile ? this._profile.last_active : null;

        const l = this._logs[n] || (this._logs[n] = { user_id: uid, day: n, habits: {} });
        l.completed = true;
        l.mood = (data && data.mood) || null;
        l.completed_at = new Date().toISOString();
        // Фото прогресса теперь снимается в замерах (старт/финал), не при завершении дня.
        // Кап тарифа: триал не открывает дни дальше 3 (а сервер это ещё и перепроверяет).
        // Прогресс МОНОТОНЕН — никогда не уходит назад: следующий день (n+1) прижимаем
        // капом тарифа, но если прогресс уже выше капа (тариф понизили) — оставляем как
        // есть, а не откатываем. Иначе понижение до триала могло бы слить прогресс к дню 3.
        const newProg = Math.max(this.progressDay, Math.min(this.tierMaxDay() || 28, n + 1));
        if (this._profile) { this._profile.progress_day = newProg; this._profile.last_active = t; }

        if (KF_PREVIEW) return { ok: true };
        const { error: e1 } = await sb.from('day_logs').upsert(
            { user_id: uid, day: n, completed: true, mood: l.mood, habits: l.habits, completed_at: l.completed_at },
            { onConflict: 'user_id,day' });
        const { error: e2 } = e1 ? { error: e1 }
            : await sb.from('profiles').update({ progress_day: newProg, last_active: t }).eq('id', uid);
        const error = e1 || e2;
        if (error) {
            if (prevLog) this._logs[n] = prevLog; else delete this._logs[n];
            if (this._profile) { this._profile.progress_day = prevProg; this._profile.last_active = prevActive; }
            const auth = error.code === 'PGRST301' || /jwt|token|401|403|permission/i.test(error.message || '');
            if (!auth && window.KFErr) KFErr.dbFailure('completeDay(' + n + ')', error.message);
            return { ok: false, reason: auth ? 'auth' : 'network', error };
        }
        return { ok: true };
    },

    completedCount() {
        let c = 0; for (let i = 1; i <= 28; i++) if (this.isCompleted(i)) c++; return c;
    },
    workoutsCompleted() {
        let c = 0; for (let i = 1; i <= 28; i++) if (this.isCompleted(i) && PROGRAM[i - 1].type === 'workout') c++; return c;
    },
    isFinished() { return this.isCompleted(28); },
    activeDay() { return this.isFinished() ? 28 : this.progressDay; },

    // ─── Контент дня (Supabase program_days, закрыт RLS) ───
    // Возвращает строку дня { day, week, type, title, focus, workout, meals, habits }
    // ИЛИ null, если день ещё закрыт (RLS не отдаёт строку) — тогда рисуем замок.
    // Это и есть «настоящий замок»: сервер решает, не клиент. Открытые дни кэшируем;
    // null не кэшируем — чтобы после открытия дня повторный запрос его подтянул.
    async getDay(n) {
        if (KF_PREVIEW) return (n <= this.progressDay) ? this._previewDay(n) : null;
        if (this._days[n]) return this._days[n];
        const { data } = await sb.from('program_days').select('*').eq('day', n).maybeSingle();
        if (data) this._days[n] = data;
        return data || null;
    },

    // ─── Данные ПИТАНИЯ (Supabase nutrition_days / nutrition_reference, RLS по тарифу) ───
    // Меню и справочник (замены/вкусняшки/списки) переехали под серверный замок
    // (?v=0.6.73, миграция 0024). Загружаем в кэш NUTRITION (js/nutrition-data.js),
    // откуда синхронные геттеры (nutritionDay/nutritionConstructor/…) их читают.
    //   opts.days      — 'all' (все открытые тарифом) | [n, …] (конкретные дни)
    //   opts.reference — грузить constructor+treats+shopping (один раз)
    // Каждый запрос обёрнут таймаутом (сеть из РФ иногда висит — урок 0.6.60): не
    // блокируем рендер, при сбое кэш просто пуст → геттер вернёт null → фолбэк.
    async loadNutrition(opts) {
        opts = opts || {};
        if (KF_PREVIEW) return this._loadNutritionPreview(opts);
        if (!sb) return;
        const jobs = [];

        // Меню дней (nutrition_days). Уже загруженные не перезапрашиваем.
        if (opts.days === 'all') {
            jobs.push(this._raceNutri(
                sb.from('nutrition_days').select('day,data'),
                rows => { (rows || []).forEach(r => { NUTRITION.days[r.day] = r.data; }); }));
        } else if (Array.isArray(opts.days) && opts.days.length) {
            const want = opts.days.filter(n => n >= 1 && n <= 28 && !NUTRITION.days[n]);
            if (want.length) jobs.push(this._raceNutri(
                sb.from('nutrition_days').select('day,data').in('day', want),
                rows => { (rows || []).forEach(r => { NUTRITION.days[r.day] = r.data; }); }));
        }

        // Справочник (constructor/treats/shopping) — один раз на сессию страницы.
        if (opts.reference && !NUTRITION._refLoaded) {
            jobs.push(this._raceNutri(
                sb.from('nutrition_reference').select('id,data'),
                rows => {
                    if (!rows) return;               // сбой/таймаут — не помечаем загруженным
                    rows.forEach(r => {
                        if (r.id === 'constructor') NUTRITION.constructor = r.data;
                        else if (r.id === 'treats') NUTRITION.treats = r.data;
                        else if (r.id === 'shopping') NUTRITION.shopping = r.data;
                    });
                    NUTRITION._refLoaded = true;
                }));
        }
        await Promise.all(jobs);
    },

    // Запрос Supabase + таймаут 8с. Supabase-билдер — thenable; Promise.resolve
    // адаптирует его в настоящий промис (можно .catch). apply получает data|null.
    async _raceNutri(query, apply) {
        const req = Promise.resolve(query).then(r => (r && r.data) || null).catch(() => null);
        const data = await Promise.race([
            req,
            new Promise(res => setTimeout(() => res(null), 8000)),
        ]);
        apply(data);
    },

    // Мок питания для локального превью (?preview). ⚠️ ВЫДУМАННЫЙ, НЕ копия реальных
    // данных: app.js уходит в публичный браузер — мок с настоящим меню вернул бы
    // утечку через чёрный ход. Покрывает ветки рендера (items+rec, перекус-treat,
    // читмил, разные недели) + мини-справочник, чтобы превью ловило регрессии.
    _loadNutritionPreview(opts) {
        opts = opts || {};
        const cap = TIER_MAX_DAY[KF_PREVIEW.tier] || 28;
        const wantDay = n => n >= 1 && n <= 28 && n <= cap;
        const put = n => { if (wantDay(n) && !NUTRITION.days[n]) NUTRITION.days[n] = this._previewNutritionDay(n); };
        if (opts.days === 'all') { for (let n = 1; n <= 28; n++) put(n); }
        else if (Array.isArray(opts.days)) opts.days.forEach(put);
        if (opts.reference && !NUTRITION._refLoaded && KF_PREVIEW.tier !== 'none') {
            NUTRITION.constructor = this._previewConstructor();
            NUTRITION.treats = this._previewTreats();
            if (KF_PREVIEW.tier === 'nutrition' || KF_PREVIEW.tier === 'full') NUTRITION.shopping = this._previewShopping();
            NUTRITION._refLoaded = true;
        }
    },
    _previewNutritionDay(n) {
        const week = Math.ceil(n / 7);
        const cheat = (n % 7 === 0);           // читмилы 7/14/21/28
        if (cheat) {
            return { week, theme: 'Превью · читмил', phase: 'Читмил', cheat: true, meals: [
                { slot: 'Завтрак', text: 'Демо-омлет из 2 яиц (100 г), овощи.', p: 18, f: 14, c: 6, items: [], rec: ['Демо-шаг рецепта для превью.'] },
                { slot: 'Обед', text: 'Демо-курица (170 г сырой, ≈ 120 г готового), демо-крупа (50 г сухой, ≈ 140 г готовой).', p: 40, f: 8, c: 40, items: [{ n: 'Демо-курица', g: 120, k: 0.7 }, { n: 'Демо-крупа', g: 140, k: 2.7 }], rec: ['Демо-шаг рецепта для превью.'] },
                { slot: 'Ужин', cheat: true, text: 'Свободный приём — демо-читмил превью.' },
            ] };
        }
        return { week, theme: 'Превью-неделя ' + week, phase: 'Демо', cheat: false, meals: [
            { slot: 'Завтрак', text: 'Демо-каша (45 г сухой, ≈ 135 г готовой), 2 яйца.', p: 22, f: 15, c: 35, items: [{ n: 'Демо-крупа', g: 135, k: 3 }], rec: ['Свари демо-кашу — шаг для превью.', 'Отвари яйца — второй шаг.'] },
            { slot: 'Обед', text: 'Демо-рыба (180 г сырой, ≈ 145 г готового), демо-картофель (180 г сырой, ≈ 150 г готового), овощи.', p: 35, f: 9, c: 38, items: [{ n: 'Демо-рыба', g: 145, k: 0.8 }, { n: 'Демо-картофель', g: 150, k: 0.83 }], rec: ['Запеки демо-рыбу — шаг превью.'] },
            { slot: 'Перекус', treat: true, text: 'Демо-вкусняшка (20 г) + чай.', p: 2, f: 8, c: 20 },
            { slot: 'Ужин', text: 'Демо-творог (150 г), демо-ягоды (80 г).', p: 27, f: 10, c: 12, items: [], rec: ['Смешай демо-творог с ягодами — шаг превью.'] },
        ] };
    },
    _previewConstructor() {
        return { intro: 'Демо-описание Конструктора для превью (реальный текст — на сервере).', groups: [
            { title: 'Белки', note: '≈ 25–30 г белка', rows: [
                { n: 'Демо-курица', slot: 'ld', raw: '130–140 г', cooked: '90–100 г', kcal: 138, p: 30, f: 2, c: 0, rec: 'Демо-рецепт замены.' },
                { n: 'Демо-творог', slot: 'bd', raw: '150–180 г', cooked: '', kcal: 196, p: 28, f: 8, c: 3 },
            ] },
            { title: 'Сложные углеводы', note: '≈ 28–37 г углеводов', rows: [
                { n: 'Демо-крупа', slot: 'l', raw: '40–45 г', cooked: '110–120 г', kcal: 145, p: 5, f: 1, c: 29, rec: 'Демо-рецепт крупы.' },
            ] },
            { title: 'Полезные жиры', note: '≈ 10–12 г жиров', rows: [
                { n: 'Демо-масло', slot: 'bld', raw: '1 ст. ложка (10 г)', cooked: '', kcal: 90, p: 0, f: 10, c: 0 },
            ] },
        ] };
    },
    _previewTreats() {
        return { note: 'Демо-примечание вкусняшек для превью.', rows: [
            { n: 'Демо-шоколад', w: '20 г', kcal: 111, p: 1, f: 7, c: 11 },
            { n: 'Демо-зефир', w: '1 шт (35 г)', kcal: 120, p: 1, f: 0, c: 29 },
        ] };
    },
    _previewShopping() {
        const wk = w => ({ week: w, note: 'Демо-примечание списка недели ' + w + '.', groups: [
            { t: 'Мясо, рыба', items: [['Демо-курица', '≈ 1,3 кг'], ['Демо-рыба', '≈ 500 г']] },
            { t: 'Крупы, хлеб', items: [['Демо-крупа', '≈ 175 г'], ['Демо-хлеб', '4 куска']] },
            { t: 'Молочное и яйца', items: [['Яйца', '10 шт'], ['Демо-творог', '≈ 500 г']] },
        ] });
        return [wk(1), wk(2), wk(3), wk(4)];
    },

    // ─── Замеры (старт/финал) ───
    getMeasurements(phase) { return this._measure[phase] || null; },
    // Есть ли реально заполненные поля (а не пустая строка-заглушка).
    hasMeasurements(phase) {
        const m = this._measure[phase];
        return !!(m && MEASURE_FIELDS.some(f => m[f.key] != null));
    },
    // Подписанный URL фото прогресса фазы (или null) — синхронно, из памяти (см. _signPhoto).
    getMeasurePhotoUrl(phase) { const m = this._measure[phase]; return (m && m._photoUrl) || null; },
    // Стартовая анкета заполнена: все обязательные поля (возраст/рост/вес).
    // Это «ворота» к завершению Дня 1 (см. day.html) и к карточке «Ваши данные».
    anketaComplete() {
        const m = this._measure.start;
        if (!m) return false;
        // Обязательны только числовые поля (возраст/рост/вес — нужны для расчёта
        // питания по Миффлину). Фото «до» — по желанию (раньше было обязательным;
        // сняли, чтобы сбой загрузки фото не блокировал старт — замеры важнее).
        return MEASURE_FIELDS.filter(f => f.required).every(f => m[f.key] != null);
    },

    // ─── Согласие на обработку персональных данных (152-ФЗ) ───
    // Даётся один раз чекбоксом в стартовой анкете (dashboard.html). Пишем ФАКТ
    // и ВРЕМЯ в профиль — не привилегия (в отличие от access_tier), поэтому без RPC.
    consentAccepted() { return !!(this._profile && this._profile.consent_accepted_at); },
    async acceptConsent() {
        const uid = this._uid(); if (!uid) return { ok: false, reason: 'auth' };
        const t = new Date().toISOString();
        if (KF_PREVIEW) { if (this._profile) { this._profile.consent_accepted_at = t; this._profile.policy_version = CONSENT_POLICY_VERSION; } return { ok: true }; }
        const patch = { consent_accepted_at: t, policy_version: CONSENT_POLICY_VERSION };
        const { error } = await sb.from('profiles').update(patch).eq('id', uid);
        if (error) {
            const auth = error.code === 'PGRST301' || /jwt|token|401|403|permission/i.test(error.message || '');
            if (!auth && window.KFErr) KFErr.dbFailure('acceptConsent', error.message);
            return { ok: false, reason: auth ? 'auth' : 'network', error };
        }
        if (this._profile) Object.assign(this._profile, patch);
        return { ok: true };
    },

    // ─── Личная норма калорий по Миффлину — Сан Жеор ───
    // Считаем из стартовой анкеты (возраст/рост/вес; пол женский — константа).
    // Это «бюджет дня» под персональную цель снижения веса. Множитель активности
    // участница выбирает в анкете (ACTIVITY_LEVELS); дефицит и белок пока зашиты —
    // позже вынести в настройку, чтобы Катя крутила.
    // Возвращает { bmr, tdee, kcal, protein, fat, carb, activity } или null (нет анкеты).
    nutritionTargets() {
        const m = this._measure.start;
        if (!m || m.weight == null || m.height == null || m.age == null) return null;
        const w = +m.weight, h = +m.height, a = +m.age;
        const lv = activityLevel(m.activity);               // выбор из анкеты (или средняя по умолчанию)
        const bmr = 10 * w + 6.25 * h - 5 * a - 161;       // женщины
        const tdee = bmr * lv.mult;                         // бытовая активность × BMR
        const FLOOR = 1200;                                 // защитный пол (не ниже — безопасность)
        let kcal = Math.round(tdee * 0.82 / 10) * 10;       // дефицит ~18%, округление до 10 ккал
        if (kcal < FLOOR) kcal = FLOOR;
        const protein = Math.round(1.5 * w);                // белок 1.5 г/кг
        const fat = Math.round(kcal * 0.30 / 9);            // жиры 30% калорий
        const carb = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
        return { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, fat, carb, activity: lv };
    },
    // Возвращает { ok:true } или { ok:false, reason:'auth'|'network' } — вызывающий
    // код ДОЛЖЕН проверить результат и показать ошибку (раньше сбой глотался молча,
    // и участница видела «ничего не произошло»).
    // photoBlob (необязательно) — сжатое фото прогресса (Blob/File) → грузим в
    // приватный bucket progress/<uid>/<phase>.jpg (upsert), путь пишем в photo_path.
    // Фото не обязательно: без него старое фото фазы сохраняется (upsert не трогает
    // отсутствующие колонки).
    async saveMeasurements(phase, data, photoBlob) {
        const uid = this._uid(); if (!uid) return { ok: false, reason: 'auth' };
        const row = { user_id: uid, phase, taken_at: todayISO() };
        MEASURE_FIELDS.forEach(f => {
            const k = f.key;
            row[k] = (data && data[k] != null && data[k] !== '') ? Number(data[k]) : null;
        });
        // Уровень активности — текстовый ключ, только в анкете (фаза 'start'); влияет
        // на бюджет калорий (nutritionTargets). Всегда пишем валидный ключ.
        if (phase === 'start') row.activity = activityLevel(data && data.activity).key;
        if (KF_PREVIEW) {
            if (photoBlob) { row.photo_path = phase; row._photoUrl = URL.createObjectURL(photoBlob); }
            this._measure[phase] = row; this.undismissMeasure(phase); return { ok: true };
        }
        // Фото — по желанию и НЕ должно ронять сохранение замеров: если фото не легло
        // из-за сети, всё равно пишем замеры (они важнее), а про фото сообщаем флагом
        // photoFailed — вызывающий код предложит повторить фото, не теряя цифр.
        let photoFailed = false;
        if (photoBlob) {
            const path = uid + '/' + phase + '.jpg';
            // Мобильная сеть капризна: фото-fetch падает разовым «Load failed» (WebKit).
            // Фото небольшое — тихо пробуем залить ещё раз, прежде чем сдаться.
            let upErr = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                ({ error: upErr } = await sb.storage.from('progress')
                    .upload(path, photoBlob, { contentType: 'image/jpeg', upsert: true }));
                if (!upErr) break;
                if (/jwt|token|401|403|permission/i.test(upErr.message || '')) break; // auth — повтор не поможет
                if (attempt === 0) await new Promise(r => setTimeout(r, 800));
            }
            if (upErr) {
                // Истёкшая сессия — замеры тоже не лягут, честно просим перезайти.
                if (/jwt|token|401|403|permission/i.test(upErr.message || ''))
                    return { ok: false, reason: 'auth', error: upErr };
                // Сетевой сбой только у фото — НЕ теряем замеры, сохраняем их без фото.
                if (window.KFErr) KFErr.dbFailure('saveMeasurements/photo(' + phase + ')', upErr.message);
                photoFailed = true;
            } else {
                row.photo_path = path;
            }
        }
        const { data: saved, error } = await sb.from('measurements')
            .upsert(row, { onConflict: 'user_id,phase' }).select().maybeSingle();
        if (error) {
            // 401/403/JWT → сессия истекла (нужен повторный вход); иначе считаем сетью.
            const auth = error.code === 'PGRST301' || /jwt|token|401|403|permission/i.test(error.message || '');
            if (!auth && window.KFErr) KFErr.dbFailure('saveMeasurements(' + phase + ')', error.message);
            return { ok: false, reason: auth ? 'auth' : 'network', error };
        }
        const out = saved || row;
        this._measure[phase] = out;
        await this._signPhoto(out);     // свежий signed URL (новое фото или сохранённое прежним)
        // Новое фото прогресса -> отправить Кате в Telegram (best-effort, не блокирует).
        if (row.photo_path && out._photoUrl) this._notifyPhoto(phase, out._photoUrl);
        this.undismissMeasure(phase);
        return { ok: true, photoFailed };
    },
    // Отдать Кате фото прогресса в Telegram. Шлём подписанную ссылку на СВОЁ фото
    // (RLS разрешает владельцу) в RPC report_progress_photo -> n8n -> sendPhoto. Тихо,
    // не ждём: сбой уведомления не должен мешать сохранению (фото уже в Storage).
    async _notifyPhoto(phase, url) {
        if (KF_PREVIEW) return;
        try { await sb.rpc('report_progress_photo', { p_phase: phase, p_url: url }); } catch (e) {}
    },
    // ─── Недельные взвешивания (по желанию) ───
    // Фазы w1..w3 = вес в конце недель 1–3 (конец недели 4 — это 'finish').
    // Предлагаем ТОЛЬКО последнюю прожитую неделю (день 7/14/21 завершён):
    // догонять пропущенные недели задним числом бессмысленно — вес уже не тот.
    weeklyDue() {
        if (this.isFinished() || !this.anketaComplete()) return null;
        let w = 0;
        for (let i = 1; i <= 3; i++) if (this.isCompleted(i * 7)) w = i;
        if (!w) return null;
        const m = this._measure['w' + w];
        if (m && m.weight != null) return null;
        return { phase: 'w' + w, week: w };
    },
    // Ряд веса для мини-графика на дашборде: старт → недели → финал
    // (только заполненные точки, по порядку).
    weightSeries() {
        const pts = [];
        const push = (phase, label) => {
            const m = this._measure[phase];
            if (m && m.weight != null) pts.push({ phase, label, w: +m.weight });
        };
        push('start', 'старт');
        push('w1', 'нед 1'); push('w2', 'нед 2'); push('w3', 'нед 3');
        push('finish', 'финал');
        return pts;
    },

    // Стрик задачи idx: сколько дней ПОДРЯД она отмечена, считая назад от дня n.
    // Сам день n входит, если уже отмечен; иначе считаем от вчера — чтобы утром
    // стрик не «сгорал» до того, как участница успела поставить галочку.
    habitStreak(n, idx) {
        let d = n;
        if (!this.getHabits(d)[idx]) d--;
        let s = 0;
        while (d >= 1 && this.getHabits(d)[idx]) { s++; d--; }
        return s;
    },

    // Напоминание о замерах гасим ТОЛЬКО на текущую сессию (sessionStorage),
    // чтобы при следующем входе снова предложить — пока замеры не введены.
    measureDismissed(phase) { try { return sessionStorage.getItem('kf_measure_dismiss_' + phase) === '1'; } catch (e) { return false; } },
    dismissMeasure(phase) { try { sessionStorage.setItem('kf_measure_dismiss_' + phase, '1'); } catch (e) {} },
    undismissMeasure(phase) { try { sessionStorage.removeItem('kf_measure_dismiss_' + phase); } catch (e) {} },
    // Разница старт→финал по каждому полю (для экрана прогресса). Только поля,
    // заполненные в ОБОИХ замерах. delta < 0 = объём/вес ушли (прогресс).
    measureProgress() {
        const s = this._measure.start, f = this._measure.finish;
        if (!s || !f) return [];
        return MEASURE_FIELDS
            .filter(fl => s[fl.key] != null && f[fl.key] != null)
            .map(fl => ({
                key: fl.key, label: fl.label, unit: fl.unit,
                from: s[fl.key], to: f[fl.key],
                delta: +(f[fl.key] - s[fl.key]).toFixed(1),
            }));
    },

    // Возвращает { ok:true } или { ok:false, reason:'auth'|'network' } — вызывающий
    // код обязан проверить ok, иначе «Начать заново» молча перезагрузит страницу,
    // а прогресс останется. Порядок записей: сначала профиль (progress_day=1),
    // потом логи/замеры — если сбой случится на середине, при следующем входе
    // _healStuckProgress по оставшимся логам вернёт прогресс на место, то есть
    // частичный сбой = «сброс не случился», а не рваное состояние.
    async reset() {
        const uid = this._uid(); if (!uid) return { ok: false, reason: 'auth' };
        const t = todayISO();
        if (!KF_PREVIEW) {
            const { error: e1 } = await sb.from('profiles')
                .update({ progress_day: 1, start_date: t, last_active: t }).eq('id', uid);
            const { error: e2 } = e1 ? { error: e1 }
                : await sb.from('day_logs').delete().eq('user_id', uid);
            const { error: e3 } = (e1 || e2) ? { error: e1 || e2 }
                : await sb.from('measurements').delete().eq('user_id', uid);
            const error = e1 || e2 || e3;
            if (error) {
                const auth = error.code === 'PGRST301' || /jwt|token|401|403|permission/i.test(error.message || '');
                if (!auth && window.KFErr) KFErr.dbFailure('reset', error.message);
                return { ok: false, reason: auth ? 'auth' : 'network', error };
            }
            // Файлы фото — best-effort: их сиротство не мешает сбросу (перезапишутся upsert'ом).
            try { await sb.storage.from('progress').remove([uid + '/start.jpg', uid + '/finish.jpg']); } catch (e) {}
        }
        if (this._profile) { this._profile.progress_day = 1; this._profile.start_date = t; this._profile.last_active = t; }
        this._logs = {}; this._measure = {}; this._days = {}; // дни снова закрылись — сбросить кэш контента
        this.undismissMeasure('start'); this.undismissMeasure('finish');
        return { ok: true };
    },

    // Лечим «застрявший» прогресс после апгрейда тарифа. completeDay прижимает
    // progress_day к капу тарифа (триал: день 3), поэтому последний пробный день
    // остаётся завершённым, но прогресс с него не сдвигается. Когда тариф
    // расширяют (через бота, меняется только access_tier), активным днём остаётся
    // уже пройденный: нет кнопки «Завершить», следующий под замком — тупик.
    // Двигаем progress_day к первому непройденному дню в пределах нового тарифа
    // и сохраняем (сервер отдаёт контент по progress_day из БД, не по клиенту).
    async _healStuckProgress() {
        const uid = this._uid(); if (!uid || KF_PREVIEW || this.isFinished()) return;
        let p = this.progressDay;
        const max = this.tierMaxDay() || 28;
        while (p < max && this.isCompleted(p)) p++;
        if (p === this.progressDay) return;
        const { error } = await sb.from('profiles').update({ progress_day: p }).eq('id', uid);
        if (!error && this._profile) this._profile.progress_day = p;
    },

    gapDays() {
        const la = this._profile && this._profile.last_active;
        return la ? daysBetween(la, todayISO()) : 0;
    },
    // Пауза, зафиксированная на входе в сессию (до touch). См. requireAuth().
    _sessionGap: 0,
    shouldOfferResume() {
        return this.auth && this.progressDay > 1 && !this.isFinished() && this._sessionGap >= RESUME_GAP_DAYS;
    },
};

// Состояние ячейки дня: 'done' | 'today' | 'locked'
function dayState(n) {
    if (KF.isCompleted(n)) return 'done';
    if (n === KF.activeDay() && !KF.isFinished()) return 'today';
    return 'locked';
}

async function requireAuth() {
    if (!(await KF.boot())) { window.location.replace('index.html'); return false; }
    // Гейт доступа (M5): вошла, но тариф ещё не выдан → экран «доступ скоро».
    if (!KF.hasAccess) { window.location.replace('pending.html'); return false; }
    KF._sessionGap = KF.gapDays(); // зафиксировать паузу ДО отметки активности
    KF.touch();                    // async, не ждём — обновит last_active в фоне
    return true;
}

function initTopbar() {
    const nm = KF.name;
    document.querySelectorAll('[data-user-name]').forEach(el => { el.textContent = nm; el.classList.remove('is-skel'); });
    document.querySelectorAll('[data-user-avatar]').forEach(el => { el.textContent = (nm.trim()[0] || 'К').toUpperCase(); el.classList.remove('is-skel'); });
    const logout = document.querySelector('[data-logout]');
    if (logout) logout.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('Выйти из кабинета? Чтобы вернуться, нужно снова войти по коду из письма.')) return;
        await KF.logout();
        window.location.href = 'index.html';
    });
}

// ─── PWA: регистрация Service Worker ────────────────────────────────────────
// Делает кабинет устанавливаемым на телефон + быстрым офлайн (см. sw.js).
// Молчит в мок-превью (?preview), чтобы кэш не мешал разработке вёрстки.
if ('serviceWorker' in navigator && !KF_PREVIEW) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим не критичен */ });
    });
}

// ─── Аккордеон шторок: на странице открыта только одна <details> ────────────
// (просьба владельца 10.07.2026 — и шторки, и раскрывашки-«вопросики»).
// Вложенные — одна цепочка: предков и потомков открытой не трогаем (вопросик
// внутри шторки не закрывает саму шторку). toggle не всплывает — ловим на
// фазе захвата.
document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.open || d.tagName !== 'DETAILS') return;
    document.querySelectorAll('details[open]').forEach(o => {
        if (o !== d && !o.contains(d) && !d.contains(o)) o.open = false;
    });
    // Захлопнувшаяся высокая шторка ВЫШЕ могла увести открытую за край экрана.
    const r = d.getBoundingClientRect();
    if (r.top < 0) d.scrollIntoView({ block: 'start' });
}, true);
