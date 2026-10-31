// =====================================================================
//  GAME DATA: the pieces, the equipable items and the Anvil recipes.
//  app.js imports this file. To add or tune an item, edit it here.
// =====================================================================

// The pieces you can place. Some are sold in the Shop, the rest you get by merging in the Anvil.
//   role:      what the piece does: belt (carries), source (makes rice balls),
//              topping (changes the sushi passing by) or exit (sells it)
//   baseCost / growth / shop:  the Shop price, how much more each extra one costs (growth 1 = the price
//              never changes; 1.15 = 15% more for each one you own), and shop: false for pieces that are not sold there
//   bonus:     adds this much value          completes: turns a rice ball into complete sushi
//   mult:      multiplies the value          speed: how fast it works (2 = twice as fast)
//   sell:      a serving piece pays this many times the value
export const TILES = [
    // ---- the basics
    { id: 'belt',   name: 'Belt',            emoji: '➡️',  role: 'belt',    colour: '#26382f', baseCost: 2,   growth: 1,    hint: 'Carries sushi' },
    { id: 'source', name: 'Rice cooker',     emoji: '🍚',  role: 'source',  colour: '#33503f', baseCost: 20,  growth: 1, hint: 'Makes a rice ball every 2 seconds' },
    { id: 'fish',   name: 'Fish topping',    emoji: '🐟',  role: 'topping', colour: '#1f4a58', baseCost: 40,  growth: 1, hint: 'Turns a rice ball into sushi: +2, and complete sushi is worth 2x', bonus: 2, completes: true },
    { id: 'chef',   name: 'Chef',            emoji: '🧑‍🍳', role: 'topping', colour: '#4f3a1f', baseCost: 120, growth: 1, hint: 'Sushi passing by is worth +5', bonus: 5 },
    { id: 'exit',   name: 'Serving counter', emoji: '🏮',  role: 'exit',    colour: '#5a2f22', baseCost: 10,  growth: 1,    hint: 'Sells what arrives for its value' },

    // ---- more things in the Shop
    { id: 'cucumber',     name: 'Cucumber',     emoji: '🥒', role: 'topping', colour: '#2c4a26', baseCost: 30, growth: 1, hint: 'Sushi passing by is worth +1 (it does not make complete sushi)', bonus: 1 },
    { id: 'salt',         name: 'Salt shaker',  emoji: '🧂', role: 'topping', colour: '#47404f', baseCost: 80, growth: 1,  hint: 'Multiplies the value of sushi passing by by 1.25', mult: 1.25 },

    // ---- only from the Anvil (or a code): a faster belt
    { id: 'express_belt', name: 'Express belt', emoji: '⏩', role: 'belt',    colour: '#3d3a1c', shop: false, hint: 'A belt that moves sushi 2x faster', speed: 2 },

    // ---- only from the Anvil (or a code): faster rice cookers
    { id: 'rice_press',   name: 'Rice press',   emoji: '🍙', role: 'source',  colour: '#2f5a45', shop: false, hint: 'Makes a rice ball every second', speed: 2 },
    { id: 'rice_factory', name: 'Rice factory', emoji: '🏭', role: 'source',  colour: '#2a6650', shop: false, hint: 'Makes a rice ball every half second', speed: 4 },

    // ---- only from the Anvil (or a code): better seafood (all make complete sushi)
    { id: 'shrimp',  name: 'Shrimp',  emoji: '🦐', role: 'topping', colour: '#1f4f66', shop: false, hint: 'Turns a rice ball into sushi: +6',   bonus: 6,   completes: true },
    { id: 'crab',    name: 'Crab',    emoji: '🦀', role: 'topping', colour: '#1f5472', shop: false, hint: 'Turns a rice ball into sushi: +16',  bonus: 16,  completes: true },
    { id: 'squid',   name: 'Squid',   emoji: '🦑', role: 'topping', colour: '#1f5a7e', shop: false, hint: 'Turns a rice ball into sushi: +40',  bonus: 40,  completes: true },
    { id: 'octopus', name: 'Octopus', emoji: '🐙', role: 'topping', colour: '#1f608a', shop: false, hint: 'Turns a rice ball into sushi: +100', bonus: 100, completes: true },
    { id: 'lobster', name: 'Lobster', emoji: '🦞', role: 'topping', colour: '#1f6696', shop: false, hint: 'Turns a rice ball into sushi: +250', bonus: 250, completes: true },

    // ---- only from the Anvil (or a code): better vegetables
    { id: 'avocado',  name: 'Avocado',  emoji: '🥑', role: 'topping', colour: '#34502a', shop: false, hint: 'Sushi passing by is worth +3',  bonus: 3 },
    { id: 'mushroom', name: 'Mushroom', emoji: '🍄', role: 'topping', colour: '#3c562e', shop: false, hint: 'Sushi passing by is worth +8',  bonus: 8 },
    { id: 'tomato',   name: 'Tomato',   emoji: '🍅', role: 'topping', colour: '#445c32', shop: false, hint: 'Sushi passing by is worth +20', bonus: 20 },

    // ---- only from the Anvil (or a code): better seasoning
    { id: 'garlic',  name: 'Garlic',  emoji: '🧄', role: 'topping', colour: '#4d4456', shop: false, hint: 'Multiplies the value of sushi passing by by 1.5', mult: 1.5 },
    { id: 'torch',   name: 'Torch',   emoji: '🔥', role: 'topping', colour: '#59404a', shop: false, hint: 'Multiplies the value of sushi passing by by 2',   mult: 2 },
    { id: 'diamond', name: 'Diamond', emoji: '💎', role: 'topping', colour: '#3f4a68', shop: false, hint: 'Multiplies the value of sushi passing by by 3',   mult: 3 },

    // ---- only from the Anvil (or a code): better serving pieces
    { id: 'bento',      name: 'Bento counter', emoji: '🍱', role: 'exit', colour: '#6a3526', shop: false, hint: 'Sells sushi for double its value', sell: 2 },
    { id: 'restaurant', name: 'Restaurant',    emoji: '🏯', role: 'exit', colour: '#7a3b2a', shop: false, hint: 'Sells sushi for 4x its value',      sell: 4 },
];

