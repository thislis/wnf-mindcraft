import { isHumanAction } from './firewater_user_action.js';
import { createRoleAwareMovements } from './library/firewater_movements.js';
import minecraftData from 'minecraft-data';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Agent } from './agent.js';
import { validateObservedCoordinateTarget } from './commands/actions.js';
import { executeCommand, getCommand, isFirewaterCommandAllowed } from './commands/index.js';

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
    await new Promise(resolve => setTimeout(resolve, 0));
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

test('failed ordinary tasks return to the stage and later requests still work', async () => {
    const { control, prompter } = fixture();
    await assert.rejects(control.run('AL_Gamja', 'come here', async () => {
        await Promise.resolve();
        throw new Error('navigation failed');
    }), /navigation failed/);
    assert.equal(prompter.active, true);
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

test('player approach uses the loaded sender position then resumes the stage', async () => {
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
    assert.equal(prompter.active, true);
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

test('clear/continue requests resume the stage instead of consuming a six-command human turn', async () => {
    const { isFirewaterResumeRequest } = await import('./firewater_human_control.js');
    for (const message of ['clear this game', 'do your To-do', 'please continue playing', '게임 계속해', '게임 클리어해줘', '자율 플레이 재개해']) {
        const { control, prompter } = fixture();
        control.hold();
        assert.equal(isFirewaterResumeRequest(message), true, message);
        let shortTurns = 0;
        await control.run('Human', message, async () => { shortTurns++; await Promise.resolve(); });
        assert.equal(shortTurns, 0);
        assert.equal(control.holding, false);
        assert.equal(prompter.active, true);
        assert.equal(prompter.starts, 1);
    }
    for (const message of ["don't continue playing", '게임 계속하지 마', '계속해도 돼?', 'come here', 'clear this game then come here'])
        assert.equal(isFirewaterResumeRequest(message), false, message);
});

test('a question does not cancel a cooperative plate hold', async () => {
    const { agent, control } = fixture();
    const { FirewaterLoop } = await import('./firewater_loop.js');
    agent.firewater.loop = new FirewaterLoop();
    agent.firewater.loop.hold = 'west plate';
    await control.run('Human', 'where is the exit?', async () => {
        assert.equal(agent.firewater.loop.hold, 'west plate');
        await Promise.resolve();
    });
});

test('human risk override is scoped to the active request, bot and generation', async () => {
    const { agent, control, session } = fixture();
    agent.bot.registry = minecraftData('1.21.6');
    agent.bot.inventory = { items: () => [] };
    const profile = { firewater_role: 'wade', firewater_active_bounds: session.session.bounds };
    assert.equal(isHumanAction(agent.bot), false);
    await control.run('Human', '나한테 와', async () => {
        assert.equal(isHumanAction(agent), true);
        assert.equal(isHumanAction(agent.bot), true);
        assert.equal(isHumanAction({}), false);
        const movements = createRoleAwareMovements(agent.bot, profile);
        assert.equal(movements.blocksToAvoid.size, 0);
        assert.equal(movements.exclusionAreasStep.length, 0);
        assert.equal(movements.allowParkour, true);
        assert.equal(movements.canDig, false, 'movement must not silently excavate puzzle blocks');
        session.generation++;
        assert.equal(isHumanAction(agent), false);
        await Promise.resolve();
    });
    assert.equal(isHumanAction(agent), false);
    assert.equal(createRoleAwareMovements(agent.bot, profile).blocksToAvoid.has(agent.bot.registry.blocksByName.lava.id), true);
});

test('human requests cross stage bounds and bypass stale coordinate and role safety guards', async () => {
    const { agent, control, session, player } = fixture();
    player.entity.position.x = 100;
    agent.bot.blockAt = position => ({ name: 'lava', position });
    session.getObservationContext = () => ({});
    session.validateObservedTarget = () => 'blocked by autonomous safety';
    await control.run('Human', 'go to me outside the puzzle', async () => {
        assert.equal(isFirewaterCommandAllowed(agent, '!goToCoordinates'), true);
        assert.equal(validateObservedCoordinateTarget(agent, 100, 64, 10, 'stand').error, undefined);
        const result = await approachFirewaterPlayer(agent, 'AL_Gamja', 2, bot => {
            bot.entity.position = player.entity.position.clone();
            return Promise.resolve();
        });
        assert.match(result, /Reached/);
    });
    assert.equal(isFirewaterCommandAllowed(agent, '!goToCoordinates'), false);
    assert.match(validateObservedCoordinateTarget(agent, 100, 64, 10, 'stand').error, /autonomous safety/);
});

test('a Korean human movement request bypasses old hold and failure guards; questions keep holds', async t => {
    const { agent, control, session } = fixture();
    const { FirewaterLoop } = await import('./firewater_loop.js');
    session.loop = new FirewaterLoop();
    session.loop.hold = 'west plate';
    session.loop.failures.set('!goToPlayer:AL_Gamja,2', { ...agent.bot.entity.position });
    t.mock.method(getCommand('!goToPlayer'), 'perform', () => Promise.resolve('Moved as requested.'));
    await control.run('Human', '나한테 와', async () => {
        assert.equal(await executeCommand(agent, '!goToPlayer("AL_Gamja", 2)'), 'Moved as requested.');
        assert.equal(session.loop.hold, null);
    });
    session.loop.hold = 'west plate';
    await control.run('Human', 'where are you?', async () => {
        assert.equal(session.loop.hold, 'west plate');
        await Promise.resolve();
    });
});

test('arrival followed by a new ordinary task clears old waiting and resumes the stage', async t => {
    const { agent, control, session, prompter } = fixture();
    const { FirewaterLoop } = await import('./firewater_loop.js');
    session.loop = new FirewaterLoop();
    control.hold();
    t.mock.method(getCommand('!goToPlayer'), 'perform', () => Promise.resolve('Reached Human.'));
    await control.run('Human', '나한테 와', () => executeCommand(agent, '!goToPlayer("Human", 2)'));
    assert.equal(control.holding, false);
    assert.equal(prompter.active, true);
    assert.equal(session.loop.needsObservation, true);
});

test('latest instruction revokes the active action and skips obsolete queued instructions', async () => {
    const { agent, control, prompter } = fixture();
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let cancelled = 0;
    agent.requestInterrupt = () => { cancelled++; release(); };
    const order = [];
    const first = control.run('Human', 'climb', async () => {
        const request = control.request;
        started(); await gate;
        assert.equal(request.cancelled, true);
        assert.equal(isHumanAction(agent), false, 'obsolete action loses human override');
    });
    await entered;
    const obsolete = control.run('Human', 'come here', async () => { order.push('obsolete'); await Promise.resolve(); });
    const latest = control.run('Human', 'wait here', async () => { order.push('latest'); await Promise.resolve(); });
    await Promise.all([first, obsolete, latest]);
    assert.deepEqual(order, ['latest']);
    assert.ok(cancelled > 0);
    assert.equal(control.holding, true);
    assert.equal(prompter.active, false);
});

test('human exit uses the floor top while a pressure plate uses its own height', async () => {
    const { agent, control, session } = fixture();
    session.getObservationContext = () => ({ gems: [] });
    await control.run('Human', 'stand on the exit', async () => {
        agent.bot.blockAt = position => ({ name: 'light_blue_glazed_terracotta', position });
        assert.equal(validateObservedCoordinateTarget(agent, 1672, -51, 13, 'stand').target.kind, 'exit');
        agent.bot.blockAt = position => ({ name: 'stone_pressure_plate', position });
        assert.equal(validateObservedCoordinateTarget(agent, 1672, -50, 13, 'stand').target.kind, 'pressure_plate');
        await Promise.resolve();
    });
});

test('an already removed registered gem is not reported as another collection', async () => {
    const { agent, control, session } = fixture();
    session.getObservationContext = () => ({ gems: [{ name: 'blue_stained_glass', position: { x: 1, y: 64, z: 1 } }] });
    agent.bot.blockAt = position => ({ name: 'air', position });
    await control.run('Human', 'get nearest gem', async () => {
        assert.match(validateObservedCoordinateTarget(agent, 1, 64, 1, 'collect').error, /no longer present/);
        await Promise.resolve();
    });
});
