import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';

import {
    createRoleAwareMovements,
    getFirewaterRole,
} from './firewater_movements.js';

const registry = minecraftData('1.21.6');
const require = createRequire(import.meta.url);
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');
const Block = require('prismarine-block')(registry);

function createBot(blockAt=() => null) {
    return {
        registry,
        inventory: { items: () => [] },
        blockAt,
    };
}

function findPathAcrossHazard(role, hazard) {
    const blockAt = (position) => {
        let name = 'air';
        if (position.y === 63) {
            name = hazard === 'poison' && position.x === 2 && position.z === 0
                ? 'green_concrete'
                : 'stone';
        } else if (position.y === 64 && position.x === 2 && position.z === 0 &&
            (hazard === 'water' || hazard === 'lava')) {
            name = hazard;
        }

        const definition = registry.blocksByName[name];
        const block = Block.fromStateId(definition.minStateId, 0);
        block.position = position.clone();
        return block;
    };
    const bot = {
        ...createBot(blockAt),
        game: { minY: -64 },
        entities: {},
        entity: { effects: {} },
    };
    const movements = createRoleAwareMovements(bot, {
        firewater_role: role,
        firewater_active_bounds: {
            min: { x: 0, y: 63, z: 0 },
            max: { x: 4, y: 64, z: 0 },
        },
    });
    const start = new Move(0, 64, 0, 0, 0);
    const goal = new pf.goals.GoalBlock(4, 64, 0);
    const astar = new AStar(start, movements, goal, 1_000, 1_000, 20);

    let result = astar.compute();
    while (result.status === 'partial') result = astar.compute();
    return result;
}

function assertNoWorldEdits(result) {
    for (const node of result.path) {
        assert.equal(node.toBreak.length, 0);
        assert.equal(node.toPlace.length, 0);
    }
}

test('ordinary profiles retain pathfinder defaults', () => {
    const movements = createRoleAwareMovements(createBot(), {});

    assert.equal(movements.canDig, true);
    assert.equal(movements.allow1by1towers, true);
    assert.ok(movements.scafoldingBlocks.length > 0);
    assert.equal(movements.exclusionAreasStep.length, 0);
    assert.equal(movements.exclusionAreasPlace.length, 0);
});

test('roles are normalized and unknown profiles stay ordinary', () => {
    assert.equal(getFirewaterRole({ firewater_role: ' Wade ' }), 'wade');
    assert.equal(getFirewaterRole({ firewater_role: 'EMBER' }), 'ember');
    assert.equal(getFirewaterRole({ firewater_role: 'spectator' }), null);
    assert.equal(getFirewaterRole({}), null);
});

test('Wade can traverse water but avoids lava without world editing', () => {
    const movements = createRoleAwareMovements(createBot(), { firewater_role: 'wade' });

    assert.equal(movements.canDig, false);
    assert.equal(movements.allow1by1towers, false);
    assert.equal(movements.allowParkour, false);
    assert.deepEqual(movements.scafoldingBlocks, []);
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName.water.id), false);
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName.lava.id), true);
    assert.equal(movements.updateLavaAvoidance, undefined);
    assert.equal(movements.exclusionAreasPlace[0]({}), Infinity);
});

test('Ember can traverse costly lava but avoids water without world editing', () => {
    const movements = createRoleAwareMovements(createBot(), { firewater_role: 'ember' });

    assert.equal(movements.canDig, false);
    assert.equal(movements.allow1by1towers, false);
    assert.equal(movements.allowParkour, false);
    assert.deepEqual(movements.scafoldingBlocks, []);
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName.water.id), true);
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName.bubble_column.id), true);
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName.lava.id), false);
    assert.equal(movements.updateLavaAvoidance, undefined);
    assert.ok(movements.liquidCost > 1);
});

test('actual pathfinder A* only routes Wade through water', () => {
    const water = findPathAcrossHazard('wade', 'water');
    const lava = findPathAcrossHazard('wade', 'lava');
    const poison = findPathAcrossHazard('wade', 'poison');

    assert.equal(water.status, 'success');
    assert.equal(lava.status, 'noPath');
    assert.equal(poison.status, 'noPath');
    assertNoWorldEdits(water);
    assertNoWorldEdits(lava);
    assertNoWorldEdits(poison);
});

test('actual pathfinder A* only routes Ember through lava', () => {
    const lava = findPathAcrossHazard('ember', 'lava');
    const water = findPathAcrossHazard('ember', 'water');
    const poison = findPathAcrossHazard('ember', 'poison');

    assert.equal(lava.status, 'success');
    assert.equal(water.status, 'noPath');
    assert.equal(poison.status, 'noPath');
    assertNoWorldEdits(lava);
    assertNoWorldEdits(water);
    assertNoWorldEdits(poison);
});