// Equipable items: you put them ON a piece you already placed (they are not bought with points).
// A piece can carry one of each. They come from redeem codes and from the Anvil.
//   applies:    which kinds of piece (by role) they can go on
//   multiplier: how much more the piece earns      speed: how fast the piece works (2 = twice as fast)
//   colour:     the colour of the glow on the piece
export const EQUIPS = [
    {
        id: 'golden_soy_sauce', name: 'Golden soy sauce', emoji: '🍶', golden: true, colour: '#ffd34d',
        multiplier: 2, applies: ['source', 'topping', 'exit'],
        hint: 'Click a rice cooker, topping or serving piece in the factory to make it golden: it earns 2x'
    },
    {
        id: 'soy_sauce', name: 'Soy sauce', emoji: '🫙', colour: '#d9823b',
        multiplier: 1.5, applies: ['source', 'topping', 'exit'],
        hint: 'Click a rice cooker, topping or serving piece to make it earn 1.5x'
    },
    {
        id: 'wasabi', name: 'Wasabi', emoji: '🌿', colour: '#8fd14f',
        speed: 2, applies: ['belt', 'source', 'topping'],
        hint: 'Click a belt, rice cooker or topping to make it work 2x faster'
    },
    {
        id: 'spicy_drink', name: 'Spicy drink', emoji: '🌶️', colour: '#e5533d',
        speed: 1.5, applies: ['belt', 'source', 'topping'],
        hint: 'Click a belt, rice cooker or topping to make it work 1.5x faster'
    },
];

// The Anvil recipes. Players are NOT shown these: they have to discover them.
export const RECIPES = [
    { out: 'soy_sauce',   n: 1, needs: [{ id: 'belt', n: 2 }] },
    { out: 'spicy_drink', n: 1, needs: [{ id: 'exit', n: 1 }, { id: 'chef', n: 1 }] },
    { out: 'wasabi',      n: 1, needs: [{ id: 'soy_sauce', n: 1 }, { id: 'spicy_drink', n: 1 }] },
    { out: 'express_belt', n: 1, needs: [{ id: 'spicy_drink', n: 100 }, { id: 'belt', n: 100 }] },
];

// Merge chains: 2 of one piece make 1 of the next one in the list
const MERGE_CHAINS = [
    ['source', 'rice_press', 'rice_factory'],
    ['fish', 'shrimp', 'crab', 'squid', 'octopus', 'lobster'],
    ['cucumber', 'avocado', 'mushroom', 'tomato'],
    ['salt', 'garlic', 'torch', 'diamond'],
    ['exit', 'bento', 'restaurant'],
];
for (const chain of MERGE_CHAINS) {
    for (let i = 0; i + 1 < chain.length; i++) {
        RECIPES.push({ out: chain[i + 1], n: 1, needs: [{ id: chain[i], n: 2 }] });
    }
}

// The Remove tool is not an item, it is a button next to the hotbar
export const REMOVE_TOOL = {
    id: 'remove', name: 'Remove', emoji: '🗑️',
    hint: 'Click a piece to take it back. Upgrades on it (soy sauce, wasabi...) come off first, one by one.'
};

export const TILE_BY_ID = {};
export const ITEM_BY_ID = {};   // tiles and equipables
for (const t of TILES) {
    TILE_BY_ID[t.id] = t;
    ITEM_BY_ID[t.id] = t;
}
for (const e of EQUIPS) {
    ITEM_BY_ID[e.id] = e;
}
