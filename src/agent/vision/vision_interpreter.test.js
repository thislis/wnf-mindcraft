import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { screenshotsToPrune } from './screenshot_retention.js';
import {
    FIREWATER_LINE_OF_SIGHT_DISTANCE,
    VisionInterpreter,
} from './vision_interpreter.js';

function makeBlock(name, x, y, z) {
    return {
        name,
        position: new Vec3(x, y, z),
        shapes: [[0, 0, 0, 1, 1, 1]],
    };
}

test('Firewater observation waits for camera and captures four ordered views with visible coordinates', async () => {
    const blocks = [
        makeBlock('lever', 1, 64, 0),
        makeBlock('stone_pressure_plate', 2, 64, 0),
        makeBlock('light_blue_glazed_terracotta', 3, 63, 0),
        makeBlock('lime_carpet', 4, 64, 0),
    ];
    const calls = [];
    let now = 10_000;
    const bot = {
        entity: {
            position: new Vec3(0, 64, 0),
            yaw: 0.25,
            pitch: 0.1,
        },
        async look(yaw, pitch) {
            await Promise.resolve();
            calls.push(`look:${yaw}:${pitch}`);
            this.entity.yaw = yaw;
            this.entity.pitch = pitch;
        },
        findBlocks(options) {
            assert.equal(options.maxDistance, FIREWATER_LINE_OF_SIGHT_DISTANCE);
            return blocks.map(block => block.position);
        },
        blockAt(position) {
            return blocks.find(block => block.position.equals(position)) || null;
        },
        canSeeBlock(block) {
            return block.name !== 'lime_carpet';
        },
    };
    const camera = {
        captureCount: 0,
        async waitUntilReady() {
            await Promise.resolve();
            calls.push('ready');
        },
        async capture() {
            await Promise.resolve();
            calls.push(`capture:${this.captureCount}`);
            return `view-${this.captureCount++}`;
        },
    };
    let sentImages = null;
    const agent = {
        name: 'Wade',
        bot,
        history: { getHistory: () => [] },
        prompter: {
            vision_model: { sendVisionRequest() {} },
            async promptVision(_messages, images) {
                await Promise.resolve();
                sentImages = images;
                return 'gate and exits';
            },
        },
        firewater: {
            getObservationContext: () => ({
                exitMaterials: ['light_blue_glazed_terracotta', 'orange_glazed_terracotta'],
                poisonMaterials: ['lime_carpet'],
            }),
        },
    };
    const interpreter = new VisionInterpreter(agent, true, {
        cameraFactory: () => Promise.resolve(camera),
        readImage: filename => Buffer.from(filename),
        now: () => now,
    });

    const result = await interpreter.observeFirewater();

    assert.equal(calls[0], 'ready');
    assert.equal(camera.captureCount, 4);
    assert.deepEqual(sentImages.map(image => image.toString()), ['view-0', 'view-1', 'view-2', 'view-3']);
    assert.match(result, /images: front, right, back, left/);
    assert.match(result, /activator lever at \(1, 64, 0\)/);
    assert.match(result, /pressure_plate stone_pressure_plate at \(2, 64, 0\)/);
    assert.match(result, /exit light_blue_glazed_terracotta at \(3, 63, 0\)/);
    assert.doesNotMatch(result, /lime_carpet/);
    assert.equal(interpreter.getRecentObservedTarget(1, 64, 0).kind, 'activator');

    now += 30_001;
    assert.equal(interpreter.getRecentObservedTarget(1, 64, 0), null);
});

test('screenshot retention keeps only the newest forty JPEG captures', () => {
    const entries = Array.from({ length: 45 }, (_, index) =>
        `screenshot_2026-01-01T00-00-${String(index).padStart(2, '0')}_0000.jpg`
    );
    entries.push('notes.txt');
    assert.deepEqual(screenshotsToPrune(entries, 40), entries.slice(0, 5));
});