test('poison exclusion checks both the feet block and solid floor below it', () => {
    const floorPosition = new Vec3(2, 63, 4);
    const bot = createBot((position) => (
        position.equals(floorPosition)
            ? { name: 'green_stained_glass', position }
            : { name: 'air', position }
    ));
    const movements = createRoleAwareMovements(bot, { firewater_role: 'wade' });
    const poisonCost = movements.exclusionAreasStep[0];

    assert.equal(poisonCost({ name: 'lime_carpet', position: new Vec3(1, 64, 1) }), Infinity);
    assert.equal(poisonCost({ name: 'air', position: floorPosition.offset(0, 1, 0) }), Infinity);
    assert.equal(poisonCost({ name: 'air', position: new Vec3(20, 64, 20) }), 0);
});

test('active stage poison materials override the defaults for pathfinding', () => {
    const movements = createRoleAwareMovements(createBot(), {
        firewater_role: 'wade',
        firewater_active_poison_materials: ['minecraft:moss_block', 'sculk'],
    });
    const poisonCost = movements.exclusionAreasStep[0];

    assert.equal(poisonCost({ name: 'moss_block', position: new Vec3(1, 64, 1) }), Infinity);
    assert.equal(poisonCost({ name: 'lime_carpet', position: new Vec3(2, 64, 2) }), 0);
});

test('active stage bounds exclude path steps outside the puzzle', () => {
    const movements = createRoleAwareMovements(createBot(), {
        firewater_role: 'wade',
        firewater_active_bounds: {
            min: { x: 0, y: 60, z: 0 },
            max: { x: 10, y: 80, z: 10 },
        },
    });
    const boundsCost = movements.exclusionAreasStep[1];
    assert.equal(boundsCost({ position: new Vec3(5, 65, 5) }), 0);
    assert.equal(boundsCost({ position: new Vec3(11, 65, 5) }), Infinity);
});

test('multi-block drops cannot bypass poison landing exclusion', () => {
    const blockAt = (position) => {
        const name = position.y === 62 ? 'green_concrete' : 'air';
        const definition = registry.blocksByName[name];
        return {
            name,
            type: definition.id,
            boundingBox: name === 'air' ? 'empty' : 'block',
            shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
            position: position.clone(),
        };
    };
    const bot = { ...createBot(blockAt), game: { minY: -64 } };
    const movements = createRoleAwareMovements(bot, { firewater_role: 'ember' });

    const landing = movements.getLandingBlock(
        { x: 0, y: 64, z: 0 },
        { x: 0, z: 0 },
    );

    assert.equal(landing, null);
});

test('command movement entry points converge on the role-aware factory', () => {
    const skillsSource = readFileSync(new URL('./skills.js', import.meta.url), 'utf8');
    const worldSource = readFileSync(new URL('./world.js', import.meta.url), 'utf8');
    const actionsSource = readFileSync(new URL('../commands/actions.js', import.meta.url), 'utf8');

    assert.doesNotMatch(skillsSource, /new pf\.Movements\(bot\)/);
    assert.doesNotMatch(worldSource, /new pf\.Movements\(bot\)/);
    assert.match(skillsSource, /export async function goToPosition[\s\S]*?await goToGoal\(/);
    assert.match(skillsSource, /export async function goToPlayer[\s\S]*?await goToGoal\(/);
    assert.match(skillsSource, /export async function goToNearestBlock[\s\S]*?await goToPosition\(/);
    assert.match(skillsSource, /export async function useToolOn[\s\S]*?await goToPosition\(/);
    assert.match(skillsSource, /export async function useToolOnBlock[\s\S]*?await goToPosition\(/);
    assert.match(skillsSource, /const doorCheckInterval = firewaterRole \? null : startDoorInterval\(bot\)/);

    assert.match(actionsSource, /name: '!goToCoordinates'[\s\S]{0,800}skills\.goToPosition/);
    assert.match(actionsSource, /name: '!goToPlayer'[\s\S]{0,800}skills\.goToPlayer/);
    assert.match(actionsSource, /name: '!searchForBlock'[\s\S]{0,1200}skills\.goToNearestBlock/);
    assert.match(actionsSource, /name: '!useOn'[\s\S]{0,1200}skills\.useToolOn/);
    assert.match(actionsSource, /name: '!activateBlockAt'[\s\S]{0,1800}skills\.goToPosition/);
    assert.match(actionsSource, /name: '!standOnBlock'[\s\S]{0,2200}skills\.goToPosition/);
    assert.match(actionsSource, /name: '!exploreFirewater'[\s\S]{0,1400}skills\.moveAway/);
});
