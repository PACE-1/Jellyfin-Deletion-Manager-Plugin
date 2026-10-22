// @ts-check
// Web/deletion-state.js
//
// Shared namespace + contract for every deletion UI surface (dashboard,
// detail-page control, top-bar entry, modal, cards). Defines JDM.deletion
// (referred to as `D` in the phase plans): constants, state, API wrappers, the
// admin gate, and status/timing/countdown helpers. The other deletion modules
// build on this contract; createModal/confirmDialog live in
// deletion-modal.js and createRequestCard lives in deletion-cards.js — both
// siblings load after this file and Object.assign onto the same `D`.
//
// Wire fields are PascalCase (Model/DeletionRequest.cs) and are read directly
// here with no camelCase transform layer.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    // ============================================================
    // Constants
    // ============================================================

    const ROUTE = '#/deletion-requests';
    const PAGE_ID = 'jdm-dashboard-page';
    const REASON_MAX = 2000;
    const MAX_BULK = 100;
    const POLL_MS = 5000;
    const ACTIVE_STATUSES = ['Pending', 'Approved'];
    const HISTORY_STATUSES = ['Executed', 'Failed', 'Denied', 'Blocked', 'Cancelled'];

    const TIMINGS = [
        { key: 'immediate', label: 'Now', wire: 'Immediate' },
        { key: '1w', label: '1 week', wire: 'OneWeek' },
        { key: '2w', label: '2 weeks', wire: 'TwoWeeks' },
        { key: '1mo', label: '1 month', wire: 'OneMonth' },
    ];

    const STATUS_BADGES = {
        Pending: { label: 'Pending', className: 'jdm-badge-neutral' },
        Approved: { label: 'Approved', className: 'jdm-badge-accent' },
        Requeued: { label: 'Requeued', className: 'jdm-badge-warning' },
        Blocked: { label: 'Blocked', className: 'jdm-badge-warning' },
        Denied: { label: 'Denied', className: 'jdm-badge-destructive jdm-badge-muted' },
        Executed: { label: 'Executed', className: 'jdm-badge-success' },
        Failed: { label: 'Failed', className: 'jdm-badge-destructive' },
        Cancelled: { label: 'Cancelled', className: 'jdm-badge-neutral jdm-badge-muted' },
    };

    // ============================================================
    // State
    // ============================================================

    const state = {
        isAdmin: null,
        executionEnabled: null,
        userId: null,
        requests: [],
        loadError: null,
        activeTab: null,
        filters: { query: '', status: '', scope: '', requester: '', source: '', timing: '' },
        sort: 'newest',
        selectedIds: new Set(),
        pollTimer: null,
    };
    let identityVersion = 0;
    const pendingRequests = new Set();

    function identityToken() {
        return `${identityVersion}:${normalizeId(currentUserId())}:${JDM.session.getEpoch()}`;
    }

    async function request(path, options = {}) {
        const identity = identityToken();
        const controller = new AbortController();
        pendingRequests.add(controller);
        try {
            const result = await JDM.api.jf(path, { ...options, signal: controller.signal });
            if (identity !== identityToken()) throw Object.assign(new Error('Account changed'), { name: 'AbortError' });
            return result;
        } finally {
            pendingRequests.delete(controller);
        }
    }

    JDM.session.onUserChange('deletion-state', () => {
        identityVersion++;
        pendingRequests.forEach(controller => controller.abort());
        pendingRequests.clear();
        if (state.pollTimer) clearInterval(state.pollTimer);
        Object.assign(state, {
            isAdmin: null, executionEnabled: null, userId: null, requests: [], loadError: null, activeTab: null,
            filters: { query: '', status: '', scope: '', requester: '', source: '', timing: '' },
            sort: 'newest', selectedIds: new Set(), pollTimer: null,
        });
    });

    // ============================================================
    // API wrappers — all via JDM.api.jf, all return Promises
    // ============================================================

    /**
     * Appends a cache-busting query param so GETs bypass coreFetch's response
     * cache/dedup (no cacheKey option is passed, so this is defense in depth —
     * without a cacheKey coreFetch never caches — but keeps every list()/get()/
     * audit() call visibly fresh for the 5s poll).
     * @param {string} path
     * @returns {string}
     */
    function freshPath(path) {
        const sep = path.indexOf('?') === -1 ? '?' : '&';
        return `${path}${sep}_=${Date.now()}`;
    }

    function list() {
        return request(freshPath('/DeletionManager/Requests'));
    }

    function get(id) {
        return request(freshPath(`/DeletionManager/Requests/${id}`));
    }

    function audit(id) {
        return request(freshPath(`/DeletionManager/Requests/${id}/audit`));
    }

    function scope(itemId, itemType) {
        const params = new URLSearchParams({ itemId, itemType });
        return request(freshPath(`/DeletionManager/Requests/scope?${params}`));
    }

    function post(path, body) {
        return request(`/DeletionManager/Requests${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    const submit = ({ itemId, itemType, expectedItemCount, expectedItemIds, reason }) => post('', { itemId, itemType, expectedItemCount, expectedItemIds, reason });
    const approve = (id, timingKey) => post(`/${id}/approve`, { timing: timingKey });
    const deny = (id, reason) => post(`/${id}/deny`, { reason });
    const cancel = (id, reason) => post(`/${id}/cancel`, { reason });
    const bulkApprove = (ids, timingKey) => post('/bulk/approve', { ids, timing: timingKey });
    const bulkDeny = (ids, reason) => post('/bulk/deny', { ids, reason });

    const cardStatus = () => request(freshPath('/DeletionManager/Requests/card-status'));
    const config = () => request(freshPath('/DeletionManager/Config'));
    const api = { list, get, audit, scope, submit, approve, deny, cancel, bulkApprove, bulkDeny, cardStatus, config };

    // ============================================================
    // Admin gate (UX only — server re-checks every mutation)
    // ============================================================

    /**
     * Resolves and caches permissions for the current identity. Boot-time
     * settings may still belong to the previous account during a SPA switch.
     * @returns {Promise<boolean>}
     */
    async function resolveIsAdmin() {
        const userId = normalizeId(currentUserId());
        if (state.userId === userId && state.isAdmin !== null) return state.isAdmin;
        const identity = identityToken();
        try {
            const user = await ApiClient.getCurrentUser();
            if (identity !== identityToken()) return false;
            state.userId = userId;
            state.isAdmin = !!(user && user.Policy && user.Policy.IsAdministrator);
            return state.isAdmin;
        } catch (e) {
            // Transient failure: do NOT cache false, so a later call retries
            // instead of permanently disabling admin-only UI for an actual admin.
            return false;
        }
    }

    function currentUserId() {
        return ApiClient.getCurrentUserId();
    }

    // ============================================================
    // Id normalization
    // ============================================================

    /**
     * Jellyfin item/user ids arrive from the client without dashes; the plugin
     * API serializes Guids with dashes. Always compare ids through this.
     * @param {*} guid
     * @returns {string}
     */
    function normalizeId(guid) {
        return String(guid || '').replace(/-/g, '').toLowerCase();
    }

    // ============================================================
    // Status derivation
    // ============================================================

    /**
     * @param {object} request A DeletionRequest, PascalCase fields.
     * @returns {'Pending'|'Approved'|'Requeued'|'Blocked'|'Denied'|'Executed'|'Failed'|'Cancelled'}
     */
    function displayStatus(request) {
        if (request && request.Status === 'Approved' && typeof request.FailureReason === 'string' && request.FailureReason.length > 0) {
            return 'Requeued';
        }
        return request ? request.Status : 'Pending';
    }

    // ============================================================
    // Timing / scope labels
    // ============================================================

    function timingLabel(wireValue) {
        const match = TIMINGS.find(t => t.wire === wireValue);
        return match ? match.label : '';
    }

    function scopeLabel(itemType) {
        switch (String(itemType || '').toLowerCase()) {
            case 'movie': return 'Movie';
            case 'series': return 'Series';
            case 'season': return 'Season';
            case 'episode': return 'Episode';
            default: return String(itemType || '');
        }
    }

    // ============================================================
    // Duration / countdown / date formatting
    // ============================================================

    /**
     * @param {number} ms
     * @returns {string} '6d 4h' | '3h 12m' | '5m'
     */
    function formatDuration(ms) {
        const totalMinutes = Math.floor(Math.abs(ms) / 60000);
        const days = Math.floor(totalMinutes / (60 * 24));
        const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
        const minutes = totalMinutes % 60;
        if (days >= 1) return `${days}d ${hours}h`;
        if (hours >= 1) return `${hours}h ${minutes}m`;
        return `${Math.max(1, minutes)}m`;
    }

    /**
     * @param {object} request
     * @returns {string|null} 'Deletes in 6d 4h' | 'Due now' | null (not approved/requeued or no ExecuteAt)
     */
    function countdownText(request) {
        if (!request || !request.ExecuteAt) return null;
        const status = displayStatus(request);
        if (status !== 'Approved' && status !== 'Requeued') return null;
        const executeAt = new Date(request.ExecuteAt).getTime();
        if (Number.isNaN(executeAt)) return null;
        const diff = executeAt - Date.now();
        if (diff <= 0) return 'Due now';
        return `Deletes in ${formatDuration(diff)}`;
    }

    function formatExact(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString();
    }

    function formatAgo(iso) {
        if (!iso) return '';
        const then = new Date(iso).getTime();
        if (Number.isNaN(then)) return '';
        const diff = Date.now() - then;
        if (diff < 0) return 'just now';
        const minutes = Math.floor(diff / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    // ============================================================
    // Poster URL
    // ============================================================

    function posterUrl(jellyfinItemId, maxWidth) {
        return ApiClient.getImageUrl(jellyfinItemId, { type: 'Primary', maxWidth });
    }

    // Copy kept when the item was deleted. Images cannot send auth headers, so the token goes in the query.
    function archivedPosterUrl(requestId) {
        const token = ApiClient.accessToken();
        if (!requestId || !token) return null;
        return `${ApiClient.getUrl(`DeletionManager/Requests/${requestId}/poster`)}?api_key=${encodeURIComponent(token)}`;
    }

    // Tries each URL in order and calls onFound with the first that loads, or onNone when all fail.
    function loadFirstImage(urls, onFound, onNone) {
        const [url, ...rest] = urls.filter(Boolean);
        if (!url) { onNone(); return; }
        const probe = new Image();
        probe.onload = () => onFound(url);
        probe.onerror = () => loadFirstImage(rest, onFound, onNone);
        probe.src = url;
    }

    // ============================================================
    // Error message
    // ============================================================

    /**
     * @param {*} error An Error thrown by JDM.api.jf, which
     *   attaches `.status` for HTTP failures and has no `.status` for a
     *   network-level failure (TypeError from fetch itself).
     * @returns {string} Plain text for the error-state card.
     */
    function errorMessage(error) {
        const status = error && error.status;
        if (status === 401 || status === 403) return "You don't have permission to view this.";
        if (!status) return 'The server did not respond.';
        return `The server returned an error (HTTP ${status}).`;
    }

    // ============================================================
    // DOM / toast helpers
    // ============================================================

    function makeText(tagName, text, className) {
        const el = document.createElement(tagName);
        if (className) el.className = className;
        el.textContent = text == null ? '' : String(text);
        return el;
    }

    /**
     * Empty/error message card shared by the dashboard grid and the drawer.
     * @param {{heading: string, lines?: string[], action?: {text: string, onClick: Function}, alert?: boolean}} opts
     * @returns {HTMLElement}
     */
    function stateCard({ heading, lines = [], action, alert }) {
        const card = document.createElement('div');
        card.className = 'jdm-state-card';
        if (alert) card.setAttribute('role', 'alert');
        card.appendChild(makeText('div', heading, 'jdm-state-card-heading'));
        lines.forEach(line => card.appendChild(makeText('div', line, 'jdm-state-card-body')));
        if (action) {
            const button = makeText('button', action.text, 'raised jdm-state-card-action');
            button.type = 'button';
            button.setAttribute('is', 'emby-button');
            button.addEventListener('click', () => action.onClick());
            card.appendChild(button);
        }
        return card;
    }

    function toast(plainText) {
        JDM.toast(plainText);
    }

    // ============================================================
    // Export
    // ============================================================

    Object.assign(D, {
        ROUTE,
        PAGE_ID,
        REASON_MAX,
        MAX_BULK,
        POLL_MS,
        ACTIVE_STATUSES,
        HISTORY_STATUSES,
        TIMINGS,
        STATUS_BADGES,
        state,
        identityToken,
        api,
        resolveIsAdmin,
        currentUserId,
        normalizeId,
        displayStatus,
        timingLabel,
        scopeLabel,
        formatDuration,
        countdownText,
        formatExact,
        formatAgo,
        posterUrl,
        archivedPosterUrl,
        loadFirstImage,
        errorMessage,
        makeText,
        stateCard,
        toast,
    });

})();
