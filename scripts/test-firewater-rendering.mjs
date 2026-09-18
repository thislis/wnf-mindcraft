// Offline regression using the same WebGL camera and worker renderer as Wade.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { Camera } from '../src/agent/vision/camera.js';

const require = createRequire(import.meta.url);
const Chunk = require('prismarine-chunk')('1.21.6');
const data = require('minecraft-data')('1.21.6');
const { World } = require('prismarine-viewer/viewer/lib/world.js');
const { getSectionGeometry } = require('prismarine-viewer/viewer/lib/models.js');
const assets = require('prismarine-viewer/public/blocksStates/1.21.4.json');
const { createCanvas, loadImage } = require('canvas');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'firewater-rendering-'));
const column = new Chunk();
for (const floor of [-61, -50, -46, -2, 63]) {
    for (let x = 1; x < 15; x++) {
        for (let z = 1; z < 15; z++) {
            column.setBlockStateId(new Vec3(x, floor, z), data.blocksByName.stone.minStateId);
            for (let y = floor + 1; y <= floor + 3; y++) {
                if (x === 1 || x === 14 || z === 1 || z === 14)
                    column.setBlockStateId(new Vec3(x, y, z), data.blocksByName.stone.minStateId);
            }
        }
    }
}
for (const [x, name] of [[4, 'blue_stained_glass'], [6, 'green_concrete'], [10, 'light_blue_glazed_terracotta'], [12, 'stone_pressure_plate']]) {
    column.setBlockStateId(new Vec3(x, -59, 5), data.blocksByName[name].minStateId);
}
const columns = new Map([['0,0', column]]);
const bot = new EventEmitter();
bot.version = '1.21.6';
bot.username = 'OfflineRenderProbe';
bot.entities = {};
bot.entity = { position: new Vec3(8, -60, 8), height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0 };
bot.world = { async getColumnAt(position) {
    await Promise.resolve();
    return columns.get(`${Math.floor(position.x / 16) * 16},${Math.floor(position.z / 16) * 16}`) || null;
} };
const camera = new Camera(bot, directory, { viewDistance: 1, maxScreenshots: 100 });

async function captureTerrain() {
    const filename = await camera.capture();
    assert.equal(camera.viewer.world.sectionsOutstanding.size, 0);
    assert.equal(camera.viewer.camera.position.y, bot.entity.position.y + bot.entity.eyeHeight);
    const image = await loadImage(path.join(directory, filename + '.jpg'));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let sky = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 173) < 4 && Math.abs(pixels[i + 1] - 216) < 4 && Math.abs(pixels[i + 2] - 230) < 4) sky++;
    }
    const skyPercent = sky / (image.width * image.height) * 100;
    assert.ok(skyPercent < 90, `Missing terrain at y=${bot.entity.position.y}: ${skyPercent}% sky`);
    console.log(`RENDER_OK y=${bot.entity.position.y} sky=${skyPercent.toFixed(2)}% file=${filename}.jpg`);
}

function verifyWorkerMesh() {
    const expectedWorld = new World('1.21.6');
    expectedWorld.addColumn(0, 0, column.toJson());
    const expected = getSectionGeometry(0, -64, 0, expectedWorld, assets);
    const mesh = camera.viewer.world.sectionMeshs['0,-64,0'].geometry;
    // This exercises the real worker's registry and named-model selection.
    // Decoding 1.21.6 states as 1.21.4 changes both models and texture UVs.
    assert.deepEqual(mesh.getAttribute('position').array, expected.positions);
    assert.deepEqual(mesh.getAttribute('uv').array, expected.uvs);
}

try {
    // No explicit render wait here: the first production capture must do it.
    await captureTerrain();
    assert.equal(camera.viewer.world.version, '1.21.6');
    assert.equal(camera.viewer.world.assetVersion, '1.21.4');
    verifyWorkerMesh();
    for (const y of [-49, -48, -47, -45, -1, 64]) {
        bot.entity.position.y = y;
        await captureTerrain();
    }
    bot.entity.position.y = -60;
    const position = new Vec3(4, -59, 5);
    const oldBlock = column.getBlock(position);
    oldBlock.position = position;
    column.setBlockStateId(position, data.blocksByName.emerald_block.minStateId);
    const newBlock = column.getBlock(position);
    newBlock.position = position;
    bot.emit('blockUpdate', oldBlock, newBlock);
    await captureTerrain();
    verifyWorkerMesh();

    // Missing destination chunks must fail instead of saving a sky-only frame.
    bot.entity.position.x = 40;
    camera.renderTimeoutMs = 50;
    const before = await fs.readdir(directory);
    await assert.rejects(camera.capture(), /Screenshot render not ready/);
    assert.deepEqual(await fs.readdir(directory), before);
    columns.set('32,0', column);
    bot.emit('chunkColumnLoad', new Vec3(32, 0, 0));
    camera.renderTimeoutMs = 15_000;
    await captureTerrain();
    console.log(`FIREWATER_RENDERING_OK first-frame=ready negative-y=visible worker-registry=1.21.6 updates=verified unloaded-chunk=rejected recovery=verified screenshots=${directory}`);
} finally {
    camera.worldView?.removeListenersFromBot(bot);
    await Promise.all(camera.viewer.world.workers.map(worker => worker.terminate()));
    camera.renderer.getContext().getExtension('STACKGL_destroy_context')?.destroy();
}
