// @ts-check
// Web/jdm-core.js
//
// Small browser runtime for the Jellyfin Deletion Manager UI: signed-in identity
// tracking, an authenticated fetch wrapper, a navigation hook, one shared
// MutationObserver, an item cache, a toast, the Home-page native tab strip
// entry and the native action-sheet row builder.
//
// The history patching, identity transitions, tab-strip handling and
// action-sheet row builder are adapted from Jellyfin Enhanced
// (n00bcodr/Jellyfin-Enhanced, GPL-3.0), reduced to what this plugin needs.
//
// Must load before every other Web/ file. Everything is exposed on
// window.JellyfinDeletionManager (JDM); deletion-state.js adds JDM.deletion.
(function () {
    'use strict';

    const LOG = 'Jellyfin Deletion Manager:';
    const JDM = window.JellyfinDeletionManager = { deletion: {} };

    function afterNextPaint(fn) {
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            clearTimeout(fallback);
            fn();
        };
        // Animation frames pause in background tabs; the timeout keeps work moving.
        const fallback = setTimeout(run, 250);
        requestAnimationFrame(() => setTimeout(run, 0));
    }

    // ============================================================
    // Navigation: pushState, replaceState, hashchange and popstate,
    // collapsed to one notification per URL change.
    // ============================================================

    const navCallbacks = new Set();
    let lastHref = null;

    function dispatchNavigate() {
        if (window.location.href === lastHref) return;
        lastHref = window.location.href;
        for (const callback of navCallbacks) {
            try { callback(); } catch (err) { console.error(`${LOG} navigation callback failed`, err); }
        }
    }

    function patchHistory() {
        if (history.__jdmPatched) return;
        history.__jdmPatched = true;
        for (const method of ['pushState', 'replaceState']) {
            const original = history[method].bind(history);
            history[method] = function (...args) {
                const before = window.location.href;
                original(...args);
                if (window.location.href !== before) window.dispatchEvent(new Event('jdm:navigate'));
            };
        }
    }

    patchHistory();
    window.addEventListener('jdm:navigate', dispatchNavigate);
    window.addEventListener('hashchange', dispatchNavigate);
    window.addEventListener('popstate', dispatchNavigate);

    JDM.navigation = {
        /** @param {Function} callback @returns {Function} Unsubscribe. */
        onNavigate(callback) {
            navCallbacks.add(callback);
            return () => navCallbacks.delete(callback);
        },
    };

    // ============================================================
    // Identity. jellyfin-web is an SPA: signing in as someone else does not
    // reload the page, so per-user state has to be dropped on a transition.
    // Async work captures getEpoch() before awaiting and discards its result
    // when the epoch has moved on.
    // ============================================================

    let epoch = 0;
    let currentUserId = null;
    let currentServerId = null;
    let adopted = false;
    const resetHandlers = new Map();

    function readIdentity() {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient) return { userId: null, serverId: null };
            const userId = (typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null) || null;
            let serverId = null;
            try {
                serverId = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId)
                    || (ApiClient._serverInfo && ApiClient._serverInfo.Id) || null;
            } catch (_) { serverId = null; }
            return { userId, serverId };
        } catch (_) {
            return { userId: null, serverId: null };
        }
    }

    function transition(userId, serverId, reason) {
        if (userId === currentUserId && serverId === currentServerId) return false;
        // The first user seen at startup is adopted silently: nothing belonged to anyone before.
        if (!adopted && currentUserId === null && userId !== null) {
            adopted = true;
            epoch++;
            currentUserId = userId;
            currentServerId = serverId;
            return false;
        }
        const previous = currentUserId;
        epoch++;
        const mine = epoch;
        currentUserId = userId;
        currentServerId = serverId;
        console.log(`${LOG} identity transition (${reason}): ${previous || 'none'} -> ${userId || 'none'}`);
        for (const [name, fn] of resetHandlers) {
            if (epoch !== mine) break;
            try { fn(); } catch (err) { console.error(`${LOG} reset handler "${name}" failed`, err); }
        }
        return true;
    }

    function checkNow(reason) {
        const { userId, serverId } = readIdentity();
        transition(userId, serverId, reason);
    }

    // Every login/logout path calls setAuthenticationInfo; hooking it clears the old
    // user's state before the new token exists. Navigation and a slow poll cover
    // hosts where the hook cannot be installed or ApiClient is replaced.
    function installAuthHook(client) {
        try {
            if (!client) return;
            let owner = client;
            while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setAuthenticationInfo')) owner = Object.getPrototypeOf(owner);
            if (!owner || typeof owner.setAuthenticationInfo !== 'function' || owner.setAuthenticationInfo.__jdmWrapped) return;
            const original = owner.setAuthenticationInfo;
            const wrapped = function (accessKey, userId) {
                const active = typeof ApiClient === 'undefined' || !ApiClient || this === ApiClient;
                try {
                    const next = userId || null;
                    if (active && adopted && next !== currentUserId) transition(next, currentServerId, 'authentication');
                } catch (err) { console.error(`${LOG} pre-auth transition failed`, err); }
                const result = original.apply(this, arguments);
                if (active) checkNow('authentication');
                return result;
            };
            wrapped.__jdmWrapped = true;
            try { owner.setAuthenticationInfo = wrapped; } catch (_) { client.setAuthenticationInfo = wrapped; }
        } catch (err) {
            console.warn(`${LOG} could not hook setAuthenticationInfo`, err);
        }
    }

    JDM.session = {
        getUserId: () => currentUserId,
        getEpoch: () => epoch,
        isCurrent: value => value === epoch,
        /** Handlers must only clear state; registering a name again replaces its handler. */
        onUserChange(name, fn) {
            resetHandlers.set(name, fn);
            return () => resetHandlers.delete(name);
        },
        checkNow,
    };

    checkNow('startup');
    installAuthHook(typeof ApiClient !== 'undefined' ? ApiClient : null);
    JDM.navigation.onNavigate(() => checkNow('navigate'));
    setInterval(() => {
        installAuthHook(typeof ApiClient !== 'undefined' ? ApiClient : null);
        checkNow('reconcile');
    }, 1000);

    // ============================================================
    // Authenticated JSON requests. No retries: mutations must run once,
    // and the dashboard polls reads again within seconds anyway.
    // ============================================================

    JDM.api = {
        /**
         * @param {string} path Server path, e.g. '/DeletionManager/Requests'.
         * @param {{method?: string, headers?: Record<string, string>, body?: any, signal?: AbortSignal}} [options]
         * @returns {Promise<any>} Parsed JSON ({} for an empty body).
         */
        async jf(path, options = {}) {
            const { method = 'GET', headers = {}, body, signal } = options;
            const token = ApiClient.accessToken();
            // Signed out (login page, mid-switch): nothing to send, and a 401 round trip helps no one.
            if (!token) throw Object.assign(new Error('Not signed in'), { status: 401 });
            const init = {
                method,
                headers: {
                    'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
                    'Authorization': `MediaBrowser Token="${token}"`,
                    'X-Emby-Token': token,
                    'Accept': 'application/json',
                    ...headers,
                },
            };
            if (signal) init.signal = signal;
            if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
            const response = await fetch(ApiClient.getUrl(path), init);
            if (!response.ok) {
                throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
            }
            const text = await response.text();
            return text ? JSON.parse(text) : {};
        },
    };

    // ============================================================
    // One MutationObserver for every module. Subscribers with priority > 0
    // run synchronously with the mutation records; the rest run once after
    // the next paint with the batch. Attribute-only changes are ignored.
    // ============================================================

    const bodySubscribers = new Map();
    let bodyObserver = null;
    let pendingMutations = [];
    let flushScheduled = false;

    function flushMutations() {
        flushScheduled = false;
        const batch = pendingMutations;
        pendingMutations = [];
        if (batch.length === 0) return;
        for (const [id, sub] of bodySubscribers) {
            if (sub.priority > 0) continue;
            try { sub.callback(batch); } catch (err) { console.error(`${LOG} observer "${id}" failed`, err); }
        }
    }

    function ensureBodyObserver() {
        if (bodyObserver || !document.body) return;
        bodyObserver = new MutationObserver(mutations => {
            if (!mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) return;
            for (const [id, sub] of bodySubscribers) {
                if (sub.priority <= 0) continue;
                try { sub.callback(mutations); } catch (err) { console.error(`${LOG} observer "${id}" failed`, err); }
            }
            pendingMutations.push(...mutations);
            if (!flushScheduled) {
                flushScheduled = true;
                afterNextPaint(flushMutations);
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    JDM.dom = {
        afterNextPaint,
        /**
         * @param {string} id Unique subscriber id; registering it again replaces the callback.
         * @param {(mutations: MutationRecord[]) => void} callback
         * @param {{priority?: number}} [options]
         */
        onBodyMutation(id, callback, options) {
            const priority = options && typeof options.priority === 'number' ? options.priority : 0;
            bodySubscribers.set(id, { callback, priority });
            ensureBodyObserver();
        },
    };

    // ============================================================
    // Item lookups (type checks on cards and the item menu)
    // ============================================================

    const ITEM_TTL_MS = 60000;
    const itemCache = new Map();
    JDM.session.onUserChange('jdm-items', () => itemCache.clear());

    JDM.items = {
        /** @returns {Promise<any>} The item, shared across callers for a minute. */
        get(itemId) {
            const userId = ApiClient.getCurrentUserId();
            const key = `${userId}:${itemId}`;
            const hit = itemCache.get(key);
            if (hit && Date.now() - hit.at < ITEM_TTL_MS) return hit.promise;
            const promise = Promise.resolve(ApiClient.getItem(userId, itemId));
            itemCache.set(key, { at: Date.now(), promise });
            promise.catch(() => { if (itemCache.get(key) && itemCache.get(key).promise === promise) itemCache.delete(key); });
            return promise;
        },
    };

    // ============================================================
    // Toast: a polite live region, text only.
    // ============================================================

    let toastTimer = null;
    JDM.toast = function toast(plainText, durationMs = 3000) {
        let host = document.getElementById('jdm-toast');
        if (!host) {
            const style = document.createElement('style');
            style.textContent = '#jdm-toast{position:fixed;left:50%;bottom:5rem;transform:translateX(-50%);z-index:100000;'
                + 'max-width:min(90vw,32rem);padding:.7rem 1.1rem;border-radius:.4rem;background:rgba(20,20,20,.96);color:#fff;'
                + 'font-size:.95rem;box-shadow:0 .25rem 1rem rgba(0,0,0,.5);pointer-events:none}#jdm-toast[hidden]{display:none}';
            document.head.appendChild(style);
            host = document.createElement('div');
            host.id = 'jdm-toast';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            host.hidden = true;
            document.body.appendChild(host);
        }
        host.textContent = String(plainText);
        host.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { host.hidden = true; }, durationMs);
    };

    // ============================================================
    // Native action sheet (jellyfin-web item menu) helpers
    // ============================================================

    JDM.actionSheet = {
        /**
         * Newest visible action-sheet scroller. Jellyfin leaves dismissed sheets
         * in the DOM, so the first match can be stale.
         */
        getActiveScroller() {
            const scrollers = document.querySelectorAll('.actionSheetScroller');
            for (let i = scrollers.length - 1; i >= 0; i--) {
                if (/** @type {HTMLElement} */ (scrollers[i]).offsetParent !== null) return scrollers[i];
            }
            return scrollers.length ? scrollers[scrollers.length - 1] : null;
        },

        /**
         * A row that mirrors a sibling's classes so size, font and focus match the
         * current sheet. Parsed via innerHTML so is="emby-button" upgrades (ripple).
         * @param {Element} scroller
         * @param {{dataId: string, icon: string, text: string}} opts
         * @returns {HTMLElement}
         */
        buildItem(scroller, opts) {
            const ref = scroller.querySelector('.actionSheetMenuItem');
            const itemClass = (ref ? ref.getAttribute('class') : 'listItem listItem-button actionSheetMenuItem')
                .replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
            const tmp = document.createElement('div');
            tmp.innerHTML =
                `<button is="emby-button" type="button" class="${itemClass}" data-id="${opts.dataId}">`
                + `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${opts.icon}" aria-hidden="true"></span>`
                + '<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div>'
                + '</button>';
            const button = /** @type {HTMLElement} */ (tmp.firstElementChild);
            button.querySelector('.actionSheetItemText').textContent = opts.text;
            return button;
        },

        /**
         * Keeps an added row on one line and on screen: jellyfin-web sized and
         * positioned the sheet before the row existed, so a wider row can spill
         * past the right edge. Call after inserting the row.
         */
        fitItemToMenu(button, scroller) {
            try {
                const dlg = /** @type {HTMLElement|null} */ (scroller.closest('.dialog, .actionSheet'));
                const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
                if (!dlg || !viewportW) return;
                const left = parseFloat(dlg.style.left);
                if (!Number.isFinite(left)) return;
                const width = dlg.offsetWidth;
                if (width <= viewportW - 20) {
                    if (left + width > viewportW - 10) dlg.style.left = Math.max(10, viewportW - width - 10) + 'px';
                } else {
                    dlg.style.left = '10px';
                    button.style.maxWidth = (viewportW - 24) + 'px';
                    const text = /** @type {HTMLElement|null} */ (button.querySelector('.actionSheetItemText'));
                    if (text) text.style.whiteSpace = 'normal';
                }
            } catch (e) { /* leave native sizing */ }
        },

        /** Closes the open sheet with dialog.close() or Escape; synthetic mouse events would reopen it. */
        close() {
            try {
                let closed = false;
                for (const dlg of document.querySelectorAll('dialog[open]')) {
                    try { /** @type {HTMLDialogElement} */ (dlg).close(); closed = true; } catch (e) { /* not a real dialog */ }
                }
                if (closed) return true;
                const sheets = [...document.querySelectorAll('.actionSheet, .actionsheet, .dialogContainer .dialog, .dialog.opened')];
                const sheet = sheets.reverse().find(s => /** @type {HTMLElement} */ (s).offsetParent !== null) || sheets[0];
                if (sheet) {
                    sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
                }
                return true;
            } catch (err) {
                console.warn(`${LOG} action sheet close failed`, err);
                return false;
            }
        },
    };

    // ============================================================
    // Home-page native tab strip entry.
    //
    // jellyfin-web's tab strip is generic: a button in `.emby-tabs-slider` with
    // data-index N plus a `.tabContent.pageTabContent` panel at position N is all
    // it takes. On Jellyfin 12's experimental layout the tab button lives inside
    // the hidden legacy header, so a header-tray button that deep-links to
    // `#/home?tab=N` is added as a fallback.
    // ============================================================

    const tabEntries = [];
    let injectPending = false;
    let appliedDeepLink = null;

    function isOnHomePage() {
        const hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
    }

    function getTabAncestors(element) {
        const ancestors = [];
        for (let node = element; node; node = node.parentElement) {
            if (node.matches('.page, .tabContent')) ancestors.push(node);
        }
        return ancestors;
    }

    /** True when every enclosing page and tab is visible and active. */
    function isActiveTabContainer(element) {
        if (!element.isConnected) return false;
        const ancestors = getTabAncestors(element);
        for (const ancestor of ancestors) {
            if (ancestor.hidden || ancestor.classList.contains('hide')) return false;
            if (ancestor.classList.contains('tabContent') && !ancestor.classList.contains('is-active')) return false;
        }
        return ancestors.length > 0 || element.offsetParent !== null;
    }

    // Jellyfin can retain old Home pages while loading a replacement; only an active root counts.
    function getTabsRoot() {
        const panels = document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]');
        for (let i = panels.length - 1; i >= 0; i--) {
            const root = panels[i].parentElement;
            if (root && isActiveTabContainer(root)) return root;
        }
        return null;
    }

    // Other plugins claim indices the same way, so scan the live strip.
    function nextFreeIndex(slider) {
        let max = 1; // native Home(0) and Favorites(1)
        slider.querySelectorAll('[data-index]').forEach(el => {
            const idx = parseInt(el.getAttribute('data-index'), 10);
            if (!isNaN(idx) && idx > max) max = idx;
        });
        return max + 1;
    }

    /** The visible button tray in the page header, on the legacy and the Jellyfin 12 layouts. */
    function getHeaderTray() {
        const legacy = document.querySelector('.headerRight');
        if (legacy && /** @type {HTMLElement} */ (legacy).offsetParent !== null) return legacy;
        const userMenuButton = document.querySelector('[aria-controls="app-user-menu"]');
        const toolbar = (userMenuButton && userMenuButton.closest('.MuiToolbar-root')) || document.querySelector('.MuiAppBar-root .MuiToolbar-root');
        if (!toolbar) return null;
        let userMenuBox = userMenuButton;
        while (userMenuBox && userMenuBox.parentElement !== toolbar) userMenuBox = userMenuBox.parentElement;
        const tray = userMenuBox && userMenuBox.previousElementSibling;
        if (tray) return tray;
        let container = toolbar.querySelector(':scope > .headerRight');
        if (!container) {
            container = document.createElement('div');
            container.className = 'headerRight';
            toolbar.appendChild(container);
        }
        return container;
    }

    function ensureDiscoverable(entry) {
        const btn = document.getElementById('jdm-native-tab-btn-' + entry.id);
        const linkId = 'jdm-native-tab-link-' + entry.id;
        if (btn && btn.offsetParent !== null) {
            const stale = document.getElementById(linkId);
            if (stale) stale.remove();
            return;
        }
        if (document.getElementById(linkId)) return;
        const tray = getHeaderTray();
        if (!tray) return;
        const link = document.createElement('button');
        link.id = linkId;
        link.type = 'button';
        link.setAttribute('is', 'paper-icon-button-light');
        link.className = 'headerButton headerButtonRight paper-icon-button-light';
        link.title = entry.title;
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.textContent = entry.icon || 'tab';
        link.appendChild(icon);
        link.addEventListener('click', () => {
            const hash = window.location.hash;
            const base = hash.indexOf('#/home') === 0 ? hash.split('?')[0] : '#/home';
            window.location.hash = base + '?tab=' + entry.index;
        });
        tray.insertBefore(link, tray.firstChild);
    }

    // Consume a `?tab=N` deep link once per page; reapplying it on every mutation would undo a later click on Home.
    function syncDeepLink() {
        const match = /[?&]tab=(\d+)/.exec(window.location.hash);
        if (!match) return;
        const wanted = parseInt(match[1], 10);
        const entry = tabEntries.find(e => e.index === wanted);
        if (!entry) return;
        const btn = document.getElementById('jdm-native-tab-btn-' + entry.id);
        const panel = document.getElementById('jdm-native-tab-panel-' + entry.id);
        const tabs = /** @type {any} */ (document.querySelector('[is="emby-tabs"]'));
        const hash = window.location.hash;
        const root = panel && panel.parentElement;
        if (appliedDeepLink && appliedDeepLink.hash === hash && appliedDeepLink.root === root
            && appliedDeepLink.panel === panel && appliedDeepLink.tabs === tabs) return;
        if (btn && panel && tabs && tabs.selectedIndex
            && (tabs.selectedIndex() !== wanted || !panel.classList.contains('is-active'))) {
            tabs.selectedIndex(wanted);
        }
        if (panel && panel.classList.contains('is-active') && tabs && tabs.selectedIndex && tabs.selectedIndex() === wanted) {
            appliedDeepLink = { hash, root, panel, tabs };
        }
    }

    // Watch only the Home page and tab wrappers for class/hidden flips, not the whole document.
    const tabObserver = new MutationObserver(() => scheduleInject());
    let watchedTabs = new Set();
    function watchTabContainers() {
        const next = new Set();
        document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]').forEach(el => {
            getTabAncestors(el).forEach(ancestor => next.add(ancestor));
        });
        if (next.size === watchedTabs.size && [...next].every(el => watchedTabs.has(el))) return;
        tabObserver.disconnect();
        watchedTabs = next;
        next.forEach(el => tabObserver.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] }));
    }

    function ensureInjected() {
        if (tabEntries.length === 0) return;
        watchTabContainers();
        if (!isOnHomePage()) return;
        const slider = document.querySelector('.emby-tabs-slider');
        const root = getTabsRoot();
        if (!slider || !root) return;
        let addedButton = false;
        for (const entry of tabEntries) {
            // Cache the index: recomputing could desync an existing button from its panel.
            if (entry.index == null) entry.index = nextFreeIndex(slider);
            if (!document.getElementById('jdm-native-tab-btn-' + entry.id)) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('is', 'emby-button');
                btn.id = 'jdm-native-tab-btn-' + entry.id;
                btn.className = 'emby-tab-button';
                btn.setAttribute('data-index', String(entry.index));
                const label = document.createElement('div');
                label.className = 'emby-button-foreground';
                label.textContent = entry.title;
                btn.appendChild(label);
                slider.appendChild(btn);
                if (window.CustomElements && window.CustomElements.upgradeSubtree) window.CustomElements.upgradeSubtree(slider);
                addedButton = true;
            }
            let panel = document.getElementById('jdm-native-tab-panel-' + entry.id);
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'jdm-native-tab-panel-' + entry.id;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                entry.onMount(panel);
            } else if (panel.parentElement !== root) {
                panel.classList.remove('is-active');
                root.appendChild(panel);
            }
        }
        tabEntries.forEach(ensureDiscoverable);
        // The strip scroller caches tab widths at init; appending a button needs an explicit refresh.
        if (addedButton) {
            const tabs = /** @type {any} */ (document.querySelector('[is="emby-tabs"]'));
            if (tabs && tabs.refresh) tabs.refresh();
        }
        syncDeepLink();
    }

    function scheduleInject() {
        if (injectPending) return;
        injectPending = true;
        afterNextPaint(() => { injectPending = false; ensureInjected(); });
    }

    JDM.nativeTabs = {
        /**
         * Registers a Home-page tab; calling again with the same id is a no-op.
         * @param {string} id
         * @param {string} title
         * @param {(panel: HTMLElement) => void} onMount Called once with the new panel.
         * @param {string} [icon] Material icon for the header-tray fallback button.
         */
        register(id, title, onMount, icon) {
            if (tabEntries.some(e => e.id === id)) return;
            tabEntries.push({ id, title, onMount, icon, index: null });
            scheduleInject();
        },
    };

    JDM.dom.onBodyMutation('jdm-native-tabs', scheduleInject);
    JDM.navigation.onNavigate(() => { appliedDeepLink = null; scheduleInject(); });
    document.addEventListener('viewshow', scheduleInject);
})();
