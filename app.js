import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, writeBatch, collection, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDD-FIJF2L5e7oCzlSIdC2EIt7CMZxV7P0",
  authDomain: "kitacat-sushiclicker.firebaseapp.com",
  projectId: "kitacat-sushiclicker",
  storageBucket: "kitacat-sushiclicker.firebasestorage.app",
  messagingSenderId: "113712170507",
  appId: "1:113712170507:web:d8d2d2ee5ea0fb9deb290e",
  measurementId: "G-EVDN6DJE68"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// =====================================================================
//  SETTINGS: change these numbers to tune the game
// =====================================================================

// Chopsticks: a click upgrade (each one makes every click worth +1 more)
const CHOPSTICKS_BASE_COST = 10;
const PRICE_GROWTH = 1.15; // each one you own makes the next 15% more expensive

// The factory grid
const COLS = 8;
const ROWS = 6;
const CELL = 56;           // size of one square, in canvas pixels
const RES = 2;             // draw at 2x so it stays sharp on big or retina screens

// How the sushi moves
const SPEED = 1.5;         // squares per second
const SPAWN_EVERY = 2;     // seconds between sushi from one rice cooker
const MAX_SUSHI = 80;      // safety limit so the page never gets slow
const COMPLETE_BOOST = 2;  // a rice ball that meets a fish becomes complete sushi: its value is multiplied by this
const MAX_AGE = 60;        // sushi older than this many seconds disappears (stops endless loops)

// The anvil: a one-time unlock in the shop
const ANVIL_COST = 100000000; // 100 million
const MAX_PER_KIND = 9999; // most of one tile you can own

// The inventory: slots like in Minecraft. The first 9 slots are the hotbar.
const INV_SLOTS = 36;      // 4 rows of 9
const HOTBAR = 9;
const MAX_STACK = 999;     // most items in one slot

// Player name and screen size (the game is drawn 20% smaller by default)
const MAX_NAME = 14;
const DEFAULT_SCALE = 80;  // percent
const MIN_SCALE = 50;
const MAX_SCALE = 150;

// The pieces you can place (you buy them in the Shop).
//   baseCost: price of the first one      growth: how much each extra one costs more
//   bonus:    how much value a topping adds to sushi that passes through
const TILES = [
    { id: 'belt',   name: 'Belt',            emoji: '➡️',  baseCost: 2,   growth: 1,    hint: 'Carries sushi' },
    { id: 'source', name: 'Rice cooker',     emoji: '🍚',  baseCost: 20,  growth: 1.15, hint: 'Makes a rice ball every 2 seconds' },
    { id: 'fish',   name: 'Fish topping',    emoji: '🐟',  baseCost: 40,  growth: 1.15, hint: 'Turns a rice ball into sushi: +2, and complete sushi is worth 2x', bonus: 2 },
    { id: 'chef',   name: 'Chef',            emoji: '🧑‍🍳', baseCost: 120, growth: 1.15, hint: 'Sushi passing by is worth +5', bonus: 5 },
    { id: 'exit',   name: 'Serving counter', emoji: '🏮',  baseCost: 10,  growth: 1,    hint: 'Sells what arrives for its value' },
];

// Equipable items: you put them ON a piece you already placed (they are not bought with points).
// A piece can carry one of each. They come from redeem codes and from the Anvil.
//   applies:    which pieces they can go on
//   multiplier: how much more the piece earns      speed: how much faster the piece works
//   colour:     the colour of the glow on the piece
const MONEY_PIECES = ['source', 'fish', 'chef', 'exit'];
const EQUIPS = [
    {
        id: 'golden_soy_sauce', name: 'Golden soy sauce', emoji: '🍶', golden: true, colour: '#ffd34d',
        multiplier: 2, applies: MONEY_PIECES,
        hint: 'Click a rice cooker, fish, chef or serving counter in the factory to make it golden: it earns 2x'
    },
    {
        id: 'soy_sauce', name: 'Soy sauce', emoji: '🫙', colour: '#d9823b',
        multiplier: 1.5, applies: MONEY_PIECES,
        hint: 'Click a rice cooker, fish, chef or serving counter to make it earn 1.5x'
    },
    {
        id: 'wasabi', name: 'Wasabi', emoji: '🌿', colour: '#8fd14f',
        speed: 2, applies: ['belt', 'source', 'fish', 'chef'],
        hint: 'Click a belt, rice cooker, fish or chef to make it work 2x faster'
    },
];

// Ingredients: they do nothing on their own, you merge them in the Anvil
const MATERIALS = [
    { id: 'spicy_drink', name: 'Spicy drink', emoji: '🌶️', hint: 'A strange ingredient. It does nothing on its own...' },
];

// The Anvil recipes. Players are NOT shown these: they have to discover them.
const RECIPES = [
    { out: 'soy_sauce',   n: 1, needs: [{ id: 'belt', n: 2 }] },
    { out: 'spicy_drink', n: 1, needs: [{ id: 'exit', n: 1 }, { id: 'chef', n: 1 }] },
    { out: 'wasabi',      n: 1, needs: [{ id: 'soy_sauce', n: 1 }, { id: 'spicy_drink', n: 1 }] },
];

// The Remove tool is not an item, it is a button next to the hotbar
const REMOVE_TOOL = {
    id: 'remove', name: 'Remove', emoji: '🗑️',
    hint: 'Click a piece to take it back. Upgrades on it (soy sauce, wasabi...) come off first, one by one.'
};

const TILE_BY_ID = {};
const ITEM_BY_ID = {};   // tiles and equipables
for (const t of TILES) {
    TILE_BY_ID[t.id] = t;
    ITEM_BY_ID[t.id] = t;
}
for (const e of EQUIPS) {
    ITEM_BY_ID[e.id] = e;
}
for (const m of MATERIALS) {
    ITEM_BY_ID[m.id] = m;
}

// Directions: 0 = right, 1 = down, 2 = left, 3 = up
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const ARROWS = ['→', '↓', '←', '↑'];

// =====================================================================
//  GAME STATE
// =====================================================================
let points = 0;
let chopsticks = 0;      // how many Chopsticks you own
let grid = [];           // the factory: COLS * ROWS squares, each null or { kind, dir }
let inventory = [];      // INV_SLOTS slots, each null or { id, n }. Slots 0-8 are the hotbar.
let anvil = false;       // true once you unlocked the anvil
let buyAmount = 1;       // the shop buys this many at a time
let sushi = [];          // all the sushi currently on the belts
let timers = {};         // per rice cooker: seconds since its last sushi
let salesLog = [];       // recent sales, used to show "per second"
let effects = [];        // little "+5" popups

let hotbarSel = 0;        // which hotbar slot (0-8) is selected
let removeMode = false;  // true while the Remove tool is selected
let invSel = null;       // the slot you picked up (a slot address, see getSlotAt)
let anvilIn = [null, null]; // the two input slots of the Anvil
let playerName = '';     // your username
let rotation = 0;        // the direction new belts / rice cookers will face
let hover = null;        // the square the mouse is over

let currentUser = null;  // set only after the player's data has loaded
let unsaved = false;     // true when there are changes not yet in Firestore
let displayDirty = true; // true when the numbers on screen need refreshing

function emptyGrid() {
    return new Array(COLS * ROWS).fill(null);
}

function emptyInventory() {
    return new Array(INV_SLOTS).fill(null);
}

function resetGame() {
    points = 0;
    chopsticks = 0;
    anvil = false;
    hotbarSel = 0;
    removeMode = false;
    invSel = null;
    anvilIn = [null, null];
    inventory = emptyInventory();
    grid = emptyGrid();
    sushi = [];
    timers = {};
    salesLog = [];
    effects = [];
    displayDirty = true;
}
resetGame();

// =====================================================================
//  MATHS
// =====================================================================
function format(number) {
    return Math.floor(number).toLocaleString('en-US'); // 12345.7 -> "12,345"
}

