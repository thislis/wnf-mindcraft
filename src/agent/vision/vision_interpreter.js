import { Vec3 } from 'vec3';
import fs from 'fs';

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

function classifyBlock(name, context) {
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
    if (bot.canSeeBlock(block)) return true;
    if (kind !== 'exit' || !bot.world?.raycast) return false;

    const head = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    // Aim just inside the top face so the ray actually intersects the block;
    // a point just above the face can legitimately return no hit.
    const top = block.position.offset(0.5, 0.999, 0.5);
    const direction = top.minus(head);
    const distance = direction.norm();
    const hit = bot.world.raycast(head, direction.normalize(), distance + 0.1);
    return !!hit && hit.position.equals(block.position);
}

function normalizeContext(raw = {}) {
    return {
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
        this.observedTargets.clear();
    }

    getRecentObservedTarget(x, y, z) {
        this._pruneObservedTargets();
        return this.observedTargets.get(`${x},${y},${z}`) || null;
    }

    async observeFirewater() {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return 'Firewater observation failed: vision is unavailable for this bot.';
        }

        const bot = this.agent.bot;
        const originalYaw = bot.entity.yaw;
        const originalPitch = bot.entity.pitch;
        const directions = [
            { label: 'front', offset: 0 },
            { label: 'right', offset: Math.PI / 2 },
            { label: 'back', offset: Math.PI },
            { label: 'left', offset: -Math.PI / 2 },
        ];
        const filenames = [];

        await this._ensureCamera();
        try {
            for (const direction of directions) {
                await bot.look(originalYaw + direction.offset, 0, true);
                filenames.push(await this.camera.capture());
            }
        } finally {
            await bot.look(originalYaw, originalPitch, true);
        }

        const targets = this._collectLineOfSightTargets();
        const timestamp = this.now();
        for (const target of targets) {
            this.observedTargets.set(positionKey(target.position), {
                ...target,
                observedAt: timestamp,
            });
        }
        this._pruneObservedTargets();

        const buffers = filenames.map(filename => this.readImage(filename));
        const messages = this.agent.history.getHistory();
        const analysis = await this.agent.prompter.promptVision(messages, buffers);
        const metadata = this._formatLineOfSightMetadata(targets);
        return [
            'FIREWATER_OBSERVATION (images: front, right, back, left)',
            `Image analysis: ${analysis}`,
            metadata,
            `Only coordinates in this observation may be targeted for ${this.observationMaxAgeMs / 1000} seconds.`,
        ].join('\n');
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
        const positions = bot.findBlocks({
            matching: block => !!block && !!classifyBlock(block.name, context),
            maxDistance: FIREWATER_LINE_OF_SIGHT_DISTANCE,
            count: 512,
            useExtraInfo: true,
        });
        const unique = new Map();
        for (const position of positions) {
            const block = bot.blockAt(position);
            if (!block) continue;
            const kind = classifyBlock(block.name, context);
            if (!kind) continue;
            if (!canSeeFirewaterTarget(bot, block, kind)) continue;
            unique.set(positionKey(block.position), {
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
        return [...unique.values()].sort((a, b) => a.distance - b.distance);
    }

    _formatLineOfSightMetadata(targets) {
        if (targets.length === 0)
            return `LINE_OF_SIGHT_TARGETS (<=${FIREWATER_LINE_OF_SIGHT_DISTANCE} blocks): none`;
        return [
            `LINE_OF_SIGHT_TARGETS (<=${FIREWATER_LINE_OF_SIGHT_DISTANCE} blocks):`,
            ...targets.map(target =>
                `- ${target.kind} ${target.name} at (${target.position.x}, ${target.position.y}, ${target.position.z}); distance=${target.distance}`
            ),
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
