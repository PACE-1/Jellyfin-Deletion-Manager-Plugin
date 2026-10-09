// @ts-check
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;

    // Late-bound: JDM.deletion (D) is defined by deletion-state.js and
    // extended by deletion-modal.js/deletion-cards.js, which all load before this
    // file (see the bundle order in WebAssetController). D.showDashboard and D.refreshBadge
    // are themselves late-bound slots filled by later modules, so this file never
    // caches the object returned by D() across an await boundary — it calls D()
    // fresh at every use so a not-yet-defined slot at first render is picked up
    // once the later module has loaded.
    const D = () => JDM.deletion;

    const SUPPORTED_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
    let lastItemId = null;
    let renderTimer = null;
    let countdownBanner = null;
    let reasonIdSeq = 0;

    function currentItemId() {
        return new URLSearchParams(window.location.hash.split('?')[1] || '').get('id');
    }

    function visibleDetailPage() {
        return document.querySelector('#itemDetailPage:not(.hide)');
    }

    function requestType(type) {
        return type === 'Movie' ? 'movie'
            : type === 'Series' ? 'series'
                : type === 'Season' ? 'season'
                    : 'episode';
    }

    function actionContainer(page) {
        return page.querySelector('.detailButtons, .itemActionsBottom, .mainDetailButtons, .detailButtonsContainer');
    }

    function removeCountdownBanner() {
        if (countdownBanner && countdownBanner.parentNode) {
            countdownBanner.parentNode.removeChild(countdownBanner);
        }
        countdownBanner = null;
    }

    /**
     * Picks the most recent (max CreatedAt) request for this item whose Status
     * is in D.ACTIVE_STATUSES ('Pending', 'Approved'). Denied, Failed, Blocked,
     * Cancelled, and Executed requests never block a new request.
     * @param {Array<object>} requests
     * @param {string} itemId
     * @returns {object|null}
     */
    function pickActiveRequest(requests, itemId) {
        const d = D();
        if (!d) return null;
        const targetId = d.normalizeId(itemId);
        let best = null;
        for (const request of requests) {
            if (d.normalizeId(request.JellyfinItemId) !== targetId) continue;
            if (!d.ACTIVE_STATUSES.includes(request.Status)) continue;
            if (!best || new Date(request.CreatedAt).getTime() > new Date(best.CreatedAt).getTime()) {
                best = request;
            }
        }
        return best;
    }

    /**
     * Renders (or clears) the page-top "Approved · deletes in Xd Yh" banner
     * for the given active request. Always clears the previous banner
     * first, so switching items or a non-approved status leaves no stale node.
     * @param {Element} page
     * @param {object} request
     */
    function renderCountdownBanner(page, request) {
        removeCountdownBanner();
        const d = D();
        if (!d) return;
        const status = d.displayStatus(request);
        if (status !== 'Approved' && status !== 'Requeued') return;
        if (!request.ExecuteAt) return;
        const countdown = d.countdownText(request);
        if (!countdown) return;

        const text = countdown === 'Due now'
            ? 'Approved · due now'
            : `Approved · deletes in ${countdown.slice('Deletes in '.length)}`;

        const banner = document.createElement('div');
        banner.className = 'jdm-countdown-banner';
        // Keyboard/click target that opens the request, so it is a button to
        // assistive tech (not a live status region).
        banner.setAttribute('role', 'button');
        banner.setAttribute('aria-label', `${text}. Open deletion request`);
        banner.textContent = text;
        banner.title = d.formatExact(request.ExecuteAt);
        banner.tabIndex = 0;
        banner.style.cursor = 'pointer';

        const open = () => {
            const dd = D();
            if (dd && typeof dd.openDrawer === 'function') dd.openDrawer(request.Id);
        };
        banner.addEventListener('click', open);
        banner.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });

        // Classic pages reserve poster space in the primary content column.
        // Keep the banner there, outside the horizontal action ribbon and the
        // floating poster, so native detail-page positioning remains intact.
        const mount = page.querySelector('.detailPageContent')
            || page.querySelector('.detailPagePrimaryContent .detailSection')
            || page.querySelector('.detailPagePrimaryContent')
            || (actionContainer(page) && actionContainer(page).parentElement);
        if (!mount) return;
        mount.insertBefore(banner, mount.firstChild);
        countdownBanner = banner;
    }

    /** Season/episode subtitle uses SeriesName (+ SeasonName for episodes); otherwise the production year. */
    function subtitleFor(item, type) {
        if (type === 'season' || type === 'episode') {
            const parts = [];
            if (item.SeriesName) parts.push(item.SeriesName);
            if (type === 'episode' && item.SeasonName) parts.push(item.SeasonName);
            return parts.length ? parts.join(' · ') : undefined;
        }
        return item.ProductionYear ? String(item.ProductionYear) : undefined;
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    // ============================================================
    // Episode picker (series and seasons)
    // ============================================================

    /**
     * Real (on-disk) episodes under a series or season, grouped by season.
     * Missing/unaired placeholders are excluded, matching the server count.
     * @param {object} item Series or Season.
     * @returns {Promise<Array<{id: string, name: string, episodes: Array<{id: string, label: string}>}>>}
     */
    async function loadSeasons(item) {
        const seriesId = item.Type === 'Series' ? item.Id : item.SeriesId;
        const query = { UserId: ApiClient.getCurrentUserId(), IsMissing: false };
        if (item.Type === 'Season') query.SeasonId = item.Id;
        const result = await ApiClient.getJSON(ApiClient.getUrl(`Shows/${seriesId}/Episodes`, query));
        const episodes = (result && result.Items || []).filter(ep => ep.LocationType !== 'Virtual' && !ep.IsMissing);

        const seasons = new Map();
        for (const ep of episodes) {
            const key = ep.SeasonId || `none-${ep.ParentIndexNumber ?? ''}`;
            if (!seasons.has(key)) {
                seasons.set(key, {
                    id: ep.SeasonId || null,
                    name: ep.SeasonName || (ep.ParentIndexNumber != null ? `Season ${ep.ParentIndexNumber}` : 'Other episodes'),
                    episodes: [],
                });
            }
            const number = ep.IndexNumber != null ? `${ep.IndexNumber}. ` : '';
            seasons.get(key).episodes.push({ id: ep.Id, label: `${number}${ep.Name || 'Episode'}` });
        }
        return Array.from(seasons.values());
    }

    /**
     * jellyfin-web checkbox (emby-checkbox upgrades it with the themed outline).
     * @param {string} text
     * @param {boolean} checked
     * @returns {{label: HTMLElement, input: HTMLInputElement}}
     */
    function makeCheckbox(text, checked) {
        const tmp = document.createElement('div');
        tmp.innerHTML = '<label class="emby-checkbox-label"><input type="checkbox" is="emby-checkbox" class="emby-checkbox"><span class="checkboxLabel"></span></label>';
        const label = /** @type {HTMLElement} */ (tmp.firstElementChild);
        const input = /** @type {HTMLInputElement} */ (label.querySelector('input'));
        input.checked = checked;
        /** @type {HTMLElement} */ (label.querySelector('.checkboxLabel')).textContent = text;
        return { label, input };
    }

    /**
     * Builds the "what to delete" picker: whole show/season, whole seasons,
     * or single episodes. Everything starts selected (the whole item).
     * @param {object} item
     * @param {Array<{id: string, name: string, episodes: Array<{id: string, label: string}>}>} seasons
     * @param {() => void} onChange
     */
    function buildPicker(item, seasons, onChange) {
        const root = document.createElement('div');
        root.className = 'jdm-picker';
        const allIds = seasons.flatMap(s => s.episodes.map(e => e.id));
        const selected = new Set(allIds);
        const locked = new Set();
        const seasonBoxes = [];
        const episodeBoxes = new Map();

        const allWord = item.Type === 'Series' ? 'Entire show' : 'Entire season';
        const all = makeCheckbox(`${allWord} (${plural(allIds.length, 'episode')})`, true);
        all.label.classList.add('jdm-picker-all');
        root.appendChild(all.label);

        const list = document.createElement('div');
        list.className = 'jdm-picker-list';
        root.appendChild(list);

        function sync() {
            const selectable = allIds.filter(id => !locked.has(id));
            all.input.checked = selectable.length > 0 && selectable.every(id => selected.has(id));
            seasonBoxes.forEach(({ season, input, count }) => {
                const ids = season.episodes.map(e => e.id);
                const n = ids.filter(id => selected.has(id)).length;
                input.checked = n === ids.length;
                input.indeterminate = n > 0 && n < ids.length;
                count.textContent = n === ids.length ? plural(ids.length, 'episode') : `${n} of ${ids.length} episodes`;
            });
            episodeBoxes.forEach((input, id) => {
                input.checked = selected.has(id);
                input.disabled = locked.has(id);
            });
            onChange();
        }

        all.input.addEventListener('change', () => {
            allIds.forEach(id => { if (!locked.has(id)) { if (all.input.checked) selected.add(id); else selected.delete(id); } });
            sync();
        });

        const multiSeason = seasons.length > 1 || item.Type === 'Series';
        seasons.forEach(season => {
            const block = document.createElement('div');
            block.className = 'jdm-picker-season';
            let episodesHost = list;

            if (multiSeason) {
                const row = document.createElement('div');
                row.className = 'jdm-picker-season-row';
                const box = makeCheckbox(season.name, true);
                const count = D().makeText('span', '', 'fieldDescription jdm-picker-count');
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.setAttribute('is', 'paper-icon-button-light');
                toggle.className = 'paper-icon-button-light jdm-picker-toggle';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-label', `Show episodes in ${season.name}`);
                const icon = D().makeText('span', '', 'material-icons expand_more');
                icon.setAttribute('aria-hidden', 'true');
                toggle.appendChild(icon);
                row.appendChild(box.label);
                row.appendChild(count);
                row.appendChild(toggle);
                block.appendChild(row);

                episodesHost = document.createElement('div');
                episodesHost.className = 'jdm-picker-episodes';
                episodesHost.hidden = true;
                block.appendChild(episodesHost);

                toggle.addEventListener('click', () => {
                    const open = episodesHost.hidden;
                    episodesHost.hidden = !open;
                    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                    icon.className = `material-icons ${open ? 'expand_less' : 'expand_more'}`;
                });
                box.input.addEventListener('change', () => {
                    season.episodes.forEach(e => { if (!locked.has(e.id)) { if (box.input.checked) selected.add(e.id); else selected.delete(e.id); } });
                    sync();
                });
                seasonBoxes.push({ season, input: box.input, count });
            } else {
                episodesHost = document.createElement('div');
                episodesHost.className = 'jdm-picker-episodes';
                block.appendChild(episodesHost);
            }

            season.episodes.forEach(ep => {
                const box = makeCheckbox(ep.label, true);
                box.input.addEventListener('change', () => {
                    if (box.input.checked) selected.add(ep.id); else selected.delete(ep.id);
                    sync();
                });
                episodeBoxes.set(ep.id, box.input);
                episodesHost.appendChild(box.label);
            });
            list.appendChild(block);
        });

        // Defer the first sync so onChange sees the fully built picker.
        setTimeout(sync, 0);

        return {
            element: root,
            selectedIds: () => allIds.filter(id => selected.has(id) && !locked.has(id)),
            /** Marks episodes as already sent so a retry cannot duplicate them. */
            lock: ids => { ids.forEach(id => { locked.add(id); selected.delete(id); }); sync(); },
            /**
             * Fewest requests covering the selection: the whole item when
             * everything is selected, whole seasons, then single episodes.
             * @returns {Array<{itemId: string, type: string, count: number, label: string}>}
             */
            plan: () => {
                const pick = new Set(allIds.filter(id => selected.has(id) && !locked.has(id)));
                if (pick.size === 0) return [];
                if (locked.size === 0 && pick.size === allIds.length) {
                    return [{ itemId: item.Id, type: requestType(item.Type), count: pick.size, label: item.Name, episodeIds: allIds }];
                }
                const out = [];
                seasons.forEach(season => {
                    const ids = season.episodes.map(e => e.id);
                    const n = ids.filter(id => pick.has(id)).length;
                    if (n === 0) return;
                    if (n === ids.length && season.id && !ids.some(id => locked.has(id))) {
                        out.push({ itemId: season.id, type: 'season', count: n, label: season.name, episodeIds: ids });
                    } else {
                        season.episodes.filter(e => pick.has(e.id))
                            .forEach(e => out.push({ itemId: e.id, type: 'episode', count: 1, label: e.label, episodeIds: [e.id] }));
                    }
                });
                return out;
            },
        };
    }

    // ============================================================
    // Request dialog
    // ============================================================

    /**
     * Opens the deletion-request dialog for any supported item. Series and
     * seasons get the episode picker; the selection is sent as the fewest
     * requests (whole item, whole seasons, single episodes). Handles the 409
     * expectedItemCount-drift guard by refreshing and keeping the dialog open.
     * @param {object|string} itemOrId A Jellyfin item or its id.
     * @param {{onSent?: Function}} [options]
     */
    async function openRequestDialog(itemOrId, options) {
        const d = D();
        if (!d) return;
        const identity = d.identityToken();
        const isCurrent = () => identity === d.identityToken();
        const onSent = options && options.onSent;
        let item = itemOrId;
        if (typeof itemOrId === 'string') {
            item = await JDM.items.get(itemOrId);
        }
        if (!isCurrent()) return;
        if (!item || !SUPPORTED_TYPES.has(item.Type)) {
            d.toast('Deletion requests are only available for movies and shows.');
            return;
        }
        const type = requestType(item.Type);

        const body = document.createElement('div');
        body.className = 'jdm-confirm-body';

        const countLine = d.makeText('p', type === 'movie' || type === 'episode' ? '1 item will be deleted.' : 'Loading episodes…', 'jdm-confirm-count');

        let picker = null;
        let primary = null;
        let closed = false;
        let submitting = false;
        const lockedIds = new Set();
        const grouped = type === 'series' || type === 'season';
        let pickerHost = null;

        function updatePrimary() {
            if (primary) primary.disabled = submitting || (grouped && (!picker || picker.selectedIds().length === 0));
        }

        async function loadPicker() {
            picker = null;
            updatePrimary();
            countLine.textContent = 'Loading episodes…';
            pickerHost.replaceChildren(d.makeText('h3', 'What should be deleted?', 'sectionTitle jdm-section-title'));
            try {
                const seasons = await loadSeasons(item);
                if (closed || !isCurrent()) return;
                picker = buildPicker(item, seasons, () => {
                    const n = picker ? picker.selectedIds().length : 0;
                    countLine.textContent = n === 0 ? 'Select at least one episode.' : `${plural(n, 'episode')} will be deleted.`;
                    updatePrimary();
                });
                picker.lock(Array.from(lockedIds));
                pickerHost.appendChild(picker.element);
            } catch (error) {
                if (closed || !isCurrent()) return;
                countLine.textContent = "Couldn't load the episode list. Retry to confirm what will be deleted.";
                pickerHost.appendChild(d.stateCard({
                    heading: "Couldn't load episodes",
                    action: { text: 'Retry', onClick: loadPicker },
                    alert: true,
                }));
                updatePrimary();
            }
        }

        if (grouped) {
            pickerHost = document.createElement('div');
            pickerHost.className = 'verticalSection jdm-picker-host';
            body.appendChild(pickerHost);
            body.appendChild(countLine);
            loadPicker();
        } else {
            body.appendChild(countLine);
        }

        const reasonId = `jdm-reason-${++reasonIdSeq}`;
        const reasonWrap = document.createElement('div');
        reasonWrap.className = 'inputContainer jdm-reason-container';
        const reasonLabel = document.createElement('label');
        reasonLabel.setAttribute('for', reasonId);
        reasonLabel.textContent = 'Reason (optional)';
        reasonLabel.className = 'inputLabel inputLabelUnfocused';
        reasonWrap.appendChild(reasonLabel);
        const reasonInput = document.createElement('textarea');
        reasonInput.id = reasonId;
        reasonInput.maxLength = d.REASON_MAX;
        reasonInput.rows = 3;
        reasonInput.placeholder = 'Why should this be deleted?';
        reasonInput.className = 'emby-textarea jdm-confirm-reason';
        reasonWrap.appendChild(reasonInput);
        body.appendChild(reasonWrap);

        const warning = document.createElement('p');
        warning.className = 'fieldDescription jdm-warning';
        warning.textContent = 'Files are permanently deleted from disk after admin approval.';
        body.appendChild(warning);

        const isAdmin = await d.resolveIsAdmin();
        if (!isCurrent()) return;
        if (isAdmin) {
            body.appendChild(d.makeText(
                'p',
                'As an admin, your request is approved immediately and runs at the next execution cycle.',
                'fieldDescription jdm-confirm-admin-note'
            ));
        }

        let sentCount = 0;
        const modal = d.createModal({
            title: item.Type === 'Episode' || item.Type === 'Season' ? (item.SeriesName || item.Name) : item.Name,
            subtitle: item.Type === 'Episode' || item.Type === 'Season'
                ? [item.Type === 'Episode' ? item.SeasonName : null, item.Name].filter(Boolean).join(' · ')
                : subtitleFor(item, type),
            imageUrl: d.posterUrl(item.Id, 400),
            body,
            primaryText: 'Request Deletion',
            primaryVariant: 'destructive',
            secondaryText: 'Not Now',
            variant: 'modal',
            onPrimary: async ctx => {
                if (closed || !isCurrent() || submitting || (grouped && !picker)) return;
                submitting = true;
                ctx.setError('');
                ctx.setBusy(true);
                const reason = reasonInput.value.trim() || null;
                const plan = picker
                    ? picker.plan()
                    : [{ itemId: item.Id, type, count: 1, label: item.Name, episodeIds: [] }];
                if (plan.length === 0) {
                    submitting = false;
                    ctx.setBusy(false);
                    updatePrimary();
                    ctx.setError('Select at least one episode.');
                    return;
                }
                for (const entry of plan) {
                    try {
                        if (!isCurrent() || closed) return;
                        await d.api.submit({ itemId: entry.itemId, itemType: entry.type,
                            expectedItemCount: entry.count,
                            expectedItemIds: entry.episodeIds,
                            reason });
                        if (!isCurrent() || closed) return;
                        sentCount++;
                        entry.episodeIds.forEach(id => lockedIds.add(id));
                        if (picker && entry.episodeIds.length) picker.lock(entry.episodeIds);
                    } catch (error) {
                        if (!isCurrent() || closed) return;
                        submitting = false;
                        ctx.setBusy(false);
                        const prefix = sentCount > 0 ? `${plural(sentCount, 'request')} sent. ` : '';
                        if (error && error.status === 409) {
                            ctx.setError(`${prefix}The request or episode selection for "${entry.label}" changed. Review and send again.`);
                            if (grouped) await loadPicker();
                        } else if (error && error.status === 400) {
                            ctx.setError(`${prefix}The request was rejected. Check the reason is under 2000 characters.`);
                        } else {
                            ctx.setError(`${prefix}${D().errorMessage(error)}`);
                        }
                        updatePrimary();
                        afterSend();
                        return;
                    }
                }
                ctx.close();
                D().toast(sentCount === 1 ? 'Deletion request sent' : `${sentCount} deletion requests sent`);
            },
            onClose: () => { closed = true; if (sentCount > 0 && isCurrent()) afterSend(); },
        });
        primary = /** @type {HTMLButtonElement|null} */ (modal.element.querySelector('.button-delete'));
        updatePrimary();

        function afterSend() {
            if (!isCurrent()) return;
            rerender();
            const dd = D();
            if (dd && typeof dd.refreshBadge === 'function') dd.refreshBadge();
            if (dd && typeof dd.refreshDashboard === 'function') dd.refreshDashboard();
            if (typeof onSent === 'function') onSent();
        }

        modal.show();
    }

    // ============================================================
    // Detail-page button
    // ============================================================

    /**
     * Sets the native icon-button look (same markup as jellyfin-web's own
     * detail buttons: button-flat detailButton > detailButton-content > icon).
     */
    function setButton(button, icon, label, disabled) {
        button.replaceChildren();
        const content = document.createElement('div');
        content.className = 'detailButton-content';
        const iconEl = document.createElement('span');
        iconEl.className = `material-icons detailButton-icon ${icon}`;
        iconEl.setAttribute('aria-hidden', 'true');
        content.appendChild(iconEl);
        button.appendChild(content);
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = disabled;
    }

    async function render() {
        const identity = D()?.identityToken();
        const page = visibleDetailPage();
        const itemId = currentItemId();
        if (!page || !itemId) return;
        const container = actionContainer(page);
        if (!container) return;

        if (itemId !== lastItemId) {
            removeCountdownBanner();
            lastItemId = itemId;
        }

        let button = page.querySelector('.jdm-request-button');
        if (!button) {
            button = document.createElement('button');
            button.setAttribute('is', 'emby-button');
            button.className = 'button-flat detailButton emby-button jdm-request-button';
            button.type = 'button';
            const more = container.querySelector('.btnMoreCommands');
            if (more && more.parentElement) more.parentElement.insertBefore(button, more);
            else container.appendChild(button);
        }
        if (button.dataset.itemId === itemId && button.dataset.ready === 'true') return;
        button.dataset.itemId = itemId;
        button.dataset.ready = 'false';
        button.classList.remove('jdm-status-badge');
        button.onclick = null;
        setButton(button, 'delete_sweep', 'Request Deletion', true);

        if (!D()) {
            button.remove();
            return;
        }

        try {
            const item = await JDM.items.get(itemId);
            if (identity !== D()?.identityToken() || itemId !== currentItemId() || !button.isConnected) return;
            if (!item || !SUPPORTED_TYPES.has(item.Type)) {
                button.remove();
                removeCountdownBanner();
                return;
            }

            let requests = [];
            try {
                requests = await D().api.list();
            } catch (listError) {
                console.warn('Jellyfin Deletion Manager: deletion request list unavailable', listError);
                requests = [];
            }
            if (identity !== D()?.identityToken() || itemId !== currentItemId() || !button.isConnected) return;
            const existing = pickActiveRequest(Array.isArray(requests) ? requests : [], item.Id);

            if (existing) {
                const status = D().displayStatus(existing);
                button.classList.add('jdm-status-badge');
                setButton(button, status === 'Pending' ? 'pending_actions' : 'auto_delete', `Deletion ${status} — view request #${existing.Id}`, false);
                button.onclick = event => {
                    event.preventDefault();
                    event.stopPropagation();
                    const dd = D();
                    if (dd && typeof dd.openDrawer === 'function') dd.openDrawer(existing.Id);
                };
                renderCountdownBanner(page, existing);
                button.dataset.ready = 'true';
                return;
            }

            removeCountdownBanner();
            button.classList.remove('jdm-status-badge');
            setButton(button, 'delete_sweep', 'Request Deletion', false);
            button.onclick = event => {
                event.preventDefault();
                event.stopPropagation();
                openRequestDialog(item);
            };
            button.dataset.ready = 'true';
        } catch (error) {
            if (identity !== D()?.identityToken()) return;
            console.warn('Jellyfin Deletion Manager: deletion request control unavailable', error);
            button.remove();
            removeCountdownBanner();
        }
    }

    /** Forces the next render() to re-fetch state instead of short-circuiting on dataset.ready. */
    function rerender() {
        const button = document.querySelector('.jdm-request-button');
        if (button) button.dataset.ready = 'false';
        render();
    }

    function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(render, 150);
    }

    const d0 = D();
    if (d0) Object.assign(d0, { openRequestDialog, SUPPORTED_ITEM_TYPES: SUPPORTED_TYPES });
    JDM.session.onUserChange('deletion-detail', () => {
        clearTimeout(renderTimer);
        lastItemId = null;
        removeCountdownBanner();
        document.querySelectorAll('.jdm-request-button').forEach(button => button.remove());
    });

    document.addEventListener('viewshow', scheduleRender);
    window.addEventListener('hashchange', scheduleRender);
    JDM.dom.onBodyMutation('deletion-request', scheduleRender);
    scheduleRender();
})();
