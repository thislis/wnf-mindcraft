import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { FirewaterLoop, waitForFirewaterResponse } from './firewater_loop.js';
import { SelfPrompter } from './self_prompter.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { FirewaterSession, planFirewaterExploration } from './firewater_session.js';
import { ConversationManager } from './conversation.js';

function scene(role = 'wade') {
    let time = 1000;
    const blocks = [
        { name: 'lever', position: new Vec3(4, 64, 0), getProperties: () => ({ powered: true }) },
        { name: 'stone_pressure_plate', position: new Vec3(2, 64, 0), getProperties: () => ({ powered: true }) },
        { name: 'ladder', position: new Vec3(5, 65, 0) },
    ];
    const agent = {
        name: role === 'wade' ? 'Wade' : 'Ember',
        bot: {
            entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
            players: { Human: { entity: { position: new Vec3(2.5, 64, 0.5) } } },
            findBlocks: options => blocks.filter(options.matching).map(block => block.position),
            blockAt: position => blocks.find(block => block.position.equals(position)),
            canSeeBlock: () => true,
            async look() { await Promise.resolve(); },
        },
        firewater: {
            generation: 1, loop: new FirewaterLoop(),
            getObservationContext: () => ({ role, interactions: [] }),
        },
        prompter: {
            vision_model: { sendVisionRequest() {} },
            async promptVision(messages) {
                assert.match(messages[0].content, /ladder/);
                time += 31_000;
                await Promise.resolve();
                return 'upper route';
            },
        },
    };
    const vision = new VisionInterpreter(agent, true, {
        now: () => time,
        cameraFactory: () => ({ async capture() { await Promise.resolve(); return 'image'; } }),
        readImage: () => Buffer.from('image'),
    });
    agent.vision_interpreter = vision;
    return { agent, vision, blocks, advance: ms => { time += ms; } };
}

for (const role of ['wade', 'ember']) {
    test(`${role}: fast observation needs no camera/model and includes cooperation and height`, async () => {
        const { agent, vision } = scene(role);
        agent.prompter = {};
        vision.allow_vision = false;
        vision.cameraFactory = () => { throw new Error('must not render'); };
        const result = await vision.observeFirewater({ visual: false });
        assert.match(result, /pressure_plate.*powered=true; occupants=Human/);
        assert.match(result, /route ladder at \(5, 65, 0\)/);
        assert.match(result, /PLAYERS: Human/);
    });
}

test('31-second image analysis returns fresh permissions and current device state', async () => {
    const { agent, vision, blocks, advance } = scene();
    const analyze = agent.prompter.promptVision;
    agent.prompter.promptVision = async (...args) => {
        const result = await analyze(...args);
        blocks[0].getProperties = () => ({ powered: false });
        return result;
    };
    const result = await vision.observeFirewater();
    assert.match(result, /activator lever.*powered=false/);
    assert.ok(vision.getRecentObservedTarget(4, 64, 0));
    advance(30_001);
    assert.equal(vision.getRecentObservedTarget(4, 64, 0), null);
    assert.ok(vision.knownTargets.has('4,64,0'));
});

test('successful interaction invalidates permissions but retains discovered goals', async () => {
    const { vision, blocks } = scene();
    await vision.observeFirewater({ visual: false });
    vision.invalidateFirewaterCoordinates();
    assert.equal(vision.getRecentObservedTarget(4, 64, 0), null);
    assert.equal(vision.knownTargets.size, 3);
    blocks[0].name = 'air';
    await vision.observeFirewater({ visual: false });
    assert.equal(vision.knownTargets.has('4,64,0'), false);
    assert.ok(vision.knownTargets.has('5,65,0'));
    vision.clearFirewaterObservations();
    assert.equal(vision.knownTargets.size, 0, 'a lifecycle reset clears all stage memory');
});

test('reset during image inspection cannot restore old coordinate permissions', async () => {
    const { agent, vision } = scene();
    agent.prompter.promptVision = async () => {
        agent.firewater.generation++;
        vision.clearFirewaterObservations();
        await Promise.resolve();
        return 'obsolete';
    };
    assert.match(await vision.observeFirewater(), /interrupted/);
    assert.equal(vision.observedTargets.size, 0);
});

test('failed target retries need a different approach or a real route change', () => {
    const loop = new FirewaterLoop();
    const position = { x: 0, y: 64, z: 0 };
    loop.recordResult('!collectGemAt', [8, 64, 0], 'No safe route to this gem', position);
    assert.match(loop.beforeCommand('!collectGemAt', [8, 64, 0], position), /already failed/);
    assert.equal(loop.beforeCommand('!activateBlockAt', [2, 64, 0], position), null);
    assert.equal(loop.beforeCommand('!collectGemAt', [8, 64, 0], { ...position, x: 4 }), null);
    loop.routeChanged();
    assert.equal(loop.beforeCommand('!collectGemAt', [8, 64, 0], position), null);
});

test('plate power changes preserve failures; new ladders reopen route planning', () => {
    const { agent } = scene();
    const session = new FirewaterSession({ ...agent, prompter: { profile: { firewater_role: 'wade' } } }, { planningDelayMs: -1 });
    session.lifecycle = 'running';
    session.session = { bounds: { min: { x: 0, y: 60, z: 0 }, max: { x: 20, y: 75, z: 20 } } };
    const position = new Vec3(2, 64, 2);
    session.recordExplorationTargetFailure(position, new Vec3(10, 64, 2));
    session.loop.recordResult('!collectGemAt', [10, 64, 2], 'No safe route', position);
    session.handleExplorationBlockUpdate(
        { name: 'stone_pressure_plate', type: 1, stateId: 1, boundingBox: 'empty' },
        { name: 'stone_pressure_plate', type: 1, stateId: 2, boundingBox: 'empty', position },
    );
    assert.equal(session.exploration.failedTargets.length, 1);
    assert.equal(session.loop.failures.size, 1);
    session.handleExplorationBlockUpdate(
        { name: 'air', type: 0, stateId: 0, boundingBox: 'empty' },
        { name: 'ladder', type: 2, stateId: 3, boundingBox: 'empty', position },
    );
    assert.equal(session.exploration.failedTargets.length, 0);
    assert.equal(session.loop.failures.size, 0);
});

test('holding forbids wandering while still allowing observation and coordination', () => {
    const loop = new FirewaterLoop();
    loop.hold = 'west plate';
    assert.match(loop.beforeCommand('!exploreFirewater', [8]), /Holding/);
    assert.equal(loop.beforeCommand('!observeFirewater', []), null);
    assert.equal(loop.beforeCommand('!startConversation', ['Ember', 'cross now']), null);
});

test('conversation completion never resumes human hold or an obsolete stage', async () => {
    for (const scenario of ['hold', 'request', 'reset', 'clear']) {
        let starts = 0;
        const session = { generation: 1, isEnabled: () => true, isRunning: () => true, humanControl: {} };
        if (scenario === 'hold') session.humanControl.holding = true;
        if (scenario === 'request') session.humanControl.request = { message: 'wait' };
        const manager = {
            agent: { firewater: session, self_prompter: { isPaused: () => true, start: () => { starts++; } } },
            inConversation: () => false,
        };
        const pending = ConversationManager.prototype._resumeSelfPrompter.call(manager);
        if (scenario === 'reset') session.generation++;
        if (scenario === 'clear') session.isRunning = () => false;
        await pending;
        assert.equal(starts, 0, scenario);
    }
});

test('model wait releases on interruption, ignores late output and handles timeout', async () => {
    let interrupted = false;
    let finish;
    const pending = waitForFirewaterResponse(new Promise(resolve => { finish = resolve; }), () => interrupted);
    interrupted = true;
    assert.equal(await pending, '');
    finish('!exploreFirewater(8)');
    await assert.rejects(waitForFirewaterResponse(new Promise(() => {}), () => false, 5), /timed out/);
});

test('autonomous loop observes action results before each single-decision turn', async () => {
    const events = [];
    const loop = new FirewaterLoop();
    loop.needsObservation = true;
    let self;
    const agent = {
        firewater: { generation: 1, loop, isRunning: () => true, recordExplorationObservation() {} },
        vision_interpreter: { async observeFirewater(options) {
            assert.equal(options.visual, false);
            loop.needsObservation = false;
            events.push('observe');
            await Promise.resolve();
            return 'current scene';
        } },
        history: { async add() { await Promise.resolve(); } },
        async handleMessage(_source, _message, budget) {
            assert.equal(budget, 1);
            await FirewaterSession.prototype.prepareDecision.call({ ...agent.firewater, agent });
            events.push('decide');
            self.pauseAfterCurrentTurn();
            await Promise.resolve();
            return true;
        },
    };
    self = new SelfPrompter(agent);
    self.start('stage');
    await self.waitForLoopStop();
    assert.deepEqual(events, ['observe', 'decide']);
    assert.equal(self.isPaused(), true);
});

test('upper-floor device approaches keep the target height', () => {
    const target = { kind: 'activator', name: 'lever', role: 'wade', position: { x: 12, y: 72, z: 12 } };
    const candidates = planFirewaterExploration(
        { min: { x: 0, y: 60, z: 0 }, max: { x: 30, y: 80, z: 30 } },
        { x: 4, y: 64, z: 4 }, [], 'wade', 8, [target],
    );
    assert.ok(candidates.some(p => p.x === 12 && p.y === 72 && p.z === 12));
});

test('actual coordination command starts without a search quota and records its result', async t => {
    const { default: manager } = await import('./conversation.js');
    const { executeCommand } = await import('./commands/index.js');
    const { agent } = scene();
    agent.prompter.profile = { firewater_role: 'wade', firewater_partner: 'Ember' };
    agent.self_prompter = { isActive: () => true };
    agent.firewater = new FirewaterSession(agent, { planningDelayMs: -1 });
    agent.firewater.lifecycle = 'running';
    agent.firewater.session = { id: 'test', attempt: 1, wadePlayer: 'Wade', emberPlayer: 'Ember' };
    t.mock.method(manager, 'isOtherAgent', () => true);
    t.mock.method(manager, 'inConversation', () => false);
    t.mock.method(manager, 'startConversation', async (name, message, options) => {
        assert.equal(name, 'Ember');
        assert.equal(message, 'Hold the plate while I cross.');
        assert.equal(options.maxMessages, 4);
        await Promise.resolve();
        return true;
    });
    const result = await executeCommand(agent, '!startConversation("Ember", "Hold the plate while I cross.")');
    assert.match(result, /Started a short Firewater coordination exchange/);
    assert.match(agent.firewater.loop.lastResult, /!startConversation/);
});

