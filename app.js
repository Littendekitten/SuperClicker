import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

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
const MAX_AGE = 60;        // sushi older than this many seconds disappears (stops endless loops)

// The anvil: a one-time unlock in the shop (merging tiles comes later)
const ANVIL_COST = 100000000; // 100 million
const MAX_PER_KIND = 9999; // most of one tile you can own

// The pieces you can place.
//   baseCost: price of the first one      growth: how much each extra one costs more
//   bonus:    how much value a topping adds to sushi that passes through
const TOOLS = [
    { id: 'belt',   name: 'Belt',            emoji: '➡️',  baseCost: 2,   growth: 1,    hint: 'Carries sushi' },
    { id: 'source', name: 'Rice cooker',     emoji: '🍚',  baseCost: 20,  growth: 1.15, hint: 'Makes a sushi every 2 seconds' },
    { id: 'fish',   name: 'Fish topping',    emoji: '🐟',  baseCost: 40,  growth: 1.15, hint: 'Sushi passing by is worth +2', bonus: 2 },
    { id: 'chef',   name: 'Chef',            emoji: '🧑‍🍳', baseCost: 120, growth: 1.15, hint: 'Sushi passing by is worth +5', bonus: 5 },
    { id: 'exit',   name: 'Serving counter', emoji: '🏮',  baseCost: 10,  growth: 1,    hint: 'Sells sushi for its value' },
    { id: 'remove', name: 'Remove',          emoji: '🗑️',  baseCost: 0,   growth: 1,    hint: 'Click a piece to take it back for a full refund' },
];
const TOOL_BY_ID = {};
for (const t of TOOLS) {
    TOOL_BY_ID[t.id] = t;
}
// Every tile you can own (everything except the Remove tool)
const TILES = TOOLS.filter(function (t) {
    return t.id !== 'remove';
});

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
let inventory = {};      // tiles you own but have not placed: { belt: 3, fish: 1, ... }
let anvil = false;       // true once you unlocked the anvil
let buyAmount = 1;       // the shop buys this many at a time
let sushi = [];          // all the sushi currently on the belts
let timers = {};         // per rice cooker: seconds since its last sushi
let salesLog = [];       // recent sales, used to show "per second"
let effects = [];        // little "+5" popups

let tool = 'belt';       // the piece you have selected
let rotation = 0;        // the direction new belts / rice cookers will face
let hover = null;        // the square the mouse is over

let currentUser = null;  // set only after the player's data has loaded
let unsaved = false;     // true when there are changes not yet in Firestore
let displayDirty = true; // true when the numbers on screen need refreshing

function emptyGrid() {
    return new Array(COLS * ROWS).fill(null);
}

function emptyInventory() {
    const result = {};
    for (const def of TILES) {
        result[def.id] = 0;
    }
    return result;
}

