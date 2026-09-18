import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { waitForWorldRender } from './render_readiness.js';

const position = new Vec3(-1, -49, 8);
function readyWorld() {
    return {
        loadedChunks: { '-16,0': true }, sectionMeshs: { '-16,-64,0': {} },
        sectionsOutstanding: new Set(), material: { map: { image: { width: 16, height: 16 } } },
    };
}

test('capture waits until chunk geometry and textures are all ready, including negative chunk coordinates', async () => {
    const world = readyWorld();
    world.sectionsOutstanding.add('-16,-64,0');
    world.material.map = null;
    let completed = false;
    const waiting = waitForWorldRender(world, position, { timeoutMs: 1000, pollIntervalMs: 1 }).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(completed, false);
    world.sectionsOutstanding.clear();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(completed, false, 'geometry alone is not enough');
    world.material.map = { image: { width: 16, height: 16 } };
    await waiting;
    assert.equal(completed, true);
});

test('unloaded columns, unbuilt meshes, and absent textures fail with a bounded diagnostic', async () => {
    for (const missing of ['column', 'mesh', 'texture']) {
        const world = readyWorld();
        if (missing === 'column') world.loadedChunks = {};
        if (missing === 'mesh') world.sectionMeshs = {};
        if (missing === 'texture') world.material.map = null;
        await assert.rejects(waitForWorldRender(world, position, { timeoutMs: 5, pollIntervalMs: 1 }), /Screenshot render not ready.*column=-16,0/);
    }
});

test('worker errors and interrupted actions never permit a screenshot', async () => {
    const world = readyWorld();
    await assert.rejects(waitForWorldRender(world, position, { isInterrupted: () => true }), /interrupted/);
    await assert.rejects(waitForWorldRender(world, position, { getError: () => new Error('worker stopped') }), /renderer failed: worker stopped/);
    world.sectionsOutstanding.add('pending');
    let interrupted = false;
    const waiting = waitForWorldRender(world, position, { isInterrupted: () => interrupted, pollIntervalMs: 1 });
    interrupted = true;
    await assert.rejects(waiting, /interrupted/);
});
