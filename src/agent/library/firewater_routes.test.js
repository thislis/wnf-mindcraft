import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { routeLandings, traverseObservedRoute } from './firewater_routes.js';
import { FirewaterLoop } from '../firewater_loop.js';
import { createRoleAwareMovements } from './firewater_movements.js';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.21.6');
const Block = require('prismarine-block')(registry);
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');

function ladderScene(role, liquid = role === 'wade' ? 'water' : 'lava') {
    const state = { ladder: true, floor: 'stone', loaded: true };
    const profile = { firewater_role: role, firewater_active_bounds: {
        min: { x: 0, y: 63, z: 0 }, max: { x: 8, y: 72, z: 0 },
    } };
    const bot = {
        registry, inventory: { items: () => [] }, entities: {}, game: { minY: -64 },
        entity: { position: new Vec3(2.5, 64, 0.5), effects: {} },
        blockAt(p) {
            if (!state.loaded && p.y >= 67) return null;
            let name = p.y === 63 ? 'stone' : 'air';
            if (p.x === 3 && p.y === 64) name = liquid;
            if (p.x === 5 && p.y >= 64 && p.y <= 66) name = p.y === 66 ? state.floor : 'stone';
            if (p.x === 4 && p.y >= 64 && p.y <= 66 && state.ladder) name = 'ladder';
            const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0);
            block.position = p.clone();
            return block;
        },
    };
    bot.pathfinder = { getPathTo(movements, goal, timeout) {
        const p = bot.entity.position.floored();
        const astar = new AStar(new Move(p.x, p.y, p.z, 0, 0), movements, goal, timeout, timeout, 40);
        let result = astar.compute();
        while (result.status === 'partial') result = astar.compute();
        return result;
    } };
    const target = { kind: 'route', name: 'ladder', position: { x: 4, y: 64, z: 0 } };
    const loop = new FirewaterLoop();
    loop.recordObservation([target, { kind: 'pressure_plate', name: 'stone_pressure_plate', powered: true,
        occupants: ['Human'], position: { x: 1, y: 64, z: 0 } }], bot.entity.position);
    const agent = { name: role, bot, prompter: { profile }, firewater: { generation: 1, loop, isRunning: () => true } };
    let moves = 0;
    const navigate = async (bot, goal) => {
        moves++;
        const path = bot.pathfinder.getPathTo(createRoleAwareMovements(bot, profile), goal, 1000);
        assert.equal(path.status, 'success');
        assert.ok(path.path.some(p => p.x === 4 && p.y > 64), 'path actually climbs the observed ladder');
        assert.ok(path.path.every(p => !p.toBreak.length && !p.toPlace.length));
        const end = path.path.at(-1);
        bot.entity.position = new Vec3(end.x + 0.5, end.y, end.z + 0.5);
        await Promise.resolve();
    };
    return { agent, target, navigate, state, moves: () => moves };
}

for (const role of ['wade', 'ember']) {
    test(`${role}: observed nearby ladder leads to an upper landing while human holds support`, async () => {
        const { agent, target, navigate, moves } = ladderScene(role);
        assert.deepEqual(routeLandings(agent.bot, target, agent.prompter.profile), [new Vec3(5, 67, 0)]);
        assert.match(await traverseObservedRoute(agent, target, navigate), /verified landing \(5,67,0\)/);
        assert.equal(moves(), 1);
        assert.equal(agent.bot.entity.position.y, 67);
        assert.equal(agent.firewater.loop.plan.phase, 'complete');
        assert.match(agent.firewater.loop.plan.support, /Human holds/);
        assert.equal(agent.firewater.loop.availableRoutes(agent.bot.entity.position).length, 0);
    });

    test(`${role}: forbidden liquid, poison or unloaded landing never starts navigation`, async () => {
        for (const cause of ['opposite liquid', 'poison', 'unloaded']) {
            const { agent, target, navigate, state, moves } = ladderScene(role, cause === 'opposite liquid' ? (role === 'wade' ? 'lava' : 'water') : undefined);
            if (cause === 'poison') state.floor = 'green_concrete';
            if (cause === 'unloaded') state.loaded = false;
            assert.match(await traverseObservedRoute(agent, target, navigate), /No safe route/);
            assert.equal(moves(), 0, cause);
        }
    });
}

test('reset or disappearing ladder cannot produce a false traversal success', async () => {
    for (const reason of ['reset', 'removed', 'outside landing']) {
        const { agent, target, navigate, state } = ladderScene('wade');
        const result = await traverseObservedRoute(agent, target, async (bot, goal) => {
            await navigate(bot, goal);
            if (reason === 'reset') agent.firewater.generation++;
            if (reason === 'removed') state.ladder = false;
            if (reason === 'outside landing') bot.entity.position.x--;
        });
        assert.doesNotMatch(result, /Traversed/);
        assert.equal(agent.firewater.loop.completedRoutes.size, 0);
    }
});

test('an observed air passage reaches its exact floor, never a radius before the gate', async () => {
    const { agent } = ladderScene('wade');
    const target = { kind: 'route', routeType: 'opening', name: 'air', position: { x: 2, y: 64, z: 0 } };
    agent.bot.entity.position = new Vec3(0.5, 64, 0.5);
    const result = await traverseObservedRoute(agent, target, async (bot, goal) => {
        assert.equal(goal.rangeSq, undefined);
        assert.ok(goal.x > target.position.x, 'landing is beyond the opening');
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        await Promise.resolve();
    });
    assert.match(result, /verified landing/);
});
