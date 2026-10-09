// @ts-check
// Web/deletion-styles.js
//
// jdm-* CSS for every deletion UI surface (dashboard, cards, modal,
// drawer, bulk bar, banners). Injects one <style id="jdm-styles">
// into document.head on load. Tokens: spacing rem
// scale, typography (weights 400/600 only), and the locked color roles
// (accent/destructive/warning/success + the neutral panel tone).
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    const STYLE_ID = 'jdm-styles';

    const CSS = `
        /* ---------- Spacing tokens (rem scale) ---------- */
        :root {
            --jdm-space-xs: 0.25rem;
            --jdm-space-sm: 0.5rem;
            --jdm-space-md: 1rem;
            --jdm-space-lg: 1.5rem;
            --jdm-space-xl: 2rem;
            --jdm-space-2xl: 3rem;
            --jdm-space-3xl: 4rem;
            /* jellyfin-web theme palette (the themes' theme.css), with its dark defaults. */
            --jdm-accent: var(--jf-palette-primary-main, #00a4dc);
            --jdm-destructive: var(--jf-palette-error-main, #c62828);
            --jdm-warning: var(--jf-palette-warning-main, #ffb300);
            --jdm-success: var(--jf-palette-success-main, #4caf50);
            --jdm-panel-bg: var(--jf-palette-background-paper, #202020);
            --jdm-panel-border: 1px solid var(--jf-palette-divider, hsla(0, 0%, 100%, 0.12));
            --jdm-text-secondary: var(--jf-palette-text-secondary, hsla(0, 0%, 100%, 0.7));
        }

        /* ---------- Screen-reader-only text ---------- */
        .jdm-sr-only {
            position: absolute !important;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        }

        /* ---------- Status badges ---------- */
        .jdm-badge {
            display: inline-flex;
            align-items: center;
            padding: var(--jdm-space-xs) var(--jdm-space-sm);
            border-radius: 999px;
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1.2;
        }
        .jdm-badge-neutral { background: rgba(0, 0, 0, 0.7); color: var(--jf-palette-text-primary, #fff); }
        .jdm-badge-accent { background: color-mix(in srgb, var(--jdm-accent) 22%, transparent); color: var(--jdm-accent); }
        .jdm-badge-warning { background: color-mix(in srgb, var(--jdm-warning) 22%, transparent); color: var(--jdm-warning); }
        .jdm-badge-destructive { background: color-mix(in srgb, var(--jdm-destructive) 22%, transparent); color: var(--jdm-destructive); }
        .jdm-badge-success { background: color-mix(in srgb, var(--jdm-success) 22%, transparent); color: var(--jdm-success); }
        .jdm-badge-muted { opacity: 0.7; }

        /* ---------- Count badge (top-bar entry) ---------- */
        .jdm-count-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 1.25rem;
            height: 1.25rem;
            padding: 0 var(--jdm-space-xs);
            border-radius: 999px;
            background: var(--jdm-accent);
            color: var(--jf-palette-primary-contrastText, rgba(0, 0, 0, 0.87));
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1.2;
        }

        /* ---------- Dialogs (deletion-modal.js) ----------
           Markup, colors and type come from jellyfin-web's dialog classes;
           this only sizes the box on wide screens (small screens get
           jellyfin-web's own full-screen dialog-fullscreen-lowres). */
        body.jdm-modal-is-open { overflow: hidden; }
        .jdm-dialog {
            width: 36em;
            max-width: 94vw;
            max-height: 90vh;
        }
        .jdm-dialog-drawer { width: 44em; }
        .jdm-dialog .formDialogContent { overflow-y: auto; overscroll-behavior: contain; }
        .jdm-dialog .dialogContentInner { padding-bottom: 1em; }
        .jdm-dialog .formDialogHeaderTitle { overflow-wrap: anywhere; }
        .jdm-modal-summary {
            display: flex;
            align-items: center;
            gap: 1em;
            margin: 0.5em 0 1em;
        }
        .jdm-modal-header-image {
            width: 4em;
            height: 6em;
            border-radius: 0.2em;
            background-size: cover;
            background-position: center;
            flex-shrink: 0;
        }
        .jdm-modal-subtitle { color: var(--jdm-text-secondary); }
        .jdm-modal-error { color: var(--jdm-destructive); margin-top: 1em; }
        .jdm-modal-error:empty { display: none; }
        .jdm-modal-footer { justify-content: flex-end; }
        .jdm-modal-footer .formDialogFooterItem { flex-basis: auto; }

        /* ---------- Episode picker (deletion-request.js) ---------- */
        .jdm-picker .emby-checkbox-label { width: 100%; }
        .jdm-picker-all { margin-bottom: 0.5em; }
        .jdm-picker-list { border-top: var(--jdm-panel-border); }
        .jdm-picker-season { border-bottom: var(--jdm-panel-border); padding: 0.25em 0; }
        .jdm-picker-season-row { display: flex; align-items: center; gap: 0.5em; }
        .jdm-picker-season-row .emby-checkbox-label { flex: 1 1 auto; width: auto; }
        .jdm-picker-count { margin: 0; white-space: nowrap; }
        .jdm-picker-episodes { padding-left: 2em; }
        .jdm-picker-episodes[hidden] { display: none; }
        .jdm-confirm-count { margin: 1em 0; }
        .jdm-reason-container { margin: 1em 0 0; }
        .jdm-reason-container .inputLabel { display: block; margin-bottom: 0.25em; }
        .jdm-dialog textarea.emby-textarea {
            display: block;
            width: 100%;
            box-sizing: border-box;
            padding: 0.4em 0.25em;
            font: inherit;
            resize: vertical;
        }

        /* ---------- Action menu (D.showMenu) ---------- */
        .jdm-menu {
            min-width: 16em;
            max-width: 94vw;
            max-height: 80vh;
            overflow-y: auto;
            padding: 0.5em 0;
        }
        .jdm-menu-positioned { align-items: flex-start; justify-content: flex-start; }
        .jdm-menu-positioned .jdm-menu { position: fixed; margin: 0; }
        .jdm-menu-title { margin: 0.25em 0 0.5em; padding: 0 1em; font-size: 1.1em; font-weight: 400; }
        .jdm-menu-item { margin: 0; padding: 0 0.5em; border: 0; background: transparent; color: inherit; text-align: left; }
        .jdm-menu-item .listItemBody { padding: 0.6em 0.75em; }
        .jdm-menu-item-destructive { color: var(--jdm-destructive); }

        /* ---------- Warning line ---------- */
        .jdm-warning { color: var(--jdm-destructive); }

        /* ---------- Execution-off banner ---------- */
        .jdm-exec-banner {
            display: flex;
            align-items: center;
            gap: var(--jdm-space-sm);
            padding: var(--jdm-space-sm) var(--jdm-space-md);
            background: color-mix(in srgb, var(--jdm-warning) 16%, transparent);
            border-left: 3px solid var(--jdm-warning);
            font-size: 0.875rem;
            flex-wrap: wrap;
        }
        .jdm-exec-banner a {
            display: inline-flex;
            align-items: center;
            min-height: 2.75rem;
            color: var(--jdm-accent);
        }

        /* ---------- Countdown banner ---------- */
        .jdm-countdown-banner {
            display: flex;
            align-items: center;
            gap: var(--jdm-space-sm);
            padding: var(--jdm-space-md);
            background: var(--jdm-panel-bg);
            color: var(--jf-palette-text-primary, #fff);
            border: var(--jdm-panel-border);
            border-radius: 0.2em;
            flex-wrap: wrap;
            overflow-wrap: anywhere;
            min-height: 2.75rem;
            box-sizing: border-box;
        }
        .jdm-countdown { color: var(--jdm-warning); }

        /* ---------- Bulk bar ---------- */
        .jdm-bulk-bar {
            position: sticky;
            bottom: 0;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: var(--jdm-space-md);
            padding: var(--jdm-space-md) var(--jdm-space-xl);
            background: var(--jdm-panel-bg);
            border: var(--jdm-panel-border);
            backdrop-filter: blur(10px);
            z-index: 5;
        }
        .jdm-bulk-bar button { margin: 0; }

        /* ---------- Timing chips (raised emby-buttons) ---------- */
        .jdm-chip {
            margin: 0;
            min-height: 2.5em;
            padding: 0 1em;
            font-size: 0.9em;
        }

        /* ---------- Empty / error state cards ---------- */
        .jdm-state-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--jdm-space-sm);
            padding: var(--jdm-space-2xl) var(--jdm-space-lg);
            background: var(--jdm-panel-bg);
            border: var(--jdm-panel-border);
            border-radius: 0.2em;
            text-align: center;
        }
        .jdm-state-card-heading { font-size: 1.17em; }
        .jdm-state-card-body { color: var(--jdm-text-secondary); }
        .jdm-state-card-action,
        .jdm-home-widget-open {
            min-height: 2.75rem;
            min-width: 2.75rem;
        }

        /* ---------- Drawer (deletion-dashboard-actions.js) ---------- */
        .jdm-drawer-link {
            display: inline-flex;
            align-items: center;
            min-height: 2.75rem;
        }
        .jdm-deny-reason,
        .jdm-confirm-reason {
            display: block;
            width: 100%;
            min-height: 6rem;
            box-sizing: border-box;
            resize: vertical;
        }
        .jdm-confirm-label { display: block; margin-bottom: var(--jdm-space-sm); }
        .jdm-chips { display: flex; flex-wrap: wrap; gap: var(--jdm-space-sm); }
        .jdm-bulk-bar .jdm-chips { flex-basis: 100%; }
        .jdm-destructive-text { color: var(--jdm-destructive) !important; }
        .jdm-deny-button .material-icons + span:not(.jdm-sr-only) { margin-left: var(--jdm-space-xs); }
        .jdm-section-heading { margin: 1em 0 0.5em; }
        .jdm-drawer-header { display: flex; gap: 1rem; align-items: flex-start; }
        .jdm-drawer-header img { width: 6rem; border-radius: 0.25rem; flex-shrink: 0; }
        .jdm-drawer-info { display: flex; flex-direction: column; gap: 0.5rem; }
        .jdm-drawer-title { font-size: 1.17em; }
        .jdm-drawer-details { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 1rem 0 0; }
        .jdm-drawer-details dt { color: var(--jdm-text-secondary); }
        .jdm-drawer-details dd { margin: 0; word-break: break-word; }
        .jdm-drawer-text { white-space: pre-wrap; margin: 0; }
        .jdm-drawer-row { margin-top: 1rem; }
        .jdm-drawer-link { color: var(--jdm-accent); }
        .jdm-timeline { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
        .jdm-timeline li { border-left: 2px solid var(--jf-palette-divider, hsla(0, 0%, 100%, 0.12)); padding-left: 0.75rem; }
        .jdm-timeline-when { color: var(--jdm-text-secondary); }

        /* ---------- Tab strip ---------- */
        .jdm-tabs {
            display: flex;
            flex-wrap: nowrap;
            overflow-x: auto;
            overflow-y: hidden;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: thin;
            max-width: 100%;
        }
        .jdm-tab-button {
            flex: 0 0 auto;
            white-space: nowrap;
            min-height: 2.75rem;
        }

        /* ---------- Toolbar ---------- */
        .jdm-toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: var(--jdm-space-sm);
            align-items: flex-end;
            padding: var(--jdm-space-md) 0;
        }
        .jdm-toolbar-search { flex: 1 1 16rem; min-width: 0; }
        .jdm-search-input {
            width: 100%;
            box-sizing: border-box;
        }
        .jdm-toolbar-filters {
            display: flex;
            flex-wrap: wrap;
            gap: var(--jdm-space-sm);
            min-width: 0;
        }
        .jdm-filter {
            display: flex;
            flex-direction: column;
            gap: var(--jdm-space-xs);
            min-width: 0;
        }
        .jdm-filter-label { font-size: 0.8em; color: var(--jdm-text-secondary); }
        .jdm-filter select { max-width: 100%; padding: 0.4em 0.5em; font: inherit; }

        /* ---------- Poster card additions (deletion-cards.js) ---------- */
        /* No position override: Jellyfin's .cardContent is absolute over
           .cardPadder; making it relative pushed the poster below the padder
           (image clipped, card height doubled). */
        .jdm-card-open {
            display: block;
            width: 100%;
            height: 100%;
            padding: 0;
            border: none;
            background-color: transparent;
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            cursor: pointer;
        }
        .jdm-card-noimage {
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--jdm-panel-bg);
        }
        .jdm-card-footer .btnCardOptions { float: right; margin: 0; }
        .jdm-card-select {
            position: absolute;
            top: var(--jdm-space-xs);
            left: var(--jdm-space-xs);
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 2.75rem;
            min-height: 2.75rem;
            z-index: 2;
        }
        .jdm-card-actions {
            display: flex;
            flex-wrap: wrap;
            gap: var(--jdm-space-xs);
            padding-top: var(--jdm-space-xs);
        }

        /* ---------- Focus visibility ---------- */
        .jdm-chip:focus-visible,
        .jdm-card-open:focus-visible,
        .jdm-card-select input:focus-visible,
        .jdm-tab-button:focus-visible,
        .jdm-search-input:focus-visible,
        .jdm-filter select:focus-visible,
        .jdm-bulk-bar button:focus-visible,
        .jdm-state-card-action:focus-visible,
        .jdm-exec-banner a:focus-visible,
        .jdm-drawer-link:focus-visible,
        .jdm-deny-reason:focus-visible,
        .jdm-confirm-reason:focus-visible,
        .jdm-countdown-banner:focus-visible,
        .jdm-request-button:focus-visible,
        .jdm-topbar-entry:focus-visible,
        .jdm-home-widget-open:focus-visible,
        .jdm-menu-item:focus-visible {
            outline: 2px solid var(--jdm-accent);
            outline-offset: 2px;
        }

        /* ---------- Responsive: full-screen sheets under 600px ---------- */
        @media (max-width: 600px) {
            .jdm-toolbar {
                flex-direction: column;
                align-items: stretch;
            }
            .jdm-toolbar-search { flex: 0 0 auto; width: 100%; }
            .jdm-toolbar-filters {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
            .jdm-filter select { width: 100%; }

            .jdm-bulk-bar {
                position: fixed;
                left: 0;
                right: 0;
                bottom: 0;
                gap: var(--jdm-space-sm);
                padding: var(--jdm-space-sm) var(--jdm-space-md);
                padding-bottom: calc(var(--jdm-space-sm) + env(safe-area-inset-bottom, 0px));
                border-left: none;
                border-right: none;
                background: var(--jdm-panel-bg);
                max-height: 60vh;
                overflow-y: auto;
                box-sizing: border-box;
                z-index: 999;
            }
            .jdm-bulk-bar > button { flex: 1 1 auto; }
            .jdm-dashboard:has(.jdm-bulk-bar) { padding-bottom: 10rem; }

            .jdm-card-actions .jdm-chip {
                flex: 1 1 auto;
                padding: 0 var(--jdm-space-sm);
            }
            .jdm-exec-banner { align-items: flex-start; }
        }

        /* ---------- Reduced motion ---------- */
        @media (prefers-reduced-motion: reduce) {
            .jdm-backdrop { transition: none !important; }
        }
    `;

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    ensureStyles();

    Object.assign(D, { ensureStyles });

})();
