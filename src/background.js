/*
 * Ad Skip — фоновый service worker.
 *
 * Хранит настройки по умолчанию и показывает на значке расширения,
 * сколько рекламы убрано на текущей вкладке.
 */
'use strict';

const DEFAULT_SETTINGS = Object.freeze({
    block: true,
    hideOverlay: true,
    fastForward: true,
    rate: 16,
    blockRequests: false
});

/**
 * Обёртка над chrome.action.*: в разных сборках Chromium эти методы
 * возвращают либо Promise, либо undefined.
 */
function callAction(method, details) {
    try {
        const result = method(details);
        if (result && typeof result.catch === 'function') {
            result.catch(() => {});
        }
    } catch (_) {
        // Значок не обновился — на работу расширения это не влияет.
    }
}

function setBadge(tabId, text) {
    callAction(chrome.action.setBadgeText.bind(chrome.action), { tabId, text });
    callAction(chrome.action.setBadgeBackgroundColor.bind(chrome.action), {
        tabId,
        color: '#00A1E7'
    });
}

chrome.runtime.onInstalled.addListener(() => {
    try {
        chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
            if (chrome.runtime.lastError) return;

            chrome.storage.sync.set(Object.assign({}, DEFAULT_SETTINGS, stored), () => {
                void chrome.runtime.lastError;
            });
        });
    } catch (_) {
        // Хранилище может быть недоступно во время обновления.
    }
});

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'stats') return undefined;

    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return undefined;

    const stats = message.stats || {};
    const removed = (Number(stats.blockedResponses) || 0) +
        (Number(stats.xhrBlockedResponses) || 0) +
        (Number(stats.bannerAdsRemoved) || 0);

    let text = '';
    if (removed > 99) text = '99+';
    else if (removed > 0) text = String(removed);

    setBadge(tabId, text);
    return undefined;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    setBadge(tabId, '');
});