for (const role of ['wade', 'ember']) {
    test(`${role}: recorded 6.15- and 2.51-block ladders survive the exploration novelty filter`, () => {
        const bounds = { min: { x: 1600, y: -64, z: 0 }, max: { x: 1674, y: -46, z: 30 } };
        for (const current of [{ x: 1629.4, y: -60, z: 13.5 }, { x: 1632.5, y: -60, z: 10.5 }]) {
            const target = { kind: 'route', name: 'ladder', position: { x: 1635, y: -60, z: 11 } };
            const candidates = planFirewaterExploration(bounds, current, [current, target.position], role, 8, [target]);
            assert.deepEqual({ x: candidates[0].x, y: candidates[0].y, z: candidates[0].z }, target.position);
            const loop = new FirewaterLoop();
            loop.recordObservation([target], current);
            assert.match(loop.beforeCommand('!exploreFirewater', [8], current), /!traverseFirewater\(1635, -60, 11\)/);
            loop.recordResult('!traverseFirewater', [1635, -60, 11], 'No safe route to landing.', current);
            assert.match(loop.beforeCommand('!traverseFirewater', [1635, -59, 11], current), /already failed/,
                'selecting another rung does not bypass the failed-route guard');
        }
    });
}

test('walking to new coordinates and discovering more water is not puzzle progress', () => {
    const loop = new FirewaterLoop();
    let position = { x: 0, y: 64, z: 0 };
    const lever = { kind: 'activator', name: 'lever', powered: false, position: { x: 3, y: 64, z: 0 } };
    loop.recordObservation([lever], position, { now: 100 });
    for (let i = 1; i <= 2; i++) {
        loop.recordResult('!exploreFirewater', [8], 'Moved to viewpoint', position);
        position = { x: i * 8, y: 64, z: 0 };
        loop.recordObservation([lever, { kind: 'hazard', name: 'water', position }], position, { now: 100 + i });
    }
    assert.equal(loop.stalledExplorations, 2);
    const reason = loop.beforeCommand('!exploreFirewater', [8], position, 200);
    assert.match(reason, /no useful target/);
    for (let n = 0; n < 3; n++) loop.recordBlocked(reason);
    assert.equal(loop.waiting, true);
    loop.recordObservation([{ ...lever, powered: true }], position, { now: 300 });
    assert.equal(loop.waiting, false, 'new device evidence allows replanning');
    assert.equal(loop.stalledExplorations, 0);
});

test('fresh repeat sensing is blocked; expiration, a different viewpoint and changed evidence allow it', () => {
    const loop = new FirewaterLoop();
    const position = { x: 0, y: 64, z: 0 };
    loop.recordObservation([], position, { now: 100, visual: true });
    assert.match(loop.beforeCommand('!observeFirewater', [], position, 200), /already fresh/);
    assert.match(loop.beforeCommand('!inspectFirewater', [], position, 200), /already inspected/);
    assert.equal(loop.beforeCommand('!observeFirewater', [], position, 30_100), null);
    assert.equal(loop.beforeCommand('!inspectFirewater', [], { ...position, x: 2 }, 200), null);
    loop.routeChanged();
    assert.equal(loop.beforeCommand('!inspectFirewater', [], position, 200), null);
});

test('image inspection includes an upward focused route view and restores the camera', async () => {
    const { agent, vision } = scene();
    const angles = [];
    let images = 0;
    agent.bot.look = async (yaw, pitch) => { angles.push([yaw, pitch]); await Promise.resolve(); };
    agent.prompter.promptVision = async (messages, buffers) => {
        images = buffers.length;
        assert.match(messages[0].content, /focused route top\/landing/);
        await Promise.resolve();
        return 'The top needs a closer approach.';
    };
    await vision.observeFirewater();
    assert.equal(images, 5);
    assert.ok(angles.some(([, pitch]) => pitch > 0));
    assert.deepEqual(angles.at(-1), [0, 0]);
});

test('reaching a nearby known objective is not rejected as an insufficiently distant viewpoint', () => {
    const { agent } = scene();
    agent.prompter.profile = { firewater_role: 'wade' };
    const session = new FirewaterSession(agent, { planningDelayMs: -1 });
    const start = new Vec3(10, 64, 10);
    const end = new Vec3(11, 64, 10);
    session.exploration.visited = [start];
    assert.equal(session.recordExplorationViewpoint(start, end, 8, { x: 12, y: 64, z: 10, objective: true }), true);
    assert.equal(session.hasPendingExplorationObservation(), true);
});
