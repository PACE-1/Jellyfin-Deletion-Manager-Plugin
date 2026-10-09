const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.DeletionManager/Web');

function core(t, { url = 'http://localhost/web/index.html', layout = false } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    if (layout) {
        // jsdom has no layout; treat any element that is not hidden as rendered.
        Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.hidden ? null : this.parentNode; } });
    }
    let user = 'admin';
    const authCalls = [];
    class Client {
        setAuthenticationInfo(token, userId) { authCalls.push([token, userId]); user = userId; }
        getCurrentUserId() { return user; }
        accessToken() { return 'tok'; }
        getUrl(p) { return `http://server${p}`; }
        getItem(userId, id) { return Promise.resolve({ Id: id, Type: 'Movie', userId }); }
    }
    w.ApiClient = new Client();
    w.eval(fs.readFileSync(path.join(root, 'jdm-core.js'), 'utf8'));
    t.after(() => w.close());
    return { w, JDM: w.JellyfinDeletionManager, authCalls };
}
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test('the first user is adopted silently; later changes reset handlers and bump the epoch', t => {
    const { w, JDM } = core(t);
    const epoch = JDM.session.getEpoch();
    let resets = 0;
    JDM.session.onUserChange('x', () => { resets++; });
    JDM.session.checkNow('same');
    assert.equal(resets, 0);
    w.ApiClient.setAuthenticationInfo('t2', 'other');
    assert.equal(resets, 1);
    assert.ok(JDM.session.getEpoch() > epoch);
    assert.equal(JDM.session.isCurrent(epoch), false);
    assert.equal(JDM.session.getUserId(), 'other');
});

test('the auth hook clears state before the new credentials are installed and passes the call through', t => {
    const { w, JDM, authCalls } = core(t);
    let userSeenByReset = null;
    JDM.session.onUserChange('x', () => { userSeenByReset = w.ApiClient.getCurrentUserId(); });
    w.ApiClient.setAuthenticationInfo('t2', 'other');
    assert.equal(userSeenByReset, 'admin');
    assert.deepEqual(authCalls, [['t2', 'other']]);
});

test('a failing reset handler does not stop the others', t => {
    const { w, JDM } = core(t);
    const origError = w.console.error;
    w.console.error = () => {};
    let ran = false;
    JDM.session.onUserChange('bad', () => { throw new Error('boom'); });
    JDM.session.onUserChange('good', () => { ran = true; });
    w.ApiClient.setAuthenticationInfo('t2', 'other');
    w.console.error = origError;
    assert.equal(ran, true);
});

test('jf sends the Jellyfin auth headers, parses JSON and reads an empty body as {}', async t => {
    const { w, JDM } = core(t);
    const seen = [];
    w.fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => (url.endsWith('empty') ? '' : '{"a":1}') }; };
    assert.equal((await JDM.api.jf('/DeletionManager/Requests')).a, 1);
    assert.equal(Object.keys(await JDM.api.jf('/empty')).length, 0);
    const { init } = seen[0];
    assert.equal(seen[0].url, 'http://server/DeletionManager/Requests');
    assert.equal(init.headers.Authorization, 'MediaBrowser Token="tok"');
    assert.equal(init.headers['X-Emby-Token'], 'tok');
    await JDM.api.jf('/p', { method: 'POST', body: { x: 1 } });
    assert.equal(seen[2].init.body, '{"x":1}');
});

test('jf rejects with the HTTP status and never retries', async t => {
    const { w, JDM } = core(t);
    let attempts = 0;
    w.fetch = async () => { attempts++; return { ok: false, status: 503, text: async () => '' }; };
    await assert.rejects(JDM.api.jf('/x'), error => error.status === 503);
    assert.equal(attempts, 1);
});

test('jf does not call the server while signed out', async t => {
    const { w, JDM } = core(t);
    let attempts = 0;
    w.fetch = async () => { attempts++; return { ok: true, status: 200, text: async () => '{}' }; };
    w.ApiClient.accessToken = () => null;
    await assert.rejects(JDM.api.jf('/x'), error => error.status === 401);
    assert.equal(attempts, 0);
});

test('navigation notifies once per URL change across pushState, hashchange and popstate', async t => {
    const { w, JDM } = core(t);
    let count = 0;
    const off = JDM.navigation.onNavigate(() => { count++; });
    w.history.pushState({}, '', '/web/index.html#/home');
    assert.equal(count, 1);
    w.history.pushState({}, '', '/web/index.html#/home');
    assert.equal(count, 1);
    w.history.replaceState({}, '', '/web/index.html#/movies');
    assert.equal(count, 2);
    w.dispatchEvent(new w.Event('hashchange'));
    w.dispatchEvent(new w.Event('popstate'));
    assert.equal(count, 2);
    off();
    w.history.pushState({}, '', '/web/index.html#/tv');
    assert.equal(count, 2);
});