// For small numbers like 0.5: shows up to 2 decimals, no trailing zeros
function formatRate(number) {
    const rounded = Math.round(number * 100) / 100;
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function clickPower() {
    return 1 + chopsticks;
}

function chopsticksCost() {
    return Math.ceil(CHOPSTICKS_BASE_COST * Math.pow(PRICE_GROWTH, chopsticks));
}

function placedCount(kind) {
    let n = 0;
    for (const cell of grid) {
        if (cell && cell.kind === kind) {
            n = n + 1;
        }
    }
    return n;
}

// Everything you own of one kind: in the inventory plus placed on the factory
function ownedCount(kind) {
    return countInSlots(inventory, kind) + placedCount(kind);
}

// ---- Inventory slots. Every helper takes the slot list, so it also works on a copy.
function countInSlots(slots, id) {
    let n = 0;
    for (const s of slots) {
        if (s && s.id === id) {
            n = n + s.n;
        }
    }
    return n;
}

function cloneSlots(slots) {
    return slots.map(function (s) {
        return s ? { id: s.id, n: s.n } : null;
    });
}

// Is there room for n more of this item?
function roomFor(slots, id, n) {
    let room = 0;
    for (const s of slots) {
        if (!s) {
            room = room + MAX_STACK;
        } else if (s.id === id) {
            room = room + MAX_STACK - s.n;
        }
    }
    return room >= n;
}

// Adds n items: tops up existing stacks first, then uses the first empty slots.
// All or nothing: returns false (and changes nothing) when there is no room.
function addToSlots(slots, id, n) {
    if (!roomFor(slots, id, n)) {
        return false;
    }
    for (const s of slots) {
        if (n > 0 && s && s.id === id && s.n < MAX_STACK) {
            const add = Math.min(n, MAX_STACK - s.n);
            s.n = s.n + add;
            n = n - add;
        }
    }
    for (let i = 0; i < slots.length && n > 0; i++) {
        if (!slots[i]) {
            const add = Math.min(n, MAX_STACK);
            slots[i] = { id: id, n: add };
            n = n - add;
        }
    }
    return true;
}

// Uses up one item from a slot (placing a piece)
function useFromSlot(i) {
    inventory[i].n = inventory[i].n - 1;
    if (inventory[i].n <= 0) {
        inventory[i] = null;
    }
}

// Slot addresses: 0-35 are inventory slots, 36 and 37 are the two Anvil input slots.
function getSlotAt(address) {
    return address < INV_SLOTS ? inventory[address] : anvilIn[address - INV_SLOTS];
}

function setSlotAt(address, value) {
    if (address < INV_SLOTS) {
        inventory[address] = value;
    } else {
        anvilIn[address - INV_SLOTS] = value;
    }
}

// Moves things between two slots, like in Minecraft:
// empty slot = move, same item = merge, different item = swap.
// one = true moves just a single item (right click).
function moveSlot(from, to, one) {
    if (from === to || !getSlotAt(from)) {
        return;
    }
    const a = getSlotAt(from);
    const b = getSlotAt(to);

    if (one) {
        if (!b) {
            setSlotAt(to, { id: a.id, n: 1 });
        } else if (b.id === a.id && b.n < MAX_STACK) {
            b.n = b.n + 1;
        } else {
            return; // can't put one onto a different item
        }
        a.n = a.n - 1;
        if (a.n <= 0) {
            setSlotAt(from, null);
        }
    } else if (!b) {
        setSlotAt(to, a);
        setSlotAt(from, null);
    } else if (b.id === a.id) {
        const moved = Math.min(MAX_STACK - b.n, a.n);
        b.n = b.n + moved;
        a.n = a.n - moved;
        if (a.n <= 0) {
            setSlotAt(from, null);
        }
    } else {
        setSlotAt(from, b);
        setSlotAt(to, a);
    }
    unsaved = true;
    displayDirty = true;
    saveSoon();
}

// Whatever is lying in the Anvil goes back to the inventory
function stowAnvil() {
    for (let k = 0; k < anvilIn.length; k++) {
        const s = anvilIn[k];
        if (s && addToSlots(inventory, s.id, s.n)) {
            anvilIn[k] = null;
            unsaved = true;
            displayDirty = true;
        }
    }
}

// The inventory as it is saved: items still in the Anvil are counted in
function inventoryForSave() {
    const copy = cloneSlots(inventory);
    for (const s of anvilIn) {
        if (s) {
            addToSlots(copy, s.id, s.n);
        }
    }
    return copy;
}

// Price of the next piece of this kind. More pieces owned = more expensive.
function toolCost(def) {
    return Math.ceil(def.baseCost * Math.pow(def.growth, ownedCount(def.id)));
}

// Price of buying "amount" pieces in a row
function priceFor(def, amount) {
    const owned = ownedCount(def.id);
    let total = 0;
    for (let i = 0; i < amount; i++) {
        total = total + Math.ceil(def.baseCost * Math.pow(def.growth, owned + i));
    }
    return total;
}

// Sales in the last 10 seconds, averaged to "points per second"
function pointsPerSecond() {
    const now = performance.now() / 1000;
    let total = 0;
    for (const sale of salesLog) {
        if (now - sale.t <= 10) {
            total = total + sale.v;
        }
    }
    return total / 10;
}

// =====================================================================
//  SCREENS
// =====================================================================
let currentScreen = 'loading-screen';
let settingsReturn = 'menu-screen'; // where the Back button in Settings goes

function showScreen(screenId) {
    if (currentScreen === 'anvil-screen' && screenId !== 'anvil-screen') {
        stowAnvil();
    }
    if (screenId === 'settings-screen' && currentScreen !== 'settings-screen') {
        settingsReturn = currentScreen;
    }
    currentScreen = screenId;
    invSel = null;
    const screens = document.querySelectorAll('.screen');
    for (const screen of screens) {
        screen.classList.add('hidden');
    }
    document.getElementById(screenId).classList.remove('hidden');
    if (screenId === 'settings-screen') {
        fillSettings();
    }
    if (screenId === 'leaderboard-screen') {
        loadLeaderboard(false);
    }
    updateDisplay();
}

// =====================================================================
//  THE HOTBAR (the first 9 inventory slots) + Remove and Rotate
// =====================================================================
const hotbarParts = [];  // one { button, emoji, count } per hotbar slot
let removeButton = null;

function buildToolbar() {
    const hotbar = document.getElementById('hotbar');
    for (let i = 0; i < HOTBAR; i++) {
        const button = document.createElement('button');
        button.className = 'slot';
        button.innerHTML =
            '<span class="slot-key">' + (i + 1) + '</span>' +
            '<span class="slot-emoji"></span>' +
            '<span class="slot-count"></span>';
        button.addEventListener('click', function () {
            selectHotbar(i);
        });
        hotbar.appendChild(button);
        hotbarParts.push({
            button: button,
            emoji: button.querySelector('.slot-emoji'),
            count: button.querySelector('.slot-count')
        });
    }

    const bar = document.getElementById('tool-buttons');

    removeButton = document.createElement('button');
    removeButton.className = 'tool';
    removeButton.title = REMOVE_TOOL.hint;
    removeButton.innerHTML =
        '<span class="tool-emoji">' + REMOVE_TOOL.emoji + '</span>' +
        '<span class="tool-name">Remove</span>' +
        '<span class="tool-cost">take back</span>';
    removeButton.addEventListener('click', function () {
        removeMode = !removeMode;
        displayDirty = true;
    });
    bar.appendChild(removeButton);

    const rotate = document.createElement('button');
    rotate.className = 'tool';
    rotate.id = 'rotate-btn';
    rotate.title = 'Turn belts and rice cookers (shortcut: R)';
    rotate.innerHTML =
        '<span class="tool-emoji" id="rotate-arrow">→</span>' +
        '<span class="tool-name">Rotate</span>' +
        '<span class="tool-cost">R</span>';
    rotate.addEventListener('click', rotatePieces);
    bar.appendChild(rotate);
}
buildToolbar();

function selectHotbar(i) {
    hotbarSel = i;
    removeMode = false;
    displayDirty = true;
}

function rotatePieces() {
    rotation = (rotation + 1) % 4;
    displayDirty = true;
}

// Keys: R rotates, 1-9 pick a hotbar slot (only while you're in the game)
document.addEventListener('keydown', function (event) {
    const inGame = !document.getElementById('game-screen').classList.contains('hidden');
    if (!inGame) {
        return;
    }
    if (event.key === 'r' || event.key === 'R') {
        rotatePieces();
    } else if (event.key >= '1' && event.key <= '9') {
        selectHotbar(Number(event.key) - 1);
    }
});

// Draws one inventory slot (used by the hotbar and the inventory screen)
function paintSlot(parts, stack) {
    const def = stack ? ITEM_BY_ID[stack.id] : null;
    parts.emoji.innerText = def ? def.emoji : '';
    parts.count.innerText = stack && stack.n > 1 ? String(stack.n) : '';
    parts.button.classList.toggle('golden', !!(def && def.golden));
    parts.button.title = def ? def.name + (stack.n > 1 ? ' x' + stack.n : '') : 'Empty slot';
}

// A short message under the factory ("Need 20 points...")
let messageTimer = null;
function showMessage(text) {
    const box = document.getElementById('factory-message');
    box.innerText = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(function () {
        box.innerText = '';
    }, 2500);
}

// =====================================================================
//  SHOWING NUMBERS ON THE PAGE
// =====================================================================
function updateDisplay() {
    document.getElementById('score').innerText = format(points);
    document.getElementById('per-second').innerText =
        formatRate(pointsPerSecond()) + ' per second, ' + formatRate(clickPower()) + ' per click';

    // Chopsticks button
    const cost = chopsticksCost();
    document.getElementById('chopsticks-count').innerText = 'x' + chopsticks;
    document.getElementById('chopsticks-cost').innerText = format(cost);
    document.getElementById('chopsticks-btn').disabled = points < cost;

    // Hotbar: the first 9 inventory slots
    for (let i = 0; i < HOTBAR; i++) {
        paintSlot(hotbarParts[i], inventory[i]);
        hotbarParts[i].button.classList.toggle('selected', !removeMode && hotbarSel === i);
    }
    removeButton.classList.toggle('selected', removeMode);
    document.getElementById('rotate-arrow').innerText = ARROWS[rotation];

    // What the selected thing does
    const held = inventory[hotbarSel];
    let info = 'Empty slot. Open the Inventory to put something here.';
    if (removeMode) {
        info = REMOVE_TOOL.emoji + ' ' + REMOVE_TOOL.name + ': ' + REMOVE_TOOL.hint;
    } else if (held) {
        const def = ITEM_BY_ID[held.id];
        info = def.emoji + ' ' + def.name + ': ' + def.hint;
    }
    document.getElementById('held-info').innerText = info;

    document.getElementById('anvil-btn').classList.toggle('hidden', !anvil);
    updateShop();
    updateInventory();
    updateAnvil();
}

// =====================================================================
//  THE SHOP: buy tiles (they go to your inventory) and unlock the anvil
// =====================================================================
const shopRows = {}; // tile id (or 'anvil') -> { sub, button }

function addShopRow(id, emoji, name, hint, onBuy) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML =
        '<span class="item-emoji">' + emoji + '</span>' +
        '<span class="item-info"><span class="item-name">' + name + '</span>' +
        '<span class="item-sub"></span></span>';
    const button = document.createElement('button');
    button.className = 'item-buy';
    button.addEventListener('click', onBuy);
    row.appendChild(button);
    document.getElementById('shop-list').appendChild(row);
    shopRows[id] = { sub: row.querySelector('.item-sub'), hint: hint, button: button };
}

function buildShop() {
    for (const def of TILES) {
        addShopRow(def.id, def.emoji, def.name, def.hint, function () {
            buyTile(def);
        });
    }
    addShopRow('anvil', '⚒️', 'Anvil', 'Unlocks the Anvil: try putting items together', buyAnvil);

    for (const button of document.querySelectorAll('.amount-btn')) {
        button.addEventListener('click', function () {
            buyAmount = Number(button.dataset.amount);
            displayDirty = true;
        });
    }
}

function updateShop() {
    document.getElementById('shop-score').innerText = format(points);

    for (const button of document.querySelectorAll('.amount-btn')) {
        button.classList.toggle('selected', Number(button.dataset.amount) === buyAmount);
    }

    for (const def of TILES) {
        const row = shopRows[def.id];
        const price = priceFor(def, buyAmount);
        const room = roomFor(inventory, def.id, buyAmount);
        row.sub.innerText = def.hint + ' (you own ' + format(ownedCount(def.id)) + ')';
        row.button.innerText = room ? 'Buy ' + buyAmount + ': ' + format(price) : 'Inventory full';
        row.button.disabled = points < price || !room || ownedCount(def.id) + buyAmount > MAX_PER_KIND;
    }

    const anvilRow = shopRows.anvil;
    anvilRow.sub.innerText = anvilRow.hint;
    if (anvil) {
        anvilRow.button.innerText = 'Unlocked ✓';
        anvilRow.button.disabled = true;
    } else {
        anvilRow.button.innerText = 'Unlock: ' + format(ANVIL_COST);
        anvilRow.button.disabled = points < ANVIL_COST;
    }
}

function buyTile(def) {
    const price = priceFor(def, buyAmount);
    if (points < price || ownedCount(def.id) + buyAmount > MAX_PER_KIND) {
        return;
    }
    if (!addToSlots(inventory, def.id, buyAmount)) {
        return; // no room in the inventory
    }
    points = points - price;
    unsaved = true;
    displayDirty = true;
    saveSoon();
}

function buyAnvil() {
    if (anvil || points < ANVIL_COST) {
        return;
    }
    points = points - ANVIL_COST;
    anvil = true;
    unsaved = true;
    displayDirty = true;
    saveSoon();
}

// =====================================================================
//  THE INVENTORY: slots like in Minecraft
// =====================================================================
// Click a stack, then click another slot: empty = move, same item = merge,
// different item = swap. Right-click moves just one. You can also drag.
const invParts = [];       // the inventory screen: one { button, emoji, count } per slot
const anvInvParts = [];    // the same 36 slots, shown on the Anvil screen
const anvilInParts = [];   // the two Anvil input slots
let anvilOutPart = null;   // the Anvil output slot
let dragFrom = null;

function slotClicked(address, one) {
    if (invSel === null) {
        if (getSlotAt(address)) {
            invSel = address;
        }
    } else if (invSel === address) {
        invSel = null;
    } else {
        const from = invSel;
        moveSlot(from, address, one);
        // Right-clicking keeps the stack selected, so you can drop several one by one
        if (!(one && getSlotAt(from))) {
            invSel = null;
        }
    }
    displayDirty = true;
}

// One slot you can click, right-click and drag. address says which slot it is.
function makeSlot(address) {
    // A div, not a button: Firefox can't drag buttons
    const el = document.createElement('div');
    el.className = 'slot';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.draggable = true;
    el.innerHTML = '<span class="slot-emoji"></span><span class="slot-count"></span>';

    el.addEventListener('click', function () {
        slotClicked(address, false);
    });
    el.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        slotClicked(address, true);
    });
    el.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            slotClicked(address, false);
        }
    });

    el.addEventListener('dragstart', function (event) {
        if (!getSlotAt(address)) {
            event.preventDefault();
            return;
        }
        dragFrom = address;
        el.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(address)); // Firefox needs this
    });
    el.addEventListener('dragover', function (event) {
        if (dragFrom !== null) {
            event.preventDefault();
        }
    });
    el.addEventListener('drop', function (event) {
        event.preventDefault();
        if (dragFrom !== null) {
            moveSlot(dragFrom, address, false);
            invSel = null;
            displayDirty = true;
        }
    });
    el.addEventListener('dragend', function () {
        dragFrom = null;
        el.classList.remove('dragging');
    });

    return {
        button: el,
        emoji: el.querySelector('.slot-emoji'),
        count: el.querySelector('.slot-count')
    };
}

// The 36 inventory slots: the first 9 go in the hotbar box, the rest in the bag box
function buildSlotGrid(hotbarBox, bagBox, parts) {
    for (let i = 0; i < INV_SLOTS; i++) {
        const part = makeSlot(i);
        (i < HOTBAR ? hotbarBox : bagBox).appendChild(part.button);
        parts.push(part);
    }
}

