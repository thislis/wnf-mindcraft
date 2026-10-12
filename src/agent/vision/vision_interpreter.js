import { Vec3 } from 'vec3';
import fs from 'fs';
import { waitForFirewaterResponse } from '../firewater_loop.js';
import { targetPriority } from '../library/firewater_targets.js';

export const FIREWATER_OBSERVATION_MAX_AGE_MS = 30_000;
export const FIREWATER_LINE_OF_SIGHT_DISTANCE = 16;

const DEFAULT_EXITS = new Set([
    'light_blue_glazed_terracotta',
    'orange_glazed_terracotta',
]);

function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function isInteractive(name) {
    return name === 'lever' || name.endsWith('_button');
}

function isPressurePlate(name) {
    return name.endsWith('_pressure_plate');
}

function classifyBlock(name, context, position) {
    if (context.gems.some(gem => gem.name === name && positionKey(gem.position) === positionKey(position))) return 'gem';
    if (['ladder', 'vine', 'scaffolding'].includes(name)) return 'route';
    if (isInteractive(name)) return 'activator';
    if (isPressurePlate(name)) return 'pressure_plate';
    if (context.exitMaterials.has(name)) return 'exit';
    if (name === 'water' || name === 'lava' || context.poisonMaterials.has(name)) return 'hazard';
    return null;
}

