const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.DeletionManager/Web');
const episode = id => ({ Id: id, Name: id, SeasonId: 'season', SeasonName: 'Season 1' });
const series = { Id: 'series', Type: 'Series', Name: 'Test show' };

// Native classic homepage/season/episode cards and React Movies/Shows cards
// share cardScalable, but only classic puts cardContent on the image link.
const nativeCard = (id, react = false) => `<div class="card" data-id="${id}"><div class="cardBox"><div class="cardScalable"><div class="cardPadder"></div>${react
    ? '<div class="cardContent"><div class="cardImageContainer coveredImage"><img alt="Poster"></div></div>'
    : '<a class="cardImageContainer coveredImage cardContent" href="#details" aria-label="Test media"></a>'
}<div class="cardOverlayContainer"><a class="cardImageContainer" href="#details"></a><button class="cardOverlayButton">Play</button></div></div><div class="cardText">Test media</div></div></div>`;

function harness(t, { realApi = false, dashboard = false } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/web/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.HTMLElement.prototype.scrollIntoView = () => {};
    let user = { Id: 'admin', Policy: { IsAdministrator: true } };
    const calls = [];
    w.ApiClient = {
        getCurrentUserId: () => user.Id,
        getCurrentUser: async () => user,
        getImageUrl: () => '', accessToken: () => 'fixture-token',
        getUrl: value => value,
        getJSON: async () => ({ Items: [episode('e1'), episode('e2')] }),
    };
    const load = file => w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    load('jdm-core.js');
    const JDM = w.JellyfinDeletionManager;
    if (!realApi) {
        JDM.api.jf = async (url, options = {}) => {
            calls.push({ url, options });
            return options.method === 'POST' ? { Id: 1 } : [];
        };
    }
    load('deletion-state.js');
    load('deletion-modal.js');
    load('deletion-request.js');
    if (dashboard) {
        load('deletion-cards.js');
        load('deletion-dashboard-page.js');
        load('deletion-dashboard-actions.js');
        load('deletion-nav.js');
    }
    t.after(() => dom.window.close());
    return { w, JDM, D: JDM.deletion, calls, load,
        switchUser(next) { user = next; JDM.session.checkNow('test'); },
    };
}

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Condition did not settle');
}
const primary = w => w.document.querySelector('.button-delete');

for (const classic of [true, false]) {
    test(`detail countdown stays outside native action ribbon in ${classic ? 'classic content column' : 'detailPageContent'}`, async t => {
        const { w, D, switchUser } = harness(t);
        const ribbonMarkup = '<div class="detailRibbon"><div class="infoWrapper">Poster</div><div class="detailButtons"><button class="btnPlay">Play</button><button class="btnMoreCommands">More</button></div></div>';
        w.document.body.innerHTML = `<div id="itemDetailPage">${classic
            ? `<div class="detailPagePrimaryContainer"><div class="detailImageContainer">Floating poster</div>${ribbonMarkup}<div class="detailPagePrimaryContent padded-right"><div class="detailSection"><form class="trackSelections">Tracks</form><div class="detailSectionContent">Overview</div></div></div></div>`
            : `<div class="detailPageContent">${ribbonMarkup}<div class="detailOverview">Overview</div></div>`
        }</div>`;
        const mount = w.document.querySelector(classic ? '.detailPagePrimaryContent .detailSection' : '.detailPageContent');
        const ribbon = w.document.querySelector('.detailRibbon');
        const play = ribbon.querySelector('.btnPlay');
        const more = ribbon.querySelector('.btnMoreCommands');
        w.ApiClient.getItem = async () => ({ Id: 'movie', Type: 'Movie', Name: 'Test movie' });
        D.api.list = async () => [{ Id: 41, JellyfinItemId: 'movie', Status: 'Approved', CreatedAt: new Date().toISOString(), ExecuteAt: new Date(Date.now() + 86400000).toISOString() }];
        const opened = [];
        D.openDrawer = id => opened.push(id);
        w.location.hash = '#/details?id=movie';
        await until(() => w.document.querySelector('.jdm-countdown-banner'));
        const banner = w.document.querySelector('.jdm-countdown-banner');
        assert.equal(banner.parentElement, mount);
        assert.equal(mount.firstElementChild, banner);
        if (classic) {
            assert.equal(banner.nextElementSibling, mount.querySelector('.trackSelections'));
            assert.equal(ribbon.nextElementSibling, mount.parentElement);
            assert.equal(w.document.querySelector('.detailImageContainer').nextElementSibling, ribbon);
        }
        assert.equal(ribbon.querySelector('.btnPlay'), play);
        assert.equal(ribbon.querySelector('.btnMoreCommands'), more);
        assert.equal(ribbon.querySelector('.jdm-countdown-banner'), null);
        assert.equal(banner.getAttribute('role'), 'button');
        assert.equal(banner.tabIndex, 0);
        assert.match(banner.getAttribute('aria-label'), /Approved.*Open deletion request/);
        banner.click();
        banner.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.deepEqual(opened, [41, 41]);
        switchUser({ Id: 'user-b', Policy: { IsAdministrator: false } });
        assert.equal(w.document.querySelector('.jdm-countdown-banner'), null);
        assert.equal(w.document.querySelector('.jdm-request-button'), null);
        assert.equal(ribbon.querySelector('.btnPlay'), play);
        assert.equal(ribbon.querySelector('.btnMoreCommands'), more);
    });
}