function buildInventory() {
    buildSlotGrid(document.getElementById('inv-hotbar'), document.getElementById('inv-bag'), invParts);
}

function paintGrid(parts) {
    for (let i = 0; i < INV_SLOTS; i++) {
        paintSlot(parts[i], inventory[i]);
        parts[i].button.classList.toggle('selected', invSel === i);
    }
}

function updateInventory() {
    if (invSel !== null && !getSlotAt(invSel)) {
        invSel = null; // the picked-up stack is gone
    }
    paintGrid(invParts);
    let stock = 0;
    for (let i = 0; i < INV_SLOTS; i++) {
        if (inventory[i]) {
            stock = stock + inventory[i].n;
        }
    }
    let placed = 0;
    for (const cell of grid) {
        if (cell) {
            placed = placed + 1;
        }
    }
    document.getElementById('inventory-total').innerText =
        format(stock) + (stock === 1 ? ' item' : ' items') + ' in your inventory, ' +
        format(placed) + ' placed in the factory';

    let text = 'Click a stack, then click another slot to move, merge or swap. ' +
        'Right-click moves one item. You can drag too. The top row is your hotbar.';
    if (invSel !== null) {
        const def = ITEM_BY_ID[getSlotAt(invSel).id];
        text = def.emoji + ' ' + def.name + ' x' + getSlotAt(invSel).n + ': ' + def.hint;
    }
    document.getElementById('inv-info').innerText = text;
}
buildShop();
buildInventory();

// =====================================================================
//  THE ANVIL: two slots. Put items in and see what comes out (like Minecraft).
//  There is no recipe list: players have to work it out themselves.
// =====================================================================
// What do the two input slots make? The order and the slots don't matter, only what
// is in them: the same items as a recipe, at least as many as it needs.
function anvilRecipe() {
    const totals = {};
    for (const s of anvilIn) {
        if (s) {
            totals[s.id] = (totals[s.id] || 0) + s.n;
        }
    }
    const ids = Object.keys(totals);
    if (ids.length === 0) {
        return null;
    }
    for (const recipe of RECIPES) {
        if (recipe.needs.length === ids.length &&
            recipe.needs.every(function (need) { return (totals[need.id] || 0) >= need.n; })) {
            return recipe;
        }
    }
    return null;
}

// Uses up n of an item from the two input slots
function takeFromAnvil(id, n) {
    for (let k = 0; k < anvilIn.length && n > 0; k++) {
        const s = anvilIn[k];
        if (s && s.id === id) {
            const take = Math.min(n, s.n);
            s.n = s.n - take;
            n = n - take;
            if (s.n <= 0) {
                anvilIn[k] = null;
            }
        }
    }
}

// Click the output slot to take what it made. Shift-click makes as many as the inputs allow.
function takeOutput(all) {
    const recipe = anvilRecipe();
    if (!recipe) {
        return;
    }
    let most = 1;
    if (all) {
        most = Infinity;
        for (const need of recipe.needs) {
            let have = 0;
            for (const s of anvilIn) {
                if (s && s.id === need.id) {
                    have = have + s.n;
                }
            }
            most = Math.min(most, Math.floor(have / need.n));
        }
    }
    // If the bag has no room for that many, try fewer
    for (let count = most; count >= 1; count--) {
        const copy = cloneSlots(inventory);
        if (addToSlots(copy, recipe.out, recipe.n * count)) {
            for (const need of recipe.needs) {
                takeFromAnvil(need.id, need.n * count);
            }
            inventory = copy;
            unsaved = true;
            displayDirty = true;
            saveSoon();
            setMessage('anvil-msg', 'You made ' + (recipe.n * count) + ' x ' + ITEM_BY_ID[recipe.out].name + '!', 'good');
            return;
        }
    }
    setMessage('anvil-msg', 'Your inventory is full. Make some room first.', 'bad');
}

function buildAnvil() {
    buildSlotGrid(document.getElementById('anv-hotbar'), document.getElementById('anv-bag'), anvInvParts);

    const inBox = document.getElementById('anvil-in');
    for (let k = 0; k < 2; k++) {
        const part = makeSlot(INV_SLOTS + k);
        inBox.appendChild(part.button);
        anvilInParts.push(part);
    }

    // The output slot: you can only take from it
    const out = document.createElement('div');
    out.className = 'slot output';
    out.setAttribute('role', 'button');
    out.tabIndex = 0;
    out.innerHTML = '<span class="slot-emoji"></span><span class="slot-count"></span>';
    out.addEventListener('click', function (event) {
        takeOutput(event.shiftKey);
    });
    out.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            takeOutput(event.shiftKey);
        }
    });
    document.getElementById('anvil-out').appendChild(out);
    anvilOutPart = {
        button: out,
        emoji: out.querySelector('.slot-emoji'),
        count: out.querySelector('.slot-count')
    };
}

function updateAnvil() {
    paintGrid(anvInvParts);
    for (let k = 0; k < 2; k++) {
        paintSlot(anvilInParts[k], anvilIn[k]);
        anvilInParts[k].button.classList.toggle('selected', invSel === INV_SLOTS + k);
    }
    const recipe = anvilRecipe();
    paintSlot(anvilOutPart, recipe ? { id: recipe.out, n: recipe.n } : null);
    anvilOutPart.button.classList.toggle('ready', !!recipe);
}
buildAnvil();

// =====================================================================
//  ANTI-AUTOCLICKER
// =====================================================================
const MAX_CLICKS_PER_SECOND = 12; // a fast human is around 6-10, so 12 leaves some room
let recentClicks = [];            // when your last few clicks happened

function clickAllowed(event) {
    // Check 1: was this click made by a real mouse, touch or key?
    // A script like button.click() creates a fake event, and isTrusted is false for those.
    if (!event.isTrusted) {
        return false;
    }

    // Check 2: speed limit. Forget clicks older than 1 second, then count what's left.
    const now = performance.now();
    recentClicks = recentClicks.filter(function (time) {
        return now - time < 1000;
    });
    if (recentClicks.length >= MAX_CLICKS_PER_SECOND) {
        return false;
    }

    recentClicks.push(now);
    return true;
}

// =====================================================================
//  CLICKING
// =====================================================================
function pointsButton(event) {
    if (!clickAllowed(event)) {
        return; // ignore this click completely
    }
    const gained = clickPower();
    points = points + gained;
    unsaved = true;
    displayDirty = true;
    floatText(event, gained);
}

function buyChopsticks() {
    const cost = chopsticksCost();
    if (points < cost) {
        return;
    }
    points = points - cost;
    chopsticks = chopsticks + 1;
    unsaved = true;
    displayDirty = true;
    saveSoon();
}

// A little "+1" (or "+3"...) that floats up from where you clicked
function floatText(event, amount) {
    const rect = event.currentTarget.getBoundingClientRect();
    // event.clientX is 0 when someone "clicks" with the keyboard, so fall back to the middle
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;

    const bubble = document.createElement('span');
    bubble.className = 'float';
    bubble.innerText = '+' + formatRate(amount);
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
    document.body.appendChild(bubble);

    setTimeout(function () {
        bubble.remove();
    }, 800);
}

// =====================================================================
//  BUILDING: placing and removing pieces on the grid
// =====================================================================
function cellAt(x, y) {
    return grid[y * COLS + x];
}

function inGrid(x, y) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

// Sushi can enter any piece except a rice cooker
function passable(x, y) {
    if (!inGrid(x, y)) {
        return false;
    }
    const cell = cellAt(x, y);
    return cell !== null && cell.kind !== 'source';
}

