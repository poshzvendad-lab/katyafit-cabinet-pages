/* ============================================================
   KatyaFit · Личный кабинет — ФУНКЦИИ плана питания (данные — на сервере).

   ⭐ ДАННЫЕ ПИТАНИЯ ПЕРЕЕХАЛИ ПОД СЕРВЕРНЫЙ ЗАМОК (RLS), ?v=0.6.73. Раньше весь
   платный план (меню 28 дней, таблицы замен, вкусняшки, списки покупок) лежал
   прямо здесь и читался из исходников без входа и оплаты — блокер продаж. Теперь
   меню и справочник хранятся в БД (таблицы `nutrition_days` / `nutrition_reference`,
   RLS по ТАРИФУ) и отдаются только оплатившим. См. `supabase/migrations/0024_nutrition_lock.sql`.

   Этот файл теперь содержит ТОЛЬКО логику (функции), которая читает данные из
   кэша `NUTRITION` в памяти. Кэш наполняет `KF.loadNutrition(...)` в `js/app.js`
   (async-запрос к БД с таймаутом; в превью — выдуманный мок). Геттеры остаются
   СИНХРОННЫМИ — рендер в day.html/dashboard.html не изменился по форме.

   🖊️ РЕДАКТИРОВАТЬ МЕНЮ: правь `supabase/nutrition-source.js` (не деплоится в
   браузер), затем `node supabase/gen-nutrition-migration.js` и применяй миграцию.
   Там же — все правила по данным (двойной вес сырой/готовый, «ПРАВИЛО ПРИЁМОВ»
   обед/ужин, калорийность 1170–1250, слоты Конструктора b/l/d). Б/Ж/У оценочные —
   финальное слово за Катей-нутрициологом.

   Формат кэша (ровно то, что раньше возвращали константы):
     NUTRITION.days[n]     = { week, theme, phase, cheat, meals:[{slot,text,p,f,c,items?,rec?,treat?,cheat?}] }
     NUTRITION.constructor = { intro, groups:[{title,note,rows:[{n,slot,raw,cooked,kcal,p,f,c,rec?}]}] }
     NUTRITION.treats      = { note, rows:[{n,w,kcal,p,f,c}] }
     NUTRITION.shopping    = [{ week, note, groups:[{t, items:[[name,qty],...]}] }]
   ============================================================ */

// Кэш данных питания. Наполняется с сервера (KF.loadNutrition в app.js) —
// синхронные геттеры ниже читают отсюда. Пусто до загрузки: геттер вернёт null,
// вызывающий рендер покажет фолбэк (не пустой экран).
const NUTRITION = { days: {}, constructor: null, treats: null, shopping: null, extras: null, _refLoaded: false };

/* Персональные порции (26.07.2026, ?v=0.6.74). Меню собрано под ≈1200 ккал, а
   личная норма участницы бывает и 2200 — раньше разницу она добирала руками.
   Подгонка живёт в ОДНОЙ точке, здесь: страница дня, «что готовить завтра» и
   списки покупок ходят за меню через nutritionDay, поэтому её порции появляются
   везде сразу и разойтись между экранами не могут. Движок — js/nutrition-scale.js.

   Кэш: personalDay заметно дороже чтения объекта, а nutritionDay зовут на каждый
   рендер. Держим готовый день, пока не сменились норма или сами данные. */
const PERSONAL = { key: '', days: {}, src: {}, factors: {} };

// Меню дня n (1..28): { week, theme, phase, cheat, meals[] } или null (не загружен/
// закрыт тарифом). Раньше искал по статическому NUTRITION_PLAN — теперь из кэша.
function nutritionDay(n) {
    const raw = NUTRITION.days[n] || null;
    if (!raw || typeof personalDay !== 'function') return raw;

    // Без анкеты нормы нет — показываем базовый план (как было до подгонки).
    const t = (typeof KF !== 'undefined' && KF.nutritionTargets) ? KF.nutritionTargets() : null;
    if (!t) return raw;

    const key = t.kcal + '/' + t.protein;
    if (PERSONAL.key !== key) { PERSONAL.key = key; PERSONAL.days = {}; PERSONAL.src = {}; PERSONAL.factors = {}; }
    if (PERSONAL.src[n] !== raw) {
        PERSONAL.src[n] = raw;
        PERSONAL.days[n] = personalDay(raw, t, NUTRITION.extras || []);
    }
    return PERSONAL.days[n];
}

// Базовое меню дня БЕЗ подгонки под норму — нужно там, где важен исходный план
// (сверка, отладка). Обычному рендеру нужен nutritionDay.
function nutritionDayBase(n) { return NUTRITION.days[n] || null; }

