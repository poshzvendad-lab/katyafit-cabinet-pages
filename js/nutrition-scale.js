/* ============================================================
   KatyaFit · Личный кабинет — ПЕРСОНАЛЬНЫЕ ПОРЦИИ (подгонка плана под норму).

   ЗАЧЕМ. Меню 28 дней собрано под ≈1200 ккал — это пол бюджета из
   KF.nutritionTargets(). У активной участницы с большим весом личная норма
   1800–2300 ккал, и раньше разницу (до 1000 ккал!) она добирала руками через
   «Замены и вкусняшки». Клиент платит за готовый план — думать о доборе он не
   должен. Здесь порции блюд пересчитываются под ЕЁ норму, а если порциями норму
   не закрыть — добавляется отдельный приём пищи (см. nutrition-source, extras).

   ПОЧЕМУ РАЗМЕТКИ НЕТ В ДАННЫХ. Состав приёма выводится ПАРСЕРОМ из текста
   блюда, а не хранится вторым списком. Так разметка физически не может разойтись
   с меню: поправила Катя текст — состав пересчитался сам. Тексты и числа Кати
   этот файл не меняет, он только читает.

   ЧТО ЗДЕСЬ НЕ ЛЕЖИТ. Никакого платного контента: файл публичный (отдаётся всем
   без входа). Состав продуктов на 100 г — общеизвестные справочные числа
   (Скурихин + USDA), меню в них не восстанавливается.

   ЯКОРЬ БЕЗОПАСНОСТИ. Б/Ж/У приёма считаются как «числа Кати + дельта за
   изменённые граммы». При норме, равной базовой (коэффициент 1), возвращается
   ИСХОДНЫЙ приём — байт в байт. Ошибка в справочнике состава портит только
   добавку, а не весь план.

   ⚠️ Б/Ж/У добавленных граммов — оценочные, как и весь план (финальное слово за
   Катей-нутрициологом). Правила порций — в PORTION_RULES ниже.
   ============================================================ */

// ─── Сколько граммов в ложке (для «1 ч.л. масла», «1 ст. ложка сметаны») ───
// Плотность разная, поэтому у сыпучего/густого свои числа задаёт продукт (gSpoon).
const SPOON_G = { 'ч.л.': 5, 'дес.л.': 10, 'ст.л.': 17 };

/* ─── Справочник продуктов ───────────────────────────────────────────────────
   p/f/c — на 100 г продукта В ТОМ ВИДЕ, В КАКОМ ВЕС СТОИТ В ТЕКСТЕ: у круп это
   сухая крупа, у мяса и рыбы — сырое, у творога/сыра/овощей — как есть. Так же
   считала Катя, когда сводила Б/Ж/У приёмов (см. шапку nutrition-source.js).

   cat  — что это в бюджете: prot (белок) · carb (гарнир) · fat (жиры) ·
          veg (овощи) · fruit · dairy · treat (слот 20%) · misc.
   kind — как ведёт себя при подгонке порции:
          'scale' — тянется плавно (шаг 5 г);
          'step'  — только целыми штуками (яйцо, ломтик хлеба, ложка масла);
          'fixed' — не трогаем совсем (вкусняшка, овощи, фрукт, напиток).
   max  — потолок ОДНОЙ порции в единицах главного веса: дальше тарелка
          перестаёт быть человеческой (450 г гречки никто не съест).
   Порядок важен: частные правила стоят выше общих («куриная печень» до «курин»).
   ------------------------------------------------------------------------- */
// Граница слова: в JS \b не работает с кириллицей (для него русская буква —
// не «буквенный» символ), поэтому левую границу пишем как «начало или не-буква»,
// правую — отрицательным просмотром вперёд. Без этого /рис/ не находил «Рис», а
// /сыр/ ловил «сырой» и подставлял сыр вместо мяса.
const EDGE_L = '(?:^|[^а-яёa-z])';   // слева от слова
const EDGE_R = '(?![а-яё])';         // справа от слова
const mkRe = s => new RegExp(s, 'i');

const FOODS = [
    // ── Крупы и гарниры (вес в тексте — СУХОЙ) ──
    { id: 'grechka',   re: mkRe('гречк|гречнев'),                   p: 12.6, f: 3.3, c: 62,   cat: 'carb', kind: 'scale', max: 90 },
    { id: 'ris-brown', re: mkRe('бурый рис'),                       p: 7.4,  f: 1.8, c: 72,   cat: 'carb', kind: 'scale', max: 90 },
    { id: 'ris',       re: mkRe(EDGE_L + 'рис(?:а|у|ом|е|ов\\w*)?' + EDGE_R), p: 7,  f: 1,   c: 74,   cat: 'carb', kind: 'scale', max: 90 },
    { id: 'ovsyanka',  re: mkRe('овсян|овсяноблин|хлопь|каша из смеси злаков|каша из злаков|мюсл|гранол'),
                                                                  p: 12,   f: 6.5, c: 61,   cat: 'carb', kind: 'scale', max: 80 },
    { id: 'perlovka',  re: mkRe('перловк'),                         p: 9.3,  f: 1.1, c: 67,   cat: 'carb', kind: 'scale', max: 90 },
    { id: 'makarony',  re: mkRe('макарон'),                         p: 10.4, f: 1.1, c: 71,   cat: 'carb', kind: 'scale', max: 100 },
    { id: 'kartofel',  re: mkRe('картофел|картошк|пюре'),           p: 2,    f: 0.4, c: 17,   cat: 'carb', kind: 'scale', max: 400 },
    { id: 'hleb',      re: mkRe('хлеб|тост|хлебц'),                 p: 9,    f: 3,   c: 43,   cat: 'carb', kind: 'step',  max: 3, gPer: 30 },
    { id: 'sup',       re: mkRe('борщ|суп' + EDGE_R + '|' + EDGE_L + 'щи' + EDGE_R + '|бульон'), p: 3, f: 2, c: 4, cat: 'misc', kind: 'fixed' },

    // ── Белок: птица, мясо (вес в тексте — СЫРОЙ) ──
    { id: 'kur-pechen', re: mkRe('печен(?:ь|и|ью|ени)' + EDGE_R),       p: 20,   f: 5.9, c: 0.7,  cat: 'prot', kind: 'scale', max: 200 },
    // Фразу захватываем целиком: иначе «филе бедра индейки» ближним словом
    // прочиталось бы как постное филе индейки и потеряло половину жиров.
    { id: 'ind-bedro',  re: mkRe('(?:филе )?бедр\\w*(?: индейки)?|филе бедра индейки'),
                                                                  p: 17.5, f: 8,   c: 0,    cat: 'prot', kind: 'scale', max: 250 },
    { id: 'ind-farsh',  re: mkRe('фарш\\w*(?: из)? индейки|тефтел'), p: 16.5, f: 8,  c: 0,    cat: 'prot', kind: 'scale', max: 250 },
    { id: 'indeyka',    re: mkRe('индейк'),                         p: 22,   f: 2,   c: 0,    cat: 'prot', kind: 'scale', max: 250 },
    { id: 'kuritsa',    re: mkRe('кури[нц]|курой|курице|котлет'),   p: 23,   f: 1.5, c: 0,    cat: 'prot', kind: 'scale', max: 250 },
    { id: 'govyadina',  re: mkRe('говядин|гуляш'),                  p: 20.2, f: 7,   c: 0,    cat: 'prot', kind: 'scale', max: 220 },
    { id: 'svinina',    re: mkRe('свинин|вырезк'),                  p: 19.4, f: 7.1, c: 0,    cat: 'prot', kind: 'scale', max: 220 },

    // ── Белок: рыба и морепродукты (вес в тексте — СЫРОЙ) ──
    { id: 'ryba-sol',   re: mkRe('слабосол'),                       p: 21,   f: 9,   c: 0,    cat: 'prot', kind: 'scale', max: 100 },
    { id: 'gorbusha',   re: mkRe('горбуш|' + EDGE_L + 'кет[аыу]' + EDGE_R + '|лосос|форел'),
                                                                  p: 20.5, f: 6.5, c: 0,    cat: 'prot', kind: 'scale', max: 260 },
    { id: 'treska',     re: mkRe('треск|минта|белая рыба|хек|пикш'), p: 17,  f: 0.8, c: 0,    cat: 'prot', kind: 'scale', max: 300 },
    { id: 'kalmar',     re: mkRe('кальмар'),                        p: 18,   f: 2.2, c: 2,    cat: 'prot', kind: 'scale', max: 260 },
    { id: 'krevetki',   re: mkRe('кревет|морепродукт'),             p: 20,   f: 1.5, c: 0,    cat: 'prot', kind: 'scale', max: 260 },
    { id: 'tunets',     re: mkRe('тунец|тунца'),                    p: 24,   f: 1,   c: 0,    cat: 'prot', kind: 'scale', max: 200 },
    { id: 'ryba',       re: mkRe('рыб[аоуые]'),                     p: 18,   f: 2,   c: 0,    cat: 'prot', kind: 'scale', max: 280 },

    // ── Молочное и яйца ──
    { id: 'tvorog-sir', re: mkRe('творожн\\w*\\s+сыр'),             p: 6,    f: 22,  c: 4,    cat: 'fat',  kind: 'scale', max: 60 },
    { id: 'zapekanka',  re: mkRe('запеканк|сырник|вареник'),        p: 17,   f: 5,   c: 2,    cat: 'prot', kind: 'scale', max: 300 },
    { id: 'tvorog',     re: mkRe('творог|творож|скир'),             p: 17,   f: 5,   c: 2,    cat: 'prot', kind: 'scale', max: 300 },
    { id: 'yogurt',     re: mkRe('йогурт|кефир'),                   p: 4.5,  f: 2,   c: 6,    cat: 'dairy', kind: 'scale', max: 250 },
    { id: 'smetana',    re: mkRe('сметан'),                         p: 2.6,  f: 15,  c: 3,    cat: 'fat',  kind: 'step',  max: 3, gSpoon: { 'ч.л.': 8, 'дес.л.': 15, 'ст.л.': 25 } },
    { id: 'syr',        re: mkRe('сыр(?:а|е|у|ом|ы|ов)?' + EDGE_R),     p: 25,   f: 27,  c: 0,    cat: 'fat',  kind: 'scale', max: 60 },
    { id: 'yaytso',     re: mkRe('яй[цч]\\w*|яиц|яичн|омлет|скрембл|пашот'),
                                                                  p: 12.7, f: 11.5, c: 0.7, cat: 'prot', kind: 'step',  max: 4, gPer: 55 },
    { id: 'moloko',     re: mkRe('молок|сливк'),                    p: 3,    f: 1.5, c: 4.7,  cat: 'dairy', kind: 'fixed' },

    // ── Жиры ──
    { id: 'maslo-sliv', re: mkRe('сливочн\\w*\\s+масл|слив\\.?\\s?масл'), p: 0.5, f: 82.5, c: 0.8, cat: 'fat', kind: 'step', max: 3 },
    { id: 'maslo',      re: mkRe('масл'),                           p: 0,    f: 99.9, c: 0,   cat: 'fat',  kind: 'step',  max: 3 },
    { id: 'orehi',      re: mkRe('орех|семечк|миндал|арахис'),      p: 15,   f: 65,  c: 7,    cat: 'fat',  kind: 'scale', max: 30 },
    { id: 'avokado',    re: mkRe('авокадо'),                        p: 2,    f: 15,  c: 2,    cat: 'fat',  kind: 'fixed' },

    // ── Овощи, фрукты, прочее: в тарелке нужны, но порцию ими не растят ──
    { id: 'kuraga',     re: mkRe('кураг|чернослив|финик|изюм'),     p: 5,    f: 0.3, c: 51,   cat: 'fruit', kind: 'fixed' },
    { id: 'yagody',     re: mkRe('ягод'),                           p: 0.8,  f: 0.4, c: 8,    cat: 'fruit', kind: 'fixed' },
    { id: 'banan',      re: mkRe('банан'),                          p: 1.5,  f: 0.2, c: 21,   cat: 'fruit', kind: 'fixed' },
    { id: 'fruit',      re: mkRe('яблок|груш|киви|апельсин|мандарин|фрукт|персик|абрикос'),
                                                                  p: 0.4,  f: 0.3, c: 10,   cat: 'fruit', kind: 'fixed' },
    { id: 'morkov',     re: mkRe('морков'),                         p: 1.3,  f: 0.1, c: 7,    cat: 'veg',  kind: 'fixed' },
    { id: 'muka',       re: mkRe('мук[аи]' + EDGE_R + '|отруб'),        p: 10,   f: 1.5, c: 70,   cat: 'carb', kind: 'fixed' },
    { id: 'med',        re: mkRe('мёд|' + EDGE_L + 'мед' + EDGE_R),         p: 0.8,  f: 0,   c: 80,   cat: 'treat', kind: 'fixed' },
    { id: 'ovoshi',     re: mkRe('овощ|огур|томат|помидор|капуст|брокколи|фасол|кабач|перец|зелен|салат|укроп|' + EDGE_L + 'лук' + EDGE_R + '|чеснок|черри|редис|баклажан|шпинат|стручк|оливк'),
                                                                  p: 1.5,  f: 0.2, c: 4.5,  cat: 'veg',  kind: 'fixed' },

    // ── Слот 20%: вкусняшка — «строго одна в день» (правило методички), не растим.
    // Разбиты по плотности: шоколадное ≈500 ккал/100 г, сахарное ≈325, молочное ≈205 —
    // одним средним числом счёт дня врал бы на сотню калорий.
    { id: 'treat-prot', re: mkRe('протеинов\\w*\\s+(?:батончик|печень)'),
                                                                  p: 24,   f: 12,  c: 40,   cat: 'treat', kind: 'fixed' },
    { id: 'treat-fat',  re: mkRe('шоколад|батончик|халв|вафл|чипс|конфет|печень[ье]|козинак'),
                                                                  p: 6,    f: 30,  c: 50,   cat: 'treat', kind: 'fixed' },
    { id: 'treat-milk', re: mkRe('пломбир|мороженое|сорбет|сырок|десерт|мусс|йогурт питьев'),
                                                                  p: 4,    f: 11,  c: 22,   cat: 'treat', kind: 'fixed' },
    { id: 'treat-sug',  re: mkRe('зефир|мармелад|пастил|пряник|джем|варень|карамел|леденц'),
                                                                  p: 1,    f: 0,   c: 80,   cat: 'treat', kind: 'fixed' },
    { id: 'napitok',    re: mkRe('кофе|чай|цикорий|капучино|латте|какао|вода'), p: 0, f: 0, c: 0, cat: 'misc', kind: 'fixed' },
];

// Глобальные копии правил — ищем ВСЕ вхождения в контексте, чтобы выбрать
// ближайшее к числу, а не первое по списку.
const FOODS_G = FOODS.map(f => ({ f, g: new RegExp(f.re.source, 'gi') }));

/* Продукт по куску текста рядом с числом.
   dir 'left'  — имя стоит ПЕРЕД весом («Гречка отварная (50 г)»): берём
                 ближайшее к числу, то есть последнее вхождение.
   dir 'right' — имя стоит ПОСЛЕ веса («200 г картофеля»): берём первое.
   При наложении правил побеждает более длинное совпадение — иначе «творожным
   сыром» прочитался бы как «сыр», а «сливочного масла» как растительное.
   filter — необязательное сито по продукту (см. маркеры «сухой»/«сырой»). */
function pickFoods(ctx, dir, filter) {
    if (!ctx) return [];
    const hits = [];
    FOODS_G.forEach(({ f, g }) => {
        if (filter && !filter(f)) return;
        g.lastIndex = 0;
        let m, hit = null;
        while ((m = g.exec(ctx)) !== null) {
            hit = { start: m.index, end: m.index + m[0].length, len: m[0].length, food: f };
            if (dir === 'right') break;           // справа нужно первое вхождение
            if (m.index === g.lastIndex) g.lastIndex++;
        }
        if (hit) hits.push(hit);
    });
    hits.sort((a, b) => dir === 'left'
        ? (b.end - a.end) || (b.len - a.len)
        : (a.start - b.start) || (b.len - a.len));
    return hits.map(h => h.food);
}
function pickFood(ctx, dir, filter) { return pickFoods(ctx, dir, filter)[0] || null; }

