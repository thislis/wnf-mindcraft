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

test('only visible registered gems get coordinates; metadata identifies both device roles', () => {
    for (const role of ['wade', 'ember']) {
        const blocks = [
            makeBlock('blue_stained_glass', 2, 64, 2),
            makeBlock('red_stained_glass', 2, 64, 6),
            makeBlock('emerald_block', 3, 64, 3),
            makeBlock('blue_stained_glass', 9, 64, 9), // decoration
            makeBlock('blue_stained_glass', 10, 64, 2), // registered but occluded
            makeBlock('lever', 4, 64, 2), makeBlock('lever', 4, 64, 6),
        ];
        const gems = blocks.filter((_, i) => i < 3 || i === 4).map(block => ({
            name: block.name, position: block.position,
            role: block.name === 'blue_stained_glass' ? 'wade' : block.name === 'red_stained_glass' ? 'ember' : 'any',
            offsetY: -0.5, radius: 2.1,
        }));
        const agent = { name: role, bot: {
            entity: { position: new Vec3(0, 64, 0) },
            findBlocks: options => blocks.filter(options.matching).map(b => b.position),
            blockAt: position => blocks.find(b => b.position.equals(position)),
            canSeeBlock: block => block.position.x !== 10,
        }, firewater: { getObservationContext: () => ({ role, gems, interactions: [
            { position: blocks[5].position, role: 'wade' }, { position: blocks[6].position, role: 'ember' },
        ] }) } };
        const vision = new VisionInterpreter(agent, true);
        const targets = vision._collectLineOfSightTargets();
        assert.equal(targets.filter(t => t.kind === 'gem').length, 3);
        assert.ok(targets.every(t => t.position.x !== 9 && t.position.x !== 10));
        const text = vision._formatLineOfSightMetadata(targets);
        assert.match(text, /gem blue_stained_glass.*role=wade/);
        assert.match(text, /gem red_stained_glass.*role=ember/);
        assert.match(text, /gem emerald_block.*role=any/);
        assert.match(text, /activator lever at \(4, 64, 2\).*role=wade/);
        assert.match(text, /activator lever at \(4, 64, 6\).*role=ember/);
        assert.equal(targets[0].kind, 'gem');
    }
});