function clickSquare(x, y) {
    const index = y * COLS + x;
    const cell = grid[index];

    // Remove tool: upgrades (soy sauce, wasabi...) come off first, the last one put on first
    if (removeMode) {
        if (!cell) {
            return;
        }
        if (cell.mods.length > 0) {
            const last = cell.mods[cell.mods.length - 1];
            if (!addToSlots(inventory, last, 1)) {
                showMessage('Your inventory is full.');
                return;
            }
            cell.mods.pop();
        } else {
            if (!addToSlots(inventory, cell.kind, 1)) {
                showMessage('Your inventory is full.');
                return;
            }
            grid[index] = null;
        }
        unsaved = true;
        displayDirty = true;
        return;
    }

    const stack = inventory[hotbarSel];
    if (!stack) {
        showMessage('Nothing in this slot. Pick another one, or open the Inventory.');
        return;
    }
    const def = ITEM_BY_ID[stack.id];

    // An ingredient: it is used in the Anvil, not in the factory
    if (!TILE_BY_ID[def.id] && !def.applies) {
        showMessage('The ' + def.name.toLowerCase() + ' is an ingredient. It does not go on pieces.');
        return;
    }

    // An equipable item (soy sauce, wasabi...): goes ON a piece you already placed
    if (def.applies) {
        if (!cell) {
            showMessage('Click a piece you already placed to use the ' + def.name.toLowerCase() + ' on it.');
        } else if (!def.applies.includes(cell.kind)) {
            showMessage('The ' + def.name.toLowerCase() + " doesn't work on a " + TILE_BY_ID[cell.kind].name.toLowerCase() + '.');
        } else if (cell.mods.includes(def.id)) {
            showMessage('That piece already has ' + def.name.toLowerCase() + ' on it.');
        } else {
            cell.mods.push(def.id);
            useFromSlot(hotbarSel);
            unsaved = true;
            displayDirty = true;
        }
        return;
    }

    // A piece
    if (cell) {
        // Clicking a belt or rice cooker with the same piece turns it
        if (cell.kind === def.id && (def.id === 'belt' || def.id === 'source')) {
            cell.dir = rotation;
            unsaved = true;
        } else {
            showMessage('That square is taken. Use Remove first.');
        }
        return;
    }
    grid[index] = { kind: def.id, dir: rotation, mods: [] };
    useFromSlot(hotbarSel);
    unsaved = true;
    displayDirty = true;
}

// =====================================================================
//  THE SUSHI: moving along belts
// =====================================================================
// Every sushi is an object: where it is (x, y), where it is heading (tx, ty),
// how far along it is (p from 0 to 1), and how much it is worth (value).

// How much a piece earns: all its upgrades multiplied (golden 2 x soy sauce 1.5 = 3)
function modMultiplier(cell) {
    let m = 1;
    if (cell && cell.mods) {
        for (const id of cell.mods) {
            m = m * (ITEM_BY_ID[id].multiplier || 1);
        }
    }
    return m;
}

// How fast a piece works: wasabi makes it 2x
function speedMultiplier(cell) {
    let m = 1;
    if (cell && cell.mods) {
        for (const id of cell.mods) {
            m = m * (ITEM_BY_ID[id].speed || 1);
        }
    }
    return m;
}

function trySpawn(sx, sy, dir, value) {
    const tx = sx + DX[dir];
    const ty = sy + DY[dir];
    if (!passable(tx, ty) || sushi.length >= MAX_SUSHI) {
        return false; // nowhere to put it
    }
    sushi.push({
        x: sx, y: sy, tx: tx, ty: ty,
        dx: DX[dir], dy: DY[dir],
        p: 0, value: value, age: 0,
        seen: [],                          // machines it already passed (each gives its bonus once)
        complete: false,                   // false = a plain rice ball, true = sushi (it passed a fish)
        waiting: false,                    // true when it has reached the end of a belt
        jx: (Math.random() - 0.5) * 0.3,   // small random offset so waiting sushi form a little pile
        jy: (Math.random() - 0.5) * 0.3,
        dead: false
    });
    return true;
}

// Looks at the square the sushi is standing on and decides where to go next.
function tryDepart(s) {
    const cell = cellAt(s.x, s.y);
    if (!cell || cell.kind === 'source') {
        s.dead = true;
        return;
    }
    if (cell.kind === 'belt') {
        s.dx = DX[cell.dir];
        s.dy = DY[cell.dir];
    }
    // Machines (fish, chef) keep the direction the sushi was already travelling in

    const tx = s.x + s.dx;
    const ty = s.y + s.dy;
    if (passable(tx, ty)) {
        s.tx = tx;
        s.ty = ty;
        s.waiting = false;
    } else {
        s.waiting = true; // end of the line: wait until you build something there
    }
}

function sell(s, x, y, multiplier) {
    const now = performance.now() / 1000;
    const gained = s.value * multiplier;
    points = points + gained;
    salesLog.push({ t: now, v: gained });
    effects.push({ x: x, y: y, text: '+' + formatRate(gained), age: 0 });
    unsaved = true;
    displayDirty = true;
}

// Called when a sushi reaches the middle of its target square
function arrive(s) {
    s.x = s.tx;
    s.y = s.ty;
    const cell = cellAt(s.x, s.y);

    if (!cell || cell.kind === 'source') {
        s.dead = true; // the piece was removed while it was on its way
        return;
    }
    if (cell.kind === 'exit') {
        sell(s, s.x, s.y, modMultiplier(cell));
        s.dead = true;
        return;
    }
    if (cell.kind === 'fish' || cell.kind === 'chef') {
        const index = s.y * COLS + s.x;
        if (!s.seen.includes(index)) {
            s.seen.push(index);
            s.value = s.value + TILE_BY_ID[cell.kind].bonus * modMultiplier(cell);
            // The first fish turns the rice ball into complete sushi, which is worth more
            if (cell.kind === 'fish' && !s.complete) {
                s.complete = true;
                s.value = s.value * COMPLETE_BOOST;
            }
        }
    }
    tryDepart(s);
}

function stepSushi(s, dt) {
    s.age = s.age + dt;
    if (s.age > MAX_AGE) {
        s.dead = true;
        return;
    }

    if (s.waiting) {
        tryDepart(s); // maybe you built something since last time
        if (s.waiting || s.dead) {
            return;
        }
    }

    s.p = s.p + SPEED * dt * speedMultiplier(cellAt(s.x, s.y)); // wasabi pieces are faster
    // "while" in case a lot of time passed (for example the tab was in the background)
    while (s.p >= 1 && !s.dead) {
        s.p = s.p - 1;
        arrive(s);
        if (s.waiting) {
            s.p = 0;
            return;
        }
    }
}

// One step of the whole factory. dt = seconds since the last step.
function runFactory(dt) {
    // Rice cookers make sushi
    for (let i = 0; i < grid.length; i++) {
        const cell = grid[i];
        if (cell && cell.kind === 'source') {
            timers[i] = (timers[i] || 0) + dt * speedMultiplier(cell);
            while (timers[i] >= SPAWN_EVERY) {
                const x = i % COLS;
                const y = Math.floor(i / COLS);
                if (trySpawn(x, y, cell.dir, 1 * modMultiplier(cell))) {
                    timers[i] = timers[i] - SPAWN_EVERY;
                } else {
                    timers[i] = SPAWN_EVERY; // blocked: make one as soon as there is room
                    break;
                }
            }
        } else {
            delete timers[i];
        }
    }

    // Move all the sushi
    for (const s of sushi) {
        stepSushi(s, dt);
    }
    sushi = sushi.filter(function (s) {
        return !s.dead;
    });

    // Fade the "+5" popups
    for (const effect of effects) {
        effect.age = effect.age + dt;
    }
    effects = effects.filter(function (effect) {
        return effect.age < 0.9;
    });

    // Forget sales older than 10 seconds
    const now = performance.now() / 1000;
    salesLog = salesLog.filter(function (sale) {
        return now - sale.t <= 10;
    });
}

// The factory runs 20 times a second. It uses real elapsed time, so it also keeps
// working (a bit more roughly) when the tab is in the background.
let lastTick = performance.now();
setInterval(function () {
    const now = performance.now();
    const dt = Math.min((now - lastTick) / 1000, 5);
    lastTick = now;
    runFactory(dt);
}, 50);

// Refresh the "per second" number once a second, even when nothing else changed
setInterval(function () {
    displayDirty = true;
}, 1000);