test('body observer: priority subscribers run at once with records; others batch after paint; attribute changes are ignored', async t => {
    const { w, JDM } = core(t);
    const fast = [], slow = [];
    JDM.dom.onBodyMutation('fast', records => fast.push(records.length), { priority: 1 });
    JDM.dom.onBodyMutation('slow', records => slow.push(records.length));
    w.document.body.setAttribute('data-x', '1');
    await tick(20);
    assert.equal(fast.length + slow.length, 0);
    const a = w.document.createElement('div');
    w.document.body.appendChild(a);
    w.document.body.appendChild(w.document.createElement('div'));
    await tick(0);
    assert.equal(fast.length, 1);
    assert.equal(slow.length, 0);
    await tick(300);
    assert.deepEqual(slow, [2]);
});

test('item lookups share one request for a minute and are dropped on a user switch', async t => {
    const { w, JDM } = core(t);
    let fetches = 0;
    const original = w.ApiClient.getItem.bind(w.ApiClient);
    w.ApiClient.getItem = (userId, id) => { fetches++; return original(userId, id); };
    const [a, b] = await Promise.all([JDM.items.get('m1'), JDM.items.get('m1')]);
    assert.equal(a, b);
    assert.equal(fetches, 1);
    w.ApiClient.setAuthenticationInfo('t2', 'other');
    assert.equal((await JDM.items.get('m1')).userId, 'other');
    assert.equal(fetches, 2);
});

test('a failed item lookup is not cached', async t => {
    const { w, JDM } = core(t);
    let fetches = 0;
    w.ApiClient.getItem = () => { fetches++; return Promise.reject(new Error('down')); };
    await assert.rejects(JDM.items.get('m1'));
    await tick();
    await assert.rejects(JDM.items.get('m1'));
    assert.equal(fetches, 2);
});

test('toast is a polite live region that shows text, not markup', async t => {
    const { w, JDM } = core(t);
    JDM.toast('<b>done</b>', 30);
    const host = w.document.getElementById('jdm-toast');
    assert.equal(host.getAttribute('role'), 'status');
    assert.equal(host.getAttribute('aria-live'), 'polite');
    assert.equal(host.textContent, '<b>done</b>');
    assert.equal(host.querySelector('b'), null);
    assert.equal(host.hidden, false);
    await tick(60);
    assert.equal(host.hidden, true);
});

test('action-sheet rows copy a sibling row and set the label as text', t => {
    const { w, JDM } = core(t);
    w.document.body.innerHTML = '<div class="actionSheetScroller"><button class="listItem actionSheetMenuItem selected xl" data-id="play"></button></div>';
    const scroller = w.document.querySelector('.actionSheetScroller');
    const row = JDM.actionSheet.buildItem(scroller, { dataId: 'jdm-x', icon: 'delete_sweep', text: '<img src=x> Request' });
    assert.equal(row.tagName, 'BUTTON');
    assert.equal(row.getAttribute('class'), 'listItem actionSheetMenuItem xl');
    assert.equal(row.dataset.id, 'jdm-x');
    assert.equal(row.querySelector('.actionSheetItemText').textContent, '<img src=x> Request');
    assert.equal(row.querySelector('img'), null);
    assert.ok(row.querySelector('.material-icons.delete_sweep'));
    assert.equal(JDM.actionSheet.getActiveScroller(), scroller);
});

test('closing the action sheet prefers dialog.close() and falls back to Escape', t => {
    const { w, JDM } = core(t);
    w.document.body.innerHTML = '<div class="actionSheet"></div>';
    let escaped = false;
    w.document.querySelector('.actionSheet').addEventListener('keydown', e => { escaped = e.key === 'Escape'; });
    assert.equal(JDM.actionSheet.close(), true);
    assert.equal(escaped, true);
});

function homePage(w, { sliderHidden = false } = {}) {
    w.document.body.innerHTML = `<header class="skinHeader"><div class="emby-tabs-slider"${sliderHidden ? ' hidden' : ''}>`
        + '<button class="emby-tab-button" data-index="0">Home</button><button class="emby-tab-button" data-index="1">Favorites</button></div>'
        + '<div class="headerRight"></div></header>'
        + '<div id="indexPage" class="page"><div class="tabContent pageTabContent is-active" data-index="0"></div>'
        + '<div class="tabContent pageTabContent" data-index="1"></div></div>';
    const tabs = w.document.createElement('div');
    tabs.setAttribute('is', 'emby-tabs');
    let selected = 0;
    // Like emby-tabs: selecting an index activates the panel at that position.
    tabs.selectedIndex = value => {
        if (value !== undefined) {
            selected = value;
            w.document.querySelectorAll('.tabContent.pageTabContent').forEach(panel => {
                panel.classList.toggle('is-active', panel.getAttribute('data-index') === String(value));
            });
        }
        return selected;
    };
    tabs.refresh = () => { tabs.refreshed = true; };
    w.document.body.appendChild(tabs);
    return tabs;
}