// The actual HTTP retry machinery must not retry destructive mutations.
test('a lost submission response is attempted once', async t => {
    const { w, D } = harness(t, { realApi: true });
    let commits = 0;
    w.fetch = async () => { commits++; throw new TypeError('response lost after commit'); };
    await assert.rejects(D.api.submit({ itemId: 'movie', itemType: 'movie', expectedItemCount: 1 }));
    assert.equal(commits, 1);
});

test('account switch clears cached admin, requests, selections and open dialogs', async t => {
    const { w, D, switchUser } = harness(t);
    assert.equal(await D.resolveIsAdmin(), true);
    D.state.requests = [{ ItemName: 'Private request' }];
    D.state.selectedIds.add(1);
    D.createModal({ title: 'Private request', secondaryText: 'Close' }).show();
    switchUser({ Id: 'user-b', Policy: { IsAdministrator: false } });
    assert.equal(await D.resolveIsAdmin(), false);
    assert.equal(D.state.requests.length, 0);
    assert.equal(D.state.selectedIds.size, 0);
    assert.equal(w.document.querySelector('.jdm-modal'), null);
});

test('late admin lookup cannot cache the previous identity', async t => {
    const { w, D, switchUser } = harness(t);
    let finish;
    w.ApiClient.getCurrentUser = () => new Promise(resolve => { finish = resolve; });
    const pending = D.resolveIsAdmin();
    switchUser({ Id: 'user-b', Policy: { IsAdministrator: false } });
    finish({ Policy: { IsAdministrator: true } });
    assert.equal(await pending, false);
    assert.equal(D.state.isAdmin, null);
});