// Таблицы замен (Мастер-Конструктор) / вкусняшки — из кэша (null до загрузки).
function nutritionConstructor() { return NUTRITION.constructor; }
function nutritionTreats() { return NUTRITION.treats; }

// ккал приёма из Б/Ж/У (4/9/4). Возвращает null, если макросов нет (diy/cheat).
function mealKcal(m) {
    if (m.p == null) return null;
    return Math.round(m.p * 4 + m.f * 9 + m.c * 4);
}

// Сумма Б/Ж/У/ккал по дню (только приёмы с макросами) + флаг, что есть свободные.
function nutritionDayTotals(plan) {
    const t = { p: 0, f: 0, c: 0, kcal: 0, hasFree: false };
    plan.meals.forEach(m => {
        if (m.p == null) { t.hasFree = true; return; }
        t.p += m.p; t.f += m.f; t.c += m.c; t.kcal += mealKcal(m);
    });
    return t;
}

// Сырой/сухой вес продукта из веса ГОТОВОГО на тарелке (item.g) и коэффициента
// варки (item.k): сырой = готовый / k, округляем до 5 г. k>1 → крупа набирает воду
// (сырой < готового), k<1 → мясо/рыба теряют (сырой > готового). k нет/равен 1 →
// вес не меняется, возвращаем как есть. См. правило «ВЕС ПРОДУКТОВ» в источнике.
function rawFromCooked(cookedG, k) {
    if (!k || k === 1) return cookedG;
    return Math.max(5, Math.round(cookedG / k / 5) * 5);
}

// ─── Общие помощники разбора текста приёма (11.07.2026, ?v=0.6.68) ───
// Нужны и day.html (карточки блюд), и dashboard.html (список покупок «по дням
// и блюдам») — живут здесь, чтобы логика не разъезжалась. day.html делегирует
// сюда свои mealParts/mealShortName. Работают на тексте, данных не касаются.
// Режем текст состава на компоненты: делители «, » и «. » перед заглавной,
// только ВНЕ скобок — запятая в «1,5%» (без пробела), внутри «(творог 160 г,
// 1 яйцо…)» и точки в «ст. л.» (дальше строчная) строку не рвут.
function nutritionMealParts(text) {
    const t = text.trim().replace(/[.!]\s*$/, '');
    const parts = [];
    let buf = '', depth = 0;
    for (let j = 0; j < t.length; j++) {
        const ch = t[j];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        if (depth === 0 && t[j + 1] === ' ' &&
            (ch === ',' || ((ch === '.' || ch === '!') && /[А-ЯЁ]/.test(t[j + 2] || '')))) {
            parts.push(buf); buf = ''; j++; continue;
        }
        buf += ch;
    }
    parts.push(buf);
    return parts.map(s => s.trim()).filter(Boolean)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1));
}
// Короткое имя блюда: первая часть состава, но если она — гарнир
// (перловка/рис/картофель…), берём белковую: «Гуляш из говядины», а не «Перловка».
function nutritionMealName(text) {
    const parts = nutritionMealParts(text).map(p => p.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim());
    if (!parts.length) return '';
    const side = /^(гречк|рис|бурый рис|перловк|пшен|макарон|запечённый картофел|картофел|овощ|салат)/i;
    if (side.test(parts[0])) {
        const prot = parts.find(p => /кури|говя|свинин|индей|рыб|треск|минтай|горбуш|кета|фарш|печен|творо|кальмар|кревет|омлет|яичн|тефтел|гуляш|морепрод/i.test(p));
        if (prot) return prot;
    }
    return parts[0];
}

// ─── Список покупок «по дням и блюдам» (11.07.2026, ?v=0.6.68) ───
// Альтернативный вид недельного списка: для недели w возвращает её 7 дней —
// { day, meals: [{ slot, cheat, treat, parts }] }. parts — компоненты состава
// С ВЕСАМИ ровно из текста приёма (та же строка, что в плане дня, — граммовки
// не пересчитываются и разойтись с рецептом не могут). Читает меню дней из
// кэша через nutritionDay — на дашборде их заранее грузит KF.loadNutrition.
// Рендер — dashboard.html.
function nutritionShoppingByDay(w) {
    const out = [];
    for (let n = (w - 1) * 7 + 1; n <= w * 7; n++) {
        const plan = nutritionDay(n);
        if (!plan) continue;
        out.push({
            day: n,
            // name (nutritionMealName) намеренно НЕ отдаём: вид «по дням» скрывает
            // названия блюд ради интриги (11.07.2026) — только слот + продукты.
            meals: plan.meals.map(m => ({
                slot: m.slot,
                cheat: !!m.cheat,
                treat: !!m.treat,
                parts: m.cheat ? [] : nutritionMealParts(m.text),
            })),
        });
    }
    return out;
}

