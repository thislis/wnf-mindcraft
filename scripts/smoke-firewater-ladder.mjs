import { Agent } from '../src/agent/agent.js';
import pf from 'mineflayer-pathfinder';
import { traverseObservedRoute } from '../src/agent/library/firewater_routes.js';
import { FirewaterLoop } from '../src/agent/firewater_loop.js';
import { FirewaterHumanControl } from '../src/agent/firewater_human_control.js';
import { runHumanAction } from '../src/agent/firewater_user_action.js';
import { executeCommand } from '../src/agent/commands/index.js';
import agentSettings from '../src/agent/settings.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { initBot } from '../src/utils/mcdata.js';
import Vec3 from 'vec3';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(repositoryRoot, '..');
const serverRoot = path.join(workspaceRoot, 'minecraft-server');
const paperJar = path.join(serverRoot, 'server.jar');
const pluginJar = path.join(
    repositoryRoot,
    'server-plugin',
    'firewater-game',
    'build',
    'libs',
    'firewater-game-0.1.0.jar'
);

const timeout = (milliseconds, label) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
});

async function waitUntil(predicate, label, milliseconds = 3_000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    server.close();
    await once(server, 'close');
    return port;
}

async function findServerJava() {
    const runtimeRoot = path.join(serverRoot, 'runtime');
    try {
        const runtimes = await fs.readdir(runtimeRoot, { withFileTypes: true });
        for (const runtime of runtimes) {
            if (!runtime.isDirectory()) continue;
            const executable = path.join(runtimeRoot, runtime.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
            try {
                await fs.access(executable);
                return executable;
            } catch {
                // Try the next bundled runtime.
            }
        }
    } catch {
        // Fall back to PATH below.
    }
    return 'java';
}

function connectBot(username, port, whispers) {
    return new Promise((resolve, reject) => {
        Object.assign(agentSettings, { host: '127.0.0.1', port, auth: 'offline', minecraft_version: '1.21.6' });
        const bot = initBot(username);
        const onError = error => reject(new Error(`${username} failed to connect: ${error.message}`));
        bot.once('error', onError);
        bot.once('spawn', () => {
            bot.off('error', onError);
            bot.on('whisper', (source, message) => whispers.push({ target: username, source, message }));
            bot.on('messagestr', (message, _position, jsonMessage) => {
                const translation = String(jsonMessage?.translate || '').toLowerCase();
                if ((translation.includes('whispers to you')
                    || translation.includes('commands.message.display.incoming'))
                    && message.includes('[FWG:')) {
                    whispers.push({ target: username, source: 'Server', message });
                }
            });
            resolve(bot);
        });
    });
}

async function main() {
    await fs.access(paperJar);
    await fs.access(pluginJar);

    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'firewater-runtime-smoke-'));
    const pluginsDirectory = path.join(temporaryRoot, 'plugins');
    const stagesDirectory = path.join(pluginsDirectory, 'FirewaterGame', 'stages');
    await fs.mkdir(stagesDirectory, { recursive: true });
    await fs.copyFile(paperJar, path.join(temporaryRoot, 'server.jar'));
    // Reuse the installed server's public runtime dependencies in the isolated server.
    for (const directory of ['cache', 'libraries', 'versions']) {
        await fs.cp(path.join(serverRoot, directory), path.join(temporaryRoot, directory), { recursive: true });
    }
    await fs.copyFile(pluginJar, path.join(pluginsDirectory, 'FirewaterGame.jar'));
    await fs.writeFile(path.join(temporaryRoot, 'eula.txt'), 'eula=true\n', 'utf8');

    const port = await freePort();
    await fs.writeFile(path.join(temporaryRoot, 'server.properties'), [
        `server-port=${port}`,
        'server-ip=127.0.0.1',
        'online-mode=false',
        'white-list=false',
        'gamemode=survival',
        'difficulty=peaceful',
        'level-type=minecraft:flat',
        'generate-structures=false',
        'spawn-protection=0',
        'view-distance=4',
        'simulation-distance=4',
        'motd=Firewater runtime smoke',
    ].join('\n') + '\n', 'utf8');

    await fs.writeFile(path.join(stagesDirectory, 'smoke.yml'), `schema-version: 1
id: smoke
world: world
enabled: false
goal: "Both players must reach their matching exits."
bot-brief: "Runtime smoke stage."
bounds:
  min: { x: -20, y: 90, z: -20 }
  max: { x: 20, y: 110, z: 20 }
start:
  trigger: { type: button, x: 0, y: 100, z: -3 }
  wade: { x: 0.5, y: 100.0, z: 0.5, yaw: 0.0, pitch: 0.0 }
  ember: { x: 4.5, y: 100.0, z: 0.5, yaw: 0.0, pitch: 0.0 }
finish:
  hold-ticks: 10
  wade: { x: 8, y: 99, z: 0, material: light_blue_glazed_terracotta }
  ember: { x: 10, y: 99, z: 0, material: orange_glazed_terracotta }
walls:
  default-visible:
    default-visible: true
    blocks:
      - { x: 6, y: 100, z: 2, data: "minecraft:stone" }
    triggers:
      - { type: pad, x: 2, y: 100, z: 2 }
      - { type: pad, x: 4, y: 100, z: 2 }
  default-hidden:
    default-visible: false
    blocks:
      - { x: 6, y: 100, z: 3, data: "minecraft:stone" }
    triggers:
      - { type: pad, x: 2, y: 100, z: 2 }
      - { type: pad, x: 4, y: 100, z: 2 }
hazards:
  poison-materials: [lime_carpet, green_stained_glass, green_concrete]
`, 'utf8');

    const java = await findServerJava();
    const paper = spawn(java, ['-Xms256M', '-Xmx768M', '-jar', 'server.jar', '--nogui'], {
        cwd: temporaryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let log = '';
    const waiters = new Set();
    const recordLine = line => {
        log += `${line}\n`;
        process.stdout.write(`${line}\n`);
        for (const waiter of [...waiters]) {
            if (waiter.pattern.test(line)) {
                waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(line);
            }
        }
    };
    readline.createInterface({ input: paper.stdout }).on('line', recordLine);
    readline.createInterface({ input: paper.stderr }).on('line', recordLine);
    const waitForLog = (pattern, label, milliseconds = 45_000) => new Promise((resolve, reject) => {
        const waiter = { pattern, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}`));
        }, milliseconds);
        waiters.add(waiter);
    });
    const command = value => paper.stdin.write(`${value}\n`);

    const bots = [];
    const whispers = [];
    try {
        await Promise.race([
            waitForLog(/Done \(.+\)! For help, type "help"/, 'Paper startup', 90_000),
            once(paper, 'exit').then(([code]) => { throw new Error(`Paper exited during startup with code ${code}`); }),
        ]);

        command('fill -15 99 -15 15 99 15 minecraft:stone');
        bots.push(await Promise.race([connectBot('LadderProbe', port, whispers), timeout(20_000, 'LadderProbe login')]));
        const bot = bots[0];
        bot._client.write('player_loaded', {});
        bot.modes = { isOn: () => false };
        const profile = { firewater_role: 'wade', firewater_active_bounds: { min: { x: -15, y: 99, z: -15 }, max: { x: 15, y: 110, z: 15 } } };
        agentSettings.profile = profile;
        const agent = { name: 'LadderProbe', bot, prompter: { profile },
            self_prompter: { pauseAfterCurrentTurn() {} },
            firewater: { generation: 1, isRunning: () => true, loop: new FirewaterLoop(), getObservationContext: () => ({ gems: [] }) },
            actions: { async runAction(_label, action) { bot.output = ''; await action(); return { message: bot.output }; } } };
        agent.firewater.agent = agent;
        agent.firewater.humanControl = new FirewaterHumanControl(agent.firewater);
        let count = 0;
        for (const [facing, dx, dz] of [['north',0,1],['south',0,-1],['east',-1,0],['west',1,0]]) {
            for (const directed of [false, true]) {
                command('tp LadderProbe 5.5 100 5.5');
                await waitUntil(() => bot.entity.position.x > 5, 'reset probe');
                command('fill -2 100 -2 2 107 2 minecraft:air');
                command(`fill ${dx} 100 ${dz} ${dx} 104 ${dz} minecraft:stone`);
                command(`fill 0 100 0 0 104 0 minecraft:ladder[facing=${facing},waterlogged=false]`);
                await waitUntil(() => bot.blockAt(new Vec3(0,104,0))?.getProperties?.()?.facing === facing, 'ladder geometry');
                command(`tp LadderProbe ${0.5-dx} 100 ${0.5-dz}`);
                await waitUntil(() => bot.entity.position.distanceTo(new Vec3(0.5-dx,100,0.5-dz)) < 0.2, 'ladder approach');
                await bot.waitForTicks(3);
                agent.firewater.humanControl.request = directed ? { source:'Human', message:'climb' } : null;
                const action = () => traverseObservedRoute(agent, { name:'ladder', kind:'route', position:{x:0,y:100,z:0} }, () => { throw new Error('Adjacent ladder attempted base pathfinding'); });
                const result = await (directed ? runHumanAction(agent, action) : action());
                if (!result.startsWith('Traversed ladder') || !bot.entity.onGround || bot.entity.position.floored().y !== 105) throw new Error(`${facing}/${directed}: ${result} position=${bot.entity.position}`);
                console.log(`LADDER_SERVER_OK facing=${facing} mode=${directed?'human':'auto'} position=${bot.entity.position}`);
                count++;
            }
        }
        // Run the real command wrapper, pathfinder and post-arrival check for the exit floor.
        command('tp LadderProbe 5.5 100 0.5');
        command('setblock 8 99 0 minecraft:light_blue_glazed_terracotta');
        await waitUntil(() => bot.entity.position.x > 5 && bot.entity.position.y < 101 && bot.blockAt(new Vec3(8,99,0))?.name === 'light_blue_glazed_terracotta', 'exit approach');
        agent.firewater.loop.reset();
        agent.firewater.humanControl.request = { source: 'Human', message: 'stand on light blue glazed terracotta' };
        const exitResult = await runHumanAction(agent, () => executeCommand(agent, '!standOnBlock(8, 99, 0)'));
        if (!exitResult.includes('Standing on light_blue_glazed_terracotta') || !bot.entity.position.floored().equals(new Vec3(8,100,0))) throw new Error(`Exit failed: ${exitResult}`);
        console.log(`FIREWATER_LADDER_SERVER_OK cases=${count} exit=actual-command-verified`);
    } catch (error) {
        console.error(error.stack || error.message);
        console.error(`Last server log lines:\n${log.split('\n').slice(-80).join('\n')}`);
        throw error;
    } finally {
        for (const bot of bots) {
            try { bot.quit('runtime smoke complete'); } catch { /* already disconnected */ }
        }
        if (paper.exitCode === null) {
            command('stop');
            await Promise.race([once(paper, 'exit'), timeout(15_000, 'Paper shutdown')]).catch(() => paper.kill());
        }
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}

main().catch(() => {
    process.exitCode = 1;
});