// =====================================================================
//  DRAWING THE FACTORY (canvas)
// =====================================================================
const canvas = document.getElementById('factory-canvas');
const ctx = canvas.getContext('2d');
canvas.width = COLS * CELL * RES;
canvas.height = ROWS * CELL * RES;

// Noto Color Emoji is the ChromeOS emoji set. style.css loads it from Google Fonts,
// so every device shows the same emojis.
const EMOJI_FONT = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

// Canvas only uses a font that is already loaded, so ask for it up front
if (document.fonts && document.fonts.load) {
    const allEmoji = Object.values(ITEM_BY_ID).map(function (t) { return t.emoji; }).join('') + '⚒️🛒🎒🗑️✨⚙️';
    document.fonts.load('28px "Noto Color Emoji"', allEmoji).catch(function () {});
}

function roundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawEmoji(emoji, cx, cy, size) {
    ctx.font = size + 'px ' + EMOJI_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(emoji, cx, cy + 2);
}

// Upgrades on a piece: a coloured glow and edge for each, and its little icon in the corner
function drawMods(x, y, mods) {
    if (!mods || mods.length === 0) {
        return;
    }
    for (let k = 0; k < mods.length; k++) {
        const def = ITEM_BY_ID[mods[k]];
        ctx.fillStyle = def.colour;
        ctx.globalAlpha = 0.22;
        roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = def.colour;
        ctx.lineWidth = 2.5;
        roundedRect(x + 2 + k * 3, y + 2 + k * 3, CELL - 4 - k * 6, CELL - 4 - k * 6, 10);
        ctx.stroke();
        drawEmoji(def.emoji, x + CELL - 12 - k * 14, y + 12, 13);
    }
}

// Draws one piece in the square at (gx, gy)
function drawPiece(kind, dir, gx, gy, time, mods) {
    const x = gx * CELL;
    const y = gy * CELL;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;

    if (kind === 'belt') {
        ctx.fillStyle = '#26382f';
        roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 8);
        ctx.fill();

        // Moving arrows that point the way the belt goes
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(dir * Math.PI / 2);
        ctx.strokeStyle = 'rgba(246, 243, 234, 0.35)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const cellNow = mods && mods.length ? { mods: mods } : null;
        const phase = (time * SPEED * speedMultiplier(cellNow)) % 1;
        for (let k = 0; k < 2; k++) {
            const px = (((phase + k * 0.5) % 1) - 0.5) * CELL * 0.8;
            ctx.beginPath();
            ctx.moveTo(px - 5, -8);
            ctx.lineTo(px + 3, 0);
            ctx.lineTo(px - 5, 8);
            ctx.stroke();
        }
        ctx.restore();
        drawMods(x, y, mods);
        return;
    }

    // Machines: a coloured tile with an emoji on it
    const colours = { source: '#33503f', fish: '#1f4a58', chef: '#4f3a1f', exit: '#5a2f22' };
    ctx.fillStyle = colours[kind];
    roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
    ctx.fill();
    drawEmoji(TILE_BY_ID[kind].emoji, cx, cy, 28);

    drawMods(x, y, mods);

    // The rice cooker also shows which way it sends sushi
    if (kind === 'source') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(dir * Math.PI / 2);
        ctx.fillStyle = '#ff7a4d';
        ctx.beginPath();
        ctx.moveTo(CELL * 0.3, -7);
        ctx.lineTo(CELL * 0.45, 0);
        ctx.lineTo(CELL * 0.3, 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}

// A little piece of nigiri
// A plain rice ball (before a fish) or complete sushi (after a fish)
function drawSushi(cx, cy, value, complete) {
    const w = CELL * 0.5;
    const h = CELL * 0.3;

    if (!complete) {
        ctx.fillStyle = '#f6f3ea';
        ctx.beginPath();
        ctx.arc(cx, cy + 2, CELL * 0.17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        ctx.beginPath();
        ctx.arc(cx + 2, cy + 5, CELL * 0.1, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.fillStyle = '#f6f3ea';
        roundedRect(cx - w / 2, cy - h / 2 + 3, w, h * 0.7, 5);
        ctx.fill();

        ctx.fillStyle = '#ff7a4d';
        roundedRect(cx - w / 2 - 1, cy - h / 2 - 3, w + 2, h * 0.55, 5);
        ctx.fill();
    }

    if (value > 1) {
        ctx.font = '700 12px Fredoka, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#0f1f1a';
        ctx.strokeText(formatRate(value), cx, cy - h / 2 - 11);
        ctx.fillStyle = '#b7e05a';
        ctx.fillText(formatRate(value), cx, cy - h / 2 - 11);
    }
}

function draw() {
    requestAnimationFrame(draw);

    // Keep the numbers fresh on every screen (shop and inventory too)
    if (displayDirty) {
        updateDisplay();
        displayDirty = false;
    }

    // Nothing to draw while another screen is showing
    if (document.getElementById('game-screen').classList.contains('hidden')) {
        return;
    }

    const time = performance.now() / 1000;
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.clearRect(0, 0, COLS * CELL, ROWS * CELL);

    // Floor: a faint checkerboard
    for (let gy = 0; gy < ROWS; gy++) {
        for (let gx = 0; gx < COLS; gx++) {
            ctx.fillStyle = (gx + gy) % 2 === 0 ? '#0b1713' : '#0e1c17';
            ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
        }
    }

    // Pieces
    for (let i = 0; i < grid.length; i++) {
        const cell = grid[i];
        if (cell) {
            drawPiece(cell.kind, cell.dir, i % COLS, Math.floor(i / COLS), time, cell.mods);
        }
    }

    // Sushi on top
    for (const s of sushi) {
        let gx;
        let gy;
        if (s.waiting) {
            gx = s.x + s.jx;
            gy = s.y + s.jy;
        } else {
            gx = s.x + (s.tx - s.x) * s.p;
            gy = s.y + (s.ty - s.y) * s.p;
        }
        drawSushi((gx + 0.5) * CELL, (gy + 0.5) * CELL, s.value, s.complete);
    }

    // "+5" popups
    for (const effect of effects) {
        const rise = effect.age * 40;
        ctx.globalAlpha = 1 - effect.age / 0.9;
        ctx.font = '700 18px Fredoka, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#0f1f1a';
        ctx.strokeText(effect.text, (effect.x + 0.5) * CELL, effect.y * CELL - rise + 8);
        ctx.fillStyle = '#b7e05a';
        ctx.fillText(effect.text, (effect.x + 0.5) * CELL, effect.y * CELL - rise + 8);
        ctx.globalAlpha = 1;
    }

    // The square under the mouse: outline + a see-through preview of the piece
    if (hover) {
        const cell = cellAt(hover.x, hover.y);
        const stack = inventory[hotbarSel];
        const def = stack ? ITEM_BY_ID[stack.id] : null;
        let colour = '#b7e05a';          // green: this will work
        if (removeMode) {
            colour = cell ? '#ff9c9c' : 'rgba(246, 243, 234, 0.35)';
        } else if (!def) {
            colour = 'rgba(246, 243, 234, 0.35)';
        } else if (def.applies) {
            // Equipable: only works on a matching piece with nothing on it yet
            const works = cell && def.applies.includes(cell.kind) && !cell.mods.includes(def.id);
            colour = works ? def.colour : '#ff9c9c';
        } else if (!TILE_BY_ID[def.id]) {
            colour = '#ff9c9c';            // an ingredient can't be placed
        } else if (!cell) {
            ctx.globalAlpha = 0.55;
            drawPiece(def.id, rotation, hover.x, hover.y, time, []);
            ctx.globalAlpha = 1;
        } else if (cell.kind !== def.id) {
            colour = '#ff9c9c';
        }
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        roundedRect(hover.x * CELL + 2, hover.y * CELL + 2, CELL - 4, CELL - 4, 8);
        ctx.stroke();
    }
}
requestAnimationFrame(draw);

// Mouse and touch on the canvas
function squareFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / rect.width * COLS);
    const y = Math.floor((event.clientY - rect.top) / rect.height * ROWS);
    if (!inGrid(x, y)) {
        return null;
    }
    return { x: x, y: y };
}

