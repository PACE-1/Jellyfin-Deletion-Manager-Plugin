// @ts-check
// Web/deletion-menu.js
//
// Adds "Request deletion" to jellyfin-web's own item menu (the action sheet)
// wherever it opens for a movie, series, season or episode: a card's "…"
// button, a list row's "…" button, right-click / long-press on a card, and
// the detail page's "More" button.
//
// The item is captured when the menu
// is triggered (the only moment the source card is known), and the entry is
// injected into the sheet on the frame it appears, built with
// JDM.actionSheet.buildItem so it matches the native rows exactly.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    const ITEM_DATA_ID = 'jdm-request-deletion';
    const CONTEXT_TTL_MS = 5000;
    // Rows only the per-item menu has; sort/OSD/library menus have none.
    const ITEM_SHEET_IDS = ['addtoplaylist', 'addtocollection', 'moremediainfo', 'instantmix', 'queue', 'shuffle',
        'share', 'identify', 'editimages', 'copy-stream', 'playallfromhere', 'resume', 'play', 'download', 'markplayed', 'markunplayed'];
    const SUPPORTED = new Set(['Movie', 'Series', 'Season', 'Episode']);

    /** @type {{itemId: string, type: Promise<string|null>, ts: number}|null} */
    let context = null;
    let injecting = false;
    JDM.session.onUserChange('deletion-menu', () => { context = null; });

    /** Resolves an item's Type (card attribute first, else a cached item fetch). */
    function resolveType(itemId, hint) {
        if (hint) return Promise.resolve(hint);
        return Promise.resolve(JDM.items.get(itemId)).then(item => (item && item.Type) || null).catch(() => null);
    }

    function capture(itemId, typeHint) {
        if (!itemId) { context = null; return; }
        context = { itemId, type: resolveType(itemId, typeHint), ts: Date.now() };
    }

    function detailItemId() {
        if (!document.querySelector('#itemDetailPage:not(.hide)')) return null;
        return new URLSearchParams(window.location.hash.split('?')[1] || '').get('id');
    }

    function isInsideOpenMenu(target) {
        return !!(target.closest && target.closest('.actionSheetContent, .actionSheet, .dialogContainer, dialog'));
    }

    /** @param {Element|null} el */
    function captureFromElement(el) {
        const holder = el && el.closest('.card[data-id], .listItem[data-id], [data-id][data-type]');
        if (!holder) { context = null; return; }
        const id = /** @type {HTMLElement} */ (holder).dataset.id;
        const type = /** @type {HTMLElement} */ (holder).dataset.type || null;
        if (type && !SUPPORTED.has(type)) { context = null; return; }
        capture(id || null, type);
    }

    // Capture phase so the context exists before jellyfin-web opens the sheet.
    document.addEventListener('mousedown', (e) => {
        const target = /** @type {Element} */ (e.target);
        if (!target || !target.closest || isInsideOpenMenu(target)) return;
        if (target.closest('.btnMoreCommands')) {
            capture(detailItemId(), null);
            return;
        }
        const menuButton = target.closest('button[data-action="menu"], .btnCardOptions, .listItemButton[data-action="menu"]');
        if (menuButton) captureFromElement(menuButton);
    }, true);

    // Touch devices fire no mousedown before a tap on some browsers.
    document.addEventListener('touchstart', (e) => {
        const target = /** @type {Element} */ (e.target);
        if (!target || !target.closest || isInsideOpenMenu(target)) return;
        if (target.closest('.btnMoreCommands')) { capture(detailItemId(), null); return; }
        const menuButton = target.closest('button[data-action="menu"], .btnCardOptions');
        if (menuButton) { captureFromElement(menuButton); return; }
        // Long-press on a card opens the same item menu.
        const card = target.closest('.card[data-id], .listItem[data-id]');
        if (card) captureFromElement(card);
    }, { capture: true, passive: true });

    document.addEventListener('contextmenu', (e) => {
        const target = /** @type {Element} */ (e.target);
        if (!target || !target.closest || isInsideOpenMenu(target)) return;
        captureFromElement(target.closest('.card[data-id], .listItem[data-id]'));
    }, true);

    function isItemSheet(scroller) {
        return ITEM_SHEET_IDS.some(id => scroller.querySelector(`[data-id="${id}"]`));
    }

    function buildItem(scroller, itemId) {
        const button = JDM.actionSheet.buildItem(scroller, { dataId: ITEM_DATA_ID, icon: 'delete_sweep', text: 'Request deletion' });
        button.dataset.jdmItemId = itemId;
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            JDM.actionSheet.close();
            // Let the sheet finish closing (it restores focus and its own
            // history state) before the request dialog takes focus.
            setTimeout(() => {
                if (typeof D.openRequestDialog === 'function') D.openRequestDialog(itemId);
            }, 200);
        });
        return button;
    }

    async function inject() {
        const scroller = JDM.actionSheet.getActiveScroller();
        if (!scroller) return;
        const existing = scroller.querySelector(`[data-id="${ITEM_DATA_ID}"]`);
        if (!isItemSheet(scroller)) { if (existing) existing.remove(); return; }

        const ctx = context;
        if (!ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) return;
        if (existing && /** @type {HTMLElement} */ (existing).dataset.jdmItemId === ctx.itemId) { context = null; return; }
        if (existing) existing.remove();
        context = null;

        const identity = D.identityToken();
        const type = await ctx.type;
        if (identity !== D.identityToken()) return;
        if (!type || !SUPPORTED.has(type) || !scroller.isConnected) return;
        if (scroller.querySelector(`[data-id="${ITEM_DATA_ID}"]`)) return;

        const button = buildItem(scroller, ctx.itemId);
        const anchor = scroller.querySelector('[data-id="delete"]');
        if (anchor) anchor.after(button);
        else scroller.appendChild(button);
        JDM.actionSheet.fitItemToMenu(button, scroller);
    }

    const SHEET_SELECTOR = '.actionSheet, .actionSheetScroller, .dialogContainer';
    function touchesSheet(mutations) {
        for (const m of mutations) {
            const t = /** @type {Element} */ (m.target);
            if (t && t.closest && t.closest(SHEET_SELECTOR)) return true;
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && (/** @type {Element} */ (node).matches(SHEET_SELECTOR) || /** @type {Element} */ (node).querySelector(SHEET_SELECTOR))) return true;
            }
        }
        return false;
    }

    function onMutations(mutations) {
        if (injecting || !context || !touchesSheet(mutations)) return;
        injecting = true;
        requestAnimationFrame(() => {
            injecting = false;
            inject().catch(err => console.warn('Jellyfin Deletion Manager: [deletion-menu] inject failed', err));
        });
    }

    JDM.dom.onBodyMutation('deletion-menu', onMutations, { priority: 1 });

})();
