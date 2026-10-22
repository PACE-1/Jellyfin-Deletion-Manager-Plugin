// @ts-check
// Web/deletion-dashboard-actions.js
//
// Admin decision UX for the deletion dashboard: approve with timing
// chips (Now needs a second confirmation), deny with an optional reason,
// cancel an approved not-yet-due request, card quick actions,
// the request detail drawer with its audit timeline, and the bulk
// action bar. Fills the late-bound slots deletion-dashboard-page.js
// calls: D.renderQuickActions, D.openDrawer, D.renderBulkBar.
//
// Every DOM node is built with createElement/textContent — request names and
// reasons are user-controlled. Client-side admin gating is UX only;
// the server enforces every mutation.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    const LOG_PREFIX = 'Jellyfin Deletion Manager: Deletion Actions:';

    let fieldSeq = 0;

    // ============================================================
    // Shared helpers
    // ============================================================

    /**
     * Refreshes the dashboard list and the top-bar badge after any action.
     * @returns {Promise<void>}
     */
    async function afterAction() {
        try {
            if (typeof D.refreshDashboard === 'function') await D.refreshDashboard();
        } catch (err) {
            console.error(LOG_PREFIX, 'refreshDashboard failed:', err);
        }
        if (typeof D.refreshBadge === 'function') {
            try { D.refreshBadge(); } catch (err) { console.error(LOG_PREFIX, 'refreshBadge failed:', err); }
        }
    }

    /**
     * Announces an action result to screen readers (the toast alone is not
     * guaranteed to be in a live region).
     * @param {string} message
     */
    function announceResult(message) {
        if (typeof D.announce === 'function') D.announce(message, { force: true });
    }

    /**
     * Plain-text message for a failed mutation.
     * @param {*} error
     * @returns {string}
     */
    function actionErrorText(error) {
        const status = error && error.status;
        if (status === 409) return 'This request changed. Refreshing.';
        if (status === 403) return "You don't have permission to do that.";
        return 'Action failed. Try again.';
    }

    /**
     * Toasts a failed mutation. A 409 means another admin (or the executor)
     * changed the request — refresh instead of keeping stale state.
     * @param {*} error
     */
    function actionError(error) {
        console.error(LOG_PREFIX, 'action failed:', error);
        D.toast(actionErrorText(error));
        announceResult(actionErrorText(error));
        if (error && error.status === 409) afterAction();
    }

    /**
     * @param {object} request
     * @returns {number}
     */
    function itemCountOf(request) {
        const n = Number(request && request.ItemCount);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    /**
     * Shared disable/enable guard for a group of buttons so only one action
     * runs at a time from a given surface.
     */
    function createLock() {
        const buttons = [];
        let busy = false;
        return {
            add(button) { buttons.push(button); return button; },
            isBusy() { return busy; },
            async run(fn) {
                if (busy) return undefined;
                busy = true;
                buttons.forEach(b => { b.disabled = true; });
                try {
                    return await fn();
                } finally {
                    busy = false;
                    buttons.forEach(b => { b.disabled = false; });
                }
            },
        };
    }

    /**
     * Navigates to an in-app route like "#/details?id=..." through Jellyfin's
     * router (same fallback chain as features-random-button.js) instead of
     * assigning the URL fragment directly.
     * @param {string} href
     */
    function navigateToHref(href) {
        const route = String(href || '').replace(/^#!?/, '');
        if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === 'function') {
            window.Emby.Page.show(route);
        } else if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
            window.Dashboard.navigate(route.replace(/^\//, ''));
        } else {
            window.location.assign(href);
        }
    }

    // ============================================================
    // Single-request actions
    // ============================================================

    /**
     * Approves a pending request. "Now" requires a second confirmation.
     * @param {object} request
     * @param {string} timingKey One of D.TIMINGS[].key.
     * @returns {Promise<boolean>} true on success.
     */
    async function approveRequest(request, timingKey) {
        if (!request) return false;
        if (timingKey === 'immediate') {
            const confirmed = await D.confirmDialog({
                title: 'Delete now?',
                message: `Delete ${itemCountOf(request)} item(s) immediately? This cannot be undone.`,
                confirmText: 'Delete Now',
                cancelText: 'Keep as Pending',
                destructive: true,
            });
            if (!confirmed) return false;
        }
        try {
            await D.api.approve(request.Id, timingKey);
        } catch (error) {
            actionError(error);
            return false;
        }
        D.toast(`Approved: ${request.ItemName}`);
        announceResult(`Approved: ${request.ItemName}`);
        await afterAction();
        return true;
    }

    /**
     * Builds the optional reason field used by single and bulk deny.
     * @returns {{ body: HTMLElement, textarea: HTMLTextAreaElement }}
     */
    function buildDenyReasonField() {
        const fieldId = `jdm-deny-reason-${++fieldSeq}`;
        const wrap = document.createElement('div');

        const label = D.makeText('label', 'Reason for denial (optional)', 'jdm-confirm-label');
        label.htmlFor = fieldId;
        wrap.appendChild(label);

        const textarea = document.createElement('textarea');
        textarea.id = fieldId;
        textarea.className = 'emby-textarea jdm-deny-reason';
        textarea.maxLength = D.REASON_MAX;
        textarea.rows = 4;
        textarea.placeholder = 'Reason for denial (optional)';
        wrap.appendChild(textarea);

        return { body: wrap, textarea };
    }

    /**
     * Opens a deny dialog. No second confirmation (only "Now" needs one).
     * @param {object} options
     * @param {string} options.title
     * @param {string} [options.subtitle]
     * @param {string} options.primaryText
     * @param {(reason: string|null) => Promise<*>} options.submit
     * @param {(result: *) => void} options.onSuccess
     * @returns {Promise<boolean>} Resolves when the dialog closes; true if submitted.
     */
    function openDenyDialog({ title, subtitle, primaryText, submit, onSuccess }) {
        return new Promise(resolve => {
            let succeeded = false;
            const { body, textarea } = buildDenyReasonField();
            const modal = D.createModal({
                title,
                subtitle,
                body,
                primaryText,
                primaryVariant: 'destructive',
                secondaryText: 'Keep as Pending',
                variant: 'dialog',
                onPrimary: async (ctx) => {
                    ctx.setBusy(true);
                    ctx.setError('');
                    const reason = textarea.value.trim();
                    let result;
                    try {
                        result = await submit(reason.length > 0 ? reason : null);
                    } catch (error) {
                        console.error(LOG_PREFIX, 'deny failed:', error);
                        ctx.setBusy(false);
                        ctx.setError(actionErrorText(error));
                        if (error && error.status === 409) afterAction();
                        return;
                    }
                    succeeded = true;
                    ctx.close();
                    try { onSuccess(result); } catch (err) { console.error(LOG_PREFIX, 'deny onSuccess failed:', err); }
                },
                onClose: () => resolve(succeeded),
            });
            modal.show();
        });
    }

    /**
     * @param {object} request
     * @returns {Promise<boolean>} true when denied.
     */
    function denyRequest(request) {
        if (!request) return Promise.resolve(false);
        return openDenyDialog({
            title: 'Deny Request',
            subtitle: request.ItemName,
            primaryText: 'Deny Request',
            submit: reason => D.api.deny(request.Id, reason),
            onSuccess: () => {
                D.toast(`Denied: ${request.ItemName}`);
                announceResult(`Denied: ${request.ItemName}`);
                afterAction();
            },
        });
    }

    /**
     * Cancels an approved, not-yet-due request after confirmation.
     * @param {object} request
     * @returns {Promise<boolean>}
     */
    async function cancelRequest(request) {
        if (!request) return false;
        const confirmed = await D.confirmDialog({
            title: 'Cancel Request',
            message: 'Cancel this approved deletion? The request will be closed without executing.',
            confirmText: 'Cancel Request',
            cancelText: 'Keep Approved',
            destructive: true,
        });
        if (!confirmed) return false;
        try {
            await D.api.cancel(request.Id, null);
        } catch (error) {
            actionError(error);
            return false;
        }
        D.toast(`Cancelled: ${request.ItemName}`);
        announceResult(`Cancelled: ${request.ItemName}`);
        await afterAction();
        return true;
    }

    // ============================================================
    // Timing chips + deny button (shared by cards and drawer)
    // ============================================================

    /**
     * @param {object} request
     * @param {ReturnType<typeof createLock>} lock
     * @param {(ok: boolean) => void} [onDone]
     * @returns {HTMLElement}
     */
    function buildTimingChips(request, lock, onDone) {
        const group = document.createElement('div');
        group.className = 'jdm-chips';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `Approve ${request.ItemName}`);

        D.TIMINGS.forEach(timing => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'raised emby-button jdm-chip';
            chip.textContent = timing.label;
            chip.setAttribute('aria-label', `Approve with timing ${timing.label}`);
            chip.addEventListener('click', async (event) => {
                event.stopPropagation();
                const ok = await lock.run(() => approveRequest(request, timing.key));
                if (typeof onDone === 'function') onDone(!!ok);
            });
            lock.add(chip);
            group.appendChild(chip);
        });

        return group;
    }

    /**
     * @param {object} request
     * @param {ReturnType<typeof createLock>} lock
     * @param {(ok: boolean) => void} [onDone]
     * @param {boolean} [iconOnly]
     * @returns {HTMLButtonElement}
     */
    function buildDenyButton(request, lock, onDone, iconOnly) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'raised emby-button jdm-chip jdm-deny-button jdm-destructive-text';
        button.setAttribute('aria-label', `Deny ${request.ItemName}`);

        const icon = D.makeText('span', 'block', 'material-icons');
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.appendChild(D.makeText('span', 'Deny Request', iconOnly ? 'jdm-sr-only' : ''));

        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const ok = await lock.run(() => denyRequest(request));
            if (typeof onDone === 'function') onDone(!!ok);
        });
        lock.add(button);
        return button;
    }

    /**
     * Card quick actions — pending cards only.
     * @param {HTMLElement} actionsEl
     * @param {object} request
     */
    function renderQuickActions(actionsEl, request) {
        if (!actionsEl || !request || request.Status !== 'Pending') return;
        actionsEl.replaceChildren();
        const lock = createLock();
        const chips = buildTimingChips(request, lock);
        chips.appendChild(buildDenyButton(request, lock, undefined, true));
        actionsEl.appendChild(chips);
    }

    // ============================================================
    // Detail drawer
    // ============================================================

    const OUTCOME_LABELS = {
        Denied: 'Denial reason',
        Failed: 'Failure reason',
        Blocked: 'Blocked reason',
        Requeued: 'Requeue reason',
        Cancelled: 'Cancellation note',
    };

    const AUDIT_LABELS = {
        executed: 'Deleted',
        failed: 'Failed',
        requeued: 'Skipped (item in playback), requeued',
        blocked: 'Blocked (favorite protected)',
        cancelled: 'Cancelled',
    };

    /**
     * @param {string} text
     * @returns {HTMLElement}
     */
    function sectionHeading(text) {
        return D.makeText('h3', text, 'jdm-section-heading');
    }

    /**
     * @param {object} request
     * @returns {HTMLElement}
     */
    function buildDrawerHeader(request) {
        const header = document.createElement('div');
        header.className = 'jdm-drawer-header';

        if (request.JellyfinItemId) {
            const img = document.createElement('img');
            img.alt = request.ItemName || '';
            D.loadFirstImage(
                [D.posterUrl(request.JellyfinItemId, 300), D.archivedPosterUrl(request.Id)],
                (url) => { img.src = url; },
                () => { img.style.display = 'none'; });
            header.appendChild(img);
        }

        const info = D.makeText('div', '', 'jdm-drawer-info');
        info.appendChild(D.makeText('div', request.ItemName, 'jdm-drawer-title'));
        info.appendChild(D.makeText('div', `${D.scopeLabel(request.ItemType)} · ${itemCountOf(request)} item(s)`));

        const status = D.displayStatus(request);
        const badgeInfo = D.STATUS_BADGES[status] || { label: status, className: 'jdm-badge-neutral' };
        const badgeRow = document.createElement('div');
        const badge = D.makeText('span', badgeInfo.label, `jdm-badge ${badgeInfo.className}`);
        badgeRow.appendChild(badge);
        info.appendChild(badgeRow);

        const countdown = D.countdownText(request);
        if (countdown) {
            const countdownEl = D.makeText('div', countdown, 'jdm-countdown');
            if (request.ExecuteAt) countdownEl.title = D.formatExact(request.ExecuteAt);
            info.appendChild(countdownEl);
        }

        header.appendChild(info);
        return header;
    }

    /**
     * @param {object} request
     * @returns {HTMLElement}
     */
    function buildDetailsList(request) {
        const dl = document.createElement('dl');
        dl.className = 'jdm-drawer-details';

        const addRow = (label, value) => {
            if (value == null || value === '') return;
            dl.appendChild(D.makeText('dt', label));
            dl.appendChild(D.makeText('dd', value));
        };

        addRow('Requested by', request.RequesterName);
        addRow('Source', request.Source);
        addRow('Requested', D.formatExact(request.CreatedAt));
        addRow('Timing', D.timingLabel(request.Timing) || 'Not set');
        addRow('Executes at', D.formatExact(request.ExecuteAt));
        addRow('Approved at', D.formatExact(request.ApprovedAt));
        addRow('Executed at', D.formatExact(request.ExecutedAt));
        addRow('Request ID', request.Id);
        addRow('Item ID', request.JellyfinItemId);
        return dl;
    }

    /**
     * Merges synthesized lifecycle events with audit rows, oldest first.
     * @param {object} request
     * @param {Array<{Action: string, Reason?: string, OccurredAt: string}>} auditRows
     * @returns {HTMLElement}
     */
    function buildTimeline(request, auditRows) {
        /** @type {Array<{label: string, at: string, reason: string|null, order: number}>} */
        const events = [];
        let order = 0;
        if (!auditRows.some(row => String(row && row.Action).toLowerCase() === 'submitted')) events.push({ label: `Requested by ${request.RequesterName || 'unknown'}`, at: request.CreatedAt, reason: null, order: order++ });
        if (request.Status === 'Denied' && !auditRows.some(row => String(row && row.Action).toLowerCase() === 'denied')) {
            if (request.ApprovedAt) events.push({ label: 'Denied', at: request.ApprovedAt, reason: null, order: order++ });
        } else if (request.Status !== 'Denied' && request.ApprovedAt && !auditRows.some(row => String(row && row.Action).toLowerCase() === 'approved')) {
            const timing = D.timingLabel(request.Timing);
            events.push({ label: timing ? `Approved · ${timing}` : 'Approved', at: request.ApprovedAt, reason: null, order: order++ });
        }
        auditRows.forEach(row => {
            if (!row) return;
            const action = String(row.Action || '');
            const label = action.toLowerCase() === 'submitted' ? `Requested by ${request.RequesterName || 'unknown'}` : action.toLowerCase() === 'approved' ? 'Approved' : action.toLowerCase() === 'denied' ? 'Denied' : AUDIT_LABELS[action.toLowerCase()] || action;
            events.push({ label, at: row.OccurredAt, reason: row.Reason || null, order: order++ });
        });

        const timeOf = (iso) => {
            const t = iso ? new Date(iso).getTime() : NaN;
            return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
        };
        events.sort((a, b) => (timeOf(a.at) - timeOf(b.at)) || (a.order - b.order));

        const list = document.createElement('ol');
        list.className = 'jdm-timeline';

        events.forEach(event => {
            const item = document.createElement('li');
            item.appendChild(D.makeText('div', event.label, 'jdm-timeline-label'));
            const when = D.formatExact(event.at);
            if (when) item.appendChild(D.makeText('div', when, 'jdm-timeline-when'));
            if (event.reason) item.appendChild(D.makeText('div', event.reason));
            list.appendChild(item);
        });
        return list;
    }

    /**
     * @param {object} request
     * @returns {boolean}
     */
    function isCancellable(request) {
        if (!request || request.Status !== 'Approved' || request.ExecutedAt || !request.ExecuteAt) return false;
        const executeAt = new Date(request.ExecuteAt).getTime();
        return !Number.isNaN(executeAt) && executeAt > Date.now();
    }

    /**
     * @param {object} request
     * @param {() => void} reload Re-fetches and re-renders the drawer in place.
     * @returns {HTMLElement|null}
     */
    function buildAdminControls(request, reload) {
        const lock = createLock();
        const onDone = (ok) => { if (ok) reload(); };

        if (request.Status === 'Pending') {
            const wrap = document.createElement('div');
            wrap.appendChild(sectionHeading('Actions'));
            const chips = buildTimingChips(request, lock, onDone);
            wrap.appendChild(chips);
            const denyRow = D.makeText('div', '', 'jdm-drawer-row');
            denyRow.appendChild(buildDenyButton(request, lock, onDone, false));
            wrap.appendChild(denyRow);
            return wrap;
        }

        if (isCancellable(request)) {
            const wrap = document.createElement('div');
            wrap.appendChild(sectionHeading('Actions'));
            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'raised emby-button jdm-chip jdm-destructive-text';
            cancelButton.textContent = 'Cancel Request';
            cancelButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const ok = await lock.run(() => cancelRequest(request));
                onDone(!!ok);
            });
            lock.add(cancelButton);
            wrap.appendChild(cancelButton);
            return wrap;
        }

        return null;
    }

    /**
     * @param {object} request
     * @param {Array<object>} auditRows
     * @param {boolean} isAdmin
     * @param {() => void} reload
     * @param {(href: string) => void} navigate
     * @returns {HTMLElement}
     */
    function buildDrawerBody(request, auditRows, isAdmin, reload, navigate) {
        const body = document.createElement('div');
        body.className = 'jdm-drawer-body';

        body.appendChild(buildDrawerHeader(request));
        body.appendChild(buildDetailsList(request));

        body.appendChild(sectionHeading("Requester's reason"));
        const reasonText = typeof request.RequesterReason === 'string' && request.RequesterReason.trim().length > 0
            ? request.RequesterReason
            : 'No reason given.';
        body.appendChild(D.makeText('p', reasonText, 'jdm-drawer-text'));

        const status = D.displayStatus(request);
        if (typeof request.FailureReason === 'string' && request.FailureReason.length > 0) {
            body.appendChild(sectionHeading(OUTCOME_LABELS[status] || 'Outcome note'));
            body.appendChild(D.makeText('p', request.FailureReason, 'jdm-drawer-text'));
        }

        body.appendChild(sectionHeading('Timeline'));
        body.appendChild(buildTimeline(request, auditRows));

        if (isAdmin) {
            const controls = buildAdminControls(request, reload);
            if (controls) body.appendChild(controls);
        }

        if (request.Status !== 'Executed' && request.JellyfinItemId) {
            const href = `#/details?id=${encodeURIComponent(request.JellyfinItemId)}`;
            const linkRow = D.makeText('div', '', 'jdm-drawer-row');
            const link = D.makeText('a', 'Open item page', 'jdm-drawer-link');
            link.href = href;
            link.addEventListener('click', (event) => {
                event.preventDefault();
                navigate(href);
            });
            linkRow.appendChild(link);
            body.appendChild(linkRow);
        }

        return body;
    }

    /**
     * Opens the request detail drawer.
     * @param {number|string} requestId
     */
    function openDrawer(requestId) {
        const id = Number(requestId);
        const cached = (Array.isArray(D.state.requests) ? D.state.requests : []).find(r => r && r.Id === id);

        const content = document.createElement('div');
        let isOpen = true;
        let pendingNavigation = null;

        const modal = D.createModal({
            title: cached && cached.ItemName ? cached.ItemName : 'Request details',
            body: content,
            secondaryText: 'Close Details',
            variant: 'drawer',
            onClose: () => {
                isOpen = false;
                if (pendingNavigation) navigateToHref(pendingNavigation);
            },
        });
        const titleEl = modal.element.querySelector('.jdm-modal-title');

        const navigate = (href) => {
            pendingNavigation = href;
            modal.close();
        };

        function renderLoadError(error) {
            content.replaceChildren(D.stateCard({
                heading: "Couldn't load this request",
                lines: [D.errorMessage(error)],
                action: { text: 'Retry', onClick: load },
                alert: true,
            }));
        }

        async function load() {
            content.setAttribute('aria-busy', 'true');
            content.replaceChildren(D.makeText('div', 'Loading request…', 'jdm-state-card-body'));
            let request;
            let auditRows;
            try {
                [request, auditRows] = await Promise.all([D.api.get(id), D.api.audit(id)]);
            } catch (error) {
                console.error(LOG_PREFIX, 'drawer load failed:', error);
                if (!isOpen) return;
                content.removeAttribute('aria-busy');
                renderLoadError(error);
                return;
            }
            const isAdmin = await D.resolveIsAdmin();
            if (!isOpen) return;
            if (titleEl) titleEl.textContent = request && request.ItemName ? request.ItemName : 'Request details';
            content.removeAttribute('aria-busy');
            content.replaceChildren(buildDrawerBody(request, Array.isArray(auditRows) ? auditRows : [], isAdmin, load, navigate));
        }

        modal.show();
        load();
    }

    /**
     * Poster / "…" menu for a dashboard card: the same actions as the
     * drawer, one tap away. Admins get approve/deny/cancel; everyone gets
     * details and the item page.
     * @param {object} request
     * @param {HTMLElement} [anchor]
     */
    async function openRequestMenu(request, anchor) {
        if (!request) return;
        const identity = D.identityToken();
        const isAdmin = await D.resolveIsAdmin();
        if (identity !== D.identityToken()) return;
        const items = [{ icon: 'info', text: 'View request details', onSelect: () => openDrawer(request.Id) }];
        if (isAdmin && request.Status === 'Pending') {
            D.TIMINGS.forEach(timing => {
                items.push({
                    icon: timing.key === 'immediate' ? 'delete_forever' : 'schedule',
                    text: timing.key === 'immediate' ? 'Approve, delete now' : `Approve, delete in ${timing.label}`,
                    destructive: timing.key === 'immediate',
                    onSelect: () => approveRequest(request, timing.key),
                });
            });
            items.push({ icon: 'block', text: 'Deny request', onSelect: () => denyRequest(request) });
        }
        if (isAdmin && isCancellable(request)) {
            items.push({ icon: 'cancel', text: 'Cancel request', onSelect: () => cancelRequest(request) });
        }
        if (request.Status !== 'Executed' && request.JellyfinItemId) {
            items.push({
                icon: 'open_in_new',
                text: 'Open item page',
                onSelect: () => navigateToHref(`#/details?id=${encodeURIComponent(request.JellyfinItemId)}`),
            });
        }
        D.showMenu({ title: request.ItemName || 'Deletion request', items, anchor });
    }

    // ============================================================
    // Bulk action bar
    // ============================================================

    // Survives poll-driven re-renders of the bar.
    const bulkUi = { chipsOpen: false, busy: false };

    /**
     * Selected requests that are still pending in the current list.
     * @returns {Array<object>}
     */
    function selectedPendingRequests() {
        const requests = Array.isArray(D.state.requests) ? D.state.requests : [];
        return requests.filter(r => r && r.Status === 'Pending' && D.state.selectedIds.has(r.Id));
    }

    /**
     * Toasts a bulk result and drops succeeded ids from the selection.
     * @param {*} response { Results: [{ Id, Succeeded, Message }] }
     * @param {string} verb 'approved' | 'denied'
     */
    function handleBulkResult(response, verb) {
        const results = response && Array.isArray(response.Results) ? response.Results : [];
        const succeeded = results.filter(r => r && r.Succeeded);
        const failed = results.filter(r => r && !r.Succeeded);
        succeeded.forEach(r => D.state.selectedIds.delete(r.Id));
        let message = `${succeeded.length} ${verb}`;
        if (failed.length > 0) {
            message += `, ${failed.length} failed: ${failed[0].Message || 'Unknown error'}`;
        }
        D.toast(message);
        announceResult(message);
    }

    /**
     * @param {string} timingKey
     */
    async function bulkApprove(timingKey) {
        const selected = selectedPendingRequests();
        if (selected.length === 0 || selected.length > D.MAX_BULK) return;
        const ids = selected.map(r => r.Id);
        if (timingKey === 'immediate') {
            const totalItems = selected.reduce((sum, r) => sum + itemCountOf(r), 0);
            const confirmed = await D.confirmDialog({
                title: 'Delete now?',
                message: `Delete ${totalItems} item(s) in ${ids.length} request(s) immediately? This cannot be undone.`,
                confirmText: 'Delete Now',
                cancelText: 'Keep as Pending',
                destructive: true,
            });
            if (!confirmed) return;
        }
        let response;
        try {
            response = await D.api.bulkApprove(ids, timingKey);
        } catch (error) {
            actionError(error);
            return;
        }
        bulkUi.chipsOpen = false;
        handleBulkResult(response, 'approved');
        await afterAction();
    }

    async function bulkDeny() {
        const selected = selectedPendingRequests();
        if (selected.length === 0 || selected.length > D.MAX_BULK) return;
        const ids = selected.map(r => r.Id);
        await openDenyDialog({
            title: `Deny ${ids.length} requests`,
            primaryText: 'Deny Selected',
            submit: reason => D.api.bulkDeny(ids, reason),
            onSuccess: (response) => {
                bulkUi.chipsOpen = false;
                handleBulkResult(response, 'denied');
                afterAction();
            },
        });
    }

    /**
     * Runs a bulk action with the bar disabled; re-renders around it.
     * @param {HTMLElement} hostEl
     * @param {() => Promise<void>} fn
     */
    async function runBulk(hostEl, fn) {
        if (bulkUi.busy) return;
        bulkUi.busy = true;
        renderBulkBar(hostEl);
        try {
            await fn();
        } finally {
            bulkUi.busy = false;
            renderBulkBar(hostEl);
        }
    }

    /**
     * @param {string} text
     * @returns {HTMLButtonElement}
     */
    function bulkButton(text) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('is', 'emby-button');
        button.className = 'raised emby-button';
        button.textContent = text;
        return button;
    }

    /**
     * Renders the bulk bar into hostEl, or nothing when no pending cards are
     * selected on the Pending tab. Called by the dashboard on every render.
     * @param {HTMLElement} hostEl
     */
    function renderBulkBar(hostEl) {
        if (!hostEl) return;
        hostEl.replaceChildren();

        const onPendingTab = D.state.activeTab === 'pending' && !!D.state.isAdmin;
        const n = D.state.selectedIds.size;
        if (!onPendingTab || n === 0) {
            bulkUi.chipsOpen = false;
            return;
        }

        const tooMany = n > D.MAX_BULK;
        const disabled = bulkUi.busy || tooMany;

        const bar = document.createElement('div');
        bar.className = 'jdm-bulk-bar';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Bulk actions');

        // "{n} selected" is announced through the dashboard's persistent
        // aria-live region (D.announce) on every toggle; a live region
        // recreated on each render is not reliably read.
        const count = D.makeText('span', `${n} selected`);
        bar.appendChild(count);

        const approveButton = bulkButton('Approve Selected');
        approveButton.setAttribute('aria-expanded', bulkUi.chipsOpen ? 'true' : 'false');
        approveButton.disabled = disabled;
        approveButton.addEventListener('click', () => {
            bulkUi.chipsOpen = !bulkUi.chipsOpen;
            renderBulkBar(hostEl);
        });
        bar.appendChild(approveButton);

        const denyButton = bulkButton('Deny Selected');
        denyButton.classList.add('jdm-destructive-text');
        denyButton.disabled = disabled;
        denyButton.addEventListener('click', () => runBulk(hostEl, bulkDeny));
        bar.appendChild(denyButton);

        const clearButton = bulkButton('Clear Selection');
        clearButton.disabled = bulkUi.busy;
        clearButton.addEventListener('click', () => {
            D.state.selectedIds.clear();
            bulkUi.chipsOpen = false;
            if (typeof D.refreshDashboard === 'function') D.refreshDashboard();
            else renderBulkBar(hostEl);
        });
        bar.appendChild(clearButton);

        if (tooMany) {
            const warning = D.makeText('span', `Select at most ${D.MAX_BULK} requests.`, 'jdm-destructive-text');
            warning.setAttribute('role', 'alert');
            bar.appendChild(warning);
        }

        if (bulkUi.chipsOpen && !tooMany) {
            const chips = document.createElement('div');
            chips.className = 'jdm-chips';
            chips.setAttribute('role', 'group');
            chips.setAttribute('aria-label', `Approve ${n} selected requests`);
            D.TIMINGS.forEach(timing => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'raised emby-button jdm-chip';
                chip.textContent = timing.label;
                chip.setAttribute('aria-label', `Approve selected with timing ${timing.label}`);
                chip.disabled = bulkUi.busy;
                chip.addEventListener('click', () => runBulk(hostEl, () => bulkApprove(timing.key)));
                chips.appendChild(chip);
            });
            bar.appendChild(chips);
        }

        hostEl.appendChild(bar);
    }

    Object.assign(D, { approveRequest, denyRequest, cancelRequest, renderQuickActions, openDrawer, openRequestMenu, renderBulkBar });

})();
