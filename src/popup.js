/*
 * Ad Skip — панель управления (Rutube и Дзен).
 */
'use strict';

const DEFAULT_SETTINGS = {
    block: true,
    hideOverlay: true,
    fastForward: true,
    rate: 16,
    blockRequests: false
};

const RUTUBE_RE = /^https:\/\/(?:[^/]+\.)?rutube\.ru\//i;
const DZEN_RE = /^https:\/\/(?:[^/]+\.)?dzen\.ru\//i;
const SITE_RE = new RegExp(`${RUTUBE_RE.source}|${DZEN_RE.source}`, 'i');

const el = {
    blocked: document.getElementById('blockedCount'),
    banners: document.getElementById('bannerCount'),
    fallback: document.getElementById('fallbackCount'),
    skipped: document.getElementById('skipCount'),
    pageState: document.getElementById('pageState'),
    subtitle: document.getElementById('subtitle'),
    toggleBlock: document.getElementById('toggleBlock'),
    toggleOverlay: document.getElementById('toggleOverlay'),
    toggleFast: document.getElementById('toggleFast'),
    toggleRequests: document.getElementById('toggleRequests'),
    rate: document.getElementById('rate'),
    reload: document.getElementById('reload'),
    version: document.getElementById('version')
};

function isDzen(url) {
    return DZEN_RE.test(url || '');
}

function setStats(stats) {
    if (!stats) {
        el.blocked.textContent = '0';
        el.banners.textContent = '0';
        el.fallback.textContent = '0';
        el.skipped.textContent = '0';
        return;
    }

    const blocked = (Number(stats.blockedResponses) || 0) +
        (Number(stats.xhrBlockedResponses) || 0);

    el.blocked.textContent = String(blocked);
    el.banners.textContent = String(Number(stats.bannerAdsRemoved) || 0);
    el.fallback.textContent = String(Number(stats.fallbackSessions) || 0);
    el.skipped.textContent = String(Number(stats.skipButtonsClicked) || 0);
}

function showState(text, warn) {
    el.pageState.textContent = text;
    el.pageState.classList.toggle('warn', Boolean(warn));
}

async function getActiveTab() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        return tabs && tabs[0] ? tabs[0] : null;
    } catch (_) {
        return null;
    }
}

async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const settings = Object.assign({}, DEFAULT_SETTINGS, stored);

    el.toggleBlock.checked = Boolean(settings.block);
    el.toggleOverlay.checked = Boolean(settings.hideOverlay);
    el.toggleFast.checked = Boolean(settings.fastForward);
    el.toggleRequests.checked = Boolean(settings.blockRequests);
    el.rate.value = String(settings.rate);
    syncControls();

    return settings;
}

function syncControls() {
    el.rate.disabled = !el.toggleFast.checked;
    el.rate.parentElement.classList.toggle('disabled', !el.toggleFast.checked);

    el.toggleOverlay.disabled = !el.toggleBlock.checked;
    el.toggleOverlay.parentElement.classList.toggle('disabled', !el.toggleBlock.checked);
}

async function saveSettings() {
    await chrome.storage.sync.set({
        block: el.toggleBlock.checked,
        hideOverlay: el.toggleOverlay.checked,
        fastForward: el.toggleFast.checked,
        blockRequests: el.toggleRequests.checked,
        rate: Number(el.rate.value) || 16
    });
}

async function refreshTabState() {
    const tab = await getActiveTab();

    if (!tab || !tab.url || !SITE_RE.test(tab.url)) {
        showState('Откройте видео на rutube.ru или dzen.ru, чтобы увидеть статистику.', true);
        setStats(null);
        el.reload.disabled = true;
        return;
    }

    el.reload.disabled = false;
    el.subtitle.textContent = isDzen(tab.url)
        ? 'Дзен: баннеры поверх видео скрываются, вставки ускоряются'
        : 'Реклама в видео вырезается до запуска плеера';

    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' }, { frameId: 0 });

        if (!response || !response.ok) {
            showState('Скрипт ещё не подключился. Перезагрузите страницу.', true);
            setStats(null);
            return;
        }

        if (!response.stats) {
            showState('Скрипт активен. Откройте видео, чтобы увидеть результат.', false);
            setStats(null);
            return;
        }

        setStats(response.stats);

        const blocked = (Number(response.stats.blockedResponses) || 0) +
            (Number(response.stats.xhrBlockedResponses) || 0);
        const banners = Number(response.stats.bannerAdsRemoved) || 0;

        if (isDzen(tab.url)) {
            if (banners > 0) {
                showState(`Реклама убрана. Скрыто баннеров поверх видео: ${banners}.`, false);
            } else if (blocked > 0) {
                showState(`Рекламные запросы остановлены: ${blocked}.`, false);
            } else if (response.stats.fallbackSessions > 0) {
                showState('Сработал запасной режим ускорения рекламы.', false);
            } else {
                showState('Скрипт активен. Рекламных баннеров на видео пока не было.', false);
            }
            return;
        }

        if (blocked > 0) {
            showState(`Реклама отключена. Конфигурация плеера очищена ${blocked} раз(а).`, false);
        } else if (response.stats.fallbackSessions > 0) {
            showState('Сработал запасной режим ускорения рекламы.', false);
        } else {
            showState('Скрипт активен, рекламных вставок пока не встречалось.', false);
        }
    } catch (_) {
        showState('Скрипт ещё не подключился. Перезагрузите страницу.', true);
        setStats(null);
    }
}

el.toggleBlock.addEventListener('change', () => {
    syncControls();
    saveSettings().then(refreshTabState).catch(() => {});
});

el.toggleOverlay.addEventListener('change', () => {
    saveSettings().then(refreshTabState).catch(() => {});
});

el.toggleFast.addEventListener('change', () => {
    syncControls();
    saveSettings().then(refreshTabState).catch(() => {});
});

el.toggleRequests.addEventListener('change', () => {
    saveSettings().then(refreshTabState).catch(() => {});
});

el.rate.addEventListener('change', () => {
    saveSettings().catch(() => {});
});

el.reload.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== 'number') return;

    try {
        await chrome.tabs.reload(tab.id);
        window.close();
    } catch (_) {
        showState('Не удалось перезагрузить вкладку.', true);
    }
});

(async () => {
    try {
        el.version.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (_) {
        // Версия не критична.
    }

    await loadSettings();
    await refreshTabState();
})();