// Старое имя оставлено для простых проверок «есть ли продукт в строке».
function foodMatch(s) { return pickFood(s, 'right'); }

/* ─── Разбор состава приёма ──────────────────────────────────────────────────
   Находим в тексте все веса и привязываем каждый к продукту. Возвращаем позиции
   С ИНДЕКСАМИ СИМВОЛОВ — по ним потом точечно переписываем числа, поэтому два
   продукта с одинаковым весом («200 г картофеля… 200 г овощей») не путаются.

   Виды записи, которые встречаются в меню:
     «Гречка отварная (50 г сухой, ≈ 140 г готовой)»   — имя ПЕРЕД скобкой,
                                                          второе число — парное «готовое»
     «(200 г картофеля, 50 мл молока)»                 — имя ПОСЛЕ числа
     «(рис 50 г сухой, ≈ 135 г готового; филе 150 г)»  — имя перед числом внутри скобки
     «2 отварных яйца», «2 тоста из ц/з хлеба»         — штуки без единицы
     «1 ст. ложка сметаны 15%», «1 ч.л. масла»         — ложки
   ------------------------------------------------------------------------- */
const RE_WEIGHT = /(\d+(?:[.,]\d+)?)\s*(мл|кг|г|шт)(?![а-яёa-z])/gi;
// Хвост «ожк\w*» ловит все падежи ложки: «1 ст. ложка», «с 1 ст. ложкой».
const RE_SPOON = /(\d+|½|¼)\s*(ч\.?\s?л|ст\.?\s?л|дес\.?\s?л)(?:\.|\s|ожк\w*)/gi;
// Штуки без единицы: «2 отварных яйца», «1 кусок ц/з хлеба», «2 тоста».
const RE_PIECE = /(\d+)\s+(?=[а-яё/.\s]{0,24}?(?:яй[цч]|яиц|тост|кус(?:ок|ка|ки|ков)|ломт))/gi;
// Маркеры второго («готового») веса той же позиции — не самостоятельный продукт.
const RE_COOKED = /^[\s,;)]*(?:готов)/i;
// «50 г сухой» — сухими бывают только крупы; «170 г сырой» — только мясо, рыба
// и картофель. Сито отсекает соседей вроде «каша на молоке» и «плов с курицей».
const RE_DRY = /^[\s,;)]*сух/i;
const RE_RAW = /^[\s,;)]*сыр(?:ой|ая|ое|ого|ых|ым|ым)/i;
const ONLY_CARB = f => f.cat === 'carb';
const ONLY_RAW = f => f.cat === 'prot' || f.id === 'kartofel';

// Кусок текста от конца предыдущего веса до текущего числа, обрезанный по
// последнему разделителю «, » / «; » — дальше начинается ЧУЖАЯ позиция.
function leftSegment(text, from, idx) {
    const seg = text.slice(from, idx);
    const cut = Math.max(seg.lastIndexOf(', '), seg.lastIndexOf('; '));
    return cut === -1 ? seg : seg.slice(cut + 2);
}

/* Санитарная проверка кандидата по калорийности. Определение может стоять
   ПОСЛЕ существительного («цветная капуста с маслом (200 г)»), и ближайшим слева
   окажется масло — 200 г масла это 1800 ккал в приёме на 290. Заявленные ккал
   приёма служат потолком: кандидат, который в него не влезает, отбрасывается. */
function chooseSane(cands, pos, maxKcal) {
    for (let i = 0; i < cands.length; i++) {
        const food = cands[i];
        if (!maxKcal) return food;
        const g = foodGrams({ food, num: pos.num, unit: pos.unit, spoon: pos.spoon });
        const mac = foodMacros(food, g);
        if (mac.p * 4 + mac.f * 9 + mac.c * 4 <= maxKcal * 1.15) return food;
    }
    return null;   // ничего правдоподобного — позицию просто не трогаем
}

