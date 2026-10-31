import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { doc, getDoc, getDocs, setDoc, writeBatch, collection, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { TILES, EQUIPS, RECIPES, REMOVE_TOOL, EDIT_TOOL, TILE_BY_ID, ITEM_BY_ID } from "./data.js";
import { auth, db } from "./firebase.js";
import { initTrade, getTradeId, isSaveBlocked, resetTrade, resumeTrade, onTradeScreenShown } from "./trade.js";

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
const CELLS = COLS * ROWS; // squares on one factory floor

// Chopping tables: little factories inside a factory (they can hold more chopping tables, forever)
const TABLE_ID = 'chopping_table';
const MAX_SAVE_CHARS = 900000; // a Firestore document can hold about 1 million characters

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

// Directions: 0 = right, 1 = down, 2 = left, 3 = up
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const ARROWS = ['→', '↓', '←', '↑'];

// =====================================================================
//  GAME STATE
// =====================================================================
let points = 0;
let chopsticks = 0;      // how many Chopsticks you own
let rootLayer = null;    // the main factory (a "layer": see newLayer)
let viewPath = [];       // the chopping tables you are inside, outermost first. [] = the main factory
let viewOrigin = 'factory'; // where "Leave table" goes back to: 'factory' or 'inventory'
let editMode = false;    // true while the Edit tool is selected
let inventory = [];      // INV_SLOTS slots, each null or { id, n }. Slots 0-8 are the hotbar.
                         // A chopping table slot also has table: its inside (a "layer", see newLayer)
let anvil = false;       // true once you unlocked the anvil
let buyAmount = 1;       // the shop buys this many at a time
let salesLog = [];       // recent sales, used to show "per second"

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

let weirdDeclined = false; // you said "Stop the weirdness": we don't ask again until the diamonds are gone
let weirdBusy = false;     // true while the weirdness popup or event is on screen
let weirdTimers = [];      // the timeouts of the event, so they can be cancelled


function emptyGrid() {
    return new Array(CELLS).fill(null);
}

// A "layer" is one factory floor: the main factory, or the inside of a chopping table.
//   grid:    COLS * ROWS squares, each null or { kind, dir, mods, table }
//            (table is only on chopping tables: it is the layer inside that table)
//   sushi, timers, effects: what is going on on this floor right now (these are never saved)
function newLayer() {
    return { grid: emptyGrid(), sushi: [], timers: {}, effects: [] };
}

// The floor you are looking at: the main factory, or the inside of the table you opened
function viewLayer() {
    return viewPath.length > 0 ? viewPath[viewPath.length - 1] : rootLayer;
}

// Copies a floor and everything inside it (also the tables inside the tables...).
// It loops instead of calling itself, so a table inside a table inside a table... never runs out of stack.
function cloneLayer(layer) {
    const copy = newLayer();
    const todo = [[layer, copy]];
    while (todo.length > 0) {
        const pair = todo.pop();
        for (let i = 0; i < pair[0].grid.length; i++) {
            const cell = pair[0].grid[i];
            if (cell) {
                const cellCopy = { kind: cell.kind, dir: cell.dir, mods: cell.mods.slice() };
                if (cell.table) {
                    cellCopy.table = newLayer();
                    todo.push([cell.table, cellCopy.table]);
                }
                pair[1].grid[i] = cellCopy;
            }
        }
    }
    return copy;
}

// Is "target" this floor, or somewhere inside it? (Used so a table can never go inside itself.)
function layerContains(layer, target) {
    const todo = [layer];
    while (todo.length > 0) {
        const floor = todo.pop();
        if (floor === target) {
            return true;
        }
        for (const cell of floor.grid) {
            if (cell && cell.table) {
                todo.push(cell.table);
            }
        }
    }
    return false;
}

// How many pieces are on this floor, counting the ones inside tables too
function countPieces(layer) {
    let n = 0;
    const todo = [layer];
    while (todo.length > 0) {
        const floor = todo.pop();
        for (const cell of floor.grid) {
            if (cell) {
                n = n + 1;
                if (cell.table) {
                    todo.push(cell.table);
                }
            }
        }
    }
    return n;
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
    rootLayer = newLayer();
    viewPath = [];
    viewOrigin = 'factory';
    editMode = false;
    cancelWeird();
    salesLog = [];
    displayDirty = true;
}
resetGame();

// =====================================================================
//  MATHS
// =====================================================================
// Big numbers get a letter: 1,474,879 -> "1.47M". Below one million we
// show the whole number with commas, like before.
const SUFFIXES = ['M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

// Returns the shortened text, or null when the number is too small to shorten
function abbreviate(number) {
    if (!(number >= 1000000)) return null;
    // How many groups of 3 digits are there above the first million?
    let group = Math.floor(Math.log10(number) / 3) - 2;      // 0 = M, 1 = B, ...
    if (group >= SUFFIXES.length) group = SUFFIXES.length - 1;
    let scaled = number / Math.pow(1000, group + 2);
    // Cut off (don't round) to 2 decimals, so 999,999,999 never shows as "1000M"
    scaled = Math.floor(scaled * 100) / 100;
    // Safety net for floating point: 1000M should become 1B
    if (scaled >= 1000 && group < SUFFIXES.length - 1) {
        group++;
        scaled = 1;
    }
    return String(scaled) + SUFFIXES[group];                  // 1.5 -> "1.5M", 2 -> "2M"
}

function format(number) {
    const short = abbreviate(number);
    if (short) return short;
    return Math.floor(number).toLocaleString('en-US'); // 12345.7 -> "12,345"
}

// The exact number with commas, for tooltips: 1474879 -> "1,474,879"
function formatFull(number) {
    return Math.floor(number).toLocaleString('en-US');
}

// For small numbers like 0.5: shows up to 2 decimals, no trailing zeros
function formatRate(number) {
    const short = abbreviate(number);
    if (short) return short;
    const rounded = Math.round(number * 100) / 100;
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function clickPower() {
    return 1 + chopsticks;
}

function chopsticksCost() {
    return Math.ceil(CHOPSTICKS_BASE_COST * Math.pow(PRICE_GROWTH, chopsticks));
}

// Everything you own, counted per kind: in the inventory plus placed on the factory.
// Pieces inside chopping tables count too (whether the table is in your bag or placed).
function ownedTotals() {
    const totals = {};
    const floors = [rootLayer];
    for (const s of inventory) {
        if (s) {
            totals[s.id] = (totals[s.id] || 0) + s.n;
            if (s.table) {
                floors.push(s.table);
            }
        }
    }
    while (floors.length > 0) {
        const floor = floors.pop();
        for (const cell of floor.grid) {
            if (cell) {
                totals[cell.kind] = (totals[cell.kind] || 0) + 1;
                if (cell.table) {
                    floors.push(cell.table);
                }
            }
        }
    }
    return totals;
}

function ownedCount(kind) {
    return ownedTotals()[kind] || 0;
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

// withTables = false: the copy shares the chopping tables with the original (fine when
// you only want to check if something fits, because that never changes a table)
function cloneSlots(slots, withTables) {
    return slots.map(function (s) {
        if (!s) {
            return null;
        }
        const copy = { id: s.id, n: s.n };
        if (s.table) {
            copy.table = withTables === false ? s.table : cloneLayer(s.table);
        }
        return copy;
    });
}

// How many fit in one slot: 999 for most things, 1 for a chopping table (it never stacks)
function stackMax(id) {
    const def = ITEM_BY_ID[id];
    return def && def.stackMax ? def.stackMax : MAX_STACK;
}

// Is there room for n more of this item?
function roomFor(slots, id, n) {
    const max = stackMax(id);
    let room = 0;
    for (const s of slots) {
        if (!s) {
            room = room + max;
        } else if (s.id === id) {
            room = room + max - s.n;
        }
    }
    return room >= n;
}

// Adds n items: tops up existing stacks first, then uses the first empty slots.
// All or nothing: returns false (and changes nothing) when there is no room.
// "table" is for chopping tables only: the inside to give it (a new empty table if you leave it out).
function addToSlots(slots, id, n, table) {
    if (!roomFor(slots, id, n)) {
        return false;
    }
    const max = stackMax(id);
    for (const s of slots) {
        if (n > 0 && s && s.id === id && s.n < max) {
            const add = Math.min(n, max - s.n);
            s.n = s.n + add;
            n = n - add;
        }
    }
    for (let i = 0; i < slots.length && n > 0; i++) {
        if (!slots[i]) {
            const add = Math.min(n, max);
            slots[i] = { id: id, n: add };
            if (id === TABLE_ID) {
                slots[i].table = table || newLayer();
                table = null; // every other table gets its own new inside
            }
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
    const single = stackMax(a.id) === 1; // a chopping table: always moves as a whole, never merges

    if (one && !single) {
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
    } else if (b.id === a.id && !single) {
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
        if (s && addToSlots(inventory, s.id, s.n, s.table)) {
            anvilIn[k] = null;
            unsaved = true;
            displayDirty = true;
        }
    }
}

// The inventory as it is saved: items still in the Anvil are counted in
function inventoryForSave() {
    const copy = cloneSlots(inventory, false); // only used to save, so the tables don't need copying
    for (const s of anvilIn) {
        if (s) {
            addToSlots(copy, s.id, s.n, s.table);
        }
    }
    return copy;
}

// Price of the next piece of this kind. More pieces owned = more expensive.
function toolCost(def) {
    return Math.ceil(def.baseCost * Math.pow(def.growth, ownedCount(def.id)));
}

// Price of buying "amount" pieces in a row (ownedNow: how many you own, if you already counted)
function priceFor(def, amount, ownedNow) {
    const owned = ownedNow === undefined ? ownedCount(def.id) : ownedNow;
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
    // You stay inside a table while you visit the Shop or the Inventory, but not on other screens
    if (screenId !== 'game-screen' && screenId !== 'shop-screen' && screenId !== 'inventory-screen') {
        viewPath = [];
        viewOrigin = 'factory';
    }
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
    if (screenId === 'trade-screen') {
        onTradeScreenShown();
    }
    playMusicFor(screenId);
    updateDisplay();
    if (screenId === 'game-screen') {
        setTimeout(checkWeirdness, 350); // a factory full of diamonds is weird
    }
}

// =====================================================================
//  THE HOTBAR (the first 9 inventory slots) + Remove and Rotate
// =====================================================================
const hotbarParts = [];  // one { button, emoji, count } per hotbar slot
let removeButton = null;
let editButton = null;

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
        editMode = false;
        displayDirty = true;
    });
    bar.appendChild(removeButton);

    editButton = document.createElement('button');
    editButton.className = 'tool';
    editButton.title = EDIT_TOOL.hint;
    editButton.innerHTML =
        '<span class="tool-emoji">' + EDIT_TOOL.emoji + '</span>' +
        '<span class="tool-name">Edit</span>' +
        '<span class="tool-cost">open table</span>';
    editButton.addEventListener('click', function () {
        editMode = !editMode;
        removeMode = false;
        displayDirty = true;
    });
    bar.appendChild(editButton);

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
    editMode = false;
    displayDirty = true;
}

// ---- Going inside chopping tables
// From the factory: the table you clicked becomes the floor you look at
function enterTable(layer) {
    if (viewPath.length === 0) {
        viewOrigin = 'factory';
    }
    viewPath.push(layer);
    hover = null;
    displayDirty = true;
}

// From the Inventory: edit a table that is in your bag
function openTableFromInventory(layer) {
    viewPath = [layer];
    viewOrigin = 'inventory';
    hover = null;
    showScreen('game-screen');
}

function leaveTable() {
    if (viewPath.length === 0) {
        return;
    }
    viewPath.pop();
    hover = null;
    displayDirty = true;
    if (viewPath.length === 0 && viewOrigin === 'inventory') {
        viewOrigin = 'factory';
        showScreen('inventory-screen');
    }
}

// The bar above the factory while you are inside a table: where you are, and the way back
function updateTableBar() {
    const inside = viewPath.length > 0;
    document.getElementById('table-bar').classList.toggle('hidden', !inside);
    document.querySelector('.factory').classList.toggle('in-table', inside);
    document.getElementById('factory-title').innerText = inside ? '🔪 Chopping Table' : 'Sushi Factory';
    if (!inside) {
        return;
    }
    const depth = viewPath.length;
    let trail = viewOrigin === 'inventory' ? '🎒 Inventory' : '🏭 Factory';
    const shown = Math.min(depth, 3);
    trail = trail + (depth > shown ? ' › …' : '');
    for (let i = 0; i < shown; i++) {
        trail = trail + ' › 🔪 Table';
    }
    document.getElementById('table-trail').innerText = trail + ' (depth ' + depth + ')';
    document.getElementById('table-back').innerText =
        depth === 1 && viewOrigin === 'inventory' ? '⬅ Back to Inventory' : '⬅ Leave table';
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
    if (event.key === 'Escape' && !weirdBusy) {
        leaveTable();
    } else if (event.key === 'r' || event.key === 'R') {
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
    parts.button.classList.toggle('woody', !!(def && def.editable));
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
    document.getElementById('score').title = formatFull(points); // hover to see the exact number
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
    editButton.classList.toggle('selected', editMode);
    updateTableBar();
    document.getElementById('rotate-arrow').innerText = ARROWS[rotation];

    // What the selected thing does
    const held = inventory[hotbarSel];
    let info = 'Empty slot. Open the Inventory to put something here.';
    if (removeMode) {
        info = REMOVE_TOOL.emoji + ' ' + REMOVE_TOOL.name + ': ' + REMOVE_TOOL.hint;
    } else if (editMode) {
        info = EDIT_TOOL.emoji + ' ' + EDIT_TOOL.name + ': ' + EDIT_TOOL.hint;
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
const SHOP_TILES = TILES.filter(function (t) { return t.shop !== false; });
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
    for (const def of SHOP_TILES) {
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
    if (currentScreen !== 'shop-screen') {
        return; // nothing to refresh while the shop is closed
    }
    const owned = ownedTotals();

    for (const button of document.querySelectorAll('.amount-btn')) {
        button.classList.toggle('selected', Number(button.dataset.amount) === buyAmount);
    }

    for (const def of SHOP_TILES) {
        const row = shopRows[def.id];
        const have = owned[def.id] || 0;
        const price = priceFor(def, buyAmount, have);
        const room = roomFor(inventory, def.id, buyAmount);
        row.sub.innerText = def.hint + ' (you own ' + format(have) + ')';
        row.button.innerText = room ? 'Buy ' + buyAmount + ': ' + format(price) : 'Inventory full';
        row.button.disabled = points < price || !room || have + buyAmount > MAX_PER_KIND;
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
    if (currentScreen !== 'inventory-screen') {
        return; // nothing to refresh while the inventory is closed
    }
    paintGrid(invParts);
    let stock = 0;
    for (let i = 0; i < INV_SLOTS; i++) {
        if (inventory[i]) {
            stock = stock + inventory[i].n;
        }
    }
    const placed = countPieces(rootLayer);
    document.getElementById('inventory-total').innerText =
        format(stock) + (stock === 1 ? ' item' : ' items') + ' in your inventory, ' +
        format(placed) + ' placed in the factory';

    let text = 'Click a stack, then click another slot to move, merge or swap. ' +
        'Right-click moves one item. You can drag too. The top row is your hotbar.';
    const picked = invSel !== null && invSel < INV_SLOTS ? inventory[invSel] : null;
    if (invSel !== null) {
        const stack = getSlotAt(invSel);
        const def = ITEM_BY_ID[stack.id];
        text = def.emoji + ' ' + def.name + (stack.table ? '' : ' x' + stack.n) + ': ' + def.hint;
        if (stack.table) {
            text = text + ' (' + format(countPieces(stack.table)) + ' pieces inside)';
        }
    }
    document.getElementById('inv-info').innerText = text;
    // A chopping table can be edited right here
    document.getElementById('inv-edit-btn').classList.toggle('hidden', !(picked && picked.table));
}

document.getElementById('inv-edit-btn').addEventListener('click', function () {
    const stack = invSel !== null && invSel < INV_SLOTS ? inventory[invSel] : null;
    if (stack && stack.table) {
        openTableFromInventory(stack.table);
    }
});
document.getElementById('table-back').addEventListener('click', leaveTable);
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
function cellAt(layer, x, y) {
    return layer.grid[y * COLS + x];
}

function inGrid(x, y) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

// Sushi can enter any piece except a rice cooker or a chopping table
function passable(layer, x, y) {
    if (!inGrid(x, y)) {
        return false;
    }
    const cell = cellAt(layer, x, y);
    return cell !== null && roleOf(cell) !== 'source' && roleOf(cell) !== 'table';
}

function clickSquare(x, y) {
    const layer = viewLayer();
    const index = y * COLS + x;
    const cell = layer.grid[index];

    // Edit tool: go inside a chopping table
    if (editMode) {
        if (cell && cell.table) {
            enterTable(cell.table);
        } else {
            showMessage('Click a chopping table to go inside it.');
        }
        return;
    }

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
            // A chopping table comes back with everything that is inside it
            if (!addToSlots(inventory, cell.kind, 1, cell.table)) {
                showMessage('Your inventory is full.');
                return;
            }
            layer.grid[index] = null;
        }
        unsaved = true;
        displayDirty = true;
        afterBuilding();
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
        } else if (!def.applies.includes(roleOf(cell))) {
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
        if (cell.kind === def.id && (def.role === 'belt' || def.role === 'source')) {
            cell.dir = rotation;
            unsaved = true;
        } else {
            showMessage('That square is taken. Use Remove first.');
        }
        return;
    }
    const isTable = def.role === 'table';
    // A chopping table can go inside another one, but never inside itself (or inside something it holds)
    if (isTable && layerContains(stack.table, layer)) {
        showMessage("A chopping table can't go inside itself.");
        return;
    }
    layer.grid[index] = { kind: def.id, dir: isTable ? 0 : rotation, mods: [] };
    if (isTable) {
        layer.grid[index].table = stack.table; // the inside moves with it
    }
    useFromSlot(hotbarSel);
    unsaved = true;
    displayDirty = true;
    afterBuilding();
}

// After placing or removing something: a floor full of diamonds is weird (see THE WEIRDNESS below)
function afterBuilding() {
    setTimeout(checkWeirdness, 300);
}

// =====================================================================
//  THE SUSHI: moving along belts
// =====================================================================
// Every sushi is an object: where it is (x, y), where it is heading (tx, ty),
// how far along it is (p from 0 to 1), and how much it is worth (value).

// What kind of piece is this cell: belt, source, topping or exit (null if empty)
function roleOf(cell) {
    return cell ? TILE_BY_ID[cell.kind].role : null;
}

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

// How fast a piece works: its own speed times its upgrades (wasabi 2x, spicy drink 1.5x)
function speedMultiplier(cell) {
    let m = 1;
    if (cell && cell.kind && TILE_BY_ID[cell.kind]) {
        m = TILE_BY_ID[cell.kind].speed || 1;   // express belts and bigger rice cookers
    }
    if (cell && cell.mods) {
        for (const id of cell.mods) {
            m = m * (ITEM_BY_ID[id].speed || 1);
        }
    }
    return m;
}

function trySpawn(layer, sx, sy, dir, value) {
    const tx = sx + DX[dir];
    const ty = sy + DY[dir];
    if (!passable(layer, tx, ty) || layer.sushi.length >= MAX_SUSHI) {
        return false; // nowhere to put it
    }
    layer.sushi.push({
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
function tryDepart(layer, s) {
    const cell = cellAt(layer, s.x, s.y);
    if (!cell || roleOf(cell) === 'source') {
        s.dead = true;
        return;
    }
    if (roleOf(cell) === 'belt') {
        s.dx = DX[cell.dir];
        s.dy = DY[cell.dir];
    }
    // Machines (fish, chef) keep the direction the sushi was already travelling in

    const tx = s.x + s.dx;
    const ty = s.y + s.dy;
    if (passable(layer, tx, ty)) {
        s.tx = tx;
        s.ty = ty;
        s.waiting = false;
    } else {
        s.waiting = true; // end of the line: wait until you build something there
    }
}

function sell(layer, s, x, y, multiplier) {
    const now = performance.now() / 1000;
    const gained = s.value * multiplier;
    points = points + gained;
    salesLog.push({ t: now, v: gained });
    if (layer === viewLayer()) {
        layer.effects.push({ x: x, y: y, text: '+' + formatRate(gained), age: 0 }); // only if you can see it
    }
    unsaved = true;
    displayDirty = true;
}

// Called when a sushi reaches the middle of its target square
function arrive(layer, s) {
    s.x = s.tx;
    s.y = s.ty;
    const cell = cellAt(layer, s.x, s.y);

    if (!cell || roleOf(cell) === 'source' || roleOf(cell) === 'table') {
        s.dead = true; // the piece was removed (or replaced by a table) while it was on its way
        return;
    }
    const def = TILE_BY_ID[cell.kind];
    if (def.role === 'exit') {
        sell(layer, s, s.x, s.y, (def.sell || 1) * modMultiplier(cell));
        s.dead = true;
        return;
    }
    if (def.role === 'topping') {
        const index = s.y * COLS + s.x;
        if (!s.seen.includes(index)) {
            s.seen.push(index);
            if (def.bonus) {
                s.value = s.value + def.bonus * modMultiplier(cell);
            }
            // The first seafood turns the rice ball into complete sushi, which is worth more
            if (def.completes && !s.complete) {
                s.complete = true;
                s.value = s.value * COMPLETE_BOOST;
            }
            // Seasoning multiplies the value (golden etc. make the extra part bigger)
            if (def.mult) {
                s.value = s.value * (1 + (def.mult - 1) * modMultiplier(cell));
            }
        }
    }
    tryDepart(layer, s);
}

function stepSushi(layer, s, dt) {
    s.age = s.age + dt;
    if (s.age > MAX_AGE) {
        s.dead = true;
        return;
    }

    if (s.waiting) {
        tryDepart(layer, s); // maybe you built something since last time
        if (s.waiting || s.dead) {
            return;
        }
    }

    s.p = s.p + SPEED * dt * speedMultiplier(cellAt(layer, s.x, s.y)); // wasabi pieces are faster
    // "while" in case a lot of time passed (for example the tab was in the background)
    while (s.p >= 1 && !s.dead) {
        s.p = s.p - 1;
        arrive(layer, s);
        if (s.waiting) {
            s.p = 0;
            return;
        }
    }
}

// One step of one floor. dt = seconds since the last step.
function runLayer(layer, dt) {
    // Rice cookers make sushi
    for (let i = 0; i < layer.grid.length; i++) {
        const cell = layer.grid[i];
        if (cell && roleOf(cell) === 'source') {
            layer.timers[i] = (layer.timers[i] || 0) + dt * speedMultiplier(cell);
            while (layer.timers[i] >= SPAWN_EVERY) {
                const x = i % COLS;
                const y = Math.floor(i / COLS);
                if (trySpawn(layer, x, y, cell.dir, 1 * modMultiplier(cell))) {
                    layer.timers[i] = layer.timers[i] - SPAWN_EVERY;
                } else {
                    layer.timers[i] = SPAWN_EVERY; // blocked: make one as soon as there is room
                    break;
                }
            }
        } else {
            delete layer.timers[i];
        }
    }

    // Move all the sushi
    for (const s of layer.sushi) {
        stepSushi(layer, s, dt);
    }
    layer.sushi = layer.sushi.filter(function (s) {
        return !s.dead;
    });

    // Fade the "+5" popups
    for (const effect of layer.effects) {
        effect.age = effect.age + dt;
    }
    layer.effects = layer.effects.filter(function (effect) {
        return effect.age < 0.9;
    });
}

// One step of the whole factory: the main floor and every chopping table placed on it,
// and the tables inside those tables, and so on. (A loop, not recursion: tables can go forever.)
function runFactory(dt) {
    const floors = [rootLayer];
    // A table you are editing from your Inventory is not placed anywhere, but it works while you watch it
    if (viewPath.length > 0 && viewOrigin === 'inventory' && currentScreen === 'game-screen') {
        floors.push(viewPath[0]);
    }
    while (floors.length > 0) {
        const floor = floors.pop();
        runLayer(floor, dt);
        for (const cell of floor.grid) {
            if (cell && cell.table) {
                floors.push(cell.table);
            }
        }
    }

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

// Brighter colours for the little factory drawn on a chopping table (the real ones are too dark)
const MINI_COLOUR = { belt: '#8fa89a', source: '#7fd1a0', topping: '#6fb7e0', exit: '#ff9c6e', table: '#d9b26f' };

// A chopping table: a wooden tile with a tiny picture of what is inside it
function drawTable(x, y, table) {
    ctx.fillStyle = TILE_BY_ID[TABLE_ID].colour;
    roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
    ctx.fill();
    ctx.strokeStyle = '#a07a45';
    ctx.lineWidth = 2;
    roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
    ctx.stroke();

    const pad = 9;
    const size = (CELL - pad * 2) / COLS;
    const top = y + (CELL - size * ROWS) / 2 - 1;
    for (let gy = 0; gy < ROWS; gy++) {
        for (let gx = 0; gx < COLS; gx++) {
            const inner = table ? table.grid[gy * COLS + gx] : null;
            ctx.fillStyle = inner ? MINI_COLOUR[TILE_BY_ID[inner.kind].role] : 'rgba(0, 0, 0, 0.35)';
            ctx.fillRect(x + pad + gx * size + 0.5, top + gy * size + 0.5, size - 1, size - 1);
        }
    }
    drawEmoji(TILE_BY_ID[TABLE_ID].emoji, x + CELL - 11, y + CELL - 10, 12);
}

// Draws one piece in the square at (gx, gy). table: the inside of a chopping table (to draw it small)
function drawPiece(kind, dir, gx, gy, time, mods, table) {
    const x = gx * CELL;
    const y = gy * CELL;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;

    const def = TILE_BY_ID[kind];
    if (def.role === 'table') {
        drawTable(x, y, table);
        return;
    }
    if (def.role === 'belt') {
        ctx.fillStyle = def.colour;
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
        const cellNow = { kind: kind, mods: mods || [] };
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
    ctx.fillStyle = def.colour;
    roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
    ctx.fill();
    drawEmoji(TILE_BY_ID[kind].emoji, cx, cy, 28);

    drawMods(x, y, mods);

    // The rice cooker also shows which way it sends sushi
    if (def.role === 'source') {
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
    const layer = viewLayer();
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
    for (let i = 0; i < layer.grid.length; i++) {
        const cell = layer.grid[i];
        if (cell) {
            drawPiece(cell.kind, cell.dir, i % COLS, Math.floor(i / COLS), time, cell.mods, cell.table);
        }
    }

    // Sushi on top
    for (const s of layer.sushi) {
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
    for (const effect of layer.effects) {
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
        const cell = cellAt(layer, hover.x, hover.y);
        const stack = inventory[hotbarSel];
        const def = stack ? ITEM_BY_ID[stack.id] : null;
        let colour = '#b7e05a';          // green: this will work
        if (removeMode) {
            colour = cell ? '#ff9c9c' : 'rgba(246, 243, 234, 0.35)';
        } else if (editMode) {
            colour = cell && cell.table ? '#d9b26f' : '#ff9c9c';
        } else if (!def) {
            colour = 'rgba(246, 243, 234, 0.35)';
        } else if (def.applies) {
            // Equipable: only works on a matching piece with nothing on it yet
            const works = cell && def.applies.includes(roleOf(cell)) && !cell.mods.includes(def.id);
            colour = works ? def.colour : '#ff9c9c';
        } else if (!TILE_BY_ID[def.id]) {
            colour = '#ff9c9c';            // an ingredient can't be placed
        } else if (!cell) {
            if (def.role === 'table' && layerContains(stack.table, layer)) {
                colour = '#ff9c9c';    // a table can't go inside itself
            } else {
                ctx.globalAlpha = 0.55;
                drawPiece(def.id, rotation, hover.x, hover.y, time, [], stack.table);
                ctx.globalAlpha = 1;
            }
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
        const cell = cellAt(viewLayer(), square.x, square.y);
        if (event.shiftKey && cell && cell.table) {
            enterTable(cell.table); // Shift-click a table: go inside
            return;
        }
        clickSquare(square.x, square.y);
        saveSoon();
    }
});

// Right-click a chopping table: go inside (on any other square the normal menu stays)
canvas.addEventListener('contextmenu', function (event) {
    const square = squareFromEvent(event);
    const cell = square ? cellAt(viewLayer(), square.x, square.y) : null;
    if (cell && cell.table) {
        event.preventDefault();
        enterTable(cell.table);
    }
});

// =====================================================================
//  SAVING
// =====================================================================
// The factory is saved as a list of short texts, one per square: "" (empty) or "belt:0".
// Upgrades add a third part: "fish:0:golden_soy_sauce,wasabi".
// A chopping table carries its inside in square brackets: "chopping_table:0[ ...48 squares split by ; ... ]".
// A table inside a table is just a table text inside those brackets, so it can go on forever,
// and it all still fits in the same two fields (factory and inventory) the Firestore rules already allow.

// "belt:0" / "fish:0:wasabi" / "chopping_table:0": a piece without its inside
function cellHead(cell) {
    return cell.kind + ':' + cell.dir + (cell.mods.length > 0 ? ':' + cell.mods.join(',') : '');
}

// The reverse of cellHead (null if it is not a real piece). A chopping table gets no inside yet.
function cellFromHead(head) {
    const parts = String(head).split(':');
    const kind = parts[0];
    const dir = Number(parts[1]);
    if (!TILE_BY_ID[kind] || !(dir >= 0 && dir <= 3)) {
        return null;
    }
    const cell = { kind: kind, dir: dir, mods: [] };
    if (TILE_BY_ID[kind].role === 'table') {
        cell.table = newLayer(); // (replaced by the real inside when the text has one)
    }
    for (const id of String(parts[2] || '').split(',')) {
        const equip = ITEM_BY_ID[id];
        if (equip && equip.applies && equip.applies.includes(TILE_BY_ID[kind].role) && !cell.mods.includes(id)) {
            cell.mods.push(id);
        }
    }
    return cell;
}

// One whole floor as text: its 48 squares split by ";" and the inside of every table in [ ].
// Loops instead of calling itself, so a table inside a table inside a table... is fine.
function layerToText(root) {
    const out = [];
    const stack = [{ grid: root.grid, i: 0 }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.i >= CELLS) {
            stack.pop();
            if (stack.length > 0) {
                out.push(']');
            }
            continue;
        }
        if (frame.i > 0) {
            out.push(';');
        }
        const cell = frame.grid[frame.i];
        frame.i = frame.i + 1;
        if (cell) {
            out.push(cellHead(cell));
            if (cell.table) {
                out.push('[');
                stack.push({ grid: cell.table.grid, i: 0 });
            }
        }
    }
    return out.join('');
}

// The reverse of layerToText. Bad text gives empty squares instead of an error.
function textToLayer(text) {
    const root = newLayer();
    const stack = [{ layer: root, i: 0, head: '', opened: false }];

    // The square we were reading is done: store it (unless it was a table, which was stored at its "[")
    function finishSquare(frame) {
        if (!frame.opened && frame.head !== '' && frame.i < CELLS) {
            const cell = cellFromHead(frame.head);
            if (cell) {
                frame.layer.grid[frame.i] = cell;
            }
        }
        frame.i = frame.i + 1;
        frame.head = '';
        frame.opened = false;
    }

    for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        const frame = stack[stack.length - 1];
        if (ch === ';') {
            finishSquare(frame);
        } else if (ch === '[') {
            const cell = cellFromHead(frame.head);
            let inside = newLayer(); // (thrown away if this square is not a real table)
            if (cell && TILE_BY_ID[cell.kind].role === 'table' && frame.i < CELLS) {
                cell.table = inside;
                frame.layer.grid[frame.i] = cell;
            }
            frame.opened = true;
            stack.push({ layer: inside, i: 0, head: '', opened: false });
        } else if (ch === ']') {
            if (stack.length > 1) {
                finishSquare(frame);
                stack.pop();
            }
        } else {
            frame.head = frame.head + ch;
        }
    }
    finishSquare(stack[stack.length - 1]);
    return root;
}

function gridToList(layer) {
    return layer.grid.map(function (cell) {
        if (!cell) {
            return '';
        }
        return cellHead(cell) + (cell.table ? '[' + layerToText(cell.table) + ']' : '');
    });
}

// Returns the 48 squares (empty ones if the saved list is missing or wrong)
function listToGrid(list) {
    const result = emptyGrid();
    if (!Array.isArray(list) || list.length !== CELLS) {
        return result;
    }
    for (let i = 0; i < list.length; i++) {
        const text = String(list[i]);
        const open = text.indexOf('[');
        if (open < 0) {
            result[i] = cellFromHead(text);
        } else if (text.endsWith(']')) {
            const cell = cellFromHead(text.slice(0, open));
            if (cell && TILE_BY_ID[cell.kind].role === 'table') {
                cell.table = textToLayer(text.slice(open + 1, -1));
                result[i] = cell;
            }
        }
    }
    return result;
}

// An inventory slot as text: "belt:12". A chopping table carries its inside: "chopping_table:1[...]".
function slotToText(s) {
    if (!s) {
        return '';
    }
    return s.id + ':' + s.n + (s.table ? '[' + layerToText(s.table) + ']' : '');
}

// The reverse (null if it is not a real item)
function slotFromText(text) {
    text = String(text);
    let inside = null;
    const open = text.indexOf('[');
    if (open >= 0) {
        if (!text.endsWith(']')) {
            return null;
        }
        inside = text.slice(open + 1, -1);
        text = text.slice(0, open);
    }
    const parts = text.split(':');
    const n = Math.floor(Number(parts[1]));
    if (!ITEM_BY_ID[parts[0]] || !(n >= 1)) {
        return null;
    }
    const stack = { id: parts[0], n: Math.min(n, stackMax(parts[0])) };
    if (parts[0] === TABLE_ID) {
        stack.table = inside === null ? newLayer() : textToLayer(inside);
    }
    return stack;
}

// The inventory is saved as a list of INV_SLOTS short texts: "" (empty) or "belt:12".
function inventoryToSave() {
    return inventory.map(slotToText);
}

function inventoryFromSave(saved) {
    const result = emptyInventory();
    if (Array.isArray(saved)) {
        // The new format: one text per slot
        for (let i = 0; i < Math.min(saved.length, INV_SLOTS); i++) {
            result[i] = slotFromText(saved[i]);
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
    const data = {
        name: playerName,
        points: Math.round(pointsValue * 100) / 100, // keep 2 decimals
        chopsticks: chopsticksValue,
        factory: gridToList(rootLayer),
        inventory: slotsList.map(slotToText),
        anvil: anvil,
        savedAt: serverTimestamp() // Google's clock, not the player's
    };
    if (getTradeId()) {
        data.trade = getTradeId(); // the trade you are in right now (only present while you are in one)
    }
    return data;
}

// The leaderboard entry is a tiny public copy of your name and points.
// It is written together with your save, but at most every 30 seconds
// (and always when you change your name or leave the page) to keep writes low.
const BOARD_EVERY = 30000;
let lastBoardWrite = -BOARD_EVERY;
let boardForce = true;

async function save() {
    if (!currentUser || !unsaved || isSaveBlocked()) {
        return;
    }
    unsaved = false;
    const uid = currentUser.uid;
    const withBoard = boardForce || performance.now() - lastBoardWrite >= BOARD_EVERY;
    boardForce = false;
    try {
        const data = saveData(points, chopsticks, inventoryForSave());
        // A Firestore document holds about 1 million characters. Better to say so than to fail every time.
        if (data.factory.join('').length + data.inventory.join('').length > MAX_SAVE_CHARS) {
            unsaved = true;
            boardForce = boardForce || withBoard;
            showMessage('Your factory is too big to save! Take some pieces out of your tables.');
            return;
        }
        const batch = writeBatch(db);
        batch.set(doc(db, 'users', uid), data);
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
            resetTrade();
            playerName = cleanName(user.displayName) || 'Player';
            if (snapshot.exists()) {
                const data = snapshot.data();
                playerName = cleanName(data.name) || playerName;
                points = Number(data.points) || 0;
                // Older saves kept this inside "owned"
                chopsticks = Number(data.chopsticks) || Number(data.owned && data.owned.chopsticks) || 0;
                rootLayer.grid = listToGrid(data.factory);
                inventory = inventoryFromSave(data.inventory); // older saves have none: starts empty
                anvil = data.anvil === true;
                unsaved = false;
            } else {
                // New player: create their document right away, empty.
                await setDoc(doc(db, 'users', user.uid), saveData(0, 0, inventory));
                unsaved = false;
            }
            currentUser = user;
            // Were you in the middle of a trade? Carry on with it.
            if (snapshot.exists() && typeof snapshot.data().trade === 'string' && snapshot.data().trade) {
                resumeTrade(snapshot.data().trade);
            }
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
        resetTrade();
        unsaved = false;
        showScreen('login-screen');
    }
});

// =====================================================================
//  MUSIC: one song per screen (files are in Sound/Music/)
// =====================================================================
// Screens that are not listed here play the main theme.
const MUSIC_DIR = 'Sound/Music/';
const MUSIC_DEFAULT = 'Main_Theme.mp3';
const SCREEN_MUSIC = {
    'menu-screen': 'MainMenu.mp3',
    'shop-screen': 'Shop.mp3',
    'settings-screen': 'Codes.mp3'
};
const DEFAULT_VOLUME = 50;   // percent

const musicTracks = {};      // file name -> <audio> element
let currentMusic = null;     // the file that should be playing now
let musicVolume = loadVolume() / 100;
let musicBlocked = false;    // true when the browser refused to play before a click

function loadVolume() {
    try {
        const saved = localStorage.getItem('sushiMusicVolume');
        if (saved !== null && Number(saved) >= 0 && Number(saved) <= 100) {
            return Number(saved);
        }
    } catch (error) {}
    return DEFAULT_VOLUME;
}

function getTrack(file) {
    if (!musicTracks[file]) {
        const audio = document.createElement('audio');
        audio.src = MUSIC_DIR + file;
        audio.loop = true;
        audio.preload = 'auto';
        audio.volume = 0;
        audio.dataset.track = file;
        audio.hidden = true;
        document.body.appendChild(audio);
        musicTracks[file] = audio;
    }
    return musicTracks[file];
}

// Slowly changes the volume of a song (pauseAtEnd = stop it when it is quiet)
function fadeMusic(audio, target, ms, pauseAtEnd) {
    clearInterval(audio.fadeTimer);
    const from = audio.volume;
    const steps = Math.max(1, Math.round(ms / 50));
    let step = 0;
    audio.fadeTimer = setInterval(function () {
        step = step + 1;
        audio.volume = Math.min(1, Math.max(0, from + (target - from) * step / steps));
        if (step >= steps) {
            clearInterval(audio.fadeTimer);
            if (pauseAtEnd) {
                audio.pause();
            }
        }
    }, 50);
}

function startMusic() {
    if (!currentMusic || musicVolume === 0 || document.visibilityState === 'hidden') {
        return;
    }
    const audio = getTrack(currentMusic);
    if (!audio.paused) {
        fadeMusic(audio, musicVolume, 400, false);
        return;
    }
    audio.volume = 0;
    audio.play().then(function () {
        musicBlocked = false;
        fadeMusic(audio, musicVolume, 700, false);
    }).catch(function () {
        // Browsers only allow sound after you click something. We try again on the first click.
        musicBlocked = true;
    });
}

function playMusicFor(screenId) {
    const file = SCREEN_MUSIC[screenId] || MUSIC_DEFAULT;
    if (file === currentMusic) {
        return; // same song: keep playing, don't restart it
    }
    if (currentMusic) {
        fadeMusic(getTrack(currentMusic), 0, 500, true);
    }
    currentMusic = file;
    startMusic();
}

function setMusicVolume(percent, remember) {
    musicVolume = percent / 100;
    document.getElementById('music-value').innerText = percent + '%';
    document.getElementById('music-input').value = percent;
    if (remember) {
        try {
            localStorage.setItem('sushiMusicVolume', String(percent));
        } catch (error) {}
    }
    if (musicVolume === 0) {
        if (currentMusic) {
            getTrack(currentMusic).pause();
        }
    } else {
        startMusic();
    }
}

document.getElementById('music-input').addEventListener('input', function (event) {
    setMusicVolume(Number(event.target.value), true);
});

// The first click or key press lets the browser play music
function unlockMusic() {
    if (musicBlocked) {
        startMusic();
    }
}
document.addEventListener('pointerdown', unlockMusic);
document.addEventListener('keydown', unlockMusic);

// Pause when you switch to another tab
document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
        if (currentMusic) {
            getTrack(currentMusic).pause();
        }
    } else {
        startMusic();
    }
});

setMusicVolume(Math.round(musicVolume * 100), false);

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
//  THE WEIRDNESS: fill a whole factory with diamonds...
// =====================================================================
// When every square of the floor you are on holds a diamond, something weird happens. You can say
// "Stop the weirdness" (it asks again when you place a diamond again, or when you come back later), or
// "Let me see then!": the diamonds are pulled together and turn into a Chopping table in your inventory.
// This works on any floor: the main factory, or the inside of a chopping table.

function isAllDiamonds(layer) {
    return layer.grid.every(function (cell) {
        return cell && cell.kind === 'diamond';
    });
}

// Is there room in the inventory for the table, and for the upgrades that sat on the diamonds?
function weirdRoom(layer) {
    const copy = cloneSlots(inventory, false);
    if (!addToSlots(copy, TABLE_ID, 1)) {
        return false;
    }
    for (const cell of layer.grid) {
        for (const id of cell.mods) {
            if (!addToSlots(copy, id, 1)) {
                return false;
            }
        }
    }
    return true;
}

function checkWeirdness() {
    if (weirdBusy || !currentUser || currentScreen !== 'game-screen') {
        return;
    }
    const layer = viewLayer();
    if (!isAllDiamonds(layer)) {
        weirdDeclined = false; // the diamonds are gone: next time it is allowed to ask again
        return;
    }
    if (weirdDeclined) {
        return;
    }
    if (!weirdRoom(layer)) {
        showMessage('Something weird is going on... but your inventory is full. Make some room!');
        return;
    }
    weirdBusy = true;
    document.getElementById('weird-popup').classList.remove('hidden');
    document.getElementById('weird-go').focus();
}

function weirdAfter(ms, fn) {
    weirdTimers.push(setTimeout(fn, ms));
}

// Hides the popup and the event, and stops the event if it was running
function cancelWeird() {
    for (const t of weirdTimers) {
        clearTimeout(t);
    }
    weirdTimers = [];
    weirdBusy = false;
    document.getElementById('weird-popup').classList.add('hidden');
    document.getElementById('weird-scene').classList.add('hidden');
}

function weirdLine(text) {
    document.getElementById('weird-line').innerText = text;
}

// The diamonds turn into a table: this is the moment the factory really changes
function makeTableFromDiamonds(layer) {
    const upgrades = [];
    for (const cell of layer.grid) {
        for (const id of cell.mods) {
            upgrades.push(id);
        }
    }
    addToSlots(inventory, TABLE_ID, 1);
    for (const id of upgrades) {
        addToSlots(inventory, id, 1); // the soy sauce etc. that was on the diamonds comes back
    }
    for (let i = 0; i < layer.grid.length; i++) {
        layer.grid[i] = null;
    }
    layer.sushi = [];
    layer.timers = {};
    layer.effects = [];
    unsaved = true;
    displayDirty = true;
    saveSoon();
}

function startWeirdScene() {
    const layer = viewLayer(); // the floor that is full of diamonds
    const scene = document.getElementById('weird-scene');
    const field = document.getElementById('weird-field');

    // 48 diamonds in the same places as on the factory floor
    field.innerHTML = '';
    for (let i = 0; i < CELLS; i++) {
        const gem = document.createElement('div');
        gem.className = 'weird-gem';
        gem.innerText = '💎';
        gem.style.setProperty('--cx', String((COLS - 1) / 2 - (i % COLS)));
        gem.style.setProperty('--cy', String((ROWS - 1) / 2 - Math.floor(i / COLS)));
        field.appendChild(gem);
    }
    document.getElementById('weird-table').classList.add('hidden');
    document.getElementById('weird-done').classList.add('hidden');
    scene.className = 'overlay phase-hum';
    weirdLine('The diamonds are humming...');

    weirdAfter(1800, function () {
        scene.className = 'overlay phase-pull';
        weirdLine('They are pulling together...');
    });
    weirdAfter(3300, function () {
        // Check again: it must still be the same full floor, with room for the table
        if (!isAllDiamonds(layer) || !weirdRoom(layer)) {
            cancelWeird();
            return;
        }
        makeTableFromDiamonds(layer);
        scene.className = 'overlay phase-flash';
        weirdLine('');
    });
    weirdAfter(3900, function () {
        scene.className = 'overlay phase-table';
        document.getElementById('weird-table').classList.remove('hidden');
        weirdLine('A Chopping Table appeared! It is in your Inventory.');
        const done = document.getElementById('weird-done');
        done.classList.remove('hidden');
        done.focus();
    });
}

document.getElementById('weird-stop').addEventListener('click', function () {
    cancelWeird();
    weirdDeclined = true;
    showMessage('The weirdness fades... for now.');
});

document.getElementById('weird-go').addEventListener('click', function () {
    document.getElementById('weird-popup').classList.add('hidden');
    document.getElementById('weird-scene').classList.remove('hidden');
    startWeirdScene();
});

document.getElementById('weird-done').addEventListener('click', function () {
    cancelWeird();
    weirdDeclined = false;
});

// =====================================================================
//  TRADING lives in trade.js. This is everything it may use from here.
// =====================================================================
initTrade({
    TABLE_ID: TABLE_ID,
    setMessage: setMessage,
    format: format,
    cloneSlots: cloneSlots,
    countInSlots: countInSlots,
    addToSlots: addToSlots,
    getUser: function () { return currentUser; },
    getPlayerName: function () { return playerName; },
    getScreen: function () { return currentScreen; },
    getPoints: function () { return points; },
    getChopsticks: function () { return chopsticks; },
    getInventory: function () { return inventory; },
    getAnvilIn: function () { return anvilIn; },
    inventoryForSave: inventoryForSave,
    buildSave: saveData,
    addPoints: function (n) {
        points = points + n;
        displayDirty = true;
    },
    markUnsaved: function () {
        unsaved = true;
        saveSoon();
    }
});

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
