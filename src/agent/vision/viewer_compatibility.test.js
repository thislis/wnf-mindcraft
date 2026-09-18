import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';

const require = createRequire(import.meta.url);
const { Viewer } = require('prismarine-viewer/viewer/lib/viewer.js');
const { WorldRenderer } = require('prismarine-viewer/viewer/lib/worldrenderer.js');
const { World } = require('prismarine-viewer/viewer/lib/world.js');
const { getSectionGeometry } = require('prismarine-viewer/viewer/lib/models.js');
const assets = require('prismarine-viewer/public/blocksStates/1.21.4.json');
const Chunk = require('prismarine-chunk')('1.21.6');
const data = require('minecraft-data')('1.21.6');

function singleBlock(name, y) {
    const chunk = new Chunk();
    const position = new Vec3(8, y, 8);
    chunk.setBlockStateId(position, data.blocksByName[name].minStateId);
    const world = new World('1.21.6');
    world.addColumn(0, 0, chunk.toJson());
    return { world, position };
}

test('viewer passes the actual protocol version to workers and only falls back for named assets', () => {
    for (const version of ['1.21.4', '1.21.6']) {
        const messages = [];
        const renderer = {
            resetWorld() {}, updateTexturesData() {},
            workers: [{ postMessage(message) { messages.push(message); } }],
            setVersion: WorldRenderer.prototype.setVersion,
        };
        const viewer = { world: renderer, entities: { clear() {} }, primitives: { clear() {} } };
        assert.equal(Viewer.prototype.setVersion.call(viewer, version), true);
        assert.equal(renderer.version, version);
        assert.equal(renderer.assetVersion, '1.21.4');
        assert.deepEqual(messages, [{ type: 'version', version }]);
    }
});

test('1.21.6 gems, poison, plates, and exits retain their identities after chunk transport and updates', () => {
    for (const name of ['blue_stained_glass', 'red_stained_glass', 'green_concrete', 'stone_pressure_plate', 'light_blue_glazed_terracotta', 'emerald_block']) {
        const { world, position } = singleBlock(name, -49);
        assert.equal(world.getBlock(position).name, name);
        const mesh = getSectionGeometry(0, -64, 0, world, assets);
        assert.ok(mesh.positions.length > 0, `${name} must have a model using the fallback assets`);
        world.setBlockStateId(position, data.blocksByName.blue_stained_glass.minStateId);
        assert.equal(world.getBlock(position).name, 'blue_stained_glass');
    }
});

test('water and lava render all six faces at negative Y and across section boundaries', () => {
    for (const name of ['water', 'lava']) {
        for (const y of [-63, -61, -49, -48, -47, -1, 0, 64]) {
            const { world } = singleBlock(name, y);
            const mesh = getSectionGeometry(0, Math.floor(y / 16) * 16, 0, world, assets);
            assert.equal(mesh.positions.length / 3, 24, `${name} at y=${y}`);
        }
    }
});
