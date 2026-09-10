import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { parseTargetContracts, GoalCollectGem, collectObservedGem } from './firewater_targets.js';

const fields = {
    'interaction-roles': '1621,-60,7,wade|1621,-60,23,ember|1655,-55,21,any',
    gems: '1614,-59,7,blue_stained_glass,wade,-0.5,2.1|1614,-59,23,red_stained_glass,ember,-0.5,2.1|1669,-49,15,emerald_block,any,-0.5,2.1',
};

test('parses both role contracts and the shared gem without inventing rules', () => {
    const result = parseTargetContracts(fields);
    assert.deepEqual(result.interactions.map(t => t.role), ['wade', 'ember', 'any']);
    assert.deepEqual(result.gems.map(t => t.role), ['wade', 'ember', 'any']);
    assert.equal(result.gems[0].offsetY, -0.5);
    assert.deepEqual(parseTargetContracts({}).gems, []);
    assert.equal(parseTargetContracts({}).interactions, null);
    assert.deepEqual(parseTargetContracts({ gems: '1,2,3,blue_stained_glass,wade,bad,100' }).gems, []);
});

test('gem goal uses the datapack collection center and a margin inside the true radius', () => {
    for (const target of parseTargetContracts(fields).gems) {
        const goal = new GoalCollectGem(target);
        assert.equal(goal.center.y, target.position.y - 0.5);
        let accepted = 0;
        for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) {
            const node = { x: target.position.x + dx, y: target.position.y + dy, z: target.position.z };
            if (goal.isEnd(node)) {
                accepted++;
                assert.ok(goal.center.distanceTo(new Vec3(node.x + 0.5, node.y, node.z + 0.5)) < 2.1);
            }
        }
        assert.ok(accepted > 0);
    }
});

function agentFor(target) {
    return {
        bot: { entity: { position: new Vec3(target.position.x + 0.5, target.position.y - 1, target.position.z + 0.5) },
            blockAt: () => ({ name: 'air' }) },
        firewater: { generation: 1, isRunning: () => true },
        vision_interpreter: { clearFirewaterObservations() {} },
    };
}

test('collection waits for server removal after legitimate movement for both colors and shared gem', async () => {
    for (const target of parseTargetContracts(fields).gems) {
        const agent = agentFor(target);
        let navigated = false;
        const result = await collectObservedGem(agent, target, async (_bot, goal) => {
            await Promise.resolve(); navigated = true;
            assert.ok(goal instanceof GoalCollectGem);
        });
        assert.equal(navigated, true);
        assert.match(result, /Server removed the collected/);
    }
});

test('out-of-range and stage-reset arrivals never report collection success', async () => {
    const target = parseTargetContracts(fields).gems[0];
    const agent = agentFor(target);
    agent.bot.entity.position.x += 10;
    assert.match(await collectObservedGem(agent, target, async () => { await Promise.resolve(); }), /outside/);
    assert.match(await collectObservedGem(agent, target, async () => {
        await Promise.resolve(); agent.firewater.generation++;
    }), /interrupted/);
});

test('failed path and missing server confirmation do not claim collection', async () => {
    const target = parseTargetContracts(fields).gems[0];
    const agent = agentFor(target);
    assert.match(await collectObservedGem(agent, target, async () => {
        await Promise.resolve(); throw new Error('noPath');
    }), /No safe route/);
    agent.bot.blockAt = () => ({ name: target.name });
    assert.match(await collectObservedGem(agent, target, async () => { await Promise.resolve(); }), /did not confirm/);
});
