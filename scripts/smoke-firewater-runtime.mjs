import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import mineflayer from 'mineflayer';
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
        const bot = mineflayer.createBot({
            host: '127.0.0.1',
            port,
            username,
            auth: 'offline',
            version: '1.21.6',
            hideErrors: true,
        });
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
        command('setblock 0 100 -3 minecraft:oak_button[face=floor]');
        command('setblock 8 99 0 minecraft:light_blue_glazed_terracotta');
        command('setblock 10 99 0 minecraft:orange_glazed_terracotta');
        command('setblock 2 100 2 minecraft:stone_pressure_plate');
        command('setblock 4 100 2 minecraft:stone_pressure_plate');
        command('setblock 6 100 2 minecraft:stone');
        command('setblock 6 100 3 minecraft:stone');

        bots.push(await Promise.race([connectBot('Wade', port, whispers), timeout(20_000, 'Wade login')]));
        bots.push(await Promise.race([connectBot('Ember', port, whispers), timeout(20_000, 'Ember login')]));

        const enabled = waitForLog(/Stage smoke enabled=true/, 'stage enable');
        command('fw stage enable smoke true');
        await enabled;

        const started = waitForLog(/event=STAGE_STARTED stage=smoke .*attempt=1/, 'stage start');
        command('fw stage start smoke');
        await started;

        const blockName = (x, y, z) => bots[0].blockAt(new Vec3(x, y, z), false)?.name;
        const expectWalls = async (visibleName, hiddenName, label) => waitUntil(
            () => blockName(6, 100, 2) === visibleName && blockName(6, 100, 3) === hiddenName,
            label
        );

        // Both default states and duplicate trigger OR: adding/removing a
        // second active pad must not apply an extra inversion.
        await expectWalls('stone', 'air', 'wall defaults');
        command('tp Wade 2.5 100 2.5');
        await expectWalls('air', 'stone', 'first pad inversion');
        command('tp Ember 4.5 100 2.5');
        await expectWalls('air', 'stone', 'two-pad OR state');
        command('tp Wade 0.5 100 0.5');
        await expectWalls('air', 'stone', 'one remaining pad OR state');
        command('tp Ember 4.5 100 0.5');
        await expectWalls('stone', 'air', 'wall default restoration');

        // Safe-role matrix: Wade may touch water and Ember may touch lava.
        let hazardCount = (log.match(/event=HAZARD_CONTACT/g) || []).length;
        command('setblock 0 100 8 minecraft:water');
        command('tp Wade 0.5 100 8.5');
        await new Promise(resolve => setTimeout(resolve, 500));
        if ((log.match(/event=HAZARD_CONTACT/g) || []).length !== hazardCount) {
            throw new Error('Wade was incorrectly treated as vulnerable to water.');
        }
        command('fill -2 100 6 2 102 10 minecraft:air');
        command('tp Wade 0.5 100 0.5');

        hazardCount = (log.match(/event=HAZARD_CONTACT/g) || []).length;
        command('setblock 4 100 8 minecraft:lava');
        command('tp Ember 4.5 100 8.5');
        await new Promise(resolve => setTimeout(resolve, 500));
        if ((log.match(/event=HAZARD_CONTACT/g) || []).length !== hazardCount) {
            throw new Error('Ember was incorrectly treated as vulnerable to lava.');
        }
        command('fill 2 100 6 6 102 10 minecraft:air');
        command('tp Ember 4.5 100 0.5');

        // Fatal-role matrix and attempt-wide reset.
        const emberWater = waitForLog(/event=HAZARD_CONTACT .*player=Ember hazard=WATER/, 'Ember water failure');
        command('setblock 4 100 8 minecraft:water');
        command('tp Ember 4.5 100 8.5');
        await emberWater;
        command('fill 2 100 6 6 102 10 minecraft:air');
        await waitForLog(/event=ATTEMPT_RESET stage=smoke attempt=2 .*cause=WATER/, 'water reset');

        const wadeLava = waitForLog(/event=HAZARD_CONTACT .*player=Wade hazard=LAVA/, 'Wade lava failure');
        command('setblock 0 100 8 minecraft:lava');
        command('tp Wade 0.5 100 8.5');
        await wadeLava;
        command('fill -2 100 6 2 102 10 minecraft:air');
        await waitForLog(/event=ATTEMPT_RESET stage=smoke attempt=3 .*cause=LAVA/, 'lava reset');

        const poison = waitForLog(/event=HAZARD_CONTACT .*player=Ember hazard=POISON/, 'poison failure');
        command('setblock 4 99 8 minecraft:green_concrete');
        command('tp Ember 4.5 100 8.5');
        await poison;
        command('setblock 4 99 8 minecraft:stone');
        await waitForLog(/event=ATTEMPT_RESET stage=smoke attempt=4 .*cause=POISON/, 'poison reset');

        const cleared = waitForLog(/event=STAGE_CLEARED stage=smoke .*attempts=4/, 'dual-exit clear');
        command('tp Wade 8.5 100 0.5');
        command('tp Ember 10.5 100 0.5');
        await cleared;

        const status = waitForLog(/Firewater: .*IDLE; loaded-stages=2/, 'idle status');
        command('fw status');
        await status;

        if (!/event=FINISH_ENTER .*player=Wade/.test(log)
            || !/event=FINISH_ENTER .*player=Ember/.test(log)) {
            throw new Error('Both role-specific FINISH_ENTER events were not recorded.');
        }

        await waitUntil(
            () => ['Wade', 'Ember'].every(target => whispers.some(
                entry => entry.target === target && entry.source === 'Server' && entry.message.includes('[FWG:CLEAR]')
            )),
            'client-side FWG CLEAR whispers'
        );

        for (const target of ['Wade', 'Ember']) {
            const messages = whispers.filter(entry => entry.target === target && entry.source === 'Server');
            if (!messages.some(entry => entry.message.includes('[FWG:START]')
                && entry.message.includes('session=')
                && entry.message.includes('wade-exit=light_blue_glazed_terracotta')
                && entry.message.includes('poison=lime_carpet,green_stained_glass,green_concrete'))) {
                throw new Error(`${target} did not receive the session-scoped FWG START whisper.`);
            }
            if (messages.filter(entry => entry.message.includes('[FWG:RESET]')).length < 3) {
                throw new Error(`${target} did not receive all three FWG RESET whispers.`);
            }
            if (!messages.some(entry => entry.message.includes('[FWG:CLEAR]'))) {
                throw new Error(`${target} did not receive FWG CLEAR.`);
            }
        }

        console.log('FIREWATER_RUNTIME_SMOKE_OK walls=XOR_OR attempts=4 hazards=WATER,LAVA,POISON exits=dual whispers=verified');
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
