import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { findReachableExplorationTarget } from './firewater_exploration.js';

const require = createRequire(import.meta.url);
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');
const registry = minecraftData('1.21.6');
const Block = require('prismarine-block')(registry);

// A corridor with a role-specific liquid crossing and a closed gate at x=10.
function corridor(liquid) {
    const bot = {
        registry, inventory: { items: () => [] }, entities: {},
        entity: { effects: {} }, game: { minY: -64 },
        blockAt(position) {
            let name = 'air';
            if (position.y === 63 || position.x === 10) name = 'stone';
            else if (position.y === 64 && position.x === 3) name = liquid;
            const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0);
            block.position = position.clone();
            return block;
        },
    };
    bot.paths = [];
    bot.pathfinder = { getPathTo(movements, goal, timeout) {
        const search = new AStar(new Move(0, 64, 0, 0, 0), movements, goal, timeout, timeout, 40);
        let result = search.compute();
        while (result.status === 'partial') result = search.compute();
        bot.paths.push(result);
        return result;
    } };
    return bot;
}
const profile = role => ({ firewater_role: role, firewater_active_bounds: {
    min: { x: 0, y: 63, z: 0 }, max: { x: 20, y: 65, z: 0 },
} });
const near = { x: 7, y: 64, z: 0 };
const far = { x: 17, y: 64, z: 0 };

test('Ember selects a reachable nearby lava route and skips a blocked distant goal', async () => {
    const bot = corridor('lava');
    const failed = [];
    assert.deepEqual(await findReachableExplorationTarget(bot, profile('ember'), [far, near], p => failed.push(p)), near);
    assert.deepEqual(failed, [far]);
    assert.ok(bot.paths[1].path.some(p => p.x === 3));
    assert.ok(bot.paths.every(result => result.path.every(p => !p.toBreak.length && !p.toPlace.length)));
});

test('preflight keeps the other liquid and poison impassable for both roles', async () => {
    for (const [role, liquid] of [['ember', 'water'], ['wade', 'lava'], ['ember', 'green_concrete']]) {
        const failed = [];
        assert.equal(await findReachableExplorationTarget(corridor(liquid), profile(role), [near], p => failed.push(p)), null);
        assert.deepEqual(failed, [near]);
    }
    assert.deepEqual(await findReachableExplorationTarget(corridor('water'), profile('wade'), [near], () => {}), near);
});

test('interrupted exploration neither probes nor records failed goals', async () => {
    const bot = corridor('lava');
    bot.interrupt_code = true;
    const failed = [];
    assert.equal(await findReachableExplorationTarget(bot, profile('ember'), [near], p => failed.push(p)), null);
    assert.equal(bot.paths.length, 0);
    assert.deepEqual(failed, []);
});

test('incomplete path searches are not accepted and probe batches are bounded', async () => {
    const bot = corridor('lava');
    let probes = 0;
    bot.pathfinder.getPathTo = () => { probes++; return { status: 'timeout' }; };
    const failed = [];
    assert.equal(await findReachableExplorationTarget(bot, profile('ember'), Array(40).fill(near), p => failed.push(p)), null);
    assert.equal(probes, 24);
    assert.equal(failed.length, 24);
});