canvas.addEventListener('pointermove', function (event) {
    hover = squareFromEvent(event);
});

canvas.addEventListener('pointerleave', function () {
    hover = null;
});

canvas.addEventListener('click', function (event) {
    const square = squareFromEvent(event);
    if (square) {
        clickSquare(square.x, square.y);
        saveSoon();
    }
});

// =====================================================================
//  SAVING
// =====================================================================
// The grid is saved as a list of short texts, one per square: "" (empty) or "belt:0".
// Upgrades add a third part: "fish:0:golden_soy_sauce,wasabi".
function gridToList() {
    return grid.map(function (cell) {
        if (!cell) {
            return '';
        }
        return cell.kind + ':' + cell.dir + (cell.mods.length > 0 ? ':' + cell.mods.join(',') : '');
    });
}

function listToGrid(list) {
    const result = emptyGrid();
    if (!Array.isArray(list) || list.length !== COLS * ROWS) {
        return result;
    }
    for (let i = 0; i < list.length; i++) {
        const parts = String(list[i]).split(':');
        const kind = parts[0];
        const dir = Number(parts[1]);
        if (TILE_BY_ID[kind] && dir >= 0 && dir <= 3) {
            const cell = { kind: kind, dir: dir, mods: [] };
            for (const id of String(parts[2] || '').split(',')) {
                const equip = ITEM_BY_ID[id];
                if (equip && equip.applies && equip.applies.includes(kind) && !cell.mods.includes(id)) {
                    cell.mods.push(id);
                }
            }
            result[i] = cell;
        }
    }
    return result;
}

// The inventory is saved as a list of INV_SLOTS short texts: "" (empty) or "belt:12".
function inventoryToSave() {
    return inventory.map(function (s) {
        return s ? s.id + ':' + s.n : '';
    });
}

function inventoryFromSave(saved) {
    const result = emptyInventory();
    if (Array.isArray(saved)) {
        // The new format: one text per slot
        for (let i = 0; i < Math.min(saved.length, INV_SLOTS); i++) {
            const parts = String(saved[i]).split(':');
            const n = Math.floor(Number(parts[1]));
            if (ITEM_BY_ID[parts[0]] && n >= 1) {
                result[i] = { id: parts[0], n: Math.min(n, MAX_STACK) };
            }
        }
    } else if (saved && typeof saved === 'object') {
        // Old saves: { belt: 3, fish: 1 }. Fill the slots in order, so the hotbar
        // starts out the way the old toolbar looked.
        for (const def of TILES) {
            const n = Math.floor(Number(saved[def.id]) || 0);
            const count = Math.min(Math.max(n, 0), MAX_PER_KIND);
            if (count > 0 && !addToSlots(result, def.id, count)) {
                console.warn('Not enough inventory room while converting an old save:', def.id);
            }
        }
    }
    return result;
}

// Everything that goes into the player's Firestore document
function saveData(pointsValue, chopsticksValue, slotsList) {
    return {
        name: playerName,
        points: Math.round(pointsValue * 100) / 100, // keep 2 decimals
        chopsticks: chopsticksValue,
        factory: gridToList(),
        inventory: slotsList.map(function (s) {
            return s ? s.id + ':' + s.n : '';
        }),
        anvil: anvil,
        savedAt: serverTimestamp() // Google's clock, not the player's
    };
}

// The leaderboard entry is a tiny public copy of your name and points.
// It is written together with your save, but at most every 30 seconds
// (and always when you change your name or leave the page) to keep writes low.
const BOARD_EVERY = 30000;
let lastBoardWrite = -BOARD_EVERY;
let boardForce = true;

async function save() {
    if (!currentUser || !unsaved) {
        return;
    }
    unsaved = false;
    const uid = currentUser.uid;
    const withBoard = boardForce || performance.now() - lastBoardWrite >= BOARD_EVERY;
    boardForce = false;
    try {
        const batch = writeBatch(db);
        batch.set(doc(db, 'users', uid), saveData(points, chopsticks, inventoryForSave()));
        if (withBoard) {
            batch.set(doc(db, 'leaderboard', uid), {
                name: playerName,
                points: Math.round(points * 100) / 100,
                savedAt: serverTimestamp()
            });
        }
        await batch.commit();
        if (withBoard) {
            lastBoardWrite = performance.now();
        }
    } catch (error) {
        unsaved = true; // try again next time
        if (withBoard) {
            boardForce = true;
        }
        console.error('Save failed:', error);
    }
}

setInterval(save, 10000);

// Important changes (buying, placing, removing) save almost right away,
// so a refresh a moment later does not lose them. Plain clicks and sales
// still wait for the 10 second timer, to keep the number of writes low.
let saveTimer = null;
function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
}

// Best effort when the page is closed or refreshed
window.addEventListener('pagehide', function () {
    boardForce = true;
    save();
});

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
        boardForce = true;
        save();
    }
});

// =====================================================================
//  LOGIN
// =====================================================================
const provider = new GoogleAuthProvider();

document.getElementById('login-btn').addEventListener('click', async function () {
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error('Login failed:', error.code);
        document.getElementById('login-error').innerText = 'Login failed: ' + error.code;
    }
});

document.getElementById('logout-btn').addEventListener('click', async function () {
    boardForce = true;
    await save();          // don't lose progress
    await signOut(auth);
});

// Runs at page load and every time someone logs in or out
onAuthStateChanged(auth, async function (user) {
    if (user) {
        try {
            const snapshot = await getDoc(doc(db, 'users', user.uid));
            resetGame();
            playerName = cleanName(user.displayName) || 'Player';
            if (snapshot.exists()) {
                const data = snapshot.data();
                playerName = cleanName(data.name) || playerName;
                points = Number(data.points) || 0;
                // Older saves kept this inside "owned"
                chopsticks = Number(data.chopsticks) || Number(data.owned && data.owned.chopsticks) || 0;
                grid = listToGrid(data.factory);
                inventory = inventoryFromSave(data.inventory); // older saves have none: starts empty
                anvil = data.anvil === true;
                unsaved = false;
            } else {
                // New player: create their document right away, empty.
                await setDoc(doc(db, 'users', user.uid), saveData(0, 0, inventory));
                unsaved = false;
            }
            currentUser = user;
            boardForce = true;
            unsaved = true;   // puts you on the leaderboard
            saveSoon();
            showName();
            showScreen('menu-screen');
        } catch (error) {
            console.error('Load failed:', error);
            document.getElementById('login-error').innerText = 'Could not load your progress. Check the Firestore rules.';
            showScreen('login-screen');
        }
    } else {
        currentUser = null;
        resetGame();
        unsaved = false;
        showScreen('login-screen');
    }
});

// =====================================================================
//  SETTINGS: username, game size, redeem codes
// =====================================================================
function cleanName(raw) {
    return String(raw || '')
        .replace(/[\u0000-\u001f\u007f]/g, '') // no control characters
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_NAME);
}

function showName() {
    document.getElementById('login-status').innerText = 'Signed in as ' + playerName;
}

// A line of feedback under a setting: kind is 'good' or 'bad'
function setMessage(id, text, kind) {
    const box = document.getElementById(id);
    box.innerText = text;
    box.className = 'setting-msg' + (kind ? ' ' + kind : '');
}

// ---- Game size (saved on this device, because it depends on this screen)
function loadScale() {
    try {
        const saved = Number(localStorage.getItem('sushiScale'));
        if (saved >= MIN_SCALE && saved <= MAX_SCALE) {
            return saved;
        }
    } catch (error) {}
    return DEFAULT_SCALE;
}

function applyScale(percent, remember) {
    document.documentElement.style.setProperty('--ui-scale', percent / 100);
    document.getElementById('scale-value').innerText = percent + '%';
    document.getElementById('scale-input').value = percent;
    document.getElementById('scale-reset').innerText = 'Reset to ' + DEFAULT_SCALE + '%';
    if (remember) {
        try {
            localStorage.setItem('sushiScale', String(percent));
        } catch (error) {}
    }
}
applyScale(loadScale(), false);

document.getElementById('scale-input').addEventListener('input', function (event) {
    applyScale(Number(event.target.value), true);
});