// opts.maxKcal — ккал приёма по числам Кати (потолок для проверки выше).
function parseMealFoods(text, opts) {
    const found = [];
    const maxKcal = (opts && opts.maxKcal) || 0;
    let m;

    RE_WEIGHT.lastIndex = 0;
    let prevEnd = 0;
    while ((m = RE_WEIGHT.exec(text)) !== null) {
        const idx = m.index, end = idx + m[0].length;
        const num = parseFloat(m[1].replace(',', '.'));
        const after = text.slice(end, end + 30);
        const isPair = /≈\s*$/.test(text.slice(Math.max(0, idx - 4), idx)) || RE_COOKED.test(after);
        const filter = RE_DRY.test(after) ? ONLY_CARB : RE_RAW.test(after) ? ONLY_RAW : null;

        let food = null;
        if (!isPair) {
            const afterSeg = after.split(/[,;)]/)[0];
            const leftSeg = leftSegment(text, prevEnd, idx);
            // 1) имя перед весом в своей позиции → 2) сразу после веса → 3) голова
            // фразы (случай «Зелёный чай + мармелад (4 шт, 40 г)»).
            const cands = [];
            const push = arr => arr.forEach(f => { if (cands.indexOf(f) === -1) cands.push(f); });
            push(pickFoods(leftSeg, 'left', filter));
            push(pickFoods(afterSeg, 'right', filter));
            push(pickFoods(text.slice(0, idx).split('. ').pop(), 'left', filter));
            // Сито ничего не нашло — пробуем без сита, лишь бы не потерять позицию.
            if (!cands.length && filter) { push(pickFoods(leftSeg, 'left')); push(pickFoods(afterSeg, 'right')); }
            food = chooseSane(cands, { num, unit: m[2].toLowerCase() }, maxKcal);
        }
        // len — длина ТОЛЬКО числа: подменять будем его одно, иначе «45 г сухой»
        // превратится в «70 сухой» и участница останется без единицы измерения.
        found.push({ idx, len: m[1].length, num, unit: m[2].toLowerCase(), raw: m[0], food, isPair });
        prevEnd = end;
    }

    RE_SPOON.lastIndex = 0;
    while ((m = RE_SPOON.exec(text)) !== null) {
        const idx = m.index, end = idx + m[0].length;
        const num = m[1] === '½' ? 0.5 : m[1] === '¼' ? 0.25 : parseFloat(m[1]);
        const spoon = m[2].replace(/[\s.]/g, '').replace('чл', 'ч.л.').replace('стл', 'ст.л.').replace('десл', 'дес.л.');
        // У ложки продукт всегда следом: «1 ч.л. масла», «1 ст. ложка сметаны».
        const food = pickFood(text.slice(end, end + 34).split(/[,;)]/)[0], 'right')
            || pickFood(text.slice(end, end + 34), 'right');
        found.push({ idx, len: m[1].length, num, unit: 'spoon', spoon, raw: m[1], food, isPair: false });
    }

    RE_PIECE.lastIndex = 0;
    while ((m = RE_PIECE.exec(text)) !== null) {
        // Не считаем штуками то, что уже поймано как вес («2 шт из 145 г филе»).
        if (found.some(f => Math.abs(f.idx - m.index) < 3)) continue;
        const end = m.index + m[0].length;
        // Штучным может быть только штучный продукт — иначе «2 отварных куриных
        // яйца» прочиталось бы как курица. Имя бывает и слева: «Ц/з хлеб (2 куска)».
        const isStep = f => f.kind === 'step';
        const food = pickFood(text.slice(end, end + 30), 'right', isStep)
            || pickFood(leftSegment(text, 0, m.index), 'left', isStep);
        if (food) found.push({ idx: m.index, len: m[1].length, num: parseFloat(m[1]), unit: 'pc', raw: m[1], food, isPair: false });
    }

    found.sort((a, b) => a.idx - b.idx);
    // Парные «готовые» веса привязываем к ближайшей позиции слева — при подгонке
    // порции они едут тем же коэффициентом (иначе «170 г сырой» и «120 г готового»
    // разъедутся, и участница взвесит не то).
    found.forEach((f, i) => {
        if (!f.isPair) return;
        for (let j = i - 1; j >= 0; j--) if (!found[j].isPair) { f.parent = j; f.food = found[j].food; break; }
    });
    return found;
}

// Сколько граммов продукта стоит за позицией (для подсчёта Б/Ж/У).
function foodGrams(pos) {
    if (!pos.food) return 0;
    if (pos.unit === 'г') return pos.num;
    if (pos.unit === 'кг') return pos.num * 1000;
    if (pos.unit === 'мл') return pos.num;                     // молоко/бульон ≈ 1 г/мл
    if (pos.unit === 'pc') return pos.num * (pos.food.gPer || 0);
    if (pos.unit === 'spoon') return pos.num * ((pos.food.gSpoon && pos.food.gSpoon[pos.spoon]) || SPOON_G[pos.spoon] || 0);
    if (pos.unit === 'шт') return pos.num * (pos.food.gPer || 0);
    return 0;
}

// Б/Ж/У за N граммов продукта.
function foodMacros(food, grams) {
    return { p: food.p * grams / 100, f: food.f * grams / 100, c: food.c * grams / 100 };
}

/* ─── Правила порции ─────────────────────────────────────────────────────────
   PORTION_RULES — то, что нельзя нарушать, как бы ни была велика норма:
   1. Порция растёт не больше чем в полтора раза, а белковая — в 1.7: дальше
      тарелка перестаёт быть человеческой, и остаток честнее отдать
      ОТДЕЛЬНОМУ приёму пищи, чем горе гречки в обед.
   2. Свой потолок у каждого продукта (FOODS.max) — 250 г мяса, 90 г сухой крупы.
   3. Перекус-вкусняшку никогда не увеличиваем: «строго одна в день» — правило
      методички 80/20, оно не про калории, а про контроль тяги к сладкому. При
      маленькой норме порцию можно УМЕНЬШИТЬ (до −30%), иначе одна вкусняшка
      съедает треть дневных углеводов.
   4. Читмил не трогаем и в расчёт не берём: свободный ужин на то и свободный.
   5. Овощи, фрукты и напитки не растим — сытость они добавляют, а норму нет.  */
const BASE_PLAN_KCAL = 1200;   // под столько собрано меню (см. nutrition-source.js)
const MAX_K_PROT = 1.7;        // потолок роста белковой порции
const MAX_K_SIDE = 1.85;       // потолок роста гарнира (у крупы свой предел — 90 г сухой)
const MAX_K_FAT = 2;           // жиров в базе мало (ложка масла, горсть орехов) — растим смелее
const MIN_K_SIDE = 0.75;       // гарнир можно и убавить, но не больше чем на четверть
const EXTRA_MIN = 60;          // меньше этого добавочный приём не заводим

// Сумма Б/Ж/У/ккал по приёмам, у которых есть макросы (читмил пропускается).
function dayTotals(meals) {
    const t = { p: 0, f: 0, c: 0, kcal: 0 };
    meals.forEach(m => {
        if (m.p == null) return;
        t.p += m.p; t.f += m.f; t.c += m.c;
        t.kcal += m.p * 4 + m.f * 9 + m.c * 4;
    });
    return t;
}

// Заменяем числа в тексте СПРАВА НАЛЕВО — иначе после первой же замены
// («45» → «70») поедут индексы всех следующих позиций.
function applyEdits(text, edits) {
    return edits.slice().sort((a, b) => b.idx - a.idx)
        .reduce((s, e) => s.slice(0, e.idx) + e.txt + s.slice(e.idx + e.len), text);
}

const round5 = n => Math.max(5, Math.round(n / 5) * 5);
const round10 = n => Math.max(10, Math.round(n / 10) * 10);

/* Согласование после замены числа. «1 варёное яйцо» при росте порции стало бы
   «2 варёное яйцо» — участница читает план каждый день, безграмотность в нём
   недопустима. Формы 2–4 совпадают, поэтому хватает пары единственное→
   множественное; больше 4 штук потолки не дают. */
const PLURAL = [
    // Ложки: «с 1 ст. ложкой масла» → «с 2 ст. ложками», «1 ст. ложка сметаны»
    // → «2 ст. ложки». Падеж сохраняем — иначе получается «с 2 ст. ложкой».
    [/([2-9])(\s+(?:ст|ч|дес)\.?\s?)ложкой/gi, '$1$2ложками'],
    [/([2-9])(\s+(?:ст|ч|дес)\.?\s?)ложка(?![а-яё])/gi, '$1$2ложки'],
    [/([2-9])\s+варёное\s+яйцо/gi, '$1 варёных яйца'],
    [/([2-9])\s+отварное\s+яйцо/gi, '$1 отварных яйца'],
    [/([2-9])\s+яйцо/gi, '$1 яйца'],
    [/([2-9])\s+кусок/gi, '$1 куска'],
    [/([2-9])\s+тост(?![а-яё])/gi, '$1 тоста'],
    [/([2-9])\s+ломтик(?![а-яё])/gi, '$1 ломтика'],
];
function fixPlural(text) {
    return PLURAL.reduce((s, [re, to]) => s.replace(re, to), text);
}

/* Пересчёт одного приёма под коэффициенты kFor(продукт).
   Возвращает { text, p, f, c, items, grown } — числа Кати ПЛЮС дельта за
   изменённые граммы (см. «якорь безопасности» в шапке). */
/* Те же граммы — в шагах рецепта. Рецепт живёт отдельным полем (rec), и веса в
   нём записаны словами: «Куриное филе (170 г) посоли…». Без пересчёта участница
   видела бы в плане 250 г, а в рецепте 170 г и не знала, чему верить.
   Коэффициенты берём УЖЕ ПРИМЕНЁННЫЕ к блюду (с учётом потолков порций). */
function growRecipe(rec, kByFood, maxKcal) {
    if (!rec || !rec.length) return rec;
    return rec.map(line => {
        const pos = parseMealFoods(line, { maxKcal: maxKcal });
        const edits = [];
        pos.forEach((x, i) => {
            if (x.isPair || !x.food) return;
            const k = kByFood[x.food.id];
            if (!k) return;
            const num1 = x.food.kind === 'step' ? Math.round(x.num * k)
                : x.unit === 'мл' ? round10(x.num * k)
                    : x.unit === 'г' ? round5(x.num * k) : Math.round(x.num * k);
            if (num1 === x.num) return;
            edits.push({ idx: x.idx, len: x.len, txt: String(num1) });
            pos.forEach(y => { if (y.isPair && y.parent === i) edits.push({ idx: y.idx, len: y.len, txt: String(round5(y.num * k)) }); });
        });
        return edits.length ? fixPlural(applyEdits(line, edits)) : line;
    });
}

