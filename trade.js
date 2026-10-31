// =====================================================================
//  trade.js: swap items and points with another player
// =====================================================================
// app.js calls initTrade(host) once. "host" is the small set of things this file may ask app.js for
// (your points, your inventory, ...). Everything else about trading lives here.
import { doc, getDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { ITEM_BY_ID } from "./data.js";

// What app.js hands over (see initTrade)
let host = null;
let TABLE_ID = '';
let setMessage, format, cloneSlots, countInSlots, addToSlots;

function user() {
    return host.getUser();
}

// ---- The state of the trade you are in
let tradeId = null;        // the trade you are in. Saved in your document, so a refresh does not lose it
let tradeData = null;      // the latest copy of that trade document
let tradePending = false;  // true while our own change to the trade is not confirmed by the server yet
let tradeWatch = null;     // the trade we are listening to
let tradeUnsub = null;     // call this to stop listening
let tradeBusy = false;     // true while a trade step (moving items) is running
let tradeEnded = '';       // text shown when the trade is over
let tradeLockUntil = 0;    // Accept stays locked until performance.now() reaches this
let tradeStamp = 0;        // the "changedAt" time we last saw, to notice changes
let tradeEscrowAsked = null;
let tradeTheirsSig = '';   // what the other player offered, to warn you when it changes
let saveBlocked = false;   // true while a trade step runs: the normal save waits, so it cannot undo it

// ---- What app.js needs to know
export function getTradeId() {
    return tradeId;
}
export function isSaveBlocked() {
    return saveBlocked;
}
// Carry on with a trade that was saved in your document (after a refresh or a new login)
export function resumeTrade(id) {
    tradeId = id;
    startTradeListener(id);
}
// Called every time the trade screen is opened
export function onTradeScreenShown() {
    if (!tradeId && !tradeEnded) {
        setMessage('trade-msg', '', '');
    }
    updateTradeScreen();
}

// How it works (everything lives in Firestore, in trades/{code}):
//   1. One player creates a trade and gets a short code. The other joins with it.
//   2. Both put items and points in their offer. EVERY change un-accepts both sides and
//      locks the Accept button for 2 seconds (the Firestore rules check this with the server's clock too).
//   3. When both accepted, each game moves its own offer OUT of its save and INTO the trade
//      (one atomic write: the save and the trade change together, or neither does).
//   4. When both offers are in, each game takes what the OTHER player offered (again one atomic write).
//   5. If the trade is cancelled after someone moved their offer in, they get it back.
// The trade id is saved in your own document, so a refresh or a crash in the middle just continues.
const TRADE_LOCK_MS = 2000;     // Accept is locked this long after the last change (must match firestore.rules)
const TRADE_MAX_ITEMS = 12;     // different items in one offer
const TRADE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, so codes are easy to read out

function tEl(id) {
    return document.getElementById(id);
}

function makeTradeCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let code = '';
    for (const b of bytes) {
        code = code + TRADE_CODE_CHARS[b % TRADE_CODE_CHARS.length]; // 256 is a multiple of 32: no bias
    }
    return code;
}

function tradeRef() {
    return doc(db, 'trades', tradeId);
}

function tradeSide() {
    if (!tradeData || !user()) {
        return null;
    }
    if (tradeData.a === user().uid) {
        return 'a';
    }
    if (tradeData.b === user().uid) {
        return 'b';
    }
    return null;
}

function otherSide(side) {
    return side === 'a' ? 'b' : 'a';
}

// "belt:12" texts -> [{ id, n }]. Chopping tables and unknown things are never traded.
function parseOffer(list) {
    const out = [];
    if (!Array.isArray(list)) {
        return out;
    }
    for (const text of list) {
        const parts = String(text).split(':');
        const n = Math.floor(Number(parts[1]));
        if (ITEM_BY_ID[parts[0]] && parts[0] !== TABLE_ID && n >= 1 && n <= 999999 && out.length < TRADE_MAX_ITEMS) {
            out.push({ id: parts[0], n: n });
        }
    }
    return out;
}