test('a registered tab gets the next free index, one button and one panel, and onMount runs once', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/home', layout: true });
    const tabs = homePage(w);
    let mounts = 0;
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => { mounts++; }, 'delete_sweep');
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => { mounts++; });
    await tick(300);
    const buttons = w.document.querySelectorAll('#jdm-native-tab-btn-deletion-requests');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].getAttribute('data-index'), '2');
    assert.equal(buttons[0].textContent, 'Deletion Requests');
    const panel = w.document.getElementById('jdm-native-tab-panel-deletion-requests');
    assert.equal(panel.getAttribute('data-index'), '2');
    assert.equal(panel.parentElement, w.document.getElementById('indexPage'));
    assert.equal(mounts, 1);
    assert.equal(tabs.refreshed, true);
    // Visible tab strip: no header fallback button.
    assert.equal(w.document.getElementById('jdm-native-tab-link-deletion-requests'), null);
});

test('a tab claims the index after any other plugin tab already on the strip', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/home', layout: true });
    homePage(w);
    w.document.querySelector('.emby-tabs-slider').insertAdjacentHTML('beforeend', '<button class="emby-tab-button" data-index="4">Other</button>');
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => {});
    await tick(300);
    assert.equal(w.document.getElementById('jdm-native-tab-btn-deletion-requests').getAttribute('data-index'), '5');
});

test('nothing is added off the Home page, and the tab appears once Home is shown', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/movies', layout: true });
    homePage(w);
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => {});
    await tick(300);
    assert.equal(w.document.getElementById('jdm-native-tab-btn-deletion-requests'), null);
    w.history.pushState({}, '', '/web/index.html#/home');
    await tick(300);
    assert.ok(w.document.getElementById('jdm-native-tab-btn-deletion-requests'));
});

test('an inactive (cached) Home page is never used as the tab root', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/home', layout: true });
    homePage(w);
    w.document.getElementById('indexPage').classList.add('hide');
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => {});
    await tick(300);
    assert.equal(w.document.getElementById('jdm-native-tab-panel-deletion-requests'), null);
    w.document.getElementById('indexPage').classList.remove('hide');
    await tick(300);
    assert.ok(w.document.getElementById('jdm-native-tab-panel-deletion-requests'));
});

test('a hidden tab strip (Jellyfin 12 experimental layout) gets a header-tray button that deep-links to ?tab=N', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/home', layout: true });
    homePage(w);
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => {}, 'delete_sweep');
    await tick(300);
    const button = w.document.getElementById('jdm-native-tab-btn-deletion-requests');
    button.hidden = true;
    JDM.navigation.onNavigate(() => {});
    w.history.pushState({}, '', '/web/index.html#/home?x=1');
    await tick(300);
    const link = w.document.getElementById('jdm-native-tab-link-deletion-requests');
    assert.ok(link, 'fallback link exists');
    assert.equal(link.parentElement, w.document.querySelector('.headerRight'));
    assert.equal(link.querySelector('.material-icons').textContent, 'delete_sweep');
    link.click();
    assert.equal(w.location.hash, '#/home?tab=2');
    button.hidden = false;
    w.history.pushState({}, '', '/web/index.html#/home?x=2');
    await tick(300);
    assert.equal(w.document.getElementById('jdm-native-tab-link-deletion-requests'), null);
});

test('a ?tab=N deep link activates the tab once and does not undo a later click on Home', async t => {
    const { w, JDM } = core(t, { url: 'http://localhost/web/index.html#/home?tab=2', layout: true });
    const tabs = homePage(w);
    const selections = [];
    const select = tabs.selectedIndex;
    tabs.selectedIndex = value => { if (value !== undefined) selections.push(value); return select(value); };
    JDM.nativeTabs.register('deletion-requests', 'Deletion Requests', () => {});
    await tick(300);
    assert.deepEqual(selections, [2]);
    const panel = w.document.getElementById('jdm-native-tab-panel-deletion-requests');
    assert.ok(panel.classList.contains('is-active'));
    w.document.body.appendChild(w.document.createElement('div'));
    await tick(300);
    assert.deepEqual(selections, [2]);
    select(0);
    w.document.body.appendChild(w.document.createElement('div'));
    await tick(300);
    // The deep link was consumed for this page; mutations alone do not reapply it.
    assert.equal(select(), 0);
});