test('late request response is discarded and its signal is aborted on account switch', async t => {
    const { JDM, D, switchUser } = harness(t);
    let finish, signal;
    JDM.api.jf = (url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
    const pending = D.api.list();
    switchUser({ Id: 'b', Policy: { IsAdministrator: false } });
    assert.equal(signal.aborted, true);
    finish([{ ItemName: 'Previous user' }]);
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('dialog submits the displayed count and exact episode IDs without refreshing them silently', async t => {
    const { w, D, calls } = harness(t);
    await D.openRequestDialog(series);
    await until(() => primary(w) && !primary(w).disabled);
    assert.equal(w.document.querySelector('.jdm-confirm-count').textContent, '2 episodes will be deleted.');
    primary(w).click();
    await until(() => calls.some(call => call.options.method === 'POST'));
    const post = calls.find(call => call.options.method === 'POST');
    const body = JSON.parse(post.options.body);
    assert.equal(body.expectedItemCount, 2);
    assert.deepEqual(body.expectedItemIds, ['e1', 'e2']);
    assert.equal(calls.some(call => call.url.includes('/scope')), false);
});

test('count/selection conflict refreshes the visible picker and requires another confirmation', async t => {
    const { w, D, JDM } = harness(t);
    let posts = 0;
    JDM.api.jf = async (url, options = {}) => {
        if (options.method !== 'POST') return [];
        posts++;
        if (posts === 1) throw Object.assign(new Error('scope changed'), { status: 409 });
        return { Id: 1 };
    };
    await D.openRequestDialog(series);
    await until(() => primary(w) && !primary(w).disabled);
    w.ApiClient.getJSON = async () => ({ Items: [episode('e1'), episode('e2'), episode('e3')] });
    primary(w).click();
    await until(() => w.document.querySelector('.jdm-confirm-count')?.textContent === '3 episodes will be deleted.' && !primary(w).disabled);
    assert.equal(posts, 1);
    assert.ok(w.document.querySelector('.jdm-modal-error').textContent.includes('Review and send again'));
    primary(w).click();
    await until(() => posts === 2);
});

test('episode-load error stays disabled with a working retry action', async t => {
    const { w, D } = harness(t);
    w.ApiClient.getJSON = async () => { throw new Error('unavailable'); };
    await D.openRequestDialog(series);
    await until(() => w.document.querySelector('.jdm-state-card-action'));
    assert.equal(primary(w).disabled, true);
    assert.ok(!w.document.querySelector('.jdm-confirm-count').textContent.includes('whole item will be requested'));
    w.ApiClient.getJSON = async () => ({ Items: [episode('e1')] });
    w.document.querySelector('.jdm-state-card-action').click();
    await until(() => !primary(w).disabled);
    assert.equal(w.document.querySelector('.jdm-confirm-count').textContent, '1 episode will be deleted.');
});

test('in-flight episode load cannot reopen old-account dialog after a switch', async t => {
    const { w, D, switchUser } = harness(t);
    let finish;
    w.ApiClient.getJSON = () => new Promise(resolve => { finish = resolve; });
    await D.openRequestDialog(series);
    switchUser({ Id: 'b', Policy: { IsAdministrator: false } });
    finish({ Items: [episode('private')] });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(w.document.querySelector('.jdm-modal'), null);
});

test('double-click during submission cannot send a second request', async t => {
    const { w, D, JDM } = harness(t);
    let posts = 0, finish;
    JDM.api.jf = (url, options = {}) => {
        if (options.method !== 'POST') return Promise.resolve([]);
        posts++; return new Promise(resolve => { finish = resolve; });
    };
    await D.openRequestDialog(series);
    await until(() => primary(w) && !primary(w).disabled);
    primary(w).click(); primary(w).click();
    assert.equal(posts, 1);
    assert.equal(primary(w).disabled, true);
    finish({ Id: 1 });
    await until(() => w.document.querySelector('.jdm-modal') === null);
});

test('account switch removes dashboard rows and clears the navigation badge', async t => {
    const { w, D, JDM, switchUser } = harness(t, { dashboard: true });
    JDM.api.jf = async url => url.includes('/Requests') ? [{ Id: 1, ItemName: 'Private request', ItemType: 'movie', Status: 'Pending', RequesterId: 'admin', ItemCount: 1 }] : [];
    await D.showDashboard();
    await until(() => w.document.getElementById(D.PAGE_ID)?.textContent.includes('Private request'));
    switchUser({ Id: 'b', Policy: { IsAdministrator: false } });
    assert.equal(w.document.getElementById(D.PAGE_ID), null);
    assert.equal(D.state.requests.length, 0);
    assert.equal(D.state.pollTimer, null);
});

test('native media cards show shared approved schedules, normalize IDs and clear after cancellation', async t => {
    const { w, D, JDM, load } = harness(t);
    const id = 'aabbccdd-0000-0000-0000-000000000001';
    const executeAt = new Date(Date.now() + (6 * 24 + 23) * 3600000 + 30000).toISOString();
    let rows = [{ ItemId: id, ExecuteAt: executeAt }];
    D.api.cardStatus = async () => rows;
    const mutations = new Map();
    JDM.dom.onBodyMutation = (name, callback) => mutations.set(name, callback);
    w.document.body.innerHTML = nativeCard('aabbccdd000000000000000000000001') + nativeCard('other', true);
    load('deletion-library-badges.js');
    await until(() => w.document.querySelector('.jdm-library-badge'));
    assert.equal(w.document.querySelector('.jdm-library-countdown').textContent, 'Deletes in 6d 23h');
    assert.match(w.document.querySelector('.jdm-library-badge').getAttribute('aria-label'), /Pending deletion/);
    assert.equal(w.document.querySelectorAll('.jdm-library-badge').length, 1);
    // Home/library cards can be added or reused after SPA navigation.
    const card = w.document.querySelector('.card');
    card.setAttribute('data-id', 'other');
    mutations.get('deletion-library-badges')();
    await until(() => !card.querySelector('.jdm-library-badge'));
    card.setAttribute('data-id', id);
    mutations.get('deletion-library-badges')();
    await until(() => card.querySelector('.jdm-library-badge'));
    rows = [];
    await D.refreshLibraryBadges();
    await until(() => !w.document.querySelector('.jdm-library-badge'));
});

for (const react of [false, true]) {
    test(`${react ? 'React' : 'classic'} card badges preserve native image positioning and controls`, async t => {
        const { w, D, load } = harness(t);
        const nativeStyle = w.document.createElement('style');
        // Native Jellyfin card geometry, captured during the signed-in #30
        // reproduction. jsdom checks the cascade, not actual browser geometry.
        nativeStyle.textContent = '.cardScalable { position: relative; } .cardContent { position: absolute; inset: 0; overflow: hidden; } .cardImageContainer { width: 100%; height: 100%; }';
        w.document.head.appendChild(nativeStyle);
        w.document.body.innerHTML = nativeCard('movie', react);
        const card = w.document.querySelector('.card');
        const image = card.querySelector('.cardImageContainer');
        const content = card.querySelector('.cardContent');
        const imagePosition = w.getComputedStyle(image).position;
        const contentPosition = w.getComputedStyle(content).position;
        const nativeMarkup = card.innerHTML;
        D.api.cardStatus = async () => [{ ItemId: 'movie', ExecuteAt: new Date(Date.now() + 3600000).toISOString() }];
        load('deletion-library-badges.js');
        await until(() => card.querySelector('.jdm-library-badge'));
        const badge = card.querySelector('.jdm-library-badge');
        assert.equal(badge.parentElement, card.querySelector('.cardScalable'));
        assert.equal(w.getComputedStyle(content).position, 'absolute');
        assert.equal(w.getComputedStyle(content).position, contentPosition);
        assert.equal(w.getComputedStyle(image).position, imagePosition);
        assert.equal(w.getComputedStyle(badge).pointerEvents, 'none');
        assert.equal(w.getComputedStyle(badge).position, 'absolute');
        assert.equal(w.getComputedStyle(badge).top, '0.35rem');
        assert.equal(badge.querySelector('.material-icons').getAttribute('aria-hidden'), 'true');
        assert.match(badge.getAttribute('aria-label'), /Deletes in .*Pending deletion:/);
        // The native link, poster and hover controls are unchanged after the
        // overlay is removed, not wrapped or restyled to create badge space.
        badge.remove();
        assert.equal(card.innerHTML, nativeMarkup);
    });
}

test('badges follow replaced poster frames and skip dialogs and the deletion dashboard', async t => {
    const { w, D, JDM, load } = harness(t);
    const mutations = new Map();
    JDM.dom.onBodyMutation = (name, callback) => mutations.set(name, callback);
    D.api.cardStatus = async () => [{ ItemId: 'movie', ExecuteAt: new Date(Date.now() + 3600000).toISOString() }];
    w.document.body.innerHTML = nativeCard('movie')
        + `<div class="formDialog">${nativeCard('movie')}</div>`
        + `<div class="jdm-dashboard-page">${nativeCard('movie')}</div>`;
    load('deletion-library-badges.js');
    await until(() => w.document.querySelector('.jdm-library-badge'));
    assert.equal(w.document.querySelectorAll('.jdm-library-badge').length, 1);
    const card = w.document.querySelector('.card');
    card.innerHTML = w.document.createRange().createContextualFragment(nativeCard('movie', true)).firstChild.innerHTML;
    mutations.get('deletion-library-badges')();
    await until(() => card.querySelector('.jdm-library-badge'));
    assert.equal(w.document.querySelectorAll('.jdm-library-badge').length, 1);
    assert.equal(card.querySelector('.jdm-library-badge').parentElement, card.querySelector('.cardScalable'));
});

test('narrow-card labels expose the duration without the prefix and retain the full accessible schedule', async t => {
    const { w, D, load } = harness(t);
    let executeAt = new Date(Date.now() + (6 * 24 + 23) * 3600000 + 30000).toISOString();
    D.api.cardStatus = async () => [{ ItemId: 'movie', ExecuteAt: executeAt }];
    w.document.body.innerHTML = nativeCard('movie');
    load('deletion-library-badges.js');
    await until(() => w.document.querySelector('.jdm-library-badge'));
    const badge = w.document.querySelector('.jdm-library-badge');
    assert.equal(badge.querySelector('.jdm-library-prefix').textContent, 'Deletes in ');
    assert.equal(badge.querySelector('.jdm-library-duration').textContent, '6d 23h');
    assert.match(badge.getAttribute('aria-label'), /^Deletes in 6d 23h\. Pending deletion:/);
    // jsdom does not emulate viewport media matching. Check the actual mobile
    // rules separately; browser evidence verifies rendered widths at 320/390px.
    const mobile = Array.from(w.document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
        .find(rule => rule.conditionText === '(max-width: 600px)');
    assert.ok(mobile);
    const ruleFor = selector => Array.from(mobile.cssRules).find(rule => rule.selectorText === selector);
    assert.equal(ruleFor('.jdm-library-badge .jdm-library-prefix').style.display, 'none');
    assert.equal(ruleFor('.jdm-library-badge .jdm-library-countdown').style.getPropertyValue('white-space'), 'normal');
    executeAt = new Date(Date.now() - 60000).toISOString();
    await D.refreshLibraryBadges();
    await until(() => badge.querySelector('.jdm-library-duration').textContent === 'Due now');
    assert.equal(badge.querySelector('.jdm-library-prefix').textContent, '');
    assert.match(badge.getAttribute('aria-label'), /^Due now\. Pending deletion:/);
});

test('late card schedules cannot cross an account switch', async t => {
    const { w, D, load, switchUser } = harness(t);
    let finish;
    D.api.cardStatus = () => new Promise(resolve => { finish = resolve; });
    w.document.body.innerHTML = nativeCard('movie');
    load('deletion-library-badges.js');
    const oldFinish = finish;
    switchUser({ Id: 'other', Policy: {} });
    finish([]);
    oldFinish([{ ItemId: 'movie', ExecuteAt: new Date(Date.now() + 3600000).toISOString() }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(w.document.querySelector('.jdm-library-badge'), null);
});

test('a refresh requested while one is in flight refetches so a late approval is not missed (#34)', async t => {
    const { w, D, load } = harness(t);
    const soon = new Date(Date.now() + 3600000).toISOString();
    const resolvers = [];
    let calls = 0;
    D.api.cardStatus = () => { calls++; return new Promise(resolve => resolvers.push(resolve)); };
    w.document.body.innerHTML = nativeCard('movie');
    load('deletion-library-badges.js');
    D.refreshLibraryBadges();
    assert.equal(calls, 1);
    resolvers[0]([]);
    await until(() => calls === 2);
    resolvers[1]([{ ItemId: 'movie', ExecuteAt: soon }]);
    await until(() => w.document.querySelector('.jdm-library-badge'));
});

test('navigating refetches card schedules, throttled, so library pages open with current badges (#34)', async t => {
    const { w, D, JDM, load } = harness(t);
    const navs = [];
    JDM.navigation.onNavigate = callback => navs.push(callback);
    let rows = [];
    let calls = 0;
    D.api.cardStatus = async () => { calls++; return rows; };
    w.document.body.innerHTML = nativeCard('movie');
    load('deletion-library-badges.js');
    await until(() => calls === 1);
    rows = [{ ItemId: 'movie', ExecuteAt: new Date(Date.now() + 3600000).toISOString() }];
    navs.forEach(callback => callback());
    assert.equal(calls, 1);
    await new Promise(resolve => setTimeout(resolve, 2100));
    navs.forEach(callback => callback());
    await until(() => w.document.querySelector('.jdm-library-badge'));
    assert.equal(calls, 2);
});

test('the stylesheet has balanced comments and every theme token survives parsing (a stray */ once dropped --jdm-accent)', async t => {
    const { w } = harness(t);
    w.document.body.innerHTML = '';
    w.eval(fs.readFileSync(path.join(root, 'deletion-styles.js'), 'utf8'));
    const css = w.document.getElementById('jdm-styles').textContent;
    assert.equal(css.replace(/\/\*[\s\S]*?\*\//g, '').includes('*/'), false);
    const rootRule = Array.from(w.document.getElementById('jdm-styles').sheet.cssRules).find(rule => rule.selectorText === ':root');
    for (const token of ['space-xs', 'space-3xl', 'accent', 'destructive', 'warning', 'success', 'panel-bg', 'panel-border', 'text-secondary']) {
        assert.notEqual(rootRule.style.getPropertyValue(`--jdm-${token}`), '', `--jdm-${token} was dropped`);
    }
});