function offerToList(items) {
    return items.map(function (it) {
        return it.id + ':' + it.n;
    });
}

function cleanPoints(value) {
    const n = Math.floor(Number(value));
    return n > 0 ? n : 0;
}

function offerText(items, pts) {
    const parts = [];
    if (pts > 0) {
        parts.push(format(pts) + ' points');
    }
    for (const it of items) {
        parts.push(ITEM_BY_ID[it.id].emoji + ' ' + ITEM_BY_ID[it.id].name + ' x' + it.n);
    }
    return parts.length > 0 ? parts.join(', ') : 'nothing';
}

// Takes n of an item out of a slot list (last slots first). Returns true if there was enough.
function removeFromSlots(slots, id, n) {
    for (let i = slots.length - 1; i >= 0 && n > 0; i--) {
        const s = slots[i];
        if (s && s.id === id) {
            const take = Math.min(n, s.n);
            s.n = s.n - take;
            n = n - take;
            if (s.n <= 0) {
                slots[i] = null;
            }
        }
    }
    return n === 0;
}

// The save also counts what lies in the Anvil (see inventoryForSave)
function slotsWithAnvil(slots) {
    for (const s of host.getAnvilIn()) {
        if (s) {
            addToSlots(slots, s.id, s.n, s.table);
        }
    }
    return slots;
}

// Do I still own everything I offered?
function haveOffer(items, pts) {
    if (pts > Math.floor(host.getPoints())) {
        return false;
    }
    const need = {};
    for (const it of items) {
        need[it.id] = (need[it.id] || 0) + it.n;
    }
    for (const id in need) {
        if (countInSlots(host.getInventory(), id) < need[id]) {
            return false;
        }
    }
    return true;
}

// ---- Listening to the trade document
function stopTradeListener() {
    if (tradeUnsub) {
        tradeUnsub();
    }
    tradeUnsub = null;
    tradeWatch = null;
}

// Forget everything about trades (login / logout)
export function resetTrade() {
    stopTradeListener();
    tradeId = null;
    tradeData = null;
    tradePending = false;
    tradeBusy = false;
    tradeEnded = '';
    tradeLockUntil = 0;
    tradeStamp = 0;
    tradeEscrowAsked = null;
    tradeTheirsSig = '';
    saveBlocked = false;
}

function startTradeListener(id) {
    stopTradeListener();
    tradeWatch = id;
    tradeData = null;
    tradeStamp = 0;
    tradeTheirsSig = '';
    // includeMetadataChanges: we also want to hear when the server CONFIRMS our own change
    tradeUnsub = onSnapshot(doc(db, 'trades', id), { includeMetadataChanges: true }, function (snap) {
        if (tradeWatch !== id) {
            return;
        }
        if (!snap.exists()) {
            endTrade('That trade does not exist (anymore).');
            return;
        }
        const data = snap.data({ serverTimestamps: 'estimate' });
        tradePending = snap.metadata.hasPendingWrites;
        tradeData = data;

        // The 2 second lock starts when the SERVER has confirmed a change (not on our own guess),
        // so a slow connection can never make the button unlock early.
        const stamp = data.changedAt ? data.changedAt.toMillis() : 0;
        if (!tradePending && stamp !== tradeStamp) {
            tradeStamp = stamp;
            tradeLockUntil = performance.now() + TRADE_LOCK_MS;
        }

        // Warn when the other player changed what they offer
        const side = tradeSide();
        if (side) {
            const other = otherSide(side);
            const theirs = JSON.stringify([data[other + 'Items'], data[other + 'Points']]);
            if (tradeTheirsSig && theirs !== tradeTheirsSig && data.status === 'open') {
                setMessage('trade-msg', '⚠️ ' + (data[other + 'Name'] || 'The other player') + ' changed their offer. Look before you accept!', 'bad');
            }
            tradeTheirsSig = theirs;
        }

        updateTradeScreen();
        tradeStep();
    }, function (error) {
        console.error('Trade listener failed:', error);
        if (error && error.code === 'permission-denied') {
            endTrade('You cannot open that trade.');
        } else {
            setMessage('trade-msg', 'Lost the connection to the trade. Trying again...', 'bad');
        }
    });
}

