import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { traverseObservedRoute } from './firewater_routes.js';
import { FirewaterLoop } from '../firewater_loop.js';
import { runHumanAction } from '../firewater_user_action.js';
const require = createRequire(import.meta.url);
const { Physics, PlayerState } = require('prismarine-physics');
const data = minecraftData('1.21.6');
const Block = require('prismarine-block')(data);

function scene(facing = 'west', role = 'wade', directed = false, options = {}) {
    const [dx, dz] = { north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0] }[facing];
    const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, false]));
    let ticks = 0, cleared = 0;
    const world = { getBlock(raw) {
        const p = raw.floored();
        let name = p.y <= 63 ? 'stone' : 'air';
        if (p.x === dx && p.z === dz && p.y >= 64 && p.y <= 68) name = p.y === 68 ? options.floor || 'stone' : 'stone';
        if (p.x === 0 && p.z === 0 && p.y >= 64 && p.y <= 68) name = 'ladder';
        if (options.roof && p.y === 69 && Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1) name = 'stone';
        const b = name === 'ladder' ? Block.fromProperties('ladder', { facing, waterlogged: false }, 0) : Block.fromStateId(data.blocksByName[name].minStateId, 0);
        b.position = p;
        return b;
    } };
    const physics = Physics(data, world);
    const bot = {
        version: '1.21.6', registry: data, game: { minY: -64 }, entities: {},
        inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
        entity: { position: options.position || new Vec3(0.5 - dx, 64, 0.5 - dz), velocity: new Vec3(0, 0, 0),
            onGround: true, yaw: 0, pitch: 0, effects: [], attributes: {} },
        blockAt: p => world.getBlock(p),
        pathfinder: { setGoal(goal) { assert.equal(goal, null); cleared++; } },
        look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; return Promise.resolve(); },
        setControlState(k, v) { controls[k] = v; },
        clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
        waitForTicks(n) {
            for (let i = 0; i < n; i++) {
                physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
                ticks++;
                options.onTick?.(agent, ticks);
            }
            return Promise.resolve();
        },
    };
    const agent = { name: role, bot, prompter: { profile: { firewater_role: role,
        firewater_active_bounds: { min: { x: -5, y: 63, z: -5 }, max: { x: 5, y: 75, z: 5 } } } },
        firewater: { generation: 1, isRunning: () => true, loop: new FirewaterLoop(),
            humanControl: { request: directed ? { message: 'climb' } : null } } };
    const target = { name: 'ladder', kind: 'route', position: { x: 0, y: 64, z: 0 } };
    const run = () => traverseObservedRoute(agent, target, () => assert.fail('adjacent ladder must use direct controls, not exact-base pathfinding'));
    return { agent, controls, run: () => directed ? runHumanAction(agent, run) : run(), ticks: () => ticks, cleared: () => cleared };
}

for (const role of ['wade', 'ember']) for (const directed of [false, true]) for (const facing of ['north', 'south', 'east', 'west']) {
    test(`${role}/${directed ? 'human' : 'auto'}/${facing}: physical attach, climb and exit from one block away`, async () => {
        const s = scene(facing, role, directed);
        const result = await s.run();
        assert.match(result, /Traversed ladder; verified upper floor/);
        assert.ok(s.agent.bot.entity.onGround);
        assert.equal(s.agent.bot.entity.position.floored().y, 69);
        assert.ok(s.ticks() > 20 && s.ticks() < 400);
        assert.equal(s.cleared(), 1, 'pathfinder releases control before the macro');
        assert.ok(Object.values(s.controls).every(v => !v));
        assert.equal(s.agent.firewater.loop.plan.phase, 'complete');
    });
}

test('blocked upper exit does not claim climbing success or wait 45 seconds', async () => {
    const s = scene('west', 'wade', true, { roof: true });
    assert.match(await s.run(), /Ladder traversal failed/);
    assert.equal(s.agent.firewater.loop.completedRoutes.size, 0);
    assert.ok(s.ticks() < 400);
});

test('reset and superseding instructions stop physical controls without success', async () => {
    for (const reset of [true, false]) {
        const s = scene('west', 'wade', true, { onTick(agent, ticks) {
            if (ticks === 12) {
                if (reset) agent.firewater.generation++;
                else agent.firewater.humanControl.request.cancelled = true;
            }
        } });
        assert.match(await s.run(), /interrupted/);
        assert.equal(s.agent.firewater.loop.completedRoutes.size, 0);
        assert.ok(Object.values(s.controls).every(v => !v));
    }
});

test('autonomous poison restriction and human risk override use the same physical macro', async () => {
    const auto = scene('west', 'wade', false, { floor: 'green_concrete' });
    assert.match(await auto.run(), /no loaded allowed upper floor/);
    assert.equal(auto.ticks(), 0);
    const human = scene('west', 'wade', true, { floor: 'green_concrete' });
    assert.match(await human.run(), /verified upper floor/);
});


test('sideways approach and resuming halfway up use live alignment rather than returning to the base', async () => {
    for (const position of [new Vec3(1.5, 64, 0.5), new Vec3(0.5, 66, 0.4)]) {
        const s = scene('north', 'wade', true, { position });
        assert.match(await s.run(), /verified upper floor/);
        assert.equal(s.agent.bot.entity.position.floored().y, 69);
    }
});