function resetGame() {
    points = 0;
    chopsticks = 0;
    anvil = false;
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
    return (inventory[kind] || 0) + placedCount(kind);
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
function showScreen(screenId) {
    const screens = document.querySelectorAll('.screen');
    for (const screen of screens) {
        screen.classList.add('hidden');
    }
    document.getElementById(screenId).classList.remove('hidden');
    updateDisplay();
}

// =====================================================================
//  THE TOOLBAR (built once from the TOOLS list)
// =====================================================================
const toolButtons = {}; // tool id -> its button

function buildToolbar() {
    const bar = document.getElementById('toolbar');
    for (const def of TOOLS) {
        const button = document.createElement('button');
        button.className = 'tool';
        button.title = def.hint;
        button.innerHTML =
            '<span class="tool-emoji">' + def.emoji + '</span>' +
            '<span class="tool-name">' + def.name + '</span>' +
            '<span class="tool-cost"></span>';
        button.addEventListener('click', function () {
            tool = def.id;
            displayDirty = true;
        });
        bar.appendChild(button);
        toolButtons[def.id] = button;
    }

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

function rotatePieces() {
    rotation = (rotation + 1) % 4;
    displayDirty = true;
}

// Press R to rotate (only while you're in the game)
document.addEventListener('keydown', function (event) {
    const inGame = !document.getElementById('game-screen').classList.contains('hidden');
    if (inGame && (event.key === 'r' || event.key === 'R')) {
        rotatePieces();
    }
});

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

    // Toolbar: how many you have of each piece, highlight the selected one
    for (const def of TOOLS) {
        const button = toolButtons[def.id];
        const label = button.querySelector('.tool-cost');
        if (def.id === 'remove') {
            label.innerText = 'take back';
            button.classList.remove('poor');
        } else {
            const stock = inventory[def.id] || 0;
            label.innerText = 'x' + format(stock);
            button.classList.toggle('poor', stock === 0);
        }
        button.classList.toggle('selected', tool === def.id);
    }
    document.getElementById('rotate-arrow').innerText = ARROWS[rotation];

    document.getElementById('anvil-btn').classList.toggle('hidden', !anvil);
    updateShop();
    updateInventory();
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
    addShopRow('anvil', '⚒️', 'Anvil', 'Unlocks merging tiles (coming soon)', buyAnvil);

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
        row.sub.innerText = def.hint + ' (you own ' + format(ownedCount(def.id)) + ')';
        row.button.innerText = 'Buy ' + buyAmount + ': ' + format(price);
        row.button.disabled = points < price || ownedCount(def.id) + buyAmount > MAX_PER_KIND;
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
    points = points - price;
    inventory[def.id] = (inventory[def.id] || 0) + buyAmount;
    unsaved = true;
    displayDirty = true;
}

function buyAnvil() {
    if (anvil || points < ANVIL_COST) {
        return;
    }
    points = points - ANVIL_COST;
    anvil = true;
    unsaved = true;
    displayDirty = true;
}

// =====================================================================
//  THE INVENTORY: every tile you own, exactly
// =====================================================================
const inventoryRows = {}; // tile id -> { stock, placed, total }

function buildInventory() {
    const list = document.getElementById('inventory-list');
    for (const def of TILES) {
        const row = document.createElement('div');
        row.className = 'item';
        row.innerHTML =
            '<span class="item-emoji">' + def.emoji + '</span>' +
            '<span class="item-info"><span class="item-name">' + def.name + '</span></span>' +
            '<span class="item-counts">' +
            '<span><b class="n-stock">0</b>in bag</span>' +
            '<span><b class="n-placed">0</b>placed</span>' +
            '<span class="total"><b class="n-total">0</b>total</span>' +
            '</span>';
        list.appendChild(row);
        inventoryRows[def.id] = {
            stock: row.querySelector('.n-stock'),
            placed: row.querySelector('.n-placed'),
            total: row.querySelector('.n-total')
        };
    }
}

function updateInventory() {
    let everything = 0;
    for (const def of TILES) {
        const stock = inventory[def.id] || 0;
        const placed = placedCount(def.id);
        const row = inventoryRows[def.id];
        row.stock.innerText = format(stock);
        row.placed.innerText = format(placed);
        row.total.innerText = format(stock + placed);
        everything = everything + stock + placed;
    }
    document.getElementById('inventory-total').innerText =
        format(everything) + (everything === 1 ? ' tile' : ' tiles') + ' in total';
}

buildShop();
buildInventory();

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

    // Remove tool: the piece goes back into your inventory
    if (tool === 'remove') {
        if (cell) {
            grid[index] = null;
            inventory[cell.kind] = (inventory[cell.kind] || 0) + 1;
            unsaved = true;
            displayDirty = true;
        }
        return;
    }

    // Square already has something on it
    if (cell) {
        // Clicking a belt or rice cooker with the same tool turns it
        if (cell.kind === tool && (tool === 'belt' || tool === 'source')) {
            cell.dir = rotation;
            unsaved = true;
        } else {
            showMessage('That square is taken. Use Remove first.');
        }
        return;
    }

    // Empty square: place the piece if you have one in your inventory
    const def = TOOL_BY_ID[tool];
    if ((inventory[tool] || 0) < 1) {
        showMessage('You have no ' + def.name.toLowerCase() + '. Buy some in the Shop.');
        return;
    }
    inventory[tool] = inventory[tool] - 1;
    grid[index] = { kind: tool, dir: rotation };
    unsaved = true;
    displayDirty = true;
}

// =====================================================================
//  THE SUSHI: moving along belts
// =====================================================================
// Every sushi is an object: where it is (x, y), where it is heading (tx, ty),
// how far along it is (p from 0 to 1), and how much it is worth (value).