// The trade is over for me: stop listening and forget the pointer in my save
function endTrade(text) {
    stopTradeListener();
    tradeId = null;
    tradeEnded = text;
    host.markUnsaved();
    updateTradeScreen();
}

// ---- What my game has to do next, depending on the state of the trade
async function runTradeAction(fn) {
    tradeBusy = true;
    saveBlocked = true; // no normal save may slip in between: it would undo the change to my items
    try {
        await fn();
    } catch (error) {
        console.error('Trade step failed:', error);
        setMessage('trade-msg', 'Something went wrong. Trying again in a moment...', 'bad');
    } finally {
        tradeBusy = false;
        saveBlocked = false;
    }
}

function tradeStep() {
    if (tradeBusy || tradePending || !tradeData || !tradeId || !user()) {
        return;
    }
    const side = tradeSide();
    if (!side) {
        endTrade('You are not part of that trade.');
        return;
    }
    const other = otherSide(side);
    const d = tradeData;

    if (d[side + 'Got']) {
        endTrade('✅ Trade complete! You got: ' + offerText(parseOffer(d[other + 'Items']), cleanPoints(d[other + 'Points'])) + '.');
        return;
    }
    if (d.status === 'open') {
        // Both accepted: move on to the swap (the other player may do it first, that is fine)
        if (d.aOk && d.bOk && tradeEscrowAsked !== tradeId) {
            tradeEscrowAsked = tradeId;
            updateDoc(tradeRef(), { status: 'escrow' }).catch(function () {});
        }
        return;
    }
    if (d.status === 'escrow') {
        if (!d[side + 'In']) {
            runTradeAction(escrowMyOffer);
        } else if (d.aIn && d.bIn) {
            runTradeAction(claimTheirOffer);
        }
        return;
    }
    if (d.status === 'cancelled') {
        if (d[side + 'In'] && !d[side + 'Back']) {
            runTradeAction(refundMyOffer);
        } else {
            endTrade(d[side + 'In'] ? 'Trade cancelled. Your items and points are back.' : 'Trade cancelled.');
        }
    }
}


// Step 3: my offer leaves my save and goes into the trade
async function escrowMyOffer() {
    const side = tradeSide();
    const items = parseOffer(tradeData[side + 'Items']);
    const pts = cleanPoints(tradeData[side + 'Points']);
    if (!haveOffer(items, pts)) {
        await updateDoc(tradeRef(), { status: 'cancelled' });
        setMessage('trade-msg', 'You no longer have everything you offered, so the trade was cancelled.', 'bad');
        return;
    }
    const slots = cloneSlots(host.getInventory(), false);
    for (const it of items) {
        removeFromSlots(slots, it.id, it.n);
    }
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', user().uid), host.buildSave(host.getPoints() - pts, host.getChopsticks(), slotsWithAnvil(slots)));
    const change = {};
    change[side + 'In'] = true;
    batch.update(tradeRef(), change);
    await batch.commit();
    // Saved. Now the same in the running game.
    for (const it of items) {
        removeFromSlots(host.getInventory(), it.id, it.n);
    }
    host.addPoints(-pts);
}

// Step 4 (and the refund of a cancelled trade): items and points come into my save
async function receiveOffer(items, pts, flag) {
    const slots = cloneSlots(host.getInventory(), false);
    for (const it of items) {
        if (!addToSlots(slots, it.id, it.n)) {
            setMessage('trade-msg', 'Your inventory is full! Make room, and the trade finishes by itself.', 'bad');
            return false;
        }
    }
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', user().uid), host.buildSave(host.getPoints() + pts, host.getChopsticks(), slotsWithAnvil(slots)));
    const change = {};
    change[flag] = true;
    batch.update(tradeRef(), change);
    await batch.commit();
    for (const it of items) {
        addToSlots(host.getInventory(), it.id, it.n);
    }
    host.addPoints(pts);
    return true;
}

