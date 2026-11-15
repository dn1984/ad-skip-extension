/*
 * Rutube Ad Skip — контекст страницы (world: MAIN).
 *
 * Этот файл выполняется в том же JavaScript-окружении, что и плеер Rutube,
 * поэтому может перехватить ответ /api/play/options/ и убрать из него
 * описание рекламных вставок до того, как плеер его прочитает.
 */
(() => {
    'use strict';

    if (window.__RUTUBE_AD_SKIP_INSTALLED__) return;

    try {
        Object.defineProperty(window, '__RUTUBE_AD_SKIP_INSTALLED__', {
            value: true,
            configurable: false
        });
    } catch (_) {
        // Если пометить окно не удалось, второй экземпляр может выполниться ещё раз.
    }

    const DEFAULT_SETTINGS = Object.freeze({
        block: true,
        fastForward: true,
        rate: 16
    });

    const CONFIG = Object.freeze({
        // Сколько ждать исчезновения рекламных элементов, чтобы серия
        // роликов не вызывала мигание звука между вставками.
        adHoldMs: 900,
        // Рекламный ролик обычно короче этого значения.
        maxAdDurationSec: 120,
        tickMs: 300
    });

    let settings = Object.assign({}, DEFAULT_SETTINGS);

    const stats = {
        blockedResponses: 0,
        xhrBlockedResponses: 0,
        fallbackSessions: 0,
        skipButtonsClicked: 0,
        lastAction: 'init'
    };

    const ORIGIN = window.location.origin;
    let publishTimer = null;
    let publishLastAt = 0;

    function log(...args) {
        try {
            console.info('[Rutube Ad Skip]', ...args);
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
        if (typeof next.fastForward === 'boolean') settings.fastForward = next.fastForward;

        const rate = Number(next.rate);
        if (Number.isFinite(rate) && rate >= 1 && rate <= 64) {
            settings.rate = rate;
        }

        if (!settings.fastForward) {
            stopAllFallback();
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
                // Ничего страшного: мост просто переустановит скрипт.
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
    // Основной режим: вырезание рекламной конфигурации из play/options.
    // ---------------------------------------------------------------------

    function safeUrl(value) {
        try {
            if (typeof value === 'string') return value;
            if (value && typeof value.url === 'string') return value.url;
        } catch (_) {
            // Игнорируем нестандартные объекты запроса.
        }
        return '';
    }

    function isPlayOptionsUrl(value) {
        let url = safeUrl(value);
        if (!url) return false;

        try {
            url = new URL(url, window.location.href).href;
        } catch (_) {
            return false;
        }

        return /^https?:\/\/(?:[^/]+\.)?rutube\.ru\/api\/play\/options\//i.test(url);
    }

    /**
     * Очищает рекламные поля ответа play/options.
     * Массивы заменяются пустыми, чтобы код плеера, ожидающий наличие поля,
     * не сломался.
     */
    function stripAdConfig(payload) {
        if (!payload || typeof payload !== 'object') return false;

        let changed = false;
        const containers = [
            payload,
            payload.data,
            payload.options,
            payload.result,
            payload.video
        ].filter((item) => item && typeof item === 'object');

        for (const container of containers) {
            for (const key of ['advert', 'ad_breaks', 'adBreaks', 'advert_breaks']) {
                if (!Object.prototype.hasOwnProperty.call(container, key)) continue;

                const value = container[key];
                if (Array.isArray(value)) {
                    if (value.length > 0) {
                        container[key] = [];
                        changed = true;
                    }
                } else if (value !== null && value !== undefined) {
                    delete container[key];
                    changed = true;
                }
            }
        }

        try {
            if (payload.appearance && typeof payload.appearance === 'object' &&
                Object.prototype.hasOwnProperty.call(payload.appearance, 'advert_skin_type')) {
                delete payload.appearance.advert_skin_type;
                changed = true;
            }
        } catch (_) {
            // appearance может быть замороженным объектом.
        }

        return changed;
    }

    function rebuiltHeaders(response) {
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('transfer-encoding');
        headers.set('content-type', 'application/json; charset=utf-8');
        return headers;
    }

    function installFetchInterceptor() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function') return;

        const wrappedFetch = async function rutubeAdSkipFetch(...args) {
            const response = await nativeFetch.apply(this, args);

            try {
                if (!settings.block) return response;
                if (!isPlayOptionsUrl(args[0])) return response;
                if (!response || !response.ok) return response;

                const contentType = response.headers.get('content-type') || '';
                if (contentType && !/json/i.test(contentType)) return response;

                const clone = response.clone();
                const raw = await clone.text();
                if (!raw) return response;

                const data = JSON.parse(raw);
                if (!stripAdConfig(data)) return response;

                stats.blockedResponses += 1;
                stats.lastAction = 'play-options-ads-removed';
                publishStats(false);
                log(`рекламная конфигурация удалена (${stats.blockedResponses})`);

                return new Response(JSON.stringify(data), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: rebuiltHeaders(response)
                });
            } catch (error) {
                log('не удалось обработать ответ play/options:', error);
                return response;
            }
        };

        try {
            window.fetch = wrappedFetch;
        } catch (error) {
            log('fetch не удалось заменить:', error);
        }
    }

    /**
     * Резервный перехват XHR: плеер в основном использует fetch, но
     * отдельные версии могут обращаться к API через XMLHttpRequest.
     */
    function installXhrInterceptor() {
        const XHR = window.XMLHttpRequest;
        if (!XHR || !XHR.prototype) return;
        if (XHR.prototype.__adSkipPatched) return;

        const proto = XHR.prototype;
        const nativeOpen = proto.open;
        const nativeSend = proto.send;

        proto.open = function rutubeAdSkipOpen(method, url, ...rest) {
            try {
                this.__adSkipUrl = safeUrl(url);
            } catch (_) {
                this.__adSkipUrl = '';
            }
            return nativeOpen.call(this, method, url, ...rest);
        };

        proto.send = function rutubeAdSkipSend(...args) {
            const xhr = this;

            if (settings.block && isPlayOptionsUrl(xhr.__adSkipUrl)) {
                xhr.addEventListener('readystatechange', function onReady() {
                    if (xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;
                    if (xhr.__adSkipApplied) return;

                    try {
                        const responseType = xhr.responseType || '';
                        let data;

                        if (responseType === 'json') {
                            data = xhr.response;
                        } else if (responseType === '' || responseType === 'text') {
                            data = JSON.parse(xhr.responseText);
                        } else {
                            return;
                        }

                        if (!stripAdConfig(data)) return;

                        const newText = JSON.stringify(data);
                        if (responseType === '' || responseType === 'text') {
                            Object.defineProperty(xhr, 'responseText', {
                                configurable: true,
                                get: () => newText
                            });
                        }
                        if (responseType === 'json') {
                            Object.defineProperty(xhr, 'response', {
                                configurable: true,
                                get: () => JSON.parse(newText)
                            });
                        }

                        xhr.__adSkipApplied = true;
                        stats.xhrBlockedResponses += 1;
                        stats.lastAction = 'play-options-ads-removed-xhr';
                        publishStats(false);
                        log(`рекламная конфигурация удалена через XHR (${stats.xhrBlockedResponses})`);
                    } catch (error) {
                        log('XHR-перехват не сработал:', error);
                    }
                }, true);
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

    /**
     * Если плеер использует hls.js, отключаем вставку HLS Interstitials.
     */
    function patchHls(Hls) {
        try {
            if (!Hls || !Hls.DefaultConfig) return;
            const config = Hls.DefaultConfig;

            if (Object.prototype.hasOwnProperty.call(config, 'enableInterstitialPlayback')) {
                config.enableInterstitialPlayback = false;
            }
            if (Object.prototype.hasOwnProperty.call(config, 'interstitialAppendInPlace')) {
                config.interstitialAppendInPlace = false;
            }
        } catch (_) {
            // Другая версия hls.js или замороженный конфиг.
        }
    }

    function installHlsPatch() {
        if (window.Hls) patchHls(window.Hls);

        try {
            let current = window.Hls;
            Object.defineProperty(window, 'Hls', {
                configurable: true,
                enumerable: true,
                get: () => current,
                set: (value) => {
                    current = value;
                    patchHls(value);
                }
            });
        } catch (_) {
            // Если свойство переопределить нельзя, оставляем как есть.
        }
    }

    // ---------------------------------------------------------------------
    // Запасной режим: ускорение рекламы, если она всё-таки дошла до плеера.
    // ---------------------------------------------------------------------

    const adStates = new WeakMap();
    const clickedSkipButtons = new WeakSet();

    const AD_SELECTORS = [
        '#raichu-banner',
        '#raichu_yasdk_container',
        '#native-advert_container',
        '[data-testid*="advert" i]',
        '[data-testid*="ad-countdown" i]',
        '[class*="advert-timer" i]',
        '[class*="advert-skip" i]',
        '[class*="advert-timeline" i]',
        '[class*="vpaid-frame" i]',
        '[class*="vpaidFrame" i]',
        '[class*="yandex-advert" i]',
        '[class*="rutube-advert" i]'
    ].join(',');

    const AD_TEXT_RE = /(^|\n)\s*(?:реклама(?:\s+\d+)?|пропустить\s+рекламу|пропустить\s+через|до\s+конца\s+рекламы)\b/i;

    function isVisible(element) {
        if (!element || !(element instanceof Element)) return false;

        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }
        return element.getClientRects().length > 0;
    }

    function findPlayerRoot(video) {
        let node = video;
        for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
            try {
                if (node.matches?.('[class*="player" i], [id*="player" i], rutube-player, [data-testid*="player" i]')) {
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
            for (const element of root.querySelectorAll(AD_SELECTORS)) {
                if (isVisible(element)) return true;
            }
        } catch (_) {
            // Ошибка селектора не должна ломать плеер.
        }

        try {
            return AD_TEXT_RE.test(root.innerText || '');
        } catch (_) {
            return false;
        }
    }

    function clickSkipButton(root) {
        if (!root) return;

        let candidates;
        try {
            candidates = root.querySelectorAll('button, [role="button"], a, span, div');
        } catch (_) {
            return;
        }

        for (const candidate of candidates) {
            const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 80) continue;
            if (!/^(пропустить(\s+рекламу|\s+через|\s+ролик)?)$/i.test(text)) continue;
            if (!isVisible(candidate)) continue;
            if (candidate.getAttribute('aria-disabled') === 'true') continue;
            if ('disabled' in candidate && candidate.disabled) continue;

            const clickable = candidate.closest('button, [role="button"], a') || candidate;
            if (clickedSkipButtons.has(clickable)) continue;
            if (clickable.closest?.('a[href*="premium"], a[href*="subscription"]')) continue;

            clickedSkipButtons.add(clickable);
            try {
                clickable.click();
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

    function applyFastMode(video, state) {
        if (!state.active) return;

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
        const adVisible = hasAdUi(root);
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

    function installFallbackWatch() {
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
            document.addEventListener('emptied', schedule, true);
            document.addEventListener('play', schedule, true);
            document.addEventListener('pause', schedule, true);
            return true;
        };

        if (!startObserver()) {
            document.addEventListener('DOMContentLoaded', startObserver, { once: true });
        }

        setInterval(tick, CONFIG.tickMs);
    }

    // ---------------------------------------------------------------------
    // Инициализация: сетевые хуки ставятся как можно раньше, до плеера.
    // ---------------------------------------------------------------------

    installFetchInterceptor();
    installXhrInterceptor();
    installHlsPatch();
    installFallbackWatch();

    try {
        Object.defineProperty(window, '__RUTUBE_AD_SKIP__', {
            configurable: true,
            value: {
                version: '1.0.0',
                settings: () => Object.assign({}, settings),
                stats: () => Object.assign({}, stats),
                runCheck: tick
            }
        });
    } catch (_) {
        // Диагностический объект необязателен.
    }

    log('подключён (расширение)');
})();