function growMeal(meal, kFor) {
    const declK = meal.p * 4 + meal.f * 9 + meal.c * 4;
    const pos = parseMealFoods(meal.text, { maxKcal: declK });
    const edits = [];
    const kByFood = {};
    let dp = 0, df = 0, dc = 0, grown = false;

    pos.forEach((x, i) => {
        if (x.isPair || !x.food) return;
        const k = kFor(x.food);
        if (!k || Math.abs(k - 1) < 0.02) return;   // k < 1 — законное уменьшение гарнира
        // «Не трогаем» относится к росту: вкусняшку при маленькой норме можно
        // УМЕНЬШИТЬ (PORTION_RULES 3), остальное фиксированное — никогда.
        if (x.food.kind === 'fixed' && !(x.food.cat === 'treat' && k < 1)) return;

        let num1;
        // Штучное округляем С ПЕРЕВЕСОМ В МЕНЬШУЮ СТОРОНУ: шаг тут крупный
        // (столовая ложка масла — это сразу +150 ккал), и обычное округление
        // перескакивало цель по жирам на 10–12% калорийности дня.
        if (x.food.kind === 'step') num1 = Math.floor(x.num * k + 0.25);
        else if (x.unit === 'мл') num1 = round10(x.num * k);   // «кефир 205 мл» — не мера, а насмешка
        else num1 = x.unit === 'г' ? round5(x.num * k) : Math.round(x.num * k);
        if (x.food.max) num1 = Math.min(num1, x.food.max);
        if (num1 === x.num || !isFinite(num1)) return;

        const realK = num1 / x.num;
        kByFood[x.food.id] = realK;
        edits.push({ idx: x.idx, len: x.len, txt: String(num1) });
        const d = foodMacros(x.food, foodGrams({ food: x.food, num: num1, unit: x.unit, spoon: x.spoon }) - foodGrams(x));
        dp += d.p; df += d.f; dc += d.c; grown = true;

        // Парный вес «≈ N г готового» едет тем же коэффициентом: иначе сырой и
        // готовый разъедутся, и участница взвесит не то.
        pos.forEach(y => { if (y.isPair && y.parent === i) edits.push({ idx: y.idx, len: y.len, txt: String(round5(y.num * realK)) }); });
    });

    if (!grown) return { text: meal.text, p: meal.p, f: meal.f, c: meal.c, items: meal.items, grown: false };

    // items — та же правда, что и текст (по ним считаются списки покупок).
    // Имя item может подойти сразу нескольким правилам («Куриная печень» — и
    // печень, и курица; «Кальмары или креветки» — оба): берём того кандидата,
    // который реально вырос в тексте, иначе items отстанут от рецепта.
    const items = meal.items && meal.items.map(it => {
        const k = pickFoods(it.n, 'right').map(f => kByFood[f.id]).find(v => v);
        return k ? Object.assign({}, it, { g: round5(it.g * k) }) : it;
    });

    return {
        text: fixPlural(applyEdits(meal.text, edits)),
        p: Math.round(meal.p + dp), f: Math.round(meal.f + df), c: Math.round(meal.c + dc),
        items, rec: growRecipe(meal.rec, kByFood, declK), grown: true,
    };
}

/* ─── Главная функция: день под личную норму ─────────────────────────────────
   day     — меню дня как его отдаёт сервер;
   targets — KF.nutritionTargets() (kcal/protein/…);
   extras  — банк добавочных приёмов (nutrition_reference), может быть пуст.
   Возвращает НОВЫЙ объект (кэш не мутируем) либо исходный день, если подгонка
   не нужна. Флаг day.personal = сколько ккал добавлено — по нему интерфейс
   объясняет участнице, что план подогнан под неё. */
function personalDay(day, targets, extras) {
    if (!day || !day.meals || !targets || !targets.kcal) return day;

    const base = dayTotals(day.meals);
    if (!base.kcal) return day;
    // В читмил-день считанная часть меньше — цель уменьшаем в той же доле,
    // остаток бюджета остаётся на свободный ужин.
    const need = targets.kcal * (base.kcal / BASE_PLAN_KCAL);

    /* Каждый макрос ведём К СВОЕЙ ЦЕЛИ, а не растим день пропорционально
       калориям. С формулой «белок 1.8 г/кг, жиры 1 г/кг» (26.07.2026) белок и
       жиры зависят от ВЕСА, а не от нормы калорий: у активной участницы норма
       вдвое больше базовой, а белка нужно лишь на треть больше — разницу должны
       дать гарниры, а не гора мяса.
       Подбор ИТЕРАТИВНЫЙ: продукт даёт несколько макросов сразу (мясо — белок и
       жир, крупа — углеводы и белок), точной формулы тут нет. Три прохода от
       ИСХОДНОГО дня (не от уже выросшего — иначе рост накапливается). */
    const share = base.kcal / BASE_PLAN_KCAL;           // в читмил-день считаем меньшую часть
    const goal = {
        p: targets.protein * share,
        f: targets.fat * share,
        c: (targets.carb || 0) * share,
    };
    // День уже попадает в личные цели — не трогаем его вовсе (у участницы с
    // нормой около базовой план остаётся ровно таким, каким его собрала Катя).
    const near = (a, b) => !b || Math.abs(a - b) <= b * 0.1;
    if (near(base.p, goal.p) && near(base.f, goal.f) && near(base.c, goal.c)
        && need <= base.kcal * 1.03) return day;

    const fit = (want, have, cur, max, min) => {
        if (!have || !want) return cur;
        return Math.max(min || 1, Math.min(max, cur * (want / have)));
    };
    let kP = 1, kC = 1, kF = 1, meals = day.meals;
    for (let pass = 0; pass < 3; pass++) {
        const src = pass === 0 ? base : dayTotals(meals);
        kP = fit(goal.p, src.p, kP, MAX_K_PROT, 0.95);
        // Гарнир может и УМЕНЬШИТЬСЯ (до −15%): при цели «белок 1.8 г/кг, жиры
        // 1 г/кг» углеводов в бюджете остаётся меньше, и часть крупы уступает
        // место белку. Калорийность дня от этого не падает — она перекладывается.
        kC = fit(goal.c, src.c, kC, MAX_K_SIDE, MIN_K_SIDE);
        // Жиры тоже можно убавить: они приезжают вместе с мясом и творогом, и
        // без этого день уходил в перебор по калориям на 4–16%.
        kF = fit(goal.f, src.f, kF, MAX_K_FAT, 0.6);
        // Вкусняшку никогда не увеличиваем, но при маленькой норме УМЕНЬШАЕМ
        // порцию (до −30%): у участницы с нормой 1230 мармелад давал 39 г
        // углеводов из 92 дневных — треть дневного лимита на один перекус.
        // Правило методички «одна вкусняшка в день» сохраняется, меняется вес.
        const kT = Math.min(1, Math.max(0.7, kC));
        const kFor = f => f.cat === 'prot' ? kP
            : (f.cat === 'carb' || f.cat === 'dairy') ? kC
                : f.cat === 'fat' ? kF
                    : f.cat === 'treat' ? kT : 1;

        meals = day.meals.map(m => {
            // Читмил не трогаем (см. PORTION_RULES 4).
            if (m.p == null || m.cheat) return m;
            const g = growMeal(m, kFor);
            return g.grown ? Object.assign({}, m, { text: g.text, p: g.p, f: g.f, c: g.c, items: g.items, rec: g.rec }) : m;
        });
        // На следующем проходе fit() поправит коэффициенты по факту (src выше).
        const got = dayTotals(meals);
        if (got.p >= goal.p * 0.97 && got.c >= goal.c * 0.97 && got.f >= goal.f * 0.95) break;
    }

    /* Приоритет — КАЛОРИИ. Если цели по Б/Ж/У недостижимы для этого дня (часть
       углеводов «неснижаемая» — молоко в каше, фрукты, овощи), погоня за жирами
       уводила день на 4–8% выше нормы. Правило кабинета обратное: сначала
       уложиться в калории, потом белок, а жиры и углеводы — примерно (±15%).
       Поэтому лишнее снимаем с жиров: они дороже всего по калориям. */
    let over = dayTotals(meals);
    if (over.kcal > need * 1.03 && kF > 0.6) {
        for (let pass = 0; pass < 2 && over.kcal > need * 1.03; pass++) {
            kF = Math.max(0.6, kF * (1 - (over.kcal - need) / Math.max(1, over.f * 9)));
            const kFor = f => f.cat === 'prot' ? kP
                : (f.cat === 'carb' || f.cat === 'dairy') ? kC
                    : f.cat === 'fat' ? kF
                        : f.cat === 'treat' ? Math.min(1, Math.max(0.7, kC)) : 1;
            meals = day.meals.map(m => {
                if (m.p == null || m.cheat) return m;
                const g = growMeal(m, kFor);
                return g.grown ? Object.assign({}, m, { text: g.text, p: g.p, f: g.f, c: g.c, items: g.items, rec: g.rec }) : m;
            });
            over = dayTotals(meals);
        }
    }

    // Чего порциями не добрали — закрываем отдельным приёмом пищи.
    const after = dayTotals(meals);
    let gap = Math.round(need - after.kcal);
    const added = [];
    if (extras && extras.length) {
        let acc = { p: after.p, f: after.f, c: after.c, kcal: after.kcal };
        let guard = 0;
        while (gap >= EXTRA_MIN && guard++ < 3) {
            // Жиры у верхней границы — добираем углеводно-белковым, а не орехами:
            // иначе персональный день уезжает за 40% жирности.
            const fatHigh = acc.f * 9 / acc.kcal > 0.34;
            const free = e => added.every(a => a.slot !== e.slot);
            const fits = e => added.indexOf(e) === -1 && e.kcal <= gap + 60
                && !(fatHigh && e.f * 9 / e.kcal > 0.4);
            // Два «вторых завтрака» в одном дне читаются странно — второй добавке
            // ищем свободный слот, и только если такой не нашёлся, берём любую.
            const pool = extras.filter(e => fits(e) && free(e));
            if (!pool.length) break;
            // Выбираем не только по размеру, но и по тому, ЧЕГО не хватает:
            // недобрали углеводов — берём кашу с бананом, а не яйца с огурцом.
            const missP = Math.max(0, goal.p - acc.p), missC = Math.max(0, goal.c - acc.c);
            const score = e => Math.abs(e.kcal - gap)
                - (missC > 15 ? e.c * 2 : 0) - (missP > 10 ? e.p * 3 : 0);
            const best = pool.reduce((a, b) => score(b) < score(a) ? b : a);
            added.push(best); gap -= best.kcal;
            acc = { p: acc.p + best.p, f: acc.f + best.f, c: acc.c + best.c, kcal: acc.kcal + best.kcal };
        }
    }
    // Ставим добавку на своё место в дне: «Второй завтрак» — после завтрака,
    // «Перекус» — после обеда. В конце списка, за ужином, она читалась бы дико.
    added.forEach(e => {
        const meal = {
            slot: e.slot || 'Дополнительный приём', text: e.text, p: e.p, f: e.f, c: e.c,
            items: e.items, rec: e.rec, extra: true,
        };
        const at = e.after ? meals.map(x => x.slot).lastIndexOf(e.after) : -1;
        if (at === -1) meals.push(meal); else meals.splice(at + 1, 0, meal);
    });

    const out = Object.assign({}, day, { meals: meals });
    out.personal = Math.round(dayTotals(meals).kcal - base.kcal);
    out.personalTarget = Math.round(need);
    return out;
}

// ─── Экспорт для node-скриптов проверки (в браузере функции глобальные) ───
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        FOODS, SPOON_G, foodMatch, parseMealFoods, foodGrams, foodMacros,
        growMeal, personalDay, dayTotals, BASE_PLAN_KCAL,
    };
}