async function claimTheirOffer() {
    const side = tradeSide();
    const other = otherSide(side);
    const items = parseOffer(tradeData[other + 'Items']);
    const pts = cleanPoints(tradeData[other + 'Points']);
    if (await receiveOffer(items, pts, side + 'Got')) {
        endTrade('✅ Trade complete! You got: ' + offerText(items, pts) + '.');
    }
}

async function refundMyOffer() {
    const side = tradeSide();
    const items = parseOffer(tradeData[side + 'Items']);
    const pts = cleanPoints(tradeData[side + 'Points']);
    if (await receiveOffer(items, pts, side + 'Back')) {
        endTrade('Trade cancelled. Your items and points are back.');
    }
}

// ---- Creating and joining
async function createTrade() {
    if (tradeId || tradeBusy || !user()) {
        return;
    }
    const code = makeTradeCode();
    tradeBusy = true;
    saveBlocked = true;
    tradeId = code; // saveData() puts it in my document
    try {
        const batch = writeBatch(db);
        batch.set(doc(db, 'trades', code), {
            a: user().uid, b: null, aName: host.getPlayerName(), bName: '',
            aPoints: 0, bPoints: 0, aItems: [], bItems: [],
            aOk: false, bOk: false,
            changedAt: serverTimestamp(), createdAt: serverTimestamp(),
            status: 'open',
            aIn: false, bIn: false, aGot: false, bGot: false, aBack: false, bBack: false
        });
        batch.set(doc(db, 'users', user().uid), host.buildSave(host.getPoints(), host.getChopsticks(), host.inventoryForSave()));
        await batch.commit();
        tradeEnded = '';
        setMessage('trade-msg', '', '');
        startTradeListener(code);
    } catch (error) {
        console.error('Could not create the trade:', error);
        tradeId = null;
        setMessage('trade-msg', 'Could not create the trade. Check the Firestore rules.', 'bad');
    } finally {
        tradeBusy = false;
        saveBlocked = false;
        updateTradeScreen();
    }
}

async function joinTrade(raw) {
    if (tradeId || tradeBusy || !user()) {
        return;
    }
    const code = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) {
        setMessage('trade-msg', 'A trade code has 8 letters and numbers.', 'bad');
        return;
    }
    tradeBusy = true;
    saveBlocked = true;
    try {
        setMessage('trade-msg', 'Looking for the trade...', '');
        const snap = await getDoc(doc(db, 'trades', code));
        if (!snap.exists()) {
            setMessage('trade-msg', 'There is no trade with that code.', 'bad');
            return;
        }
        const d = snap.data();
        const uid = user().uid;
        const mine = d.a === uid || d.b === uid;
        if (!mine && (d.status !== 'open' || d.b)) {
            setMessage('trade-msg', 'That trade is already full or closed.', 'bad');
            return;
        }
        tradeId = code; // saveData() puts it in my document
        const batch = writeBatch(db);
        if (!mine) {
            batch.update(doc(db, 'trades', code), { b: uid, bName: host.getPlayerName() });
        }
        batch.set(doc(db, 'users', uid), host.buildSave(host.getPoints(), host.getChopsticks(), host.inventoryForSave()));
        try {
            await batch.commit();
        } catch (error) {
            tradeId = null;
            throw error;
        }
        tradeEnded = '';
        setMessage('trade-msg', '', '');
        startTradeListener(code);
    } catch (error) {
        console.error('Could not join the trade:', error);
        setMessage('trade-msg', 'Could not join that trade.', 'bad');
    } finally {
        tradeBusy = false;
        saveBlocked = false;
        updateTradeScreen();
    }
}

// ---- Changing my offer and accepting
function tradeCanEdit() {
    return !!(tradeId && tradeData && tradeSide() && tradeData.status === 'open' && tradeData.b);
}

