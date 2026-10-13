import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Agent } from './agent.js';
import { FirewaterSession } from './firewater_session.js';
import { FirewaterLoop } from './firewater_loop.js';
import { History } from './history.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { getCommand, executeCommand } from './commands/index.js';
import settings from './settings.js';
settings.language = 'en';

function decisionAgent(source) {
    const events = [];
    const messages = [];
    const loop = new FirewaterLoop();
    const humanControl = { request: source === 'Human' ? { source, message: 'use this route' } : null, hold() {} };
    const agent = {
        name: 'Wade',
        bot: { entity: { position: new Vec3(0, 64, 0) }, modes: { flushBehaviorLog: () => '' } },
        async checkTaskDone() { await Promise.resolve(); },
        async routeResponse(_source, message) { messages.push(message); await Promise.resolve(); },
        history: {
            turns: [],
            async add(role, content) { this.turns.push({ role, content }); await Promise.resolve(); },
            async save() { await Promise.resolve(); },
            getHistory() { return this.turns; },
        },
        self_prompter: { isActive: () => false, shouldInterrupt: () => false, handleUserPromptedCmd() {} },
        firewater: { generation: 1, loop, humanControl, isRunning: () => true, recordExplorationObservation() {} },
        vision_interpreter: {
            async observeFirewater() {
                events.push('observe');
                loop.recordObservation([], agent.bot.entity.position);
                await Promise.resolve();
                return 'fresh snapshot';
            },
        },
    };
    agent.firewater.agent = agent;
    agent.firewater.prepareDecision = () => FirewaterSession.prototype.prepareDecision.call(agent.firewater);
    return { agent, events, loop, messages };
}

for (const source of ['system', 'Human']) {
    test(`${source}: actual message loop refreshes after each movement before the next model decision`, async t => {
        const { agent, events } = decisionAgent(source);
        let decisions = 0;
        agent.prompter = { async promptConvo(history) {
            events.push('decide');
            if (decisions > 0) assert.equal(history.at(-1).content, 'fresh snapshot');
            await Promise.resolve();
            return ++decisions <= 2 ? '!exploreFirewater(8)' : 'I need a route hint.';
        } };
        t.mock.method(getCommand('!exploreFirewater'), 'perform', async () => {
            events.push('move');
            agent.bot.entity.position.x += 8;
            await Promise.resolve();
            return 'Moved to viewpoint; not yet confirmed progress.';
        });
        await Agent.prototype._handleMessage.call(agent, source, 'use the next route', 3);
        assert.deepEqual(events, ['decide', 'move', 'observe', 'decide', 'move', 'observe', 'decide']);
        assert.equal(agent.firewater.loop.stalledExplorations, 2);
    });
}

test('human turns cannot bypass duplicate-observation guards', async t => {
    const { agent, loop } = decisionAgent('Human');
    loop.recordObservation([], agent.bot.entity.position);
    let calls = 0;
    t.mock.method(getCommand('!observeFirewater'), 'perform', async () => { calls++; await Promise.resolve(); return ''; });
    for (let i = 0; i < 3; i++) assert.match(await executeCommand(agent, '!observeFirewater'), /already fresh/);
    assert.equal(calls, 0);
    assert.equal(loop.waiting, true);
});

test('repeated blocked decisions issue one help report and stop that turn', async t => {
    const { agent, loop, messages } = decisionAgent('Human');
    loop.recordObservation([], agent.bot.entity.position);
    let decisions = 0;
    agent.prompter = { async promptConvo() { decisions++; await Promise.resolve(); return '!observeFirewater'; } };
    await Agent.prototype._handleMessage.call(agent, 'Human', 'look for the exit', 6);
    assert.equal(decisions, 3);
    assert.equal(loop.waiting, true);
    assert.equal(messages.filter(m => m === loop.helpMessage()).length, 1);
});

test('reset during shared observation cannot continue the old human turn', async t => {
    const { agent, loop } = decisionAgent('Human');
    loop.needsObservation = true;
    agent.vision_interpreter.observeFirewater = async () => {
        agent.firewater.generation++;
        await Promise.resolve();
        return 'obsolete';
    };
    agent.prompter = { promptConvo() { assert.fail('old human turn must not generate another command'); } };
    await Agent.prototype._handleMessage.call(agent, 'Human', 'use the next route', 6);
    assert.equal(agent.history.turns.some(t => t.content === 'obsolete'), false);
});

test('Firewater memory compaction uses current evidence without a second model request', async () => {
    const history = {
        agent: {
            firewater: { isRunning: () => true, session: { stage: 'forest', attempt: 2 }, loop: { lastResult: 'Verified upper landing.' } },
            prompter: { promptMemSaving() { assert.fail('no model reinterpretation during Firewater'); } },
        },
    };
    await History.prototype.summarizeMemories.call(history, [{ role: 'system', content: 'old water hazard text' }]);
    assert.match(history.memory, /Verified upper landing/);
    assert.doesNotMatch(history.memory, /old water hazard/);
});

