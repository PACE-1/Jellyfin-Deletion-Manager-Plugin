// @ts-check
// Pending-deletion schedules on native Jellyfin media cards, across SPA views.
(function () {
    'use strict';
    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;
    const BADGE = 'jdm-library-badge';
    const CARDS = '.card[data-id], .card[data-itemid]';
    let schedules = new Map();
    const NAV_REFRESH_MS = 2000;
    let inFlight = null;
    let stale = false;
    let lastFetch = 0;
    let scheduled = false;

    const style = document.createElement('style');
    style.textContent = `
        .${BADGE} {
            position: absolute; left: .35rem; top: .35rem; z-index: 2;
            display: inline-flex; align-items: center; gap: .2rem;
            /* Leave Jellyfin's watched/unplayed indicator in the top right. */
            max-width: calc(100% - 2.7rem); box-sizing: border-box;
            padding: .2rem .35rem; border-radius: .3rem;
            background: rgba(80, 18, 18, .94); color: #fff;
            font-size: .72rem; font-weight: 600; line-height: 1.4;
            pointer-events: none;
        }
        .${BADGE} .material-icons { font-size: 1rem; flex-shrink: 0; }
        .${BADGE} .jdm-library-countdown { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (max-width: 600px) {
            .${BADGE} {
                max-width: calc(100% - 1.7rem);
                padding: .2rem .25rem; gap: .15rem; font-size: .65rem;
            }
            .${BADGE} .material-icons { font-size: .85rem; }
            .${BADGE} .jdm-library-prefix { display: none; }
            /* Wrap between duration units on the smallest cards, preserving
               the time instead of ellipsizing it to a meaningless prefix. */
            .${BADGE} .jdm-library-countdown { white-space: normal; overflow: visible; }
        }
    `;
    document.head.appendChild(style);

    function render() {
        document.querySelectorAll(CARDS).forEach(card => {
            const id = D.normalizeId(card.getAttribute('data-id') || card.getAttribute('data-itemid'));
            const schedule = schedules.get(id);
            // Both classic and React cards use this positioned, padded poster
            // frame. Classic cardImageContainer is also cardContent and must
            // stay absolute; overriding it collapses/clips the image and badge.
            const host = card.querySelector('.cardScalable');
            const text = schedule && D.countdownText({ Status: 'Approved', ExecuteAt: schedule });
            let badge = card.querySelector(`.${BADGE}`);
            if (!text || !host || card.closest('.jdm-dashboard-page, .formDialog, .editPageInnerContent')) {
                if (badge) badge.remove();
                return;
            }
            if (badge && badge.parentElement !== host) { badge.remove(); badge = null; }
            if (!badge) {
                badge = document.createElement('span');
                badge.className = BADGE;
                const icon = document.createElement('span');
                icon.className = 'material-icons';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = 'delete_outline';
                badge.appendChild(icon);
                const label = document.createElement('span');
                label.className = 'jdm-library-countdown';
                const prefix = document.createElement('span');
                prefix.className = 'jdm-library-prefix';
                label.appendChild(prefix);
                const duration = document.createElement('span');
                duration.className = 'jdm-library-duration';
                label.appendChild(duration);
                badge.appendChild(label);
                host.appendChild(badge);
            }
            const label = badge.querySelector('.jdm-library-countdown');
            const prefix = label.querySelector('.jdm-library-prefix');
            const duration = label.querySelector('.jdm-library-duration');
            const hasPrefix = text.startsWith('Deletes in ');
            const prefixText = hasPrefix ? 'Deletes in ' : '';
            const durationText = hasPrefix ? text.slice(prefixText.length) : text;
            if (prefix.textContent !== prefixText) prefix.textContent = prefixText;
            if (duration.textContent !== durationText) duration.textContent = durationText;
            const exact = `Pending deletion: ${D.formatExact(schedule)}`;
            if (badge.getAttribute('aria-label') !== `${text}. ${exact}`) badge.setAttribute('aria-label', `${text}. ${exact}`);
        });
    }

    function scheduleRender() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; render(); });
    }

    function refreshLibraryBadges() {
        if (inFlight) {
            // That response may predate the change that prompted this call
            // (approval, cancellation); fetch again once it lands.
            stale = true;
            return inFlight;
        }
        const identity = D.identityToken();
        lastFetch = Date.now();
        const pending = (async () => {
            try {
                const rows = await D.api.cardStatus();
                if (identity !== D.identityToken()) return;
                schedules = new Map((Array.isArray(rows) ? rows : []).map(row => [D.normalizeId(row.ItemId), row.ExecuteAt]));
                scheduleRender();
            } catch (error) {
                if (identity === D.identityToken()) { schedules.clear(); scheduleRender(); }
            } finally {
                if (identity === D.identityToken()) {
                    inFlight = null;
                    if (stale) { stale = false; refreshLibraryBadges(); }
                }
            }
        })();
        inFlight = pending;
        return pending;
    }

    function onNavigate() {
        scheduleRender();
        // Schedules change while the user is on other pages (the dashboard
        // approves and cancels); refetch so a library opened next is current.
        if (!inFlight && Date.now() - lastFetch >= NAV_REFRESH_MS) refreshLibraryBadges();
    }

    D.refreshLibraryBadges = refreshLibraryBadges;
    JDM.session.onUserChange('deletion-library-badges', () => {
        schedules.clear(); inFlight = null; stale = false; render();
        refreshLibraryBadges();
    });
    JDM.dom.onBodyMutation('deletion-library-badges', scheduleRender);
    JDM.navigation.onNavigate(onNavigate);
    // Network polling is shared with deletion-nav; this timer only ticks labels.
    setInterval(() => {
        if (document.visibilityState === 'visible') scheduleRender();
    }, 60000);
    refreshLibraryBadges();
})();