// Every change to an offer un-accepts both sides and restarts the lock (the rules insist on it)
async function updateOffer(items, pts) {
    if (!tradeCanEdit()) {
        return;
    }
    const side = tradeSide();
    const change = { aOk: false, bOk: false, changedAt: serverTimestamp() };
    change[side + 'Items'] = offerToList(items);
    change[side + 'Points'] = pts;
    setMessage('trade-msg', '', '');
    try {
        await updateDoc(tradeRef(), change);
    } catch (error) {
        console.error('Offer change failed:', error);
        setMessage('trade-msg', 'Could not change your offer.', 'bad');
    }
}

function offerAdd(id, all) {
    if (!tradeCanEdit()) {
        return;
    }
    const side = tradeSide();
    const items = parseOffer(tradeData[side + 'Items']);
    const cur = items.find(function (it) { return it.id === id; });
    const add = all ? countInSlots(host.getInventory(), id) - (cur ? cur.n : 0) : 1;
    if (add <= 0 || (cur ? cur.n : 0) + add > countInSlots(host.getInventory(), id)) {
        return;
    }
    if (!cur && items.length >= TRADE_MAX_ITEMS) {
        setMessage('trade-msg', 'You can offer at most ' + TRADE_MAX_ITEMS + ' different items.', 'bad');
        return;
    }
    if (cur) {
        cur.n = cur.n + add;
    } else {
        items.push({ id: id, n: add });
    }
    updateOffer(items, cleanPoints(tradeData[side + 'Points']));
}

function offerRemove(id, all) {
    if (!tradeCanEdit()) {
        return;
    }
    const side = tradeSide();
    const items = parseOffer(tradeData[side + 'Items']);
    const cur = items.find(function (it) { return it.id === id; });
    if (!cur) {
        return;
    }
    cur.n = all ? 0 : cur.n - 1;
    updateOffer(items.filter(function (it) { return it.n > 0; }), cleanPoints(tradeData[side + 'Points']));
}

let tradePointsTimer = null;
function offerPoints() {
    if (!tradeCanEdit()) {
        return;
    }
    const side = tradeSide();
    const input = tEl('trade-points');
    const pts = Math.min(cleanPoints(input.value), Math.floor(host.getPoints()));
    if (pts !== cleanPoints(input.value)) {
        input.value = pts;
    }
    if (pts === cleanPoints(tradeData[side + 'Points'])) {
        return;
    }
    updateOffer(parseOffer(tradeData[side + 'Items']), pts);
}

// Accept is only possible when the lock is over, something is on the table, and the server has our latest change
function acceptAllowed() {
    if (!tradeCanEdit() || tradePending || performance.now() < tradeLockUntil) {
        return false;
    }
    const d = tradeData;
    const empty = cleanPoints(d.aPoints) === 0 && cleanPoints(d.bPoints) === 0 &&
        parseOffer(d.aItems).length === 0 && parseOffer(d.bItems).length === 0;
    return !empty;
}

async function toggleAccept() {
    if (!tradeCanEdit()) {
        return;
    }
    const side = tradeSide();
    const mine = tradeData[side + 'Ok'] === true;
    if (!mine && !acceptAllowed()) {
        return;
    }
    const change = {};
    change[side + 'Ok'] = !mine;
    try {
        await updateDoc(tradeRef(), change);
        setMessage('trade-msg', '', '');
    } catch (error) {
        // The server clock says the 2 seconds are not over yet (our clock was a bit fast)
        tradeLockUntil = performance.now() + 700;
        setMessage('trade-msg', 'One moment... try again.', 'bad');
    }
}

async function cancelTrade() {
    if (!tradeId || !tradeData) {
        return;
    }
    try {
        await updateDoc(tradeRef(), { status: 'cancelled' });
    } catch (error) {
        console.error('Cancel failed:', error);
        setMessage('trade-msg', 'You cannot cancel now: both offers are already in. The swap finishes by itself.', 'bad');
    }
}