function trySpawn(sx, sy, dir) {
    const tx = sx + DX[dir];
    const ty = sy + DY[dir];
    if (!passable(tx, ty) || sushi.length >= MAX_SUSHI) {
        return false; // nowhere to put it
    }
    sushi.push({
        x: sx, y: sy, tx: tx, ty: ty,
        dx: DX[dir], dy: DY[dir],
        p: 0, value: 1, age: 0,
        seen: [],                          // machines it already passed (each gives its bonus once)
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

function sell(s, x, y) {
    const now = performance.now() / 1000;
    points = points + s.value;
    salesLog.push({ t: now, v: s.value });
    effects.push({ x: x, y: y, text: '+' + s.value, age: 0 });
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
        sell(s, s.x, s.y);
        s.dead = true;
        return;
    }
    if (cell.kind === 'fish' || cell.kind === 'chef') {
        const index = s.y * COLS + s.x;
        if (!s.seen.includes(index)) {
            s.seen.push(index);
            s.value = s.value + TOOL_BY_ID[cell.kind].bonus;
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

    s.p = s.p + SPEED * dt;
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
            timers[i] = (timers[i] || 0) + dt;
            while (timers[i] >= SPAWN_EVERY) {
                const x = i % COLS;
                const y = Math.floor(i / COLS);
                if (trySpawn(x, y, cell.dir)) {
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
    const allEmoji = TOOLS.map(function (t) { return t.emoji; }).join('') + '⚒️🛒🎒';
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

// Draws one piece in the square at (gx, gy)
function drawPiece(kind, dir, gx, gy, time) {
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
        const phase = (time * SPEED) % 1;
        for (let k = 0; k < 2; k++) {
            const px = (((phase + k * 0.5) % 1) - 0.5) * CELL * 0.8;
            ctx.beginPath();
            ctx.moveTo(px - 5, -8);
            ctx.lineTo(px + 3, 0);
            ctx.lineTo(px - 5, 8);
            ctx.stroke();
        }
        ctx.restore();
        return;
    }

    // Machines: a coloured tile with an emoji on it
    const colours = { source: '#33503f', fish: '#1f4a58', chef: '#4f3a1f', exit: '#5a2f22' };
    ctx.fillStyle = colours[kind];
    roundedRect(x + 2, y + 2, CELL - 4, CELL - 4, 10);
    ctx.fill();
    drawEmoji(TOOL_BY_ID[kind].emoji, cx, cy, 28);

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
function drawSushi(cx, cy, value) {
    const w = CELL * 0.5;
    const h = CELL * 0.3;

    ctx.fillStyle = '#f6f3ea';
    roundedRect(cx - w / 2, cy - h / 2 + 3, w, h * 0.7, 5);
    ctx.fill();

    ctx.fillStyle = '#ff7a4d';
    roundedRect(cx - w / 2 - 1, cy - h / 2 - 3, w + 2, h * 0.55, 5);
    ctx.fill();

    if (value > 1) {
        ctx.font = '700 12px Fredoka, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#0f1f1a';
        ctx.strokeText(value, cx, cy - h / 2 - 11);
        ctx.fillStyle = '#b7e05a';
        ctx.fillText(value, cx, cy - h / 2 - 11);
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
            drawPiece(cell.kind, cell.dir, i % COLS, Math.floor(i / COLS), time);
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
        drawSushi((gx + 0.5) * CELL, (gy + 0.5) * CELL, s.value);
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
        if (tool !== 'remove' && !cell) {
            ctx.globalAlpha = 0.55;
            drawPiece(tool, rotation, hover.x, hover.y, time);
            ctx.globalAlpha = 1;
        }
        const bad = (tool === 'remove' && cell) || (tool !== 'remove' && cell && cell.kind !== tool);
        ctx.strokeStyle = bad ? '#ff9c9c' : '#b7e05a';
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
    }
});

// =====================================================================
//  SAVING
// =====================================================================
// The grid is saved as a list of short texts, one per square: "" (empty) or "belt:0".
function gridToList() {
    return grid.map(function (cell) {
        return cell ? cell.kind + ':' + cell.dir : '';
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
        if (TOOL_BY_ID[kind] && kind !== 'remove' && dir >= 0 && dir <= 3) {
            result[i] = { kind: kind, dir: dir };
        }
    }
    return result;
}

function inventoryToSave() {
    const result = {};
    for (const def of TILES) {
        result[def.id] = Math.floor(inventory[def.id] || 0);
    }
    return result;
}

function inventoryFromSave(saved) {
    const result = emptyInventory();
    if (saved && typeof saved === 'object') {
        for (const def of TILES) {
            const n = Math.floor(Number(saved[def.id]) || 0);
            result[def.id] = Math.min(Math.max(n, 0), MAX_PER_KIND);
        }
    }
    return result;
}

async function save() {
    if (!currentUser || !unsaved) {
        return;
    }
    unsaved = false;
    try {
        await setDoc(doc(db, 'users', currentUser.uid), {
            name: currentUser.displayName,
            points: Math.round(points * 100) / 100, // keep 2 decimals
            chopsticks: chopsticks,
            factory: gridToList(),
            inventory: inventoryToSave(),
            anvil: anvil,
            savedAt: serverTimestamp() // Google's clock, not the player's
        });
    } catch (error) {
        unsaved = true; // try again next time
        console.error('Save failed:', error);
    }
}

setInterval(save, 10000);

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
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
    await save();          // don't lose progress
    await signOut(auth);
});

// Runs at page load and every time someone logs in or out
onAuthStateChanged(auth, async function (user) {
    if (user) {
        try {
            const snapshot = await getDoc(doc(db, 'users', user.uid));
            resetGame();
            if (snapshot.exists()) {
                const data = snapshot.data();
                points = Number(data.points) || 0;
                // Older saves kept this inside "owned"
                chopsticks = Number(data.chopsticks) || Number(data.owned && data.owned.chopsticks) || 0;
                grid = listToGrid(data.factory);
                inventory = inventoryFromSave(data.inventory); // older saves have none: starts empty
                anvil = data.anvil === true;
                unsaved = false;
            } else {
                // New player: create their document right away, empty.
                await setDoc(doc(db, 'users', user.uid), {
                    name: user.displayName,
                    points: 0,
                    chopsticks: 0,
                    factory: gridToList(),
                    inventory: inventoryToSave(),
                    anvil: false,
                    savedAt: serverTimestamp()
                });
                unsaved = false;
            }
            currentUser = user;
            document.getElementById('login-status').innerText = 'Signed in as ' + user.displayName;
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
