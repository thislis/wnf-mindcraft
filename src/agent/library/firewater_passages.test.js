import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { passageFoot, passagePlan } from './firewater_passages.js';
import { traverseObservedRoute } from './firewater_routes.js';
import { createRoleAwareMovements } from './firewater_movements.js';
import { FirewaterLoop } from '../firewater_loop.js';
import { VisionInterpreter } from '../vision/vision_interpreter.js';
import { runHumanAction } from '../firewater_user_action.js';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.21.6');
const Block = require('prismarine-block')(registry);
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');

function passageScene(role = 'wade', step = 0, hazard = null) {
    const state = { loaded: true, closed: false };
    const profile = { firewater_role: role, firewater_active_bounds: {
        min: { x: -8, y: 60, z: -8 }, max: { x: 10, y: 72, z: 8 },
    } };
    const bot = {
        registry, inventory: { items: () => [] }, entities: {}, game: { minY: -64 },
        entity: { position: new Vec3(0.5, 64, 1.5), effects: {} },
        world: { raycast: () => null }, canSeeBlock: () => true, findBlocks: () => [],
        blockAt(p) {
            if (!state.loaded && p.x === 3 && p.y <= 64) return null;
            const floorY = 63 + (p.x > 3 ? step : 0);
            let name = p.y <= floorY ? 'stone' : 'air';
            if (p.x === 3 && (state.closed || p.z < 0 || p.z > 2) && p.y >= 64) name = 'stone';
            if (hazard && p.x > 3 && p.y === floorY) name = hazard;
            const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0);
            b.position = p.clone();
            return b;
        },
    };
    bot.pathfinder = { getPathTo(movements, goal, timeout) {
        const p = bot.entity.position.floored();
        const astar = new AStar(new Move(p.x, p.y, p.z, 0, 0), movements, goal, timeout, timeout, 24);
        let result = astar.compute();
        while (result.status === 'partial') result = astar.compute();
        return result;
    } };
    const loop = new FirewaterLoop();
    const agent = { name: role, bot, prompter: { profile }, firewater: {
        generation: 1, loop, isRunning: () => true,
        humanControl: { request: { message: 'cross this passage' } },
        exploration: { openings: [{ x: 3, y: 67, z: 1 }, { x: 3, y: 65, z: 1 }] },
        getObservationContext: () => ({ role, bounds: profile.firewater_active_bounds }),
    } };
    const target = { kind: 'route', routeType: 'opening', name: 'air', position: { x: 3, y: 67, z: 1 } };
    const goals = [], paths = [];
    const navigate = (bot, goal) => {
        goals.push(goal);
        const path = bot.pathfinder.getPathTo(createRoleAwareMovements(bot, profile), goal, 1000);
        if (path.status !== 'success') return Promise.reject(new Error(`pathfinding ${path.status}`));
        assert.ok(path.path.every(n => !n.toBreak.length && !n.toPlace.length));
        paths.push(path.path);
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        return Promise.resolve();
    };
    return { agent, state, target, navigate, goals, paths };
}

for (const role of ['wade', 'ember']) for (const human of [false, true]) {
    test(`${role}/${human ? 'human' : 'autonomous'}: overhead opening markers traverse at floor height with real A*`, async () => {
        for (const y of [64, 65, 67]) {
            const { agent, target, navigate, goals, paths } = passageScene(role);
            target.position.y = y;
            const run = () => traverseObservedRoute(agent, target, navigate);
            const result = human ? await runHumanAction(agent, run) : await run();
            assert.match(result, /Traversed passage; verified arrival/);
            assert.deepEqual([goals[0].x, goals[0].y, goals[0].z], [3, 64, 1]);
            assert.ok(agent.bot.entity.position.x > 3.5);
            assert.equal(agent.bot.entity.position.y, 64);
            assert.ok(paths.flat().every(p => p.y === 64));
            assert.equal(agent.firewater.loop.plan.phase, 'complete');
        }
    });
}

test('observations collapse ceiling and head markers to the visible floor coordinate', async () => {
    const { agent } = passageScene();
    const vision = new VisionInterpreter(agent, false);
    const result = await vision.observeFirewater({ visual: false });
    assert.match(result, /route air at \(3, 64, 1\)/);
    assert.doesNotMatch(result, /route air at \(3, (65|67), 1\)/);
    assert.equal(vision.observedTargets.size, 1);
    assert.equal(vision.getRecentObservedTarget(3, 64, 1).routeType, 'opening');
});

test('passage destinations follow an upward or downward step instead of requiring a level floor', async () => {
    for (const step of [1, -1]) {
        const { agent, target, navigate } = passageScene('wade', step);
        const result = await traverseObservedRoute(agent, target, navigate);
        assert.match(result, /Traversed passage/);
        assert.equal(agent.bot.entity.position.y, 64 + step);
        assert.ok(agent.bot.entity.position.x > 3.5);
    }
});

test('door frame determines crossing direction for a sideways approach', async () => {
    const { agent, target, navigate } = passageScene();
    agent.bot.entity.position = new Vec3(2.5, 64, -4.5);
    const plan = passagePlan(agent.bot, target.position, agent.prompter.profile.firewater_active_bounds);
    assert.ok(plan.destinations.every(p => p.x > 3 && p.z === 1));
    assert.match(await traverseObservedRoute(agent, target, navigate), /Traversed passage/);
    assert.ok(agent.bot.entity.position.x > 3.5);
});

test('unknown floor and navigation failure have distinct diagnostics and preserve failed approach memory', async () => {
    const { agent, state, target, navigate, goals } = passageScene();
    state.loaded = false;
    const planning = await traverseObservedRoute(agent, target, navigate);
    assert.match(planning, /Passage planning failed:.*Movement was not attempted/);
    assert.equal(goals.length, 0);
    state.loaded = true;
    const movement = await traverseObservedRoute(agent, target, () => Promise.reject(new Error('collision')));
    assert.match(movement, /Passage movement failed:.*collision/);
    assert.doesNotMatch(movement, /safe landing/);
    for (const result of [planning, movement]) {
        agent.firewater.loop.recordResult('!traverseFirewater', [3, 67, 1], result, agent.bot.entity.position);
        assert.ok(agent.firewater.loop.failedApproach('!traverseFirewater', [3, 64, 1], agent.bot.entity.position));
    }
});

test('reset or closing passage during entrance approach cannot claim traversal success', async () => {
    for (const reset of [false, true]) {
        const { agent, state, target, navigate } = passageScene();
        const result = await traverseObservedRoute(agent, target, async (bot, goal) => {
            await navigate(bot, goal);
            if (reset) agent.firewater.generation++;
            else state.closed = true;
        });
        assert.doesNotMatch(result, /Traversed passage/);
        assert.equal(agent.firewater.loop.completedRoutes.size, 0);
    }
});

test('human passage requests keep the hazard override while autonomous crossing rejects poison', async () => {
    for (const human of [false, true]) {
        const { agent, target, navigate } = passageScene('wade', 0, 'green_concrete');
        const run = () => traverseObservedRoute(agent, target, navigate);
        const result = human ? await runHumanAction(agent, run) : await run();
        assert.match(result, human ? /Traversed passage/ : /Passage path not found/);
    }
});

test('recorded marker (1629,-57,16) resolves to the actual floor level (-60)', () => {
    const bot = { blockAt: p => ({ name: p.y <= -61 ? 'stone' : 'air', boundingBox: p.y <= -61 ? 'block' : 'empty' }) };
    assert.deepEqual(passageFoot(bot, { x: 1629, y: -57, z: 16 }), new Vec3(1629, -60, 16));
});
