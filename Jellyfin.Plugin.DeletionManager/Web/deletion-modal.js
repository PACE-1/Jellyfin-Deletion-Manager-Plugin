// @ts-check
// Web/deletion-modal.js
//
// D.createModal / D.confirmDialog / D.showMenu — dialogs built from
// jellyfin-web's own dialog markup (dialogBackdrop + dialogContainer +
// .dialog.formDialog with formDialogHeader/Content/Footer and raised
// button-submit / button-delete buttons), so fonts, colors and spacing come
// from the active Jellyfin theme instead of plugin CSS.
//
// These dialogs never touch browser history. An earlier version pushed a
// history entry per modal and undid it with history.back(); when Jellyfin's
// router or its Escape/Back handling also reacted, the page navigated away
// ("Page not found") or the swallow counter got out of step and later
// dialogs would not open. Now:
//  - Escape (window capture phase) and the header back arrow close the top
//    dialog without Jellyfin seeing the key;
//  - any route change closes every open dialog, so a browser Back press
//    navigates normally and never leaves a dialog stranded on another page.
// `body` is always a DOM Node appended via appendChild — no HTML-string
// content path for caller data.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    let modalIdSeq = 0;
    // Top-most dialog is last. Keyboard handling and outside clicks only act
    // on the top-most entry, so a confirm opened over a drawer closes alone.
    const modalStack = [];

    const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    /**
     * Visible, enabled, tabbable elements inside root, in DOM order.
     * @param {HTMLElement} root
     * @returns {HTMLElement[]}
     */
    function focusableIn(root) {
        return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE))).filter(el => {
            if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
            if (el.closest('[hidden]')) return false;
            return el.getClientRects().length > 0;
        });
    }

    /**
     * Parses a single element from trusted static markup so `is="..."`
     * custom elements (emby-button, paper-icon-button-light, emby-checkbox)
     * upgrade exactly like jellyfin-web's own templates.
     * @param {string} html Static markup only — never caller data.
     * @returns {HTMLElement}
     */
    function fromHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html.trim();
        return /** @type {HTMLElement} */ (tmp.firstElementChild);
    }

    /**
     * A jellyfin-web footer button: raised + button-submit (accent),
     * button-delete (destructive) or button-cancel (secondary).
     * @param {string} text
     * @param {'accent'|'destructive'|'secondary'} kind
     * @returns {HTMLButtonElement}
     */
    function footerButton(text, kind) {
        const cls = kind === 'destructive' ? 'button-delete' : kind === 'secondary' ? 'button-cancel' : 'button-submit';
        const button = /** @type {HTMLButtonElement} */ (fromHtml(
            `<button is="emby-button" type="button" class="raised ${cls} block formDialogFooterItem emby-button"><span></span></button>`));
        /** @type {HTMLElement} */ (button.firstElementChild).textContent = text;
        return button;
    }

    function topEntry() {
        return modalStack[modalStack.length - 1] || null;
    }

    function isEditable(target) {
        const el = /** @type {HTMLElement|null} */ (target);
        if (!el) return false;
        if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
        // Checkboxes and buttons don't take text, so Backspace there means Back.
        return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset)$/i.test(/** @type {HTMLInputElement} */ (el).type);
    }

    // Capture phase on window runs before jellyfin-web's own keydown
    // handlers, whose Escape/Back mapping would otherwise navigate the page.
    window.addEventListener('keydown', (e) => {
        const entry = topEntry();
        if (!entry) return;
        if (e.key === 'Escape' || e.key === 'Esc' || (e.key === 'Backspace' && !isEditable(e.target))) {
            e.preventDefault();
            e.stopImmediatePropagation();
            entry.close();
            return;
        }
        if (e.key === 'Tab') entry.trapTab(e);
    }, true);

    /** Closes every open dialog (route change / page swap). */
    function closeAll() {
        for (let i = modalStack.length - 1; i >= 0; i--) modalStack[i].close();
    }

    JDM.navigation.onNavigate(closeAll);

    /**
     * @param {object} options
     * @param {string} options.title
     * @param {string} [options.subtitle]
     * @param {string} [options.imageUrl]
     * @param {Node} options.body A DOM Node appended via appendChild.
     * @param {string} [options.primaryText] Omit to render no primary button (read-only drawers).
     * @param {'accent'|'destructive'} [options.primaryVariant='accent']
     * @param {string} options.secondaryText Required — a bare "Cancel" must never ship.
     * @param {(ctx: {close: Function, setBusy: (busy: boolean) => void, setError: (text: string) => void}) => void} [options.onPrimary]
     * @param {Function} [options.onClose]
     * @param {'modal'|'drawer'} [options.variant='modal']
     * @param {'auto'|'secondary'} [options.initialFocus='auto'] 'auto' = first
     *   field/button in the body, else the safe (secondary) button;
     *   'secondary' = always the safe dismiss button (confirm dialogs).
     * @returns {{ element: HTMLElement, show: Function, close: Function }}
     */
    function createModal(options) {
        const {
            title,
            subtitle,
            imageUrl,
            body,
            primaryText,
            primaryVariant = 'accent',
            secondaryText,
            onPrimary,
            onClose,
            variant = 'modal',
            initialFocus = 'auto',
        } = options || {};

        if (!secondaryText) {
            throw new Error('D.createModal: secondaryText is required (no bare "Cancel" may ship)');
        }

        const modalId = `jdm-modal-title-${++modalIdSeq}`;
        const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);

        const backdrop = document.createElement('div');
        backdrop.className = 'dialogBackdrop jdm-backdrop';

        const container = document.createElement('div');
        container.className = 'dialogContainer jdm-modal';

        const dialog = document.createElement('div');
        dialog.className = variant === 'drawer'
            ? 'focuscontainer dialog formDialog dialog-fullscreen-lowres jdm-dialog jdm-dialog-drawer'
            : 'focuscontainer dialog formDialog jdm-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', modalId);
        dialog.setAttribute('tabindex', '-1');

        const header = document.createElement('div');
        header.className = 'formDialogHeader';
        const backButton = fromHtml(
            '<button is="paper-icon-button-light" type="button" class="btnCancel autoSize paper-icon-button-light"><span class="material-icons arrow_back" aria-hidden="true"></span></button>');
        backButton.setAttribute('title', secondaryText);
        backButton.setAttribute('aria-label', secondaryText);
        header.appendChild(backButton);
        const titleEl = document.createElement('h3');
        titleEl.id = modalId;
        titleEl.className = 'formDialogHeaderTitle jdm-modal-title';
        titleEl.textContent = title || '';
        header.appendChild(titleEl);

        const content = document.createElement('div');
        content.className = 'formDialogContent smoothScrollY';
        const inner = document.createElement('div');
        inner.className = 'dialogContentInner dialog-content-centered jdm-modal-body';

        if (imageUrl || subtitle) {
            const summary = document.createElement('div');
            summary.className = 'jdm-modal-summary';
            if (imageUrl) {
                const thumb = document.createElement('div');
                thumb.className = 'jdm-modal-header-image';
                thumb.style.backgroundImage = `url("${imageUrl}")`;
                summary.appendChild(thumb);
            }
            if (subtitle) {
                const subtitleEl = document.createElement('div');
                subtitleEl.className = 'secondaryText jdm-modal-subtitle';
                subtitleEl.textContent = subtitle;
                summary.appendChild(subtitleEl);
            }
            inner.appendChild(summary);
        }
        if (body) inner.appendChild(body);
        content.appendChild(inner);

        const errorEl = document.createElement('div');
        errorEl.className = 'jdm-modal-error';
        errorEl.setAttribute('role', 'alert');
        inner.appendChild(errorEl);

        const footer = document.createElement('div');
        footer.className = 'formDialogFooter formDialogFooter-flex jdm-modal-footer';
        const secondaryBtn = footerButton(secondaryText, 'secondary');
        footer.appendChild(secondaryBtn);
        let primaryBtn = null;
        if (primaryText) {
            primaryBtn = footerButton(primaryText, primaryVariant === 'destructive' ? 'destructive' : 'accent');
            footer.appendChild(primaryBtn);
        }

        dialog.appendChild(header);
        dialog.appendChild(content);
        dialog.appendChild(footer);
        container.appendChild(dialog);

        let isOpen = false;

        function trapTab(e) {
            const list = focusableIn(dialog);
            if (list.length === 0) {
                e.preventDefault();
                dialog.focus();
                return;
            }
            const first = list[0];
            const last = list[list.length - 1];
            const active = document.activeElement;
            const outside = !dialog.contains(active) || list.indexOf(/** @type {HTMLElement} */ (active)) === -1;
            if (e.shiftKey) {
                if (active === first || outside) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (active === last || outside) {
                e.preventDefault();
                first.focus();
            }
        }

        function setBusy(busy) {
            secondaryBtn.disabled = !!busy;
            if (primaryBtn) primaryBtn.disabled = !!busy;
            dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
        }

        function setError(text) {
            errorEl.textContent = text || '';
            if (text) errorEl.scrollIntoView({ block: 'nearest' });
        }

        function show() {
            if (isOpen) return;
            isOpen = true;
            document.body.appendChild(backdrop);
            document.body.appendChild(container);
            document.body.classList.add('jdm-modal-is-open');
            modalStack.push(entry);
            requestAnimationFrame(() => {
                backdrop.classList.add('dialogBackdropOpened');
                container.classList.add('show');
                let target = null;
                if (initialFocus !== 'secondary') target = focusableIn(inner)[0] || null;
                if (!target && !secondaryBtn.disabled) target = secondaryBtn;
                if (target) target.focus();
                else dialog.focus();
            });
        }

        function close() {
            if (!isOpen) return;
            isOpen = false;

            const idx = modalStack.indexOf(entry);
            if (idx !== -1) modalStack.splice(idx, 1);
            if (modalStack.length === 0) document.body.classList.remove('jdm-modal-is-open');

            // Remove synchronously: nothing invisible may stay on top of the
            // page and swallow clicks, even if a timer never fires.
            backdrop.remove();
            container.remove();

            if (previouslyFocused && document.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch (err) { /* element went away */ }
            }
            if (typeof onClose === 'function') {
                try { onClose(); } catch (err) { console.error('Jellyfin Deletion Manager: Deletion Modal: onClose handler failed:', err); }
            }
        }

        secondaryBtn.addEventListener('click', () => close());
        backButton.addEventListener('click', () => close());
        // A click on the container itself (outside the dialog box) dismisses.
        container.addEventListener('click', (e) => { if (e.target === container && topEntry() === entry) close(); });
        if (primaryBtn) {
            primaryBtn.addEventListener('click', () => {
                if (typeof onPrimary === 'function') onPrimary({ close, setBusy, setError });
            });
        }

        const entry = { close, trapTab };

        return { element: container, show, close };
    }

    /**
     * @param {object} options
     * @param {string} options.title
     * @param {string} options.message
     * @param {string} options.confirmText Required.
     * @param {string} options.cancelText Required.
     * @param {boolean} [options.destructive]
     * @returns {Promise<boolean>} Resolves true when confirmed, false otherwise.
     */
    function confirmDialog(options) {
        const { title, message, confirmText, cancelText, destructive } = options || {};
        if (!confirmText || !cancelText) {
            throw new Error('D.confirmDialog: confirmText and cancelText are both required');
        }
        return new Promise((resolve) => {
            let resolved = false;
            const bodyEl = document.createElement('p');
            bodyEl.textContent = message || '';

            const { show } = createModal({
                title,
                body: bodyEl,
                primaryText: confirmText,
                primaryVariant: destructive ? 'destructive' : 'accent',
                secondaryText: cancelText,
                initialFocus: 'secondary',
                onPrimary: (ctx) => {
                    resolved = true;
                    resolve(true);
                    ctx.close();
                },
                onClose: () => {
                    if (!resolved) resolve(false);
                },
            });
            show();
        });
    }

    /**
     * A small action menu styled like jellyfin-web's action sheet (icon +
     * label rows), used where the native item menu does not exist (dashboard
     * posters). Closes before running the chosen action.
     * @param {object} options
     * @param {string} [options.title]
     * @param {Array<{icon: string, text: string, destructive?: boolean, onSelect: Function}>} options.items
     * @param {HTMLElement} [options.anchor] Positions the menu over this element on wide screens.
     * @returns {{close: Function}}
     */
    function showMenu(options) {
        const { title, items, anchor } = options || {};
        const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);

        const backdrop = document.createElement('div');
        backdrop.className = 'dialogBackdrop jdm-backdrop';
        const container = document.createElement('div');
        container.className = 'dialogContainer jdm-modal';

        const sheet = document.createElement('div');
        sheet.className = 'focuscontainer dialog jdm-menu';
        sheet.setAttribute('role', 'menu');
        if (title) {
            const heading = document.createElement('h2');
            heading.className = 'jdm-menu-title';
            heading.textContent = title;
            sheet.setAttribute('aria-label', title);
            sheet.appendChild(heading);
        }

        const list = document.createElement('div');
        list.className = 'jdm-menu-list';
        (items || []).forEach(item => {
            const row = fromHtml(
                '<button is="emby-button" type="button" class="listItem listItem-button jdm-menu-item emby-button" role="menuitem">'
                + '<span class="material-icons listItemIcon listItemIcon-transparent" aria-hidden="true"></span>'
                + '<div class="listItemBody"><div class="listItemBodyText"></div></div>'
                + '</button>');
            /** @type {HTMLElement} */ (row.querySelector('.listItemIcon')).classList.add(item.icon);
            /** @type {HTMLElement} */ (row.querySelector('.listItemBodyText')).textContent = item.text;
            if (item.destructive) row.classList.add('jdm-menu-item-destructive');
            row.addEventListener('click', () => {
                close();
                try { item.onSelect(); } catch (err) { console.error('Jellyfin Deletion Manager: Deletion menu action failed:', err); }
            });
            list.appendChild(row);
        });
        sheet.appendChild(list);
        container.appendChild(sheet);

        let isOpen = true;
        function close() {
            if (!isOpen) return;
            isOpen = false;
            const idx = modalStack.indexOf(entry);
            if (idx !== -1) modalStack.splice(idx, 1);
            if (modalStack.length === 0) document.body.classList.remove('jdm-modal-is-open');
            backdrop.remove();
            container.remove();
            if (previouslyFocused && document.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch (err) { /* element went away */ }
            }
        }
        function trapTab(e) {
            const rows = focusableIn(sheet);
            if (!rows.length) return;
            const i = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            e.preventDefault();
            rows[(i + (e.shiftKey ? -1 : 1) + rows.length) % rows.length].focus();
        }
        const entry = { close, trapTab };

        container.addEventListener('click', (e) => { if (e.target === container) close(); });
        sheet.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const rows = focusableIn(sheet);
            if (!rows.length) return;
            const i = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            e.preventDefault();
            rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(container);
        document.body.classList.add('jdm-modal-is-open');
        modalStack.push(entry);

        // Wide screens: open over the poster like jellyfin-web's positioned
        // action sheet. Narrow screens: centered (CSS default).
        if (anchor && window.innerWidth > 600) {
            const rect = anchor.getBoundingClientRect();
            container.classList.add('jdm-menu-positioned');
            const width = sheet.offsetWidth;
            const height = sheet.offsetHeight;
            const left = Math.min(Math.max(10, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 10);
            const top = Math.min(Math.max(10, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 10);
            sheet.style.left = `${left}px`;
            sheet.style.top = `${top}px`;
        }

        requestAnimationFrame(() => {
            backdrop.classList.add('dialogBackdropOpened');
            container.classList.add('show');
            const first = focusableIn(sheet)[0];
            if (first) first.focus();
        });
        return { close };
    }

    /**
     * Kept for older callers; dialogs no longer own history entries, so no
     * popstate ever belongs to them.
     * @returns {boolean}
     */
    function handleModalPopstate() {
        return false;
    }

    Object.assign(D, { createModal, confirmDialog, showMenu, closeAllModals: closeAll, handleModalPopstate });
    JDM.session.onUserChange('deletion-modals', closeAll);

})();