document.getElementById('scale-reset').addEventListener('click', function () {
    applyScale(DEFAULT_SCALE, true);
});

// ---- Username (saved in your Firestore document)
function fillSettings() {
    document.getElementById('name-input').value = playerName;
    setMessage('name-msg', '', '');
    setMessage('code-msg', '', '');
}

function saveName() {
    const name = cleanName(document.getElementById('name-input').value);
    if (!name) {
        setMessage('name-msg', 'Your name can not be empty.', 'bad');
        return;
    }
    playerName = name;
    document.getElementById('name-input').value = name;
    showName();
    unsaved = true;
    boardForce = true;
    saveSoon();
    setMessage('name-msg', 'Saved!', 'good');
}

document.getElementById('name-save').addEventListener('click', saveName);
document.getElementById('name-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        saveName();
    }
});

document.getElementById('settings-back').addEventListener('click', function () {
    showScreen(settingsReturn);
});

// ---- Redeem codes
// Codes live in Firestore: collection "Codes", document id = the code (UPPERCASE).
// A code document can have:
//   points: 500            chopsticks: 2
//   items: { belt: 10, golden_soy_sauce: 1 }      message: "Welcome!"
// Each account can use each code once: that is stored in users/{uid}/redeemed/{CODE},
// and the Firestore rules refuse to create that document twice.
function normalizeCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    return /^[A-Z0-9_-]{1,40}$/.test(code) ? code : '';
}

// Reads and checks the reward in a code document. Returns null if it makes no sense.
function readReward(data) {
    const reward = { points: 0, chopsticks: 0, items: [], message: '' };
    const whole = function (value, max) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
    };
    reward.points = whole(data.points, 1e12);
    reward.chopsticks = whole(data.chopsticks, 100000);
    if (typeof data.message === 'string') {
        reward.message = data.message.slice(0, 120);
    }
    if (data.items && typeof data.items === 'object') {
        for (const id of Object.keys(data.items)) {
            if (!ITEM_BY_ID[id]) {
                console.warn('Code has an unknown item:', id);
                return null; // do not burn the code on a typo
            }
            const n = whole(data.items[id], MAX_STACK);
            if (n > 0) {
                reward.items.push({ id: id, n: n });
            }
        }
    }
    if (reward.points === 0 && reward.chopsticks === 0 && reward.items.length === 0) {
        return null;
    }
    return reward;
}

function rewardText(reward) {
    const parts = [];
    if (reward.points > 0) {
        parts.push(format(reward.points) + ' points');
    }
    if (reward.chopsticks > 0) {
        parts.push(reward.chopsticks + ' chopsticks');
    }
    for (const item of reward.items) {
        parts.push(item.n + ' x ' + ITEM_BY_ID[item.id].name);
    }
    return parts.join(', ');
}

let redeeming = false;

async function redeemCode() {
    if (redeeming || !currentUser) {
        return;
    }
    const input = document.getElementById('code-input');
    const code = normalizeCode(input.value);
    if (!code) {
        setMessage('code-msg', 'Type a code first.', 'bad');
        return;
    }

    redeeming = true;
    document.getElementById('code-btn').disabled = true;
    setMessage('code-msg', 'Checking...', '');
    try {
        const uid = currentUser.uid;
        const usedRef = doc(db, 'users', uid, 'redeemed', code);
        const results = await Promise.all([getDoc(doc(db, 'Codes', code)), getDoc(usedRef)]);
        const codeSnap = results[0];
        const usedSnap = results[1];

        if (!codeSnap.exists()) {
            setMessage('code-msg', "That code doesn't exist.", 'bad');
            return;
        }
        if (usedSnap.exists()) {
            setMessage('code-msg', 'You already used that code.', 'bad');
            return;
        }
        const reward = readReward(codeSnap.data());
        if (!reward) {
            setMessage('code-msg', "That code doesn't work right now.", 'bad');
            return;
        }

        // Work out the new state on copies first
        const newSlots = cloneSlots(inventory);
        for (const item of reward.items) {
            if (!addToSlots(newSlots, item.id, item.n)) {
                setMessage('code-msg', 'Your inventory is too full for this code. Make some room and try again.', 'bad');
                return;
            }
        }
        const newPoints = Math.min(points + reward.points, 999999999999999);
        const newChopsticks = Math.min(chopsticks + reward.chopsticks, 100000);

        // One batch: the "you used this" marker and your new save go in together or not at all
        const batch = writeBatch(db);
        batch.set(usedRef, { redeemedAt: serverTimestamp() });
        batch.set(doc(db, 'users', uid), saveData(newPoints, newChopsticks, newSlots));
        await batch.commit();

        // It worked: give the reward in the game
        points = Math.min(points + reward.points, 999999999999999);
        chopsticks = Math.min(chopsticks + reward.chopsticks, 100000);
        for (const item of reward.items) {
            if (!addToSlots(inventory, item.id, item.n)) {
                inventory = newSlots; // (only if the bag changed while we were waiting)
                break;
            }
        }
        unsaved = true;
        displayDirty = true;
        saveSoon();
        input.value = '';
        setMessage('code-msg', 'Code redeemed! You got ' + rewardText(reward) + '.' +
            (reward.message ? ' ' + reward.message : ''), 'good');
    } catch (error) {
        console.error('Redeem failed:', error);
        if (error.code === 'permission-denied') {
            setMessage('code-msg', 'That code could not be redeemed. Did you already use it?', 'bad');
        } else {
            setMessage('code-msg', 'Something went wrong. Try again in a moment.', 'bad');
        }
    } finally {
        redeeming = false;
        document.getElementById('code-btn').disabled = false;
    }
}

document.getElementById('code-btn').addEventListener('click', redeemCode);
document.getElementById('code-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        redeemCode();
    }
});

// =====================================================================
//  LEADERBOARD: top 10 by points
// =====================================================================
let boardLoading = false;

// quiet = an automatic refresh: no "Loading..." text and no extra save
async function loadLeaderboard(quiet) {
    if (boardLoading) {
        return;
    }
    boardLoading = true;
    const list = document.getElementById('board-list');
    const status = document.getElementById('board-status');
    try {
        if (quiet !== true) {
            status.innerText = 'Loading...';
            // Make sure your own latest points are on the board first
            boardForce = true;
            unsaved = true;
            await save();
        }

        const snap = await getDocs(query(collection(db, 'leaderboard'), orderBy('points', 'desc'), limit(10)));
        list.innerHTML = '';
        let rank = 0;
        snap.forEach(function (entry) {
            rank = rank + 1;
            const data = entry.data();
            const row = document.createElement('div');
            row.className = 'item board-row' + (currentUser && entry.id === currentUser.uid ? ' me' : '');
            const place = document.createElement('span');
            place.className = 'board-rank';
            place.innerText = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank;
            const name = document.createElement('span');
            name.className = 'item-name board-name';
            name.innerText = cleanName(data.name) || 'Player';
            const score = document.createElement('span');
            score.className = 'points-text';
            score.innerText = format(Number(data.points) || 0);
            row.append(place, name, score);
            list.appendChild(row);
        });
        status.innerText = rank === 0 ? 'Nobody is on the board yet.' : 'Your points: ' + format(points);
    } catch (error) {
        console.error('Leaderboard failed:', error);
        status.innerText = 'Could not load the leaderboard.';
    } finally {
        boardLoading = false;
    }
}

document.getElementById('board-refresh').addEventListener('click', function () {
    loadLeaderboard(false);
});

// While the leaderboard is open it updates itself every 10 seconds
setInterval(function () {
    if (currentScreen === 'leaderboard-screen' && document.visibilityState === 'visible') {
        loadLeaderboard(true);
    }
}, 10000);

// =====================================================================
//  BUTTONS
// =====================================================================
// Every button with data-goto="..." switches to that screen
for (const button of document.querySelectorAll('[data-goto]')) {
    button.addEventListener('click', function () {
        showScreen(button.dataset.goto);
    });
}

document.getElementById('click-btn').addEventListener('click', pointsButton);
document.getElementById('chopsticks-btn').addEventListener('click', buyChopsticks);