/* ─── Список покупок недели ──────────────────────────────────────────────────
   Агрегаты (категории, формулировки) — рукотворные, из меню не выводятся. Но
   если порции подогнаны под личную норму, статичные «630 г» отправили бы
   участницу в магазин не за тем количеством. Поэтому количества умножаем на
   ФАКТИЧЕСКИЙ рост продукта за неделю: сравниваем базовые дни с персональными
   и берём отношение суммарных граммов. Продукт не вырос (овощи, зелень) —
   коэффициент 1, строка остаётся как была.                                    */
function weekFactors(w) {
    if (typeof parseMealFoods !== 'function') return null;
    // Разбор 7 дней — дорогая работа для телефона, а дашборд рисует 4 недели.
    // Держим результат до смены нормы (кэш чистится там же, где кэш дней).
    if (PERSONAL.factors[w] !== undefined) return PERSONAL.factors[w];
    const base = {}, pers = {};
    let touched = false;
    for (let n = (w - 1) * 7 + 1; n <= w * 7; n++) {
        const b = nutritionDayBase(n), p = nutritionDay(n);
        if (!b || !p || b === p) continue;
        touched = true;
        const add = (bag, meals) => meals.forEach(m => {
            if (m.cheat || m.p == null) return;
            parseMealFoods(m.text, { maxKcal: m.p * 4 + m.f * 9 + m.c * 4 }).forEach(x => {
                if (!x.food || x.isPair) return;
                bag[x.food.id] = (bag[x.food.id] || 0) + foodGrams(x);
            });
        });
        add(base, b.meals); add(pers, p.meals);
    }
    if (!touched) { PERSONAL.factors[w] = null; return null; }
    const out = {};
    Object.keys(base).forEach(id => { if (base[id] > 0) out[id] = (pers[id] || base[id]) / base[id]; });
    PERSONAL.factors[w] = out;
    return out;
}

// Умножаем количество в строке списка, сохраняя её вид: «≈ 1,3 кг» → «≈ 1,8 кг»,
// «630 г» → «880 г», «4 куска» → «6 кусков».
function scaleQty(s, k) {
    if (!k || Math.abs(k - 1) < 0.03) return s;
    // Главное количество — первое число строки. Остальные трогаем, только если
    // это тоже мера («200 г (2 средних)» → «300 г (3 средних)»): число в «(день 5)»
    // не количество, а ссылка на день, и увеличивать его нельзя.
    const big = /кг|\d\s*л(?![а-яё])/.test(s), gram = /\d\s*г(?![а-яё])/.test(s);
    let first = true;
    let out = s.replace(/(\d+(?:[.,]\d+)?)(\s*(?:средн|шт|кус|ломт)\w*)?/g, (m0, num, tail) => {
        const isFirst = first; first = false;
        if (!isFirst && !tail) return m0;
        const v = parseFloat(num.replace(',', '.')) * k;
        // Допуск против плавающей точки: 0,7 × 1,5 в JS даёт 1,0499999…, и
        // «1,1 л» превращалось бы в «1 л» — на список покупок это уже влияет.
        const rnd = (x, step) => Math.round(x / step + 1e-9) * step;
        let txt;
        if (isFirst && big) txt = String(rnd(v, 0.1).toFixed(1)).replace(/\.0$/, '').replace('.', ',');
        else if (isFirst && gram) txt = String(Math.max(10, rnd(v, 10)));
        else txt = String(Math.max(1, rnd(v, 1)));
        return txt + (tail || '');
    });
    if (parseInt(out, 10) >= 5) out = out.replace(/куска(?![а-яё])/, 'кусков').replace(/ломтика(?![а-яё])/, 'ломтиков');
    return out;
}

// Список покупок недели w (1..4) или null.
function nutritionShopping(w) {
    const s = NUTRITION.shopping;
    const week = (s && s.find(x => x.week === w)) || null;
    if (!week) return null;
    const f = weekFactors(w);
    if (!f) return week;
    return Object.assign({}, week, {
        groups: week.groups.map(g => Object.assign({}, g, {
            items: g.items.map(it => {
                const food = (typeof pickFood === 'function') && pickFood(it[0], 'right');
                return food && f[food.id] ? [it[0], scaleQty(it[1], f[food.id])] : it;
            }),
        })),
    });
}
