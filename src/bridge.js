/*
 * Ad Skip — мост между страницей и расширением (Rutube и Дзен).
 *
 * Выполняется в изолированном мире контент-скрипта: здесь доступен chrome.*,
 * но нет доступа к window.fetch страницы. Обмен идёт через postMessage.
 */
(() => {
    'use strict';

    const DEFAULT_SETTINGS = Object.freeze({
        block: true,
        hideOverlay: true,
        fastForward: true,
        rate: 16,
        blockRequests: false
    });

    const IS_DZEN = /(^|\.)dzen\.ru$/i.test(window.location.hostname) ||
        /(^|\.)zen\.yandex\.ru$/i.test(window.location.hostname);

    const ORIGIN = window.location.origin;
    const IS_TOP_FRAME = (() => {
        try {
            return window.top === window;
        } catch (_) {
            return false;
        }
    })();

    const state = {
        stats: null,
        pageReady: false,
        injectedScript: false
    };

    function post(message) {
        try {
            window.postMessage(message, ORIGIN);
        } catch (_) {
            // Окно может быть уже выгружено.
        }
    }

    function extensionAlive() {
        try {
            return Boolean(chrome && chrome.runtime && chrome.runtime.id);
        } catch (_) {
            return false;
        }
    }

    function readSettings() {
        return new Promise((resolve) => {
            if (!extensionAlive()) {
                resolve(Object.assign({}, DEFAULT_SETTINGS));
                return;
            }

            try {
                chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
                    if (chrome.runtime.lastError) {
                        resolve(Object.assign({}, DEFAULT_SETTINGS));
                        return;
                    }
                    resolve(Object.assign({}, DEFAULT_SETTINGS, stored));
                });
            } catch (_) {
                resolve(Object.assign({}, DEFAULT_SETTINGS));
            }
        });
    }

    async function pushSettings() {
        const settings = await readSettings();
        post({ __adSkip: 'settings', payload: settings });
    }

    function reportStats(stats) {
        if (!IS_TOP_FRAME || !stats || !extensionAlive()) return;

        try {
            chrome.runtime.sendMessage({ type: 'stats', stats }, () => {
                // Ответ не нужен; ошибка возникает, если фоновый скрипт неактивен.
                void chrome.runtime.lastError;
            });
        } catch (_) {
            // Расширение могло быть перезагружено.
        }
    }

    // ---------------------------------------------------------------------
    // Приём сообщений от страницы.
    // ---------------------------------------------------------------------

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== ORIGIN) return;

        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.__adSkip === 'hello' || data.__adSkip === 'pong') {
            state.pageReady = true;
            pushSettings();
        } else if (data.__adSkip === 'stats') {
            state.pageReady = true;
            state.stats = data.payload || null;
            reportStats(state.stats);
        }
    }, true);

    // ---------------------------------------------------------------------
    // Страховка: если браузер не применил world: MAIN, ставим хук сами.
    // ---------------------------------------------------------------------

    function injectPageHook() {
        if (state.injectedScript || state.pageReady) return;
        state.injectedScript = true;

        try {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL(IS_DZEN ? 'src/dzen-hook.js' : 'src/page-hook.js');
            script.async = false;
            script.onload = () => script.remove();
            script.onerror = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
        } catch (_) {
            // Если вставить скрипт не удалось, основной режим просто не включится.
        }
    }

    function handshake() {
        post({ __adSkip: 'ping' });
        setTimeout(() => {
            if (!state.pageReady) injectPageHook();
        }, 250);
    }

    if (document.readyState === 'loading') {
        handshake();
    } else {
        handshake();
    }

    // ---------------------------------------------------------------------
    // Реакция на изменения настроек и запросы панели.
    // ---------------------------------------------------------------------

    if (extensionAlive()) {
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'sync') return;
                if (!('block' in changes) && !('fastForward' in changes) && !('rate' in changes) &&
                    !('hideOverlay' in changes) && !('blockRequests' in changes)) {
                    return;
                }
                pushSettings();
            });
        } catch (_) {
            // Хранилище недоступно — остаются настройки по умолчанию.
        }

        try {
            chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
                if (!message || typeof message !== 'object') return;

                if (message.type === 'get-state') {
                    sendResponse({
                        ok: true,
                        url: window.location.href,
                        stats: state.stats,
                        pageReady: state.pageReady
                    });
                    return true;
                }

                if (message.type === 'rescan') {
                    post({ __adSkip: 'ping' });
                    sendResponse({ ok: true });
                    return true;
                }
            });
        } catch (_) {
            // Без слушателя панель просто покажет пустую статистику.
        }
    }
})();