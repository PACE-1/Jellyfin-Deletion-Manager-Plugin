// @ts-check
// Web/deletion-nav.js
//
// Top-bar "Deletion Requests" entry, count badge and compact home widget.
//
// The entry is registered through JDM.nativeTabs (Home page
// `.emby-tabs-slider`), then decorated and moved to sit right after the
// Shows button. native-tabs.js already gives the button a
// stable id (`jdm-native-tab-btn-<id>`), so it needs no change. On Jellyfin
// 12's experimental layout native-tabs.js adds a header-tray fallback link
// (`jdm-native-tab-link-<id>`); it gets the same class, so the same click
// interception opens the dashboard instead of an empty tab panel. That link
// is moved after the header's Shows link when one exists.
//
// Clicks never assign the URL fragment; they call D.showDashboard(), which
// uses history.pushState.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    const TAB_ID = 'deletion-requests';
    const LABEL = 'Deletion Requests';
    const ICON = 'delete_sweep';
    const ENTRY_CLASS = 'jdm-topbar-entry';
    const BADGE_CLASS = 'jdm-count-badge';
    const WIDGET_CLASS = 'jdm-home-widget';
    const NAV_THROTTLE_MS = 10000;
    // Background badge poll while the tab is visible, so new requests show up without navigation.
    const BADGE_POLL_MS = 15000;

    const badgeState = {
        count: 0,
        isAdmin: false,
        inFlight: null,
        lastFetch: 0,
    };

    // ============================================================
    // Styles (nav-only rules; shared tokens live in deletion-styles.js)
    // ============================================================

    function ensureNavStyles() {
        if (typeof D.ensureStyles === 'function') D.ensureStyles();
        if (document.getElementById('jdm-nav-styles')) return;
        const style = document.createElement('style');
        style.id = 'jdm-nav-styles';
        style.textContent = `
            .${ENTRY_CLASS} .emby-button-foreground {
                display: inline-flex;
                align-items: center;
                gap: var(--jdm-space-xs, 0.25rem);
            }
            .${ENTRY_CLASS} .material-icons { font-size: 1.2em; }
            /* Header-tray link starts as a round paper-icon-button; make it a
               labelled rectangle so the text is not clipped. */
            button.${ENTRY_CLASS}.headerButton {
                display: inline-flex !important;
                align-items: center;
                justify-content: flex-start;
                gap: var(--jdm-space-xs, 0.25rem);
                flex: 0 0 auto !important;
                align-self: stretch;
                width: auto !important;
                min-width: max-content !important;
                max-width: none !important;
                height: auto !important;
                margin: 0 !important;
                padding: 0 0.75em !important;
                border-radius: 0 !important;
                background: transparent !important;
                color: inherit !important;
                font: inherit;
                overflow: visible !important;
                white-space: nowrap;
                line-height: 1.2;
            }
            button.${ENTRY_CLASS}.headerButton:hover,
            button.${ENTRY_CLASS}.headerButton:focus-visible {
                background: rgba(255, 255, 255, 0.08) !important;
                color: inherit !important;
            }
            button.${ENTRY_CLASS}.headerButton .jdm-topbar-label { font-size: 1em; }
            .${ENTRY_CLASS} .${BADGE_CLASS}[hidden],
            .${WIDGET_CLASS} .${BADGE_CLASS}[hidden] { display: none; }
            .${WIDGET_CLASS} {
                display: flex;
                align-items: center;
                gap: var(--jdm-space-sm, 0.5rem);
                margin: var(--jdm-space-sm, 0.5rem) 3.3% var(--jdm-space-md, 1rem);
                padding: var(--jdm-space-sm, 0.5rem) var(--jdm-space-md, 1rem);
                background: var(--jdm-panel-bg, rgba(255, 255, 255, 0.04));
                border: var(--jdm-panel-border, 1px solid rgba(255, 255, 255, 0.14));
                border-radius: 0.5em;
            }
            .${WIDGET_CLASS} .jdm-home-widget-title { font-weight: 600; }
            .${WIDGET_CLASS} .jdm-home-widget-open { margin: 0 0 0 auto; }
            @media (max-width: 600px) {
                .${ENTRY_CLASS} { min-width: 2.75rem; min-height: 2.75rem; }
                .${ENTRY_CLASS} .jdm-topbar-label {
                    position: absolute !important;
                    width: 1px; height: 1px;
                    padding: 0; margin: -1px;
                    overflow: hidden;
                    clip: rect(0, 0, 0, 0);
                    white-space: nowrap;
                    border: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // Shared pieces
    // ============================================================

    function makeIcon() {
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = ICON;
        return icon;
    }

    function makeBadge() {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.setAttribute('aria-hidden', 'true');
        badge.hidden = true;
        return badge;
    }

    function ariaLabel() {
        if (badgeState.count <= 0) return LABEL;
        return `${LABEL}, ${badgeState.count} ${badgeState.isAdmin ? 'pending' : 'active'}`;
    }

    function openDashboard() {
        if (typeof D.showDashboard === 'function') D.showDashboard();
    }

    // ============================================================
    // Top-bar entry
    // ============================================================

    function findShowsButton(slider) {
        const buttons = slider.querySelectorAll('.emby-tab-button');
        for (const btn of buttons) {
            if (btn.classList.contains(ENTRY_CLASS)) continue;
            if (/^(shows|tv shows)$/i.test((btn.textContent || '').trim())) return btn;
        }
        return null;
    }

    function decorate(el, withLabelInForeground) {
        if (el.dataset.jdmDecorated === '1') return;
        el.dataset.jdmDecorated = '1';
        el.classList.add(ENTRY_CLASS);
        el.title = LABEL;
        el.setAttribute('aria-label', ariaLabel());

        const host = withLabelInForeground
            ? (el.querySelector('.emby-button-foreground') || el)
            : el;
        while (host.firstChild) host.removeChild(host.firstChild);
        host.appendChild(makeIcon());
        const label = document.createElement('span');
        label.className = 'jdm-topbar-label';
        label.textContent = LABEL;
        host.appendChild(label);
        host.appendChild(makeBadge());
        applyBadge();
    }

    function ensureEntry() {
        const btn = document.getElementById(`jdm-native-tab-btn-${TAB_ID}`);
        if (btn) {
            decorate(btn, true);
            const slider = btn.parentElement;
            const shows = slider ? findShowsButton(slider) : null;
            if (shows && shows.nextElementSibling !== btn) {
                shows.insertAdjacentElement('afterend', btn);
            }
        }
        // Experimental-layout header-tray fallback link created by native-tabs.js.
        const link = document.getElementById(`jdm-native-tab-link-${TAB_ID}`);
        if (link) {
            decorate(link, false);
            const shows = findHeaderShows();
            if (shows && shows.nextElementSibling !== link) {
                shows.insertAdjacentElement('afterend', link);
            }
        }
    }

    /** Visible "Shows" button/link in the page header (any layout), or null. */
    function findHeaderShows() {
        const els = document.querySelectorAll(
            '.skinHeader a, .skinHeader button, .MuiAppBar-root a, .MuiAppBar-root button, header a, header button');
        for (const el of els) {
            if (el.classList.contains(ENTRY_CLASS) || el.offsetParent === null) continue;
            if (/^(shows|tv shows)$/i.test((el.textContent || '').trim())) return el;
        }
        return null;
    }

    /**
     * Capture phase on document so this runs before Jellyfin's emby-tabs
     * click handler (and native-tabs.js's fallback-link handler) ever see the
     * event — the empty tab panel is never activated.
     */
    function onDocumentClick(event) {
        const target = /** @type {HTMLElement|null} */ (event.target);
        const entry = target && typeof target.closest === 'function' ? target.closest(`.${ENTRY_CLASS}`) : null;
        if (!entry) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openDashboard();
    }

    // ============================================================
    // Home widget
    // ============================================================

    function isOnHomePage() {
        const hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') === 0 || hash.indexOf('#/home.html?') === 0;
    }

    function findHomeAnchor() {
        const page = document.querySelector('#indexPage:not(.hide)');
        if (!page) return null;
        const sections = page.querySelector('.homeSectionsContainer');
        if (sections) return { parent: sections.parentElement, before: sections.nextSibling };
        const padded = page.querySelector('.padded-left');
        if (padded) return { parent: padded, before: null };
        return null;
    }

    function buildWidget() {
        const section = document.createElement('section');
        section.className = WIDGET_CLASS;
        section.setAttribute('aria-label', LABEL);

        section.appendChild(makeIcon());
        const title = document.createElement('span');
        title.className = 'jdm-home-widget-title';
        title.textContent = LABEL;
        section.appendChild(title);
        section.appendChild(makeBadge());

        const open = document.createElement('button');
        open.type = 'button';
        open.setAttribute('is', 'emby-button');
        open.className = 'emby-button raised jdm-home-widget-open';
        open.textContent = 'Open Deletion Requests';
        open.addEventListener('click', event => {
            event.preventDefault();
            openDashboard();
        });
        section.appendChild(open);
        return section;
    }

    function ensureHomeWidget() {
        if (!isOnHomePage()) return;
        const page = document.querySelector('#indexPage:not(.hide)');
        if (!page || page.querySelector(`.${WIDGET_CLASS}`)) return;
        const anchor = findHomeAnchor();
        if (!anchor || !anchor.parent) return;
        // Inserted as a sibling after .homeSectionsContainer (not inside it):
        // Jellyfin re-renders that container wholesale, which would wipe the widget.
        anchor.parent.insertBefore(buildWidget(), anchor.before || null);
        applyBadge();
    }

    // ============================================================
    // Badge
    // ============================================================

    function applyBadge() {
        const count = badgeState.count;
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach(badge => {
            // Only our nav badges (entry + widget); the dashboard may reuse the class.
            if (!badge.closest(`.${ENTRY_CLASS}, .${WIDGET_CLASS}`)) return;
            badge.textContent = count > 0 ? String(count) : '';
            badge.hidden = count <= 0;
        });
        const label = ariaLabel();
        document.querySelectorAll(`.${ENTRY_CLASS}`).forEach(el => el.setAttribute('aria-label', label));
    }

    function countFor(rows, isAdmin) {
        if (!Array.isArray(rows)) return 0;
        if (isAdmin) return rows.filter(r => r && r.Status === 'Pending').length;
        // Server already filters non-admin lists to the caller's own rows.
        return rows.filter(r => r && (r.Status === 'Pending' || r.Status === 'Approved') && !r.ExecutedAt).length;
    }

    /**
     * Always fetches unless a fetch is already in flight (the dashboard calls this
     * after every dashboard action). Keeps the last value on error.
     * @returns {Promise<number>}
     */
    function refreshBadge() {
        if (typeof D.refreshLibraryBadges === 'function') D.refreshLibraryBadges();
        if (badgeState.inFlight) return badgeState.inFlight;
        badgeState.inFlight = (async () => {
            const identity = D.identityToken();
            try {
                const [rows, isAdmin] = await Promise.all([D.api.list(), D.resolveIsAdmin()]);
                if (identity !== D.identityToken()) return badgeState.count;
                badgeState.isAdmin = isAdmin === true;
                badgeState.count = countFor(rows, badgeState.isAdmin);
                applyBadge();
            } catch (error) {
                console.warn('Jellyfin Deletion Manager: [deletion-nav] badge refresh failed', error);
            } finally {
                if (identity === D.identityToken()) {
                    badgeState.lastFetch = Date.now();
                    badgeState.inFlight = null;
                }
            }
            return badgeState.count;
        })();
        return badgeState.inFlight;
    }

    /** Navigation/focus path: skip if in flight or last fetch < 10 s ago. */
    function refreshBadgeThrottled() {
        if (badgeState.inFlight) return;
        if (Date.now() - badgeState.lastFetch < NAV_THROTTLE_MS) return;
        refreshBadge();
    }

    // ============================================================
    // Wiring
    // ============================================================

    let domPending = false;
    function scheduleDom() {
        if (domPending) return;
        domPending = true;
        requestAnimationFrame(() => {
            domPending = false;
            ensureEntry();
            ensureHomeWidget();
        });
    }

    function onNavigate() {
        scheduleDom();
        refreshBadgeThrottled();
    }

    Object.assign(D, { refreshBadge });
    JDM.session.onUserChange('deletion-nav', () => {
        Object.assign(badgeState, { count: 0, isAdmin: false, lastFetch: 0, inFlight: null });
        applyBadge();
    });

    function init() {
        if (!D.api || typeof D.api.list !== 'function') {
            console.warn('Jellyfin Deletion Manager: [deletion-nav] deletion state not loaded, top-bar entry disabled');
            return;
        }
        ensureNavStyles();
        document.addEventListener('click', onDocumentClick, true);

        // Panel stays empty: clicks are intercepted and open the dashboard page.
        JDM.nativeTabs.register(TAB_ID, LABEL, function () { /* no panel content */ }, ICON);

        JDM.dom.onBodyMutation('deletion-nav', scheduleDom);
        JDM.navigation.onNavigate(onNavigate);
        window.addEventListener('focus', refreshBadgeThrottled);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshBadgeThrottled();
        });
        setInterval(() => {
            if (document.visibilityState === 'visible' && !badgeState.inFlight) refreshBadge();
        }, BADGE_POLL_MS);

        scheduleDom();
        refreshBadge();
    }

    init();

})();
