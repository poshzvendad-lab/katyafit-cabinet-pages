/* KatyaFit — anti-clickjacking frame-buster.
   На GitHub Pages нельзя задать свои HTTP-заголовки, поэтому пропавший при переезде
   X-Frame-Options заменяем этим скриптом: если страницу открыли внутри фрейма/iframe
   (попытка кликджекинга) — вырываемся на верхний уровень. Директива CSP
   frame-ancestors в <meta> браузером игнорируется, так что это её рабочая замена.
   Детали: docs/МИГРАЦИЯ-ХОСТИНГА.md §13.1 */
(function () {
    if (self === top) return;                 // не во фрейме — всё хорошо
    try {
        top.location.replace(location.href);  // вырваться из фрейма наверх
    } catch (e) {
        // Кросс-доменный фрейм не даёт сменить top.location — прячем содержимое.
        document.documentElement.style.display = 'none';
    }
})();