// Mineflayer's canSeeBlock aims at a block's centre. That incorrectly marks a
// floor-level exit as hidden because the ray enters the ordinary floor before
// reaching the exit centre. For exits, also test the centre of the top face—the
// surface a player can actually see and stand on.
export function canSeeFirewaterTarget(bot, block, kind) {
    if (kind === 'route' && ['air', 'cave_air'].includes(block.name)) {
        if (!bot.world?.raycast) return false;
        const head = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
        const direction = block.position.offset(0.5, 0.5, 0.5).minus(head);
        return !bot.world.raycast(head, direction.normalize(), direction.norm());
    }
    if (bot.canSeeBlock(block)) return true;
    if (!['exit', 'gem', 'activator', 'pressure_plate'].includes(kind) || !bot.world?.raycast) return false;

    const head = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
    // Aim just inside the top face so the ray actually intersects the block;
    // a point just above the face can legitimately return no hit.
    const top = block.position.offset(0.5, 0.999, 0.5);
    const samples = [top, ...(block.shapes || []).map(([x0, y0, z0, x1, y1, z1]) =>
        block.position.offset((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))];
    return samples.some(point => {
        const direction = point.minus(head);
        const distance = direction.norm();
        if (!distance) return true;
        const hit = bot.world.raycast(head, direction.normalize(), distance + 0.1);
        return !!hit && hit.position.equals(block.position);
    });
}

function normalizeContext(raw = {}) {
    return {
        gems: raw.gems || [], interactions: raw.interactions, role: raw.role, bounds: raw.bounds,
        exitMaterials: new Set([
            ...DEFAULT_EXITS,
            ...(raw.exitMaterials || []),
        ].map(value => String(value).replace(/^minecraft:/, '').toLowerCase())),
        poisonMaterials: new Set((raw.poisonMaterials || [])
            .map(value => String(value).replace(/^minecraft:/, '').toLowerCase())),
    };
}

export class VisionInterpreter {
    constructor(agent, allow_vision, options = {}) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        this.camera = null;
        this.cameraFactory = options.cameraFactory || null;
        this.readImage = options.readImage || (filename => fs.readFileSync(`${this.fp}/${filename}.jpg`));
        this.now = options.now || (() => Date.now());
        this.observationMaxAgeMs = options.observationMaxAgeMs ?? FIREWATER_OBSERVATION_MAX_AGE_MS;
        this.observedTargets = new Map();
        this.knownTargets = new Map();
    }

    async _ensureCamera() {
        if (!this.camera) {
            if (this.cameraFactory) {
                this.camera = await this.cameraFactory(this.agent.bot, this.fp);
            } else {
                const { Camera } = await import('./camera.js');
                this.camera = new Camera(this.agent.bot, this.fp);
            }
        }
        if (typeof this.camera.waitUntilReady === 'function')
            await this.camera.waitUntilReady();
    }

    clearFirewaterObservations() {
        this.invalidateFirewaterCoordinates();
        this.knownTargets.clear();
    }

    invalidateFirewaterCoordinates() {
        this.observedTargets.clear();
    }

    getExplorationHints() {
        const context = normalizeContext(this.agent.firewater?.getObservationContext?.());
        return [...this.knownTargets.values()].filter(target => {
            const block = this.agent.bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z));
            return (!block || block.name === target.name) && targetPriority(target, context.role) < 3;
        });
    }

    getRecentObservedTarget(x, y, z) {
        this._pruneObservedTargets();
        return this.observedTargets.get(`${x},${y},${z}`) || null;
    }

    async observeFirewater({ visual = true } = {}) {
        const generation = this.agent.firewater?.generation;
        let analysis = '';
        if (visual) {
            if (!this.allow_vision || !this.agent.prompter.vision_model?.sendVisionRequest)
                analysis = 'Images unavailable; use visible block evidence.';
            else {
                const controller = new AbortController();
                try {
                    analysis = await waitForFirewaterResponse(this._inspectFirewaterImages(controller.signal),
                        () => this.agent.firewater?.generation !== generation || !!this.agent.bot.interrupt_code);
                } catch (error) {
                    analysis = `Image inspection unavailable: ${error.message}`;
                } finally {
                    controller.abort();
                }
            }
        }
        if (this.agent.firewater?.generation !== generation || (visual && this.agent.bot.interrupt_code))
            return 'Firewater observation interrupted.';
        // Refresh AFTER slow image analysis. Permissions describe the world now,
        // not blocks that existed when the screenshots were taken.
        const targets = this._collectLineOfSightTargets();
        const changes = [];
        const removed = [];
        this.observedTargets.clear();
        for (const target of targets) {
            const key = positionKey(target.position);
            const previous = this.knownTargets.get(key);
            if (!previous && target.kind !== 'hazard') changes.push(`new ${target.kind} at (${key})`);
            else if (previous.name !== target.name || previous.powered !== target.powered)
                changes.push(`changed ${target.name} at (${key}); powered=${target.powered}`);
            this.knownTargets.set(key, target);
            this.observedTargets.set(key, { ...target, observedAt: this.now() });
        }
        for (const [key, target] of this.knownTargets) {
            const block = this.agent.bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z));
            if (block && block.name !== target.name) {
                this.knownTargets.delete(key);
                removed.push(key);
                changes.push(`${target.name} no longer at (${key})`);
            }
        }
        this.agent.firewater?.loop?.recordObservation(targets, this.agent.bot.entity.position,
            { now: this.now(), visual, removed });
        return [
            visual ? 'FIREWATER_OBSERVATION (images: front, right, back, left)' : 'FIREWATER_OBSERVATION (fast visible block evidence)',
            analysis ? `Image context (captured earlier; current metadata takes precedence): ${analysis}` : '',
            this._formatLineOfSightMetadata(targets),
            this._formatPlayers(),
            `Changes: ${changes.slice(0, 12).join('; ') || 'no new visible target or device state'}.`,
            this.agent.firewater?.loop?.pendingExploration ? '' : `Explorations without useful progress: ${this.agent.firewater?.loop?.stalledExplorations || 0}.`,
            `Fresh coordinate permissions: ${this.observationMaxAgeMs / 1000}s. Older remembered targets are clues only.`,
        ].filter(Boolean).join('\n');
    }

    async _inspectFirewaterImages(signal) {
        const bot = this.agent.bot;
        const generation = this.agent.firewater?.generation;
        const originalYaw = bot.entity.yaw;
        const originalPitch = bot.entity.pitch;
        const filenames = [];
        let focus = null;
        await this._ensureCamera();
        try {
            for (const offset of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
                if (signal.aborted || bot.interrupt_code || this.agent.firewater?.generation !== generation) return '';
                await bot.look(originalYaw + offset, 0, true);
                filenames.push(await this.camera.capture());
            }
            // Resolve the ambiguity that horizontal views cannot: ladder top/landing.
            const routes = this._collectLineOfSightTargets().filter(t => t.kind === 'route');
            const route = routes.find(t => positionKey(t.position) === this.agent.firewater?.loop?.plan?.target) || routes[0];
            if (route && !signal.aborted && !bot.interrupt_code && this.agent.firewater?.generation === generation) {
                let top = new Vec3(route.position.x, route.position.y, route.position.z);
                const bounds = this.agent.firewater?.getObservationContext?.().bounds;
                for (let n = 0; n < 16 && (!bounds || top.y + 1 <= bounds.max.y) &&
                    ['ladder', 'vine', 'scaffolding'].includes(bot.blockAt(top.offset(0, 1, 0))?.name); n++) top = top.offset(0, 1, 0);
                focus = top.offset(0.5, 1.5, 0.5);
                if (bot.lookAt) await bot.lookAt(focus, true);
                else await bot.look(originalYaw, Math.PI / 6, true);
                filenames.push(await this.camera.capture());
            }
        } finally {
            if (!signal.aborted && !bot.interrupt_code && this.agent.firewater?.generation === generation)
                await bot.look(originalYaw, originalPitch, true);
        }
        if (signal.aborted || bot.interrupt_code || this.agent.firewater?.generation !== generation) return '';
        const metadata = this._formatLineOfSightMetadata(this._collectLineOfSightTargets());
        return this.agent.prompter.promptVision(
            [{ role: 'system', content: metadata + `\nView order: front, right, back, left${focus ? ', focused route top/landing' : ''}.` }],
            filenames.map(filename => this.readImage(filename)),
        );
    }

    _formatPlayers() {
        const bot = this.agent.bot;
        return 'PLAYERS: ' + Object.entries(bot.players || {}).filter(([, player]) =>
            player.entity && bot.entity.position.distanceTo(player.entity.position) <= FIREWATER_LINE_OF_SIGHT_DISTANCE
        ).map(([name, player]) => `${name} at (${player.entity.position.x.toFixed(1)}, ${player.entity.position.y.toFixed(1)}, ${player.entity.position.z.toFixed(1)})`).join('; ');
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            await this._ensureCamera();
            filename = await this.camera.capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            await this._ensureCamera();
            filename = await this.camera.capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        const result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        await this._ensureCamera();
        const filename = await this.camera.capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo(maxDistance = 128) {
        const targetBlock = this.agent.bot.blockAtCursor(maxDistance);
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        }
        return "No block in center view";
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }

    _collectLineOfSightTargets() {
        const bot = this.agent.bot;
        const context = normalizeContext(this.agent.firewater?.getObservationContext?.());
        const safeLiquid = context.role === 'wade' ? 'water' : 'lava';
        const find = category => bot.findBlocks({
            matching: block => {
                const kind = block && classifyBlock(block.name, context, block.position);
                if (category === 'targets') return !!kind && kind !== 'hazard';
                if (category === 'safe') return block?.name === safeLiquid;
                return kind === 'hazard' && block.name !== safeLiquid;
            },
            maxDistance: FIREWATER_LINE_OF_SIGHT_DISTANCE,
            count: category === 'targets' ? 512 : 64,
            useExtraInfo: true,
        });
        const openings = this.agent.firewater?.exploration?.openings || [];
        const positions = [...find('targets'), ...find('safe'), ...find('hazards'),
            ...openings.map(p => new Vec3(p.x, p.y, p.z)).filter(p => bot.entity.position.distanceTo(p) <= FIREWATER_LINE_OF_SIGHT_DISTANCE)];
        const unique = new Map();
        for (const position of positions) {
            const block = bot.blockAt(position);
            if (!block) continue;
            const bounds = context.bounds;
            const p = block.position;
            if (bounds && (p.x < bounds.min.x || p.x > bounds.max.x || p.y < bounds.min.y || p.y > bounds.max.y || p.z < bounds.min.z || p.z > bounds.max.z)) continue;
            const opening = ['air', 'cave_air'].includes(block.name) && openings.some(p => positionKey(p) === positionKey(block.position));
            const kind = opening ? 'route' : classifyBlock(block.name, context, block.position);
            if (!kind) continue;
            if (!canSeeFirewaterTarget(bot, block, kind)) continue;
            const gem = context.gems.find(g => positionKey(g.position) === positionKey(block.position));
            const interaction = context.interactions?.find(t => positionKey(t.position) === positionKey(block.position));
            const role = gem?.role || interaction?.role ||
                (['activator', 'pressure_plate'].includes(kind) ? (context.interactions ? 'unknown' : 'any') : undefined);
            const properties = block.getProperties?.() || {};
            unique.set(positionKey(block.position), {
                ...gem, role, ...(opening ? { routeType: 'opening' } : {}), powered: properties.powered === true || Number(properties.power) > 0,
                occupants: kind === 'pressure_plate' ? [
                    ...Object.entries(bot.players || {}).filter(([, player]) => player.entity &&
                        Math.floor(player.entity.position.x) === block.position.x &&
                        Math.floor(player.entity.position.z) === block.position.z &&
                        Math.abs(player.entity.position.y - block.position.y) < 0.6).map(([name]) => name),
                    ...(Math.floor(bot.entity.position.x) === block.position.x &&
                        Math.floor(bot.entity.position.z) === block.position.z &&
                        Math.abs(bot.entity.position.y - block.position.y) < 0.6 ? [this.agent.name] : []),
                ].filter((name, index, all) => all.indexOf(name) === index) : [],
                name: block.name,
                kind,
                position: {
                    x: block.position.x,
                    y: block.position.y,
                    z: block.position.z,
                },
                distance: Number(bot.entity.position.distanceTo(block.position).toFixed(2)),
            });
        }
        return [...unique.values()].sort((a, b) => targetPriority(a, context.role) - targetPriority(b, context.role) || a.distance - b.distance);
    }

    _formatLineOfSightMetadata(targets) {
        if (targets.length === 0)
            return `LINE_OF_SIGHT_TARGETS (<=${FIREWATER_LINE_OF_SIGHT_DISTANCE} blocks): none`;
        const role = this.agent.firewater?.getObservationContext?.().role;
        const safeName = role === 'wade' ? 'water' : role === 'ember' ? 'lava' : null;
        const safe = targets.filter(t => t.name === safeName);
        return [
            `LINE_OF_SIGHT_TARGETS (<=${FIREWATER_LINE_OF_SIGHT_DISTANCE} blocks):`,
            ...targets.filter(t => t.name !== safeName).map(target =>
                `- ${target.kind} ${target.name} at (${target.position.x}, ${target.position.y}, ${target.position.z}); distance=${target.distance}${target.role ? `; role=${target.role}` : ''}${target.kind === 'gem' ? '; approach with !collectGemAt' : ''}${target.kind === 'route' ? '; traverse with !traverseFirewater' : ''}${['activator', 'pressure_plate'].includes(target.kind) ? `; powered=${target.powered}` : ''}${target.kind === 'pressure_plate' ? `; occupants=${target.occupants?.join(',') || 'none'}` : ''}`
            ),
            ...(safe.length ? [`Safe terrain: ${safeName}; ${safe.length} visible blocks; nearest (${positionKey(safe[0].position)}).`] : []),
        ].join('\n');
    }

    _pruneObservedTargets() {
        const cutoff = this.now() - this.observationMaxAgeMs;
        for (const [key, target] of this.observedTargets) {
            if (target.observedAt < cutoff)
                this.observedTargets.delete(key);
        }
    }
}
