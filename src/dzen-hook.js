/*
 * Ad Skip — контекст страницы Дзена (world: MAIN).
 *
 * Задача этого файла — убрать рекламу в видеоплеере dzen.ru:
 *   1) наложенный баннер в углу видео (teaser-banner поверх плеера);
 *   2) рекламный ролик внутри самого видео (in-stream), если он появится;
 *   3) по желанию — рекламные запросы плеера к Яндексу.
 *
 * Выполняется до инициализации плеера, поэтому успевает и скрыть баннер
 * до первого кадра, и перехватить сетевые запросы рекламного SDK.
 */
(() => {
    'use strict';

    if (window.__AD_SKIP_DZEN_INSTALLED__) return;

    try {
        Object.defineProperty(window, '__AD_SKIP_DZEN_INSTALLED__', {
            value: true,
            configurable: false
        });
    } catch (_) {
        // Если пометить окно не удалось, скрипт может выполниться ещё раз.
    }

    const DEFAULT_SETTINGS = Object.freeze({
        block: true,
        hideOverlay: true,
        fastForward: true,
        rate: 16,
        blockRequests: false
    });

    const CONFIG = Object.freeze({
        adHoldMs: 900,
        maxAdDurationSec: 120,
        tickMs: 400,
        closeBannerDelayMs: 250
    });

    let settings = Object.assign({}, DEFAULT_SETTINGS);

    const stats = {
        blockedResponses: 0,
        xhrBlockedResponses: 0,
        bannerAdsRemoved: 0,
        fallbackSessions: 0,
        skipButtonsClicked: 0,
        lastAction: 'init'
    };

    const ORIGIN = window.location.origin;
    let publishTimer = null;
    let publishLastAt = 0;

    function log(...args) {
        try {
            console.info('[Ad Skip / Дзен]', ...args);
        } catch (_) {
            // Консоль может быть недоступна в очень раннем контексте.
        }
    }

    // ---------------------------------------------------------------------
    // Связь с расширением (мост живёт в изолированном мире).
    // ---------------------------------------------------------------------

    function publishStats(force) {
        const now = Date.now();
        const send = () => {
            publishTimer = null;
            publishLastAt = Date.now();
            try {
                window.postMessage({
                    __adSkip: 'stats',
                    payload: {
                        blockedResponses: stats.blockedResponses,
                        xhrBlockedResponses: stats.xhrBlockedResponses,
                        bannerAdsRemoved: stats.bannerAdsRemoved,
                        fallbackSessions: stats.fallbackSessions,
                        skipButtonsClicked: stats.skipButtonsClicked,
                        lastAction: stats.lastAction
                    }
                }, ORIGIN);
            } catch (_) {
                // Мост может быть ещё не готов.
            }
        };

        if (force) {
            if (publishTimer !== null) {
                clearTimeout(publishTimer);
                publishTimer = null;
            }
            send();
            return;
        }

        const elapsed = now - publishLastAt;
        if (elapsed >= 500) {
            send();
            return;
        }
        if (publishTimer === null) {
            publishTimer = setTimeout(send, 500 - elapsed);
        }
    }

    function applySettings(next) {
        if (!next || typeof next !== 'object') return;

        if (typeof next.block === 'boolean') settings.block = next.block;
        if (typeof next.hideOverlay === 'boolean') settings.hideOverlay = next.hideOverlay;
        if (typeof next.fastForward === 'boolean') settings.fastForward = next.fastForward;
        if (typeof next.blockRequests === 'boolean') settings.blockRequests = next.blockRequests;

        const rate = Number(next.rate);
        if (Number.isFinite(rate) && rate >= 1 && rate <= 64) {
            settings.rate = rate;
        }

        if (!settings.fastForward) {
            stopAllFallback();
        }
        if (!settings.hideOverlay) {
            revealBanners();
        } else {
            purgeBanners();
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.__adSkip === 'settings') {
            applySettings(data.payload);
            publishStats(true);
        } else if (data.__adSkip === 'ping') {
            try {
                window.postMessage({ __adSkip: 'pong' }, ORIGIN);
            } catch (_) {
                // Мост просто переустановит скрипт.
            }
            publishStats(true);
        }
    }, true);

    try {
        window.postMessage({ __adSkip: 'hello' }, ORIGIN);
    } catch (_) {
        // Мост подхватит позже по ping.
    }

    // ---------------------------------------------------------------------
    // Наложенный баннер в углу плеера.
    //
    // Разметка Дзена:
    //   div.video-viewer--video-viewer-player-ad-banner__banner-XX
    //     button[aria-label="Закрыть баннер"]
    //     div#teaser-banner-0[data-testid="video-player-teaser-ad-banner"]
    //       div#video-player-teaser.video-card-ads
    // ---------------------------------------------------------------------

    const BANNER_CONTAINER_SELECTORS = [
        '[class*="video-viewer-player-ad-banner"]',
        '[class*="video-player-ad-banner-layout"]',
        '[data-testid="video-player-teaser-ad-banner"]',
        '#video-player-teaser',
        '#teaser-banner-0'
    ];

    const hiddenBanners = new WeakSet();
    const clickedCloseButtons = new WeakSet();

    function markHidden(element) {
        if (!element || hiddenBanners.has(element)) return false;
        hiddenBanners.add(element);

        try {
            element.setAttribute('data-ad-skip-hidden', '1');
            element.style.setProperty('display', 'none', 'important');
            element.style.setProperty('visibility', 'hidden', 'important');
            element.style.setProperty('pointer-events', 'none', 'important');
        } catch (_) {
            // Стиль может быть заморожен — тогда остаётся CSS-правило.
        }
        return true;
    }

    function revealBanners() {
        for (const node of document.querySelectorAll('[data-ad-skip-hidden="1"]')) {
            try {
                node.removeAttribute('data-ad-skip-hidden');
                node.style.removeProperty('display');
                node.style.removeProperty('visibility');
                node.style.removeProperty('pointer-events');
            } catch (_) {
                // Узел мог быть уже удалён самим плеером.
            }
        }
    }

    function clickBannerClose(container) {
        let button = null;
        try {
            button = container.querySelector('button[aria-label="Закрыть баннер"]') ||
                container.querySelector('[class*="video-player-ad-banner-layout__closeButton"]');
        } catch (_) {
            return;
        }
        if (!button || clickedCloseButtons.has(button)) return;

        clickedCloseButtons.add(button);
        try {
            button.click();
        } catch (error) {
            log('кнопка закрытия баннера не нажалась:', error);
        }
    }

    function purgeBanners() {
        if (!settings.block || !settings.hideOverlay) return;

        let found = 0;
        for (const selector of BANNER_CONTAINER_SELECTORS) {
            let nodes;
            try {
                nodes = document.querySelectorAll(selector);
            } catch (_) {
                continue;
            }

            for (const node of nodes) {
                // Пропускаем вложенные элементы: скрываем только внешний контейнер.
                if (node.parentElement && node.parentElement.closest(BANNER_CONTAINER_SELECTORS.join(','))) continue;
                if (!markHidden(node)) continue;

                found += 1;
                clickBannerClose(node);
            }
        }

        if (found > 0) {
            stats.bannerAdsRemoved += found;
            stats.lastAction = 'overlay-banner-hidden';
            publishStats(false);
            log(`скрыт баннер поверх видео (${stats.bannerAdsRemoved})`);
        }
    }

    // ---------------------------------------------------------------------
    // Сетевой режим (по желанию): не пускаем рекламный SDK к его конфигу.
    // ---------------------------------------------------------------------

    const AD_REQUEST_RE = /^https?:\/\/(?:[^/]+\.)?yandex\.ru\/ads\/meta\//i;

    function safeUrl(value) {
        try {
            if (typeof value === 'string') return value;
            if (value && typeof value.url === 'string') return value.url;
        } catch (_) {
            // Нестандартный объект запроса.
        }
        return '';
    }

    function isAdRequest(value) {
        let url = safeUrl(value);
        if (!url) return false;
        try {
            url = new URL(url, window.location.href).href;
        } catch (_) {
            return false;
        }
        return AD_REQUEST_RE.test(url);
    }

    function emptyAdResponse() {
        return new Response('{}', {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json; charset=utf-8' }
        });
    }

    function installFetchInterceptor() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function') return;

        const wrappedFetch = async function adSkipFetch(...args) {
            if (settings.blockRequests && isAdRequest(args[0])) {
                stats.blockedResponses += 1;
                stats.lastAction = 'ad-request-blocked';
                publishStats(false);
                log(`рекламный запрос остановлен (${stats.blockedResponses})`);
                return emptyAdResponse();
            }
            return nativeFetch.apply(this, args);
        };

        try {
            window.fetch = wrappedFetch;
        } catch (error) {
            log('fetch не удалось заменить:', error);
        }
    }

    function installXhrInterceptor() {
        const XHR = window.XMLHttpRequest;
        if (!XHR || !XHR.prototype) return;
        if (XHR.prototype.__adSkipPatched) return;

        const proto = XHR.prototype;
        const nativeOpen = proto.open;
        const nativeSend = proto.send;

        proto.open = function adSkipOpen(method, url, ...rest) {
            try {
                this.__adSkipUrl = safeUrl(url);
            } catch (_) {
                this.__adSkipUrl = '';
            }
            return nativeOpen.call(this, method, url, ...rest);
        };

        proto.send = function adSkipSend(...args) {
            if (settings.blockRequests && isAdRequest(this.__adSkipUrl)) {
                stats.xhrBlockedResponses += 1;
                stats.lastAction = 'ad-request-blocked-xhr';
                publishStats(false);
                log(`рекламный XHR остановлен (${stats.xhrBlockedResponses})`);

                try {
                    Object.defineProperty(this, 'responseText', {
                        configurable: true,
                        get: () => '{}'
                    });
                    Object.defineProperty(this, 'response', {
                        configurable: true,
                        get: () => ({})
                    });
                    Object.defineProperty(this, 'status', {
                        configurable: true,
                        get: () => 200
                    });
                } catch (_) {
                    // Если свойства заморожены, запрос просто уйдёт как есть.
                }

                setTimeout(() => {
                    try {
                        this.dispatchEvent(new Event('load'));
                        this.dispatchEvent(new Event('loadend'));
                    } catch (_) {
                        // События не критичны.
                    }
                }, 0);
                return undefined;
            }

            return nativeSend.apply(this, args);
        };

        try {
            Object.defineProperty(proto, '__adSkipPatched', {
                value: true,
                configurable: true
            });
        } catch (_) {
            // Защита от повторной установки не критична.
        }
    }

    // ---------------------------------------------------------------------
    // Запасной режим: если реклама всё-таки играет внутри видео.
    // ---------------------------------------------------------------------

    const adStates = new WeakMap();
    const clickedSkipButtons = new WeakSet();

    const AD_UI_SELECTORS = [
        '[class*="video-player-ad" i]',
        '[class*="advert" i]',
        '[class*="adfox" i]',
        '[class*="vast" i]',
        '[class*="vpaid" i]',
        '[data-testid*="advert" i]'
    ].join(',');

    const AD_TEXT_RE = /(реклама\s*\d+|пропустить\s+рекламу|пропустить\s+через|до\s+конца\s+рекламы)/i;
    const SKIP_TEXT_RE = /^пропустить(?:\s+(?:рекламу|ролик|видео|заставку))?(?:\s+через\s+\d+)?$/i;

    function isVisible(element) {
        if (!element || !(element instanceof Element)) return false;
        if (element.hasAttribute && element.hasAttribute('data-ad-skip-hidden')) return false;

        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }
        return element.getClientRects().length > 0;
    }

    function findPlayerRoot(video) {
        let node = video;
        for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            try {
                if (node.matches?.('[class*="video-viewer" i], [class*="player" i], [id*="player" i]')) {
                    return node;
                }
            } catch (_) {
                // Некоторые узлы могут не поддерживать matches.
            }
        }
        return video.parentElement || video;
    }

    function hasAdUi(root) {
        if (!root) return false;

        try {
            for (const element of root.querySelectorAll(AD_UI_SELECTORS)) {
                // Сам баннер — не рекламная вставка: его скрывает purgeBanners,
                // и он не должен включать ускорение обычного видео.
                if (typeof element.closest === 'function' &&
                    element.closest('[class*="video-player-ad-banner-layout"], [data-testid="video-player-teaser-ad-banner"], #video-player-teaser, [class*="video-viewer-player-ad-banner"]')) {
                    continue;
                }
                if (isVisible(element)) return true;
            }
        } catch (_) {
            // Ошибка селектора не должна ломать плеер.
        }
        return false;
    }

    function hasAdText(root) {
        try {
            return AD_TEXT_RE.test(root.innerText || '');
        } catch (_) {
            return false;
        }
    }

    function hasSkipButton(root) {
        let candidates;
        try {
            candidates = root.querySelectorAll('button, [role="button"]');
        } catch (_) {
            return false;
        }

        for (const candidate of candidates) {
            const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 60) continue;
            if (!SKIP_TEXT_RE.test(text)) continue;
            if (!isVisible(candidate)) continue;
            return true;
        }
        return false;
    }

    /**
     * Реклама считается найденной только по надёжным признакам, чтобы
     * не ускорить обычное видео: либо характерные элементы рекламного
     * SDK, либо кнопка «Пропустить», либо надпись «Реклама N» на коротком
     * (рекламном) ролике.
     */
    function detectAd(root, video) {
        if (hasAdUi(root)) return true;
        if (hasSkipButton(root)) return true;

        const duration = Number(video && video.duration);
        const shortClip = Number.isFinite(duration) && duration > 0 && duration <= CONFIG.maxAdDurationSec;
        return shortClip && hasAdText(root);
    }

    function clickSkipButton(root) {
        if (!root) return;

        let candidates;
        try {
            candidates = root.querySelectorAll('button, [role="button"]');
        } catch (_) {
            return;
        }

        for (const candidate of candidates) {
            const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 60) continue;
            if (!SKIP_TEXT_RE.test(text)) continue;
            if (!isVisible(candidate)) continue;
            if (candidate.getAttribute('aria-disabled') === 'true') continue;
            if ('disabled' in candidate && candidate.disabled) continue;
            if (clickedSkipButtons.has(candidate)) continue;

            clickedSkipButtons.add(candidate);
            try {
                candidate.click();
                stats.skipButtonsClicked += 1;
                stats.lastAction = 'skip-button-clicked';
                publishStats(false);
                log('нажата кнопка пропуска рекламы');
            } catch (error) {
                log('кнопка пропуска не нажалась:', error);
            }
            return;
        }
    }

    function rememberVideoState(video) {
        return {
            rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
            muted: Boolean(video.muted),
            volume: Number.isFinite(video.volume) ? video.volume : 1
        };
    }

    function enterAdMode(video, state) {
        if (state.active) return;

        state.active = true;
        state.saved = rememberVideoState(video);
        stats.fallbackSessions += 1;
        stats.lastAction = 'fallback-fast-forward';
        publishStats(false);
        log('включён запасной режим ускорения рекламы');
    }

    function leaveAdMode(video, state) {
        if (!state.active) return;

        const saved = state.saved;
        try {
            if (saved) {
                video.playbackRate = saved.rate;
                video.muted = saved.muted;
                video.volume = saved.volume;
            }
        } catch (error) {
            log('не удалось восстановить параметры видео:', error);
        }

        state.active = false;
        state.saved = null;
        state.lastAdAt = 0;
        state.adWasShort = false;
        stats.lastAction = 'fallback-restored';
        publishStats(false);
        log('восстановлены обычные скорость и звук');
    }

    function stopAllFallback() {
        for (const video of document.querySelectorAll('video')) {
            const state = adStates.get(video);
            if (state && state.active) leaveAdMode(video, state);
        }
    }

    function applyFastMode(video) {
        try {
            if (video.playbackRate !== settings.rate) {
                video.playbackRate = settings.rate;
            }
        } catch (_) {
            // Некоторые браузеры ограничивают playbackRate.
        }

        try {
            if (!video.muted) video.muted = true;
        } catch (_) {
            // Игнорируем ограничения конкретного браузера.
        }
    }

    function inspectVideo(video) {
        const root = findPlayerRoot(video);
        const adVisible = detectAd(root, video);
        const now = Date.now();

        let state = adStates.get(video);
        if (!state) {
            state = {
                active: false,
                saved: null,
                lastAdAt: 0,
                adWasShort: false
            };
            adStates.set(video, state);
        }

        if (adVisible) {
            state.lastAdAt = now;

            if (!settings.fastForward) {
                clickSkipButton(root);
                return;
            }

            if (!state.active) {
                state.adWasShort = Number.isFinite(video.duration) &&
                    video.duration > 0 &&
                    video.duration <= CONFIG.maxAdDurationSec;
                enterAdMode(video, state);
            }

            clickSkipButton(root);
        }

        if (!state.active) return;

        const duration = Number(video.duration);
        const longContentAppeared = state.adWasShort &&
            Number.isFinite(duration) &&
            duration > CONFIG.maxAdDurationSec;

        const quietFor = state.lastAdAt ? now - state.lastAdAt : Number.POSITIVE_INFINITY;
        const shouldLeave = longContentAppeared ||
            (!adVisible && quietFor >= CONFIG.adHoldMs);

        if (shouldLeave) {
            leaveAdMode(video, state);
            return;
        }

        applyFastMode(video, state);
    }

    function tick() {
        try {
            purgeBanners();
        } catch (error) {
            log('ошибка скрытия баннера:', error);
        }

        let videos;
        try {
            videos = document.querySelectorAll('video');
        } catch (_) {
            return;
        }

        for (const video of videos) {
            try {
                inspectVideo(video);
            } catch (error) {
                log('ошибка проверки видео:', error);
            }
        }
    }

    function installWatch() {
        let timer = null;
        const schedule = () => {
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                tick();
            }, 80);
        };

        const startObserver = () => {
            if (!document.documentElement) return false;

            try {
                const observer = new MutationObserver(schedule);
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
                });
            } catch (error) {
                log('наблюдатель за плеером не установлен:', error);
            }

            document.addEventListener('loadedmetadata', schedule, true);
            document.addEventListener('play', schedule, true);
            document.addEventListener('pause', schedule, true);
            return true;
        };

        if (!startObserver()) {
            document.addEventListener('DOMContentLoaded', startObserver, { once: true });
        }

        setInterval(tick, CONFIG.tickMs);

        // Баннер Дзен появляется через паузу после старта плеера —
        // отдельная отложенная проверка ловит его без ожидания MutationObserver.
        setTimeout(schedule, CONFIG.closeBannerDelayMs);
    }

    // ---------------------------------------------------------------------
    // Инициализация.
    // ---------------------------------------------------------------------

    installFetchInterceptor();
    installXhrInterceptor();
    installWatch();

    try {
        Object.defineProperty(window, '__AD_SKIP_DZEN__', {
            configurable: true,
            value: {
                version: '1.1.0',
                settings: () => Object.assign({}, settings),
                stats: () => Object.assign({}, stats),
                runCheck: tick
            }
        });
    } catch (_) {
        // Диагностический объект необязателен.
    }

    log('подключён (Дзен)');
})();