// ---- The trade screen
function tradeSlot(id, n, hint, onClick) {
    const def = ITEM_BY_ID[id];
    const el = document.createElement('div');
    el.className = 'slot' + (def.golden ? ' golden' : '');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = def.name + ' x' + n + (hint ? ' (' + hint + ')' : '');
    el.innerHTML = '<span class="slot-emoji"></span><span class="slot-count"></span>';
    el.querySelector('.slot-emoji').innerText = def.emoji;
    el.querySelector('.slot-count').innerText = n > 1 ? String(n) : '';
    if (onClick) {
        el.addEventListener('click', function (event) {
            onClick(event.shiftKey);
        });
        el.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick(event.shiftKey);
            }
        });
    }
    return el;
}

function tradeStatusText(d, side) {
    if (!d.b) {
        return 'Waiting for a friend to join. Send them the code!';
    }
    if (d.status === 'cancelled') {
        return 'The trade was cancelled.';
    }
    if (d.status === 'escrow') {
        return d.aIn && d.bIn ? 'Swapping the offers...' : 'Both accepted! Putting the offers in the trade...';
    }
    if (d.aOk && d.bOk) {
        return 'Both accepted!';
    }
    if (tradePending) {
        return 'Saving your change...';
    }
    const left = tradeLockUntil - performance.now();
    if (left > 0) {
        return '🔒 The offer just changed. You can accept in ' + (left / 1000).toFixed(1) + 's.';
    }
    return 'Add items or points, then press Accept. Every change resets both accepts.';
}

let tradeSig = '';
export function updateTradeScreen() {
    if (host.getScreen() !== 'trade-screen') {
        return;
    }
    const d = tradeData;
    const room = !!(tradeId && d && tradeSide());
    const loading = !!(tradeId && !room);
    tEl('trade-lobby').classList.toggle('hidden', room || loading || !!tradeEnded);
    tEl('trade-room').classList.toggle('hidden', !room);
    tEl('trade-close').classList.toggle('hidden', !tradeEnded);
    if (tradeEnded) {
        setMessage('trade-msg', tradeEnded, tradeEnded.indexOf('✅') === 0 ? 'good' : '');
    } else if (loading && !tEl('trade-msg').innerText) {
        setMessage('trade-msg', 'Loading your trade...', '');
    }
    if (!room) {
        tradeSig = '';
        return;
    }

    const side = tradeSide();
    const other = otherSide(side);
    tEl('trade-code').innerText = tradeId;
    tEl('trade-status').innerText = tradeStatusText(d, side);
    tEl('trade-their-title').innerText = d.b ? (d[other + 'Name'] || 'Them') : 'Waiting...';
    tEl('trade-their-points').innerText = format(cleanPoints(d[other + 'Points']));

    const editable = tradeCanEdit();
    const myOk = d[side + 'Ok'] === true;
    const theirOk = d[other + 'Ok'] === true;
    tEl('trade-mine-col').classList.toggle('accepted', myOk);
    tEl('trade-theirs-col').classList.toggle('accepted', theirOk);
    tEl('trade-mine-ok').innerText = myOk ? '✅ You accepted' : '';
    tEl('trade-their-ok').innerText = d.b ? (theirOk ? '✅ Accepted' : 'Has not accepted') : '';

    // The points box: don't overwrite what you are typing
    const pointsBox = tEl('trade-points');
    pointsBox.disabled = !editable;
    if (document.activeElement !== pointsBox) {
        pointsBox.value = cleanPoints(d[side + 'Points']);
    }

    // The accept button
    const accept = tEl('trade-accept');
    if (myOk) {
        accept.innerText = '✅ Accepted (click to undo)';
        accept.disabled = !editable;
    } else {
        const left = tradeLockUntil - performance.now();
        accept.innerText = editable && left > 0 && !tradePending ? 'Accept (' + (left / 1000).toFixed(1) + 's)' : 'Accept';
        accept.disabled = !acceptAllowed();
    }
    const swapping = d.status === 'escrow' && d.aIn && d.bIn;
    const cancel = tEl('trade-cancel');
    cancel.disabled = d.status === 'cancelled' || swapping;
    tEl('trade-bag-box').classList.toggle('hidden', !editable);

    // The item lists: only rebuilt when something changed, or a click could get lost
    const counts = {};
    for (const s of host.getInventory()) {
        if (s && s.id !== TABLE_ID) {
            counts[s.id] = (counts[s.id] || 0) + s.n;
        }
    }
    const sig = JSON.stringify([d.aItems, d.bItems, d.b, d.status, editable, side, counts]);
    if (sig === tradeSig) {
        return;
    }
    tradeSig = sig;

    const mine = parseOffer(d[side + 'Items']);
    const theirs = parseOffer(d[other + 'Items']);
    const mineBox = tEl('trade-mine');
    const theirBox = tEl('trade-theirs');
    const bagBox = tEl('trade-bag');
    mineBox.innerHTML = '';
    theirBox.innerHTML = '';
    bagBox.innerHTML = '';
    for (const it of mine) {
        mineBox.appendChild(tradeSlot(it.id, it.n, editable ? 'click: take one back, Shift-click: take all back' : '', editable ? function (all) {
            offerRemove(it.id, all);
        } : null));
    }
    for (const it of theirs) {
        theirBox.appendChild(tradeSlot(it.id, it.n, '', null));
    }
    const offered = {};
    for (const it of mine) {
        offered[it.id] = it.n;
    }
    for (const id of Object.keys(counts)) {
        const free = counts[id] - (offered[id] || 0);
        if (free > 0) {
            bagBox.appendChild(tradeSlot(id, free, 'click: offer one, Shift-click: offer all', function (all) {
                offerAdd(id, all);
            }));
        }
    }
}

