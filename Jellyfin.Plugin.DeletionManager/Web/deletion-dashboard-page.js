// @ts-check
// Web/deletion-dashboard-page.js
//
// D.showDashboard / D.refreshDashboard — the standalone media-style dashboard
// page (My Requests | Pending | Approved | History). Uses a
// pushState + .mainAnimatedPages mount pattern adapted from Jellyfin
// Enhanced's library pages (see NOTICE.md). The route is NEVER
// assigned directly to the URL fragment; only history.pushState is used, so
// the router never renders fallbackPage over the dashboard.
//
// This file owns: page mount/show/hide, hashchange/popstate interception,
// the 150ms location watcher (for pushState navigations that don't fire
// hashchange), deep-link query parsing (?tab=&request=), and the 5s
// poll-while-open lifecycle. Tab content (tabs/toolbar/grid/states/
// banner) is rendered by renderDashboardBody, defined here and driven by
// D.refreshDashboard.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    const VALID_TABS = ['mine', 'pending', 'approved', 'history'];
    // Matches Plugin.Name — used to build
    // the execution-off banner's "Open plugin settings" link.
    const PLUGIN_NAME = 'Jellyfin Deletion Manager';

    const TAB_DEFS = [
        { key: 'mine', label: 'My Requests' },
        { key: 'pending', label: 'Pending' },
        { key: 'approved', label: 'Approved' },
        { key: 'history', label: 'History' },
    ];

    const EMPTY_COPY = {
        mine: { heading: 'No requests yet', body: 'Request deletion from any movie, series, season, or episode page.' },
        pending: { heading: 'No pending requests.', body: 'New requests from users will appear here.' },
        approved: { heading: 'Nothing approved yet', body: 'Approve a pending request to see it here with its countdown.' },
        history: { heading: 'No history yet', body: 'Executed, failed, and denied requests will appear here.' },
    };
    const MINE_HINT = 'Request deletion from any movie, series, season, or episode page.';

    // DOM references for the parts of the page that persist across renders
    // (notably dom.searchInput, whose value/focus/caret must survive every
    // poll-driven re-render).
    const dom = {
        heading: null,
        bannerHost: null,
        tabsHost: null,
        searchInput: null,
        filtersHost: null,
        gridHost: null,
        bulkHost: null,
        liveRegion: null,
    };

    const TABPANEL_ID = 'jdm-tabpanel';
    const tabId = key => `jdm-tab-${key}`;

    // Screen-reader announcements (one persistent polite live region; a
    // region created at announce time is often not read).
    const announceState = { timer: null, last: '' };

    /**
     * @param {string} message
     * @param {{force?: boolean}} [options] force: announce even if unchanged.
     */
    function announce(message, options) {
        const region = dom.liveRegion;
        if (!region || !message) return;
        if (!(options && options.force) && message === announceState.last) return;
        announceState.last = message;
        clearTimeout(announceState.timer);
        announceState.timer = setTimeout(() => {
            region.textContent = '';
            setTimeout(() => { region.textContent = message; }, 50);
        }, 400);
    }

    // Page/navigation state — distinct from D.state (the shared data/UI-filter
    // state every deletion surface reads), since this is purely about mount
    // lifecycle and is private to this file.
    const pageState = {
        visible: false,
        previousPage: null,
        locationTimer: null,
        locationSignature: null,
        mountTimer: null,
        pendingDrawerId: null,
        refreshing: false,
        lastSignature: null,
    };

    // ============================================================
    // Route matching
    // ============================================================

    function isRoute(hash) {
        if (typeof hash !== 'string') return false;
        if (hash === D.ROUTE) return true;
        return hash.startsWith(`${D.ROUTE}?`);
    }

    // ============================================================
    // Page mount
    // ============================================================

    function ensurePage() {
        let page = document.getElementById(D.PAGE_ID);
        if (!page) {
            page = document.createElement('div');
            page.id = D.PAGE_ID;
            page.className = 'page type-interior mainAnimatedPage hide';
            page.setAttribute('data-title', 'Deletion Requests');
            page.setAttribute('data-backbutton', 'true');
            page.setAttribute('data-url', D.ROUTE);
            page.setAttribute('data-type', 'custom');

            const contentWrapper = document.createElement('div');
            contentWrapper.setAttribute('data-role', 'content');

            const content = document.createElement('div');
            content.className = 'content-primary padded-left padded-right jdm-dashboard';
            contentWrapper.appendChild(content);
            page.appendChild(contentWrapper);

            const host = document.querySelector('.mainAnimatedPages');
            (host || document.body).appendChild(page);

            buildSkeleton(content);
        }
        return page;
    }

    /**
     * Builds the page's persistent structure once: heading, banner host, tab
     * strip host, toolbar (search input + filter/sort selects host), grid
     * host, bulk-action bar host. Only dom.tabsHost/filtersHost/gridHost/
     * bannerHost get rebuilt on every render; dom.searchInput is created
     * here and never recreated, so its value/focus/caret survive polling.
     * @param {HTMLElement} content
     */
    function buildSkeleton(content) {
        const liveRegion = document.createElement('div');
        liveRegion.className = 'jdm-sr-only';
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('aria-atomic', 'true');
        liveRegion.setAttribute('role', 'status');
        content.appendChild(liveRegion);
        dom.liveRegion = liveRegion;

        const heading = document.createElement('h1');
        heading.textContent = 'Deletion Requests';
        content.appendChild(heading);
        dom.heading = heading;

        const bannerHost = document.createElement('div');
        bannerHost.className = 'jdm-banner-host';
        content.appendChild(bannerHost);
        dom.bannerHost = bannerHost;

        const tabsHost = document.createElement('div');
        tabsHost.className = 'jdm-tabs-host';
        content.appendChild(tabsHost);
        dom.tabsHost = tabsHost;

        const toolbar = document.createElement('div');
        toolbar.className = 'jdm-toolbar';
        content.appendChild(toolbar);

        const searchWrap = document.createElement('div');
        searchWrap.className = 'jdm-toolbar-search';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.setAttribute('aria-label', 'Search requests');
        searchInput.placeholder = 'Search title, requester, or item ID';
        searchInput.className = 'emby-input jdm-search-input';
        searchInput.value = D.state.filters.query || '';
        searchInput.addEventListener('input', () => {
            D.state.filters.query = searchInput.value;
            renderGrid();
        });
        searchWrap.appendChild(searchInput);
        toolbar.appendChild(searchWrap);
        dom.searchInput = searchInput;

        const filtersHost = document.createElement('div');
        filtersHost.className = 'jdm-toolbar-filters';
        toolbar.appendChild(filtersHost);
        dom.filtersHost = filtersHost;

        const gridHost = document.createElement('div');
        gridHost.className = 'itemsContainer vertical-wrap jdm-grid';
        gridHost.setAttribute('role', 'tabpanel');
        gridHost.id = TABPANEL_ID;
        content.appendChild(gridHost);
        dom.gridHost = gridHost;

        const bulkHost = document.createElement('div');
        bulkHost.className = 'jdm-bulk-host';
        content.appendChild(bulkHost);
        dom.bulkHost = bulkHost;
    }

    // ============================================================
    // Location watcher — Jellyfin's router uses pushState, which does not
    // always fire hashchange/popstate. Poll signature every 150ms, same as
    // bookmarks-library-page.js and the prototype page before it.
    // ============================================================

    function startLocationWatcher() {
        if (pageState.locationTimer) return;
        pageState.locationSignature = `${window.location.pathname}${window.location.hash}`;
        pageState.locationTimer = setInterval(() => {
            const signature = `${window.location.pathname}${window.location.hash}`;
            if (signature === pageState.locationSignature) return;
            pageState.locationSignature = signature;
            if (isRoute(window.location.hash)) {
                showPage();
            } else if (pageState.visible) {
                hidePage();
            }
        }, 150);
    }

    function stopLocationWatcher() {
        if (pageState.locationTimer) clearInterval(pageState.locationTimer);
        pageState.locationTimer = null;
    }

    // ============================================================
    // Polling lifecycle — 5s while open and visible, plus focus/visibility
    // refresh. Cleared on hide so nothing polls while the page is not shown.
    // ============================================================

    function handleFocusRefresh() {
        if (pageState.visible) D.refreshDashboard();
    }

    function handleVisibilityRefresh() {
        if (pageState.visible && document.visibilityState === 'visible') D.refreshDashboard();
    }

    function startPolling() {
        stopPolling();
        D.state.pollTimer = setInterval(() => {
            // Hidden tabs skip the poll; visibilitychange refreshes on return.
            if (document.visibilityState === 'visible') D.refreshDashboard();
        }, D.POLL_MS);
        window.addEventListener('focus', handleFocusRefresh);
        document.addEventListener('visibilitychange', handleVisibilityRefresh);
    }

    function stopPolling() {
        if (D.state.pollTimer) {
            clearInterval(D.state.pollTimer);
            D.state.pollTimer = null;
        }
        window.removeEventListener('focus', handleFocusRefresh);
        document.removeEventListener('visibilitychange', handleVisibilityRefresh);
    }

    // ============================================================
    // Deep-link query parsing (?tab=&request=): tab only accepted
    // from the 4-key allow-list; request id only accepted as a positive
    // integer. The drawer load itself goes through the server's
    // requester-or-admin guard (D.api.get / D.api.audit), so an attacker-
    // supplied id just 403s there, never exposes another user's data here.
    // ============================================================

    function currentQuery() {
        const hash = window.location.hash || '';
        const qIndex = hash.indexOf('?');
        return new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1));
    }

    async function applyQueryState() {
        const query = currentQuery();
        const tabParam = query.get('tab');
        if (tabParam && VALID_TABS.indexOf(tabParam) !== -1) {
            D.state.activeTab = tabParam;
        } else if (!D.state.activeTab) {
            const isAdmin = await D.resolveIsAdmin();
            D.state.activeTab = isAdmin ? 'pending' : 'mine';
        }

        const requestParam = query.get('request');
        const parsedId = Number.parseInt(requestParam, 10);
        if (requestParam != null && Number.isInteger(parsedId) && parsedId > 0) {
            pageState.pendingDrawerId = parsedId;
        }
    }

    function openPendingDrawer() {
        if (pageState.pendingDrawerId == null) return;
        const id = pageState.pendingDrawerId;
        pageState.pendingDrawerId = null;
        if (typeof D.openDrawer === 'function') D.openDrawer(id);
    }

    // ============================================================
    // Show / hide
    // ============================================================

    async function showPage() {
        const hash = `${D.ROUTE}${window.location.hash.indexOf('?') !== -1 ? window.location.hash.slice(window.location.hash.indexOf('?')) : ''}`;
        if (!isRoute(window.location.hash)) {
            history.pushState({ page: 'deletion-requests' }, 'Deletion Requests', hash);
        }

        const page = ensurePage();
        const active = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${D.PAGE_ID})`);
        if (active) {
            pageState.previousPage = active;
            active.classList.add('hide');
            active.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'interior' } }));
        }

        if (!pageState.visible) {
            pageState.visible = true;
            page.classList.remove('hide');
            startLocationWatcher();
            startPolling();
            page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'custom', isRestored: false, options: {} } }));
        }

        await applyQueryState();
        await D.refreshDashboard();
        openPendingDrawer();
    }

    function hidePage() {
        if (!pageState.visible) return;
        pageState.visible = false;
        stopLocationWatcher();
        stopPolling();

        const page = document.getElementById(D.PAGE_ID);
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }

        const prev = pageState.previousPage;
        pageState.previousPage = null;
        if (prev && prev.id !== 'fallbackPage' && prev.isConnected
            && !document.querySelector(`.mainAnimatedPage:not(.hide):not(#${D.PAGE_ID})`)) {
            prev.classList.remove('hide');
            prev.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true } }));
        }
    }

    // ============================================================
    // D.showDashboard — public entry point (top-bar entry, home widget,
    // detail-page badge all call this instead of touching location.hash).
    // ============================================================

    async function showDashboard(options) {
        const opts = options || {};
        const params = new URLSearchParams();
        if (opts.tab && VALID_TABS.indexOf(opts.tab) !== -1) params.set('tab', opts.tab);
        if (opts.requestId) params.set('request', String(opts.requestId));
        const qs = params.toString();
        const hash = qs ? `${D.ROUTE}?${qs}` : D.ROUTE;
        if (window.location.hash !== hash) {
            history.pushState({ page: 'deletion-requests' }, 'Deletion Requests', hash);
        }
        await showPage();
    }

    // ============================================================
    // D.refreshDashboard — loads the list and re-renders. No-ops when the
    // page is hidden or a refresh is already in flight.
    // ============================================================

    async function refreshDashboard() {
        if (!pageState.visible) return;
        if (pageState.refreshing) return;
        pageState.refreshing = true;
        const identity = D.identityToken();
        try {
            const [requests] = await Promise.all([D.api.list(), refreshExecutionFlag()]);
            if (identity !== D.identityToken()) return;
            // Unchanged data: skip the rebuild so polls do not flash the grid. The
            // minute bucket still refreshes relative times ("Requested 5m ago").
            const signature = `${Math.floor(Date.now() / 60000)}|${D.state.isAdmin}|${D.state.executionEnabled}|${JSON.stringify(requests)}`;
            const unchanged = signature === pageState.lastSignature && !D.state.loadError;
            pageState.lastSignature = signature;
            D.state.requests = requests;
            D.state.loadError = null;
            if (unchanged) return;
        } catch (error) {
            if (identity !== D.identityToken()) return;
            D.state.loadError = error;
            pageState.lastSignature = null;
        } finally {
            if (identity === D.identityToken()) pageState.refreshing = false;
        }
        renderDashboardBody();
    }

    /**
     * Renders the dashboard's banner, tab strip, toolbar filter/sort
     * options, and grid into the page. Only these regions are rebuilt —
     * dom.searchInput is untouched, so its value/focus/caret survive every
     * poll-driven re-render.
     */
    async function renderDashboardBody() {
        if (!pageState.visible) return;
        const identity = D.identityToken();
        ensurePage();
        await D.resolveIsAdmin();
        if (!pageState.visible || identity !== D.identityToken()) return;
        const focus = captureFocus();
        renderBanner();
        renderTabs();
        renderToolbarFilters();
        renderGrid();
        restoreFocus(focus);
    }

    /**
     * Poll-driven re-renders rebuild tabs, selects, and cards; remember which
     * one had keyboard focus so it can be restored on the rebuilt node.
     * @returns {{kind: string, key?: string, id?: string, cls?: string, label?: string}|null}
     */
    function captureFocus() {
        const el = /** @type {HTMLElement|null} */ (document.activeElement);
        if (!el || !dom.gridHost) return null;
        const tab = dom.tabsHost && dom.tabsHost.contains(el) ? el.closest('[data-tab-key]') : null;
        if (tab) return { kind: 'tab', key: /** @type {HTMLElement} */ (tab).dataset.tabKey };
        if (dom.filtersHost && dom.filtersHost.contains(el) && el.tagName === 'SELECT') {
            const wrap = el.closest('.jdm-filter');
            const label = wrap ? wrap.querySelector('.jdm-filter-label') : null;
            return { kind: 'filter', label: label ? label.textContent || '' : '' };
        }
        const card = dom.gridHost.contains(el) ? el.closest('[data-request-id]') : null;
        if (card) {
            const cls = el.classList.contains('jdm-card-open') ? '.jdm-card-open'
                : el.closest('.jdm-card-select') ? '.jdm-card-select input'
                    : null;
            if (cls) return { kind: 'card', id: /** @type {HTMLElement} */ (card).dataset.requestId, cls };
        }
        return null;
    }

    function restoreFocus(focus) {
        if (!focus) return;
        let target = null;
        if (focus.kind === 'tab') {
            target = dom.tabsHost.querySelector(`[data-tab-key="${focus.key}"]`);
        } else if (focus.kind === 'filter') {
            const labels = Array.from(dom.filtersHost.querySelectorAll('.jdm-filter-label'));
            const match = labels.find(l => l.textContent === focus.label);
            target = match && match.parentElement ? match.parentElement.querySelector('select') : null;
        } else if (focus.kind === 'card') {
            const card = Array.from(dom.gridHost.querySelectorAll('[data-request-id]'))
                .find(c => /** @type {HTMLElement} */ (c).dataset.requestId === focus.id);
            target = card ? card.querySelector(focus.cls) : null;
        }
        if (target && target !== document.activeElement) /** @type {HTMLElement} */ (target).focus();
    }

    // ============================================================
    // Execution-off banner
    // ============================================================

    // Re-read the flag on every refresh so a settings save made after the
    // page loaded does not leave the banner stale.
    async function refreshExecutionFlag() {
        const identity = D.identityToken();
        await D.resolveIsAdmin();
        if (!D.state.isAdmin) return;
        try {
            const config = await D.api.config();
            if (identity === D.identityToken() && config && typeof config.DeletionExecutionEnabled === 'boolean') {
                D.state.executionEnabled = config.DeletionExecutionEnabled;
            }
        } catch (e) {
            // Keep the last known value; the banner is advisory only.
        }
    }

    function renderBanner() {
        dom.bannerHost.replaceChildren();
        if (!D.state.isAdmin) return;
        if (D.state.executionEnabled !== false) return;

        const banner = document.createElement('div');
        banner.className = 'jdm-exec-banner';
        banner.setAttribute('role', 'status');
        banner.appendChild(D.makeText('span', 'Physical deletion is OFF — approved requests will not run.'));
        const link = document.createElement('a');
        link.href = `#/configurationpage?name=${encodeURIComponent(PLUGIN_NAME)}`;
        link.textContent = 'Open plugin settings';
        banner.appendChild(link);
        dom.bannerHost.appendChild(banner);
    }

    // ============================================================
    // Tab membership and tab strip
    // ============================================================

    /**
     * @param {'mine'|'pending'|'approved'|'history'} key
     * @param {object[]} requests
     * @param {*} currentUserId
     * @returns {object[]}
     */
    function tabMembers(key, requests, currentUserId) {
        return requests.filter(req => {
            if (key === 'mine') return D.normalizeId(req.RequesterId) === D.normalizeId(currentUserId);
            if (key === 'pending') return req.Status === 'Pending';
            if (key === 'approved') return req.Status === 'Approved';
            if (key === 'history') return D.HISTORY_STATUSES.indexOf(req.Status) !== -1;
            return false;
        });
    }

    function selectTab(key) {
        if (D.state.activeTab === key) return;
        D.state.activeTab = key;
        D.state.selectedIds.clear();
        const params = new URLSearchParams();
        params.set('tab', key);
        const hash = `${D.ROUTE}?${params.toString()}`;
        if (window.location.hash !== hash) {
            history.replaceState(history.state, '', hash);
        }
        renderDashboardBody();
    }

    function renderTabs() {
        dom.tabsHost.replaceChildren();

        const strip = document.createElement('div');
        strip.className = 'jdm-tabs';
        strip.setAttribute('role', 'tablist');

        const requests = Array.isArray(D.state.requests) ? D.state.requests : [];
        const currentUserId = D.currentUserId();
        const buttons = [];

        TAB_DEFS.forEach(def => {
            const members = tabMembers(def.key, requests, currentUserId);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'emby-tab-button jdm-tab-button';
            button.setAttribute('role', 'tab');
            button.id = tabId(def.key);
            button.setAttribute('aria-controls', TABPANEL_ID);
            button.dataset.tabKey = def.key;
            const selected = D.state.activeTab === def.key;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (selected) button.classList.add('emby-tab-button-active');
            button.setAttribute('tabindex', selected ? '0' : '-1');
            button.appendChild(D.makeText('span', `${def.label} (${members.length})`));
            button.addEventListener('click', () => selectTab(def.key));
            strip.appendChild(button);
            buttons.push({ key: def.key, button });
        });

        strip.addEventListener('keydown', event => {
            const currentIndex = buttons.findIndex(entry => entry.button.getAttribute('aria-selected') === 'true');
            let nextIndex = -1;
            if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
            else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = buttons.length - 1;
            if (nextIndex === -1) return;
            event.preventDefault();
            const nextKey = buttons[nextIndex].key;
            selectTab(nextKey);
            setTimeout(() => {
                const target = dom.tabsHost.querySelector(`[data-tab-key="${nextKey}"]`);
                if (target) /** @type {HTMLElement} */ (target).focus();
            }, 0);
        });

        dom.tabsHost.appendChild(strip);
        dom.gridHost.setAttribute('aria-labelledby', tabId(D.state.activeTab || 'mine'));
    }

    // ============================================================
    // Toolbar: search (persistent, see buildSkeleton) + filter/sort selects
    // ============================================================

    function distinctValues(requests, field) {
        const values = new Set();
        requests.forEach(req => {
            const value = req[field];
            if (value) values.add(value);
        });
        return Array.from(values).sort((a, b) => String(a).localeCompare(String(b)));
    }

    function buildSelect(labelText, options, currentValue, onChange) {
        const wrap = document.createElement('label');
        wrap.className = 'jdm-filter';
        wrap.appendChild(D.makeText('span', labelText, 'jdm-filter-label'));
        const select = document.createElement('select');
        select.setAttribute('is', 'emby-select');
        select.className = 'emby-select-withcolor emby-select';
        options.forEach(opt => {
            const optionEl = document.createElement('option');
            optionEl.value = opt.value;
            optionEl.textContent = opt.label;
            select.appendChild(optionEl);
        });
        select.value = currentValue || '';
        select.addEventListener('change', () => onChange(select.value));
        wrap.appendChild(select);
        return wrap;
    }

    const SORT_OPTIONS = [
        { value: 'newest', label: 'Newest request' },
        { value: 'execution', label: 'Execution time' },
        { value: 'title', label: 'Title' },
        { value: 'status', label: 'Status' },
    ];

    function renderToolbarFilters() {
        dom.filtersHost.replaceChildren();
        const requests = Array.isArray(D.state.requests) ? D.state.requests : [];
        const plain = values => values.map(value => ({ value, label: value }));
        const filter = (label, key, allLabel, options) => ({
            label,
            options: [{ value: '', label: allLabel }].concat(options),
            get: () => D.state.filters[key],
            set: value => { D.state.filters[key] = value; },
        });

        const selects = [
            filter('Status', 'status', 'All statuses',
                Object.keys(D.STATUS_BADGES).map(key => ({ value: key, label: D.STATUS_BADGES[key].label }))),
            filter('Scope', 'scope', 'All scopes', plain(['Movie', 'Series', 'Season', 'Episode'])),
            D.state.isAdmin ? filter('Requester', 'requester', 'All requesters', plain(distinctValues(requests, 'RequesterName'))) : null,
            filter('Source', 'source', 'All sources', plain(distinctValues(requests, 'Source'))),
            filter('Timing', 'timing', 'All timings',
                [{ value: 'none', label: 'No timing' }].concat(D.TIMINGS.map(t => ({ value: t.wire, label: t.label })))),
            { label: 'Sort', options: SORT_OPTIONS, get: () => D.state.sort, set: value => { D.state.sort = value; } },
        ];

        selects.forEach(def => {
            if (!def) return;
            dom.filtersHost.appendChild(buildSelect(def.label, def.options, def.get(), value => {
                def.set(value);
                renderGrid();
            }));
        });
    }

    // ============================================================
    // Filtering + sorting
    // ============================================================

    function filterAndSort(members) {
        const filters = D.state.filters;
        const query = String(filters.query || '').trim().toLowerCase();

        let rows = members.filter(req => {
            if (query) {
                const idNoDash = String(req.JellyfinItemId || '').replace(/-/g, '');
                const haystack = [req.ItemName, req.RequesterName, req.JellyfinItemId, idNoDash, String(req.Id)]
                    .map(value => String(value || '').toLowerCase());
                if (!haystack.some(value => value.indexOf(query) !== -1)) return false;
            }
            if (filters.status && D.displayStatus(req) !== filters.status) return false;
            if (filters.scope && req.ItemType !== filters.scope) return false;
            if (filters.requester && req.RequesterName !== filters.requester) return false;
            if (filters.source && req.Source !== filters.source) return false;
            if (filters.timing) {
                if (filters.timing === 'none') {
                    if (req.Timing) return false;
                } else if (req.Timing !== filters.timing) {
                    return false;
                }
            }
            return true;
        });

        const sort = D.state.sort;
        rows = rows.slice().sort((a, b) => {
            if (sort === 'execution') {
                const aTime = a.ExecuteAt ? new Date(a.ExecuteAt).getTime() : Infinity;
                const bTime = b.ExecuteAt ? new Date(b.ExecuteAt).getTime() : Infinity;
                return aTime - bTime;
            }
            if (sort === 'title') {
                return String(a.ItemName || '').localeCompare(String(b.ItemName || ''));
            }
            if (sort === 'status') {
                const statusCompare = D.displayStatus(a).localeCompare(D.displayStatus(b));
                if (statusCompare !== 0) return statusCompare;
                return new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime();
            }
            return new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime();
        });

        return rows;
    }

    // ============================================================
    // Grid + empty/error states
    // ============================================================

    function renderErrorState() {
        dom.gridHost.appendChild(D.stateCard({
            heading: "Couldn't load requests",
            lines: [D.errorMessage(D.state.loadError)],
            action: { text: 'Retry', onClick: () => D.refreshDashboard() },
            alert: true,
        }));
    }

    function renderEmptyState(tabKey) {
        const copy = EMPTY_COPY[tabKey] || EMPTY_COPY.mine;
        const lines = [copy.body];
        if (tabKey !== 'mine' && !D.state.isAdmin && copy.body !== MINE_HINT) lines.push(MINE_HINT);
        dom.gridHost.appendChild(D.stateCard({ heading: copy.heading, lines }));
    }

    function renderFilteredEmptyState() {
        dom.gridHost.appendChild(D.stateCard({
            heading: 'No requests match these filters.',
            action: {
                text: 'Clear filters',
                onClick: () => {
                    D.state.filters = { query: '', status: '', scope: '', requester: '', source: '', timing: '' };
                    if (dom.searchInput) dom.searchInput.value = '';
                    renderDashboardBody();
                },
            },
        }));
    }

    function renderBulkHost() {
        if (typeof D.renderBulkBar === 'function') D.renderBulkBar(dom.bulkHost);
    }

    function renderGrid() {
        dom.gridHost.replaceChildren();

        if (D.state.loadError) {
            renderErrorState();
            renderBulkHost();
            return;
        }

        const requests = Array.isArray(D.state.requests) ? D.state.requests : [];
        const currentUserId = D.currentUserId();
        const tabKey = D.state.activeTab || 'mine';
        const members = tabMembers(tabKey, requests, currentUserId);

        // Prune selections that are no longer pending (e.g. approved/denied
        // by another admin between polls) before every render.
        const pendingIds = new Set(tabMembers('pending', requests, currentUserId).map(req => req.Id));
        Array.from(D.state.selectedIds).forEach(id => {
            if (!pendingIds.has(id)) D.state.selectedIds.delete(id);
        });

        if (members.length === 0) {
            renderEmptyState(tabKey);
            renderBulkHost();
            announce('0 requests loaded');
            return;
        }

        const rows = filterAndSort(members);

        if (rows.length === 0) {
            renderFilteredEmptyState();
            renderBulkHost();
            announce('No requests match these filters.');
            return;
        }

        const isAdmin = !!D.state.isAdmin;
        rows.forEach(req => {
            const card = D.createRequestCard(req, {
                isAdmin,
                selectable: isAdmin && tabKey === 'pending',
                selected: D.state.selectedIds.has(req.Id),
                onOpen: (id, anchor) => {
                    if (typeof D.openRequestMenu === 'function') D.openRequestMenu(req, anchor);
                    else if (typeof D.openDrawer === 'function') D.openDrawer(id);
                },
                onToggleSelect: (id, on) => {
                    if (on) D.state.selectedIds.add(id); else D.state.selectedIds.delete(id);
                    renderBulkHost();
                    announce(`${D.state.selectedIds.size} selected`, { force: true });
                },
            });
            if (isAdmin && tabKey === 'pending' && typeof D.renderQuickActions === 'function') {
                const actionsEl = card.querySelector('.jdm-card-actions');
                if (actionsEl) D.renderQuickActions(actionsEl, req);
            }
            dom.gridHost.appendChild(card);
        });

        renderBulkHost();
        announce(`${rows.length} request${rows.length === 1 ? '' : 's'} loaded`);
    }

    Object.assign(D, { showDashboard, refreshDashboard, announce });
    JDM.session.onUserChange('deletion-dashboard', () => {
        hidePage();
        clearTimeout(pageState.mountTimer);
        pageState.refreshing = false;
        pageState.pendingDrawerId = null;
        const page = document.getElementById(D.PAGE_ID);
        if (page) page.remove();
        Object.keys(dom).forEach(key => { dom[key] = null; });
    });

    // ============================================================
    // Navigation interception — capture phase so we see our route before
    // Jellyfin's router reacts (never let it render fallbackPage over us).
    // ============================================================

    function interceptNavigation(event) {
        // A Back press while a deletion modal/drawer is open (or the popstate
        // from a modal's own history.back()) belongs to the modal, not the
        // page. deletion-modal.js normally consumes it first (its capture
        // listener is registered earlier); this guard covers any load-order
        // change so the event is never swallowed before the modal sees it.
        if (event && event.type === 'popstate' && typeof D.handleModalPopstate === 'function'
            && D.handleModalPopstate(/** @type {PopStateEvent} */ (event))) {
            return;
        }
        const hash = event && event.newURL ? new URL(event.newURL).hash : window.location.hash;
        if (!isRoute(hash)) {
            if (pageState.visible) hidePage();
            return;
        }
        if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        showPage();
    }

    window.addEventListener('hashchange', interceptNavigation, true);
    window.addEventListener('popstate', interceptNavigation, true);

    document.addEventListener('viewshow', event => {
        const target = /** @type {HTMLElement|null} */ (event.target);
        if (pageState.visible && target && target.id !== D.PAGE_ID && target.id !== 'fallbackPage') hidePage();
    });

    // ============================================================
    // Initial mount — handles a direct load/reload of #/deletion-requests
    // (mainAnimatedPages may not exist yet at script-eval time) and any
    // route change JDM.navigation.onNavigate observes (pushState,
    // replaceState, hashchange, popstate — deduplicated).
    // ============================================================

    function schedule() {
        clearTimeout(pageState.mountTimer);
        pageState.mountTimer = setTimeout(() => {
            if (isRoute(window.location.hash)) {
                showPage();
            } else if (pageState.visible) {
                hidePage();
            }
        }, 150);
    }

    JDM.navigation.onNavigate(schedule);
    schedule();

})();