for (const role of ['wade', 'ember']) {
    for (const source of ['system', 'Human']) {
        test(`${role}/${source}: new liquids and poison allow the next decision after movement`, async t => {
            const { agent, events, loop } = decisionAgent(source);
            agent.name = role === 'wade' ? 'Wade' : 'Ember';
            const blocks = ['water', 'lava', 'lime_carpet'].map((name, i) => ({
                name, position: new Vec3(9 + i, 64, 0),
            }));
            agent.bot.findBlocks = options => blocks.filter(options.matching).map(b => b.position);
            agent.bot.blockAt = position => blocks.find(b => b.position.equals(position));
            agent.bot.canSeeBlock = () => agent.bot.entity.position.x > 0;
            agent.firewater.getObservationContext = () => ({ role, poisonMaterials: ['lime_carpet'] });
            agent.vision_interpreter = new VisionInterpreter(agent, false);
            let decisions = 0;
            agent.prompter = { async promptConvo(history) {
                events.push('decide');
                if (decisions > 0) {
                    assert.match(history.at(-1).content, /Safe terrain:/);
                    assert.match(history.at(-1).content, /hazard lime_carpet/);
                    assert.doesNotMatch(history.at(-1).content, /new hazard/);
                    for (const block of blocks) {
                        const { x, y, z } = block.position;
                        assert.equal(agent.vision_interpreter.getRecentObservedTarget(x, y, z).name, block.name);
                    }
                    assert.equal(loop.needsObservation, false);
                }
                await Promise.resolve();
                return ++decisions <= 2 ? '!exploreFirewater(8)' : 'I need a route hint.';
            } };
            t.mock.method(getCommand('!exploreFirewater'), 'perform', async () => {
                events.push('move');
                agent.bot.entity.position.x += 8;
                await Promise.resolve();
                return 'Moved to viewpoint.';
            });
            await Agent.prototype._handleMessage.call(agent, source, 'use the next route', 3);
            assert.deepEqual(events, ['decide', 'move', 'decide', 'move', 'decide']);
            assert.equal(loop.stalledExplorations, 2);
        });
    }
}

test('reset cancels the in-flight decision and never executes its late command', async t => {
    const { agent } = decisionAgent('system');
    let signal;
    let finish;
    agent.prompter = { promptConvo(_history, options) {
        signal = options.signal;
        agent.firewater.generation++;
        return new Promise(resolve => { finish = resolve; });
    } };
    t.mock.method(getCommand('!exploreFirewater'), 'perform', () => assert.fail('obsolete command'));
    assert.equal(await Agent.prototype._handleMessage.call(agent, 'system', 'continue', 1), false);
    assert.equal(signal.aborted, true);
    finish('!exploreFirewater(8)');
});

test('a managed request failure is not silently retried three times', async () => {
    const { agent } = decisionAgent('Human');
    let calls = 0;
    agent.firewater.humanControl.getPrompt = () => '';
    const prompter = {
        agent, profile: { conversing: 'One safe action.' },
        checkCooldown: () => Promise.resolve(), replaceStrings: p => Promise.resolve(p),
        chat_model: { sendRequest() { calls++; return Promise.reject(new DOMException('deadline', 'TimeoutError')); } },
    };
    await assert.rejects(Prompter.prototype.promptConvo.call(prompter, []), /deadline/);
    assert.equal(calls, 1);
});

test('wait ends the human response immediately instead of spending the six-command budget', async () => {
    const { agent } = decisionAgent('Human');
    agent.actions = { stop: () => Promise.resolve(), cancelResume() {} };
    let decisions = 0;
    agent.prompter = { promptConvo() { decisions++; return Promise.resolve('!waitForInstructions'); } };
    await Agent.prototype._handleMessage.call(agent, 'Human', 'come here', 6);
    assert.equal(decisions, 1);
    assert.equal(agent.firewater.humanControl.turnDone, true);
    assert.equal(agent.firewater.loop.waiting, false, 'ordinary task completion does not stop the stage');
});

test('superseded model output is cancelled before it can execute another movement', async t => {
    const { agent } = decisionAgent('Human');
    let signal, finish;
    agent.prompter = { promptConvo(_history, options) {
        signal = options.signal;
        agent.firewater.humanControl.request.cancelled = true;
        return new Promise(resolve => { finish = resolve; });
    } };
    t.mock.method(getCommand('!exploreFirewater'), 'perform', () => assert.fail('obsolete command'));
    await Agent.prototype._handleMessage.call(agent, 'Human', 'climb', 6);
    assert.equal(signal.aborted, true);
    finish('!exploreFirewater(8)');
});

test('regroup wakes blocked play when the human advances, with cooldown and hold protection', () => {
    const { agent, loop } = decisionAgent('system');
    agent.bot.players = { Human: { username: 'Human', entity: { position: new Vec3(10, 64, 0) } } };
    const session = agent.firewater;
    session.getPartnerName = () => 'Human';
    session.conversationManager = { isOtherAgent: () => false };
    const command = now => FirewaterSession.prototype.getRegroupCommand.call(session, now);
    loop.waiting = true;
    assert.equal(command(100000), '!goToPlayer("Human", 2)');
    assert.equal(loop.waiting, false);
    assert.equal(command(101000), null);
    assert.equal(command(120000), null, 'stationary failure does not repeat immediately');
    loop.failures.set(loop.targetKey('!goToPlayer', ['Human', 2]), { ...agent.bot.entity.position });
    agent.bot.players.Human.entity.position.x = 14;
    assert.equal(command(130000), '!goToPlayer("Human", 2)');
    assert.equal(loop.failedApproach('!goToPlayer', ['Human', 2], agent.bot.entity.position), undefined);
    loop.hold = 'needed plate';
    assert.equal(command(200000), null);
    loop.hold = null; session.humanControl.holding = true;
    assert.equal(command(200000), null);
});

test('ladder and movement failures are remembered before the next decision', () => {
    const { loop, agent } = decisionAgent('system');
    for (const error of ['Ladder movement failed: blocked', 'Ladder traversal failed: no progress after realignment']) {
        loop.recordResult('!traverseFirewater', [0,64,0], error, agent.bot.entity.position);
        assert.ok(loop.failedApproach('!traverseFirewater', [0,68,0], agent.bot.entity.position));
    }
});