// =====================================================================
//  Start-up: app.js calls this once
// =====================================================================
// host = {
//   TABLE_ID, setMessage, format, cloneSlots, countInSlots, addToSlots,   (helpers from app.js)
//   getUser, getPlayerName, getScreen, getPoints, getChopsticks,          (read the game)
//   getInventory, getAnvilIn, inventoryForSave,
//   buildSave(points, chopsticks, slots),                                  (the data for the player's document)
//   addPoints(n), markUnsaved()                                            (change the game)
// }
export function initTrade(h) {
    host = h;
    TABLE_ID = h.TABLE_ID;
    setMessage = h.setMessage;
    format = h.format;
    cloneSlots = h.cloneSlots;
    countInSlots = h.countInSlots;
    addToSlots = h.addToSlots;

    setInterval(tradeStep, 2000);         // also retries after a failed step, or after you made room in your inventory
    setInterval(updateTradeScreen, 200);  // the countdown on the Accept button

    tEl('trade-create').addEventListener('click', createTrade);
    tEl('trade-join').addEventListener('click', function () {
        joinTrade(tEl('trade-code-input').value);
    });
    tEl('trade-code-input').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            joinTrade(tEl('trade-code-input').value);
        }
    });
    tEl('trade-copy').addEventListener('click', function () {
        try {
            navigator.clipboard.writeText(tradeId || '');
            setMessage('trade-msg', 'Code copied. Send it to your friend!', 'good');
        } catch (error) {
            setMessage('trade-msg', 'Could not copy. The code is ' + tradeId, '');
        }
    });
    tEl('trade-accept').addEventListener('click', toggleAccept);
    tEl('trade-cancel').addEventListener('click', cancelTrade);
    tEl('trade-close').addEventListener('click', function () {
        tradeEnded = '';
        tradeData = null;
        setMessage('trade-msg', '', '');
        updateTradeScreen();
    });
    tEl('trade-points').addEventListener('input', function () {
        clearTimeout(tradePointsTimer);
        tradePointsTimer = setTimeout(offerPoints, 500);
    });
    tEl('trade-points').addEventListener('change', offerPoints);
}
