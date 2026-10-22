// @ts-check
// Web/deletion-cards.js
//
// D.createRequestCard — the poster card shared by every deletion dashboard
// tab. Built with createElement/textContent only (request text
// such as ItemName/RequesterName is user- or filesystem-controlled).
// Uses Jellyfin's native card skeleton classes so sizing/hover/responsive
// grid come for free; only jdm-* additions are new.
(function () {
    'use strict';

    const JDM = window.JellyfinDeletionManager;
    const D = JDM.deletion;

    /**
     * @param {object} request A DeletionRequest, PascalCase wire fields.
     * @param {object} [options]
     * @param {boolean} [options.isAdmin]
     * @param {boolean} [options.selectable]
     * @param {boolean} [options.selected]
     * @param {(id: *) => void} [options.onOpen]
     * @param {(id: *, checked: boolean) => void} [options.onToggleSelect]
     * @returns {HTMLElement}
     */
    function createRequestCard(request, options) {
        const opts = options || {};

        const root = document.createElement('div');
        root.className = 'card portraitCard card-hoverable jdm-card';
        root.dataset.requestId = request.Id;

        const cardBox = document.createElement('div');
        cardBox.className = 'cardBox cardBox-bottompadded';

        const cardScalable = document.createElement('div');
        cardScalable.className = 'cardScalable';

        const cardPadder = document.createElement('div');
        cardPadder.className = 'cardPadder cardPadder-portrait';
        cardScalable.appendChild(cardPadder);

        const posterButton = document.createElement('button');
        posterButton.type = 'button';
        posterButton.className = 'cardImageContainer coveredImage cardContent jdm-card-poster jdm-card-open';
        // Status is appended to the name: the badge inside this button is
        // hidden from the accessibility tree by the aria-label override.
        const statusForLabel = (D.STATUS_BADGES[D.displayStatus(request)] || { label: D.displayStatus(request) }).label;
        posterButton.setAttribute('aria-label', `Options for ${request.ItemName || ''}, ${statusForLabel}`);
        posterButton.setAttribute('aria-haspopup', 'menu');
        posterButton.addEventListener('click', () => {
            if (typeof opts.onOpen === 'function') opts.onOpen(request.Id, posterButton);
        });

        const showFallbackIcon = () => {
            posterButton.classList.add('jdm-card-noimage');
            posterButton.style.backgroundImage = '';
            const icon = D.makeText('span', String(request.ItemType || '').toLowerCase() === 'movie' ? 'movie' : 'tv', 'material-icons');
            icon.setAttribute('aria-hidden', 'true');
            posterButton.appendChild(icon);
        };
        // Executed items are gone from Jellyfin, so fall back to the poster kept at deletion time.
        D.loadFirstImage(
            [D.posterUrl(request.JellyfinItemId, 400), D.archivedPosterUrl(request.Id)],
            (url) => { posterButton.style.backgroundImage = `url("${url}")`; },
            showFallbackIcon);

        const indicators = document.createElement('div');
        indicators.className = 'cardIndicators';
        const displayStatus = D.displayStatus(request);
        const badgeInfo = D.STATUS_BADGES[displayStatus] || { label: displayStatus, className: 'jdm-badge-neutral' };
        const badge = document.createElement('span');
        badge.className = `jdm-badge ${badgeInfo.className}`;
        badge.textContent = badgeInfo.label;
        indicators.appendChild(badge);
        posterButton.appendChild(indicators);

        cardScalable.appendChild(posterButton);

        if (opts.selectable) {
            const selectLabel = document.createElement('label');
            selectLabel.className = 'jdm-card-select';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', `Select ${request.ItemName || ''}`);
            checkbox.checked = !!opts.selected;
            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('change', () => {
                if (typeof opts.onToggleSelect === 'function') opts.onToggleSelect(request.Id, checkbox.checked);
            });
            selectLabel.addEventListener('click', (e) => e.stopPropagation());
            selectLabel.appendChild(checkbox);
            cardScalable.appendChild(selectLabel);
        }

        cardBox.appendChild(cardScalable);

        const footer = document.createElement('div');
        footer.className = 'cardFooter jdm-card-footer';
        const moreButton = document.createElement('button');
        moreButton.type = 'button';
        moreButton.setAttribute('is', 'paper-icon-button-light');
        moreButton.className = 'itemAction btnCardOptions paper-icon-button-light';
        moreButton.setAttribute('aria-label', `More options for ${request.ItemName || ''}`);
        moreButton.setAttribute('aria-haspopup', 'menu');
        const moreIcon = D.makeText('span', '', 'material-icons more_vert');
        moreIcon.setAttribute('aria-hidden', 'true');
        moreButton.appendChild(moreIcon);
        moreButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof opts.onOpen === 'function') opts.onOpen(request.Id, moreButton);
        });

        footer.appendChild(moreButton);
        cardBox.appendChild(footer);

        const titleEl = document.createElement('div');
        titleEl.className = 'cardText cardText-first';
        titleEl.title = request.ItemName || '';
        titleEl.textContent = request.ItemName || '';
        footer.appendChild(titleEl);

        const scopeLine = document.createElement('div');
        scopeLine.className = 'cardText cardText-secondary';
        const count = Number(request.ItemCount || 0);
        scopeLine.textContent = `${D.scopeLabel(request.ItemType)} · ${count} item${count === 1 ? '' : 's'}`;
        footer.appendChild(scopeLine);

        const requesterLine = document.createElement('div');
        requesterLine.className = 'cardText cardText-secondary';
        requesterLine.textContent = `${request.RequesterName || ''} · ${request.Source || ''}`;
        footer.appendChild(requesterLine);

        const createdLine = document.createElement('div');
        createdLine.className = 'cardText cardText-secondary';
        createdLine.title = D.formatExact(request.CreatedAt);
        createdLine.textContent = `Requested ${D.formatAgo(request.CreatedAt)}`;
        footer.appendChild(createdLine);

        const countdown = D.countdownText(request);
        if (countdown) {
            const countdownLine = document.createElement('div');
            countdownLine.className = 'cardText cardText-secondary jdm-countdown';
            countdownLine.title = D.formatExact(request.ExecuteAt);
            countdownLine.textContent = countdown;
            footer.appendChild(countdownLine);
        } else if (request.Timing) {
            const timingLine = document.createElement('div');
            timingLine.className = 'cardText cardText-secondary';
            timingLine.textContent = `Timing: ${D.timingLabel(request.Timing)}`;
            footer.appendChild(timingLine);
        }

        const actionsEl = document.createElement('div');
        actionsEl.className = 'jdm-card-actions';
        cardBox.appendChild(actionsEl);

        root.appendChild(cardBox);

        return root;
    }

    Object.assign(D, { createRequestCard });

})();
