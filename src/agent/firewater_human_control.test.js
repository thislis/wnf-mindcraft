import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Agent } from './agent.js';
import { Prompter } from '../models/prompter.js';
import { FirewaterHumanControl } from './firewater_human_control.js';
import { approachFirewaterPlayer } from './library/firewater_player.js';

function fixture() {
    const events = [];
    const prompter = {
        active: true, starts: 0,
        isActive() { return this.active; },
        async pause() { this.active = false; events.push('pause'); await Promise.resolve(); },
        async waitForLoopStop() { events.push('stopped'); await Promise.resolve(); },
        pauseAfterCurrentTurn() { this.active = false; },
        start() { this.active = true; this.starts++; },
    };
    const player = { username: 'AL_Gamja', entity: { position: new Vec3(10, 64, 10) } };
    const agent = {
        self_prompter: prompter,
        bot: { players: { AL_Gamja: player }, entity: { position: new Vec3(1, 64, 1) } },
    };
    const session = {
        agent, generation: 1, running: true,
        isRunning() { return this.running; },
        session: { bounds: { min: { x: 0, y: 60, z: 0 }, max: { x: 40, y: 72, z: 40 } } },
    };
    agent.firewater = session;
    session.humanControl = new FirewaterHumanControl(session);
    return { agent, session, control: session.humanControl, prompter, events, player };
}

test('a human request pauses autonomous play across approach, observation, and plate actions', async () => {
    const { control, prompter, events } = fixture();
    await control.run('AL_Gamja', 'come here and stand on this plate', async () => {
        assert.deepEqual(events, ['pause', 'stopped']);
        for (const action of ['approach', 'observe', 'stand']) {
            assert.equal(prompter.active, false);
            assert.match(control.getPrompt(), /come here and stand on this plate/);
            events.push(action);
            await Promise.resolve();
        }
        control.hold();
    });
    assert.equal(prompter.active, false, 'do not wander away after completing the request');
    assert.equal(control.request, null);
    await control.run('AL_Gamja', '게임 계속해', async () => {
        control.resume();
        assert.equal(prompter.active, false, 'finish the human response before resuming');
        await Promise.resolve();
    });
    assert.equal(prompter.active, true);
    assert.equal(prompter.starts, 1);
});

test('multiple human messages are handled in order without overlapping actions', async () => {
    const { control } = fixture();
    const order = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = control.run('AL_Gamja', 'come here', async () => {
        order.push('first');
        await gate;
        control.hold();
        order.push('first done');
    });
    const second = control.run('AL_Gamja', 'stand on this plate', async () => {
        order.push('second');
        assert.match(control.getPrompt(), /stand on this plate/);
        await Promise.resolve();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(order, ['first']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'first done', 'second']);
});

test('failed human turns stay paused and later requests still work', async () => {
    const { control, prompter } = fixture();
    await assert.rejects(control.run('AL_Gamja', 'come here', async () => {
        await Promise.resolve();
        throw new Error('navigation failed');
    }), /navigation failed/);
    assert.equal(prompter.active, false);
    assert.equal(control.request, null);
    await control.run('AL_Gamja', 'resume', async () => {
        control.resume();
        await Promise.resolve();
    });
    assert.equal(prompter.active, true);
});

test('stage reset or clear prevents an old human request from restarting play', async () => {
    for (const transition of ['reset', 'clear']) {
        const { control, prompter, session } = fixture();
        await control.run('AL_Gamja', 'look', async () => {
            if (transition === 'reset') session.generation++;
            else session.running = false;
            await Promise.resolve();
        });
        assert.equal(prompter.starts, 0);
    }
});

test('player approach uses the loaded sender position and holds only after verified arrival', async () => {
    const { agent, control, prompter, player } = fixture();
    await control.run('AL_Gamja', '여기로 와', async () => {
        const result = await approachFirewaterPlayer(agent, 'al_gamja', 100, async (bot, goal) => {
            assert.equal(goal.x, player.entity.position.x);
            assert.equal(goal.rangeSq, 9, 'the requested distance must be bounded');
            bot.entity.position = new Vec3(9, 64, 10);
            await Promise.resolve();
        });
        assert.match(result, /Reached al_gamja/);
    });
    assert.equal(prompter.active, false);
});

test('unloaded and out-of-bounds players never trigger navigation', async () => {
    const { agent, player } = fixture();
    let calls = 0;
    const navigate = async () => { calls++; await Promise.resolve(); };
    assert.match(await approachFirewaterPlayer(agent, 'Absent', 2, navigate), /Cannot locate/);
    player.entity.position.x = 100;
    assert.match(await approachFirewaterPlayer(agent, 'AL_Gamja', 2, navigate), /outside/);
    assert.equal(calls, 0);
});

test('a blocked path, moving player, or stage change never produces a false arrival', async () => {
    const { agent, player, session } = fixture();
    assert.match(await approachFirewaterPlayer(agent, 'AL_Gamja', 2, async () => {
        await Promise.resolve();
        throw new Error('No path');
    }), /No safe route/);
    assert.match(await approachFirewaterPlayer(agent, 'AL_Gamja', 2, async bot => {
        bot.entity.position = player.entity.position.clone();
        player.entity.position.x += 10;
        await Promise.resolve();
    }), /moved or is still too far/);
    assert.match(await approachFirewaterPlayer(agent, 'AL_Gamja', 2, async () => {
        session.generation++;
        await Promise.resolve();
    }), /interrupted/);
});


for (const name of ['Wade', 'Ember']) {
    test(`${name} routes human chat into a paused multi-command turn and leaves system turns alone`, async () => {
        const { agent, control, prompter } = fixture();
        agent.name = name;
        agent._handleMessage = async (source, message, limit) => {
            if (source === 'AL_Gamja') {
                assert.equal(prompter.active, false);
                assert.equal(limit, 6, 'observation must not consume the entire human turn');
                assert.equal(control.request.message, message);
                control.hold();
            } else {
                assert.equal(control.request, null);
            }
            await Promise.resolve();
            return true;
        };
        assert.equal(await Agent.prototype.handleMessage.call(agent, 'AL_Gamja', 'come here'), true);
        assert.equal(prompter.active, false);
        assert.equal(await Agent.prototype.handleMessage.call(agent, 'system', 'status', 1), true);
    });
}

test('the actual conversation prompt carries the current human request alongside the stage goal', async () => {
    const { agent, control } = fixture();
    const fakePrompter = {
        agent, profile: { conversing: 'Stage goal: collect gems.' },
        async checkCooldown() { await Promise.resolve(); },
        async replaceStrings(prompt) { await Promise.resolve(); return prompt; },
        async _saveLog() { await Promise.resolve(); },
        chat_model: {
            async sendRequest(messages, prompt) {
                assert.match(prompt, /Stage goal: collect gems/);
                assert.match(prompt, /HUMAN REQUEST IN PROGRESS from AL_Gamja/);
                assert.match(prompt, /!goToPlayer\("AL_Gamja", 2\)/);
                assert.match(prompt, /before autonomous gem collection/);
                await Promise.resolve();
                return '!goToPlayer("AL_Gamja", 2)';
            },
        },
    };
    await control.run('AL_Gamja', '여기로 와', async () => {
        assert.equal(await Prompter.prototype.promptConvo.call(fakePrompter, []), '!goToPlayer("AL_Gamja", 2)');
        control.hold();
    });
});
