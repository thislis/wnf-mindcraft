import convoManager from './conversation.js';
import { parseTargetContracts, targetPriority } from './library/firewater_targets.js';

const FIREWATER_PREFIX = /\[FWG:(START|RESET|CLEAR|ABORT)\]/i;
const FIREWATER_ROLES = new Set(['wade', 'ember']);
const DEFAULT_CONVERSATION_LIMIT = 4;
const MAX_CONVERSATION_LIMIT = 4;
const DEFAULT_PLANNING_DELAY_MS = 750;
const DEFAULT_POISON_MATERIALS = ['lime_carpet', 'green_stained_glass', 'green_concrete'];
export const FIREWATER_EXPLORATIONS_BEFORE_INTEL = 3;
const MAX_VISITED_VIEWPOINTS = 64;
const EXPLORATION_HORIZONTAL_ANCHORS = Object.freeze([
    [0.12, 0.12], [0.88, 0.88], [0.12, 0.88], [0.88, 0.12],
    [0.50, 0.50], [0.50, 0.12], [0.88, 0.50], [0.50, 0.88],
    [0.12, 0.50], [0.30, 0.30], [0.70, 0.70], [0.30, 0.70],
    [0.70, 0.30],
]);

function normalizeMaterial(value, fallback) {
    const normalized = String(value || fallback).trim().toLowerCase().replace(/^minecraft:/, '');
    return normalized || fallback;
}

function normalizePlayerName(value, fallback) {
    const normalized = String(value || fallback || '').trim();
    return normalized || fallback;
}

function parseMaterialList(value) {
    const materials = String(value || '')
        .split(',')
        .map(material => normalizeMaterial(material, ''))
        .filter(Boolean);
    return materials.length > 0 ? [...new Set(materials)] : [...DEFAULT_POISON_MATERIALS];
}

function cleanValue(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function parseFields(rawFields) {
    const fields = {};
    const parts = rawFields.split(/\s*;\s*(?=[a-z][\w-]*\s*=)/i);
    for (const part of parts) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        const key = part.slice(0, separator).trim().toLowerCase();
        fields[key] = cleanValue(part.slice(separator + 1));
    }
    return fields;
}

function parsePositiveInt(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFiniteNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseBounds(fields) {
    const read = (...keys) => {
        for (const key of keys) {
            const parsed = parseFiniteNumber(fields[key]);
            if (parsed !== null) return parsed;
        }
        return null;
    };
    const bounds = {
        min: {
            x: read('min-x', 'bounds-min-x', 'minx'),
            y: read('min-y', 'bounds-min-y', 'miny'),
            z: read('min-z', 'bounds-min-z', 'minz'),
        },
        max: {
            x: read('max-x', 'bounds-max-x', 'maxx'),
            y: read('max-y', 'bounds-max-y', 'maxy'),
            z: read('max-z', 'bounds-max-z', 'maxz'),
        },
    };
    const values = [...Object.values(bounds.min), ...Object.values(bounds.max)];
    if (values.some(value => value === null)) return null;
    if (bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z)
        return null;
    return bounds;
}

function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function interpolateAxis(min, max, fraction) {
    if (max - min <= 2) return Math.round((min + max) / 2);
    return Math.round((min + 1) + ((max - 1) - (min + 1)) * fraction);
}

/**
 * Try nearby unvisited viewpoints before distant stage anchors. Reachability
 * is checked against the loaded world before navigation starts.
 */
export function planFirewaterExploration(bounds, current, visited = [], role = 'wade', minDistance = 8, hints = []) {
    if (!bounds?.min || !bounds?.max || !current) return [];
    const known = [...visited, current].map(point => ({
        x: Number(point.x), y: Number(point.y), z: Number(point.z),
    }));
    const currentY = clamp(Math.round(current.y), bounds.min.y, bounds.max.y);
    const yLevels = [currentY];
    if (bounds.max.y - bounds.min.y >= 6) {
        yLevels.push(
            interpolateAxis(bounds.min.y, bounds.max.y, 0.25),
            interpolateAxis(bounds.min.y, bounds.max.y, 0.75),
        );
    }
    const uniqueYLevels = [...new Set(yLevels)];
    const anchors = role === 'ember'
        ? [...EXPLORATION_HORIZONTAL_ANCHORS.slice(2), ...EXPLORATION_HORIZONTAL_ANCHORS.slice(0, 2)]
        : EXPLORATION_HORIZONTAL_ANCHORS;

    const requiredNovelty = Math.max(3, Math.min(8, minDistance * 0.6));
    const radius = Math.max(Math.ceil(requiredNovelty + 3), minDistance);
    const local = [];
    for (const range of [radius, radius + 4]) {
        for (let direction = 0; direction < 8; direction++) {
            const angle = (direction + (role === 'ember' ? 4 : 0)) * Math.PI / 4;
            for (const dy of [0, -1, 1]) {
                local.push({
                    x: clamp(Math.round(current.x + Math.cos(angle) * range), bounds.min.x, bounds.max.x),
                    y: clamp(currentY + dy, bounds.min.y, bounds.max.y),
                    z: clamp(Math.round(current.z + Math.sin(angle) * range), bounds.min.z, bounds.max.z),
                });
            }
        }
    }
    const distant = anchors.flatMap(([xFraction, zFraction], horizontalOrder) => (
        uniqueYLevels.map((y, verticalOrder) => {
            const target = {
                x: interpolateAxis(bounds.min.x, bounds.max.x, xFraction),
                y,
                z: interpolateAxis(bounds.min.z, bounds.max.z, zFraction),
            };
            const novelty = Math.min(...known.map(point => pointDistance(target, point)));
            return { ...target, novelty, order: horizontalOrder * 4 + verticalOrder };
        })
    ));
    const seen = new Set();
    const useful = hints.filter(target => targetPriority(target, role) < 3);
    const approaches = useful.map(target => ({
        x: target.position.x, y: target.kind === 'gem' ? Math.floor(target.position.y + target.offsetY) : currentY,
        z: target.position.z,
    })).filter(p => p.y >= bounds.min.y && p.y <= bounds.max.y);
    const interest = target => useful.length ? Math.min(...useful.map(hint =>
        targetPriority(hint, role) * 24 + pointDistance(target, hint.position))) : 0;
    return [...approaches, ...local, ...distant].filter(target => {
        const key = `${target.x},${target.y},${target.z}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(target => ({
        x: target.x, y: target.y, z: target.z,
        novelty: Math.min(...known.map(point => pointDistance(target, point))),
        distance: pointDistance(current, target),
    })).filter(target => target.novelty >= requiredNovelty + 2)
        .sort((a, b) => (a.distance + interest(a) * 2) - (b.distance + interest(b) * 2) || b.novelty - a.novelty)
        .map(({ distance, ...target }) => target);
}

function isTrustedProtocolSource(source, rawMessage) {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'server') return true;
    if (normalized !== 'system') return false;

    // messagestr has no username argument. Only accept the vanilla incoming
    // /tell rendering from the console, never arbitrary public/system text.
    return /^\s*(?:server whispers(?: to you)?:?|\[server\s*->\s*[a-z0-9_]+\])\s+/i.test(rawMessage);
}

export function extractFirewaterMessage(message) {
    if (typeof message !== 'string') return null;
    const match = FIREWATER_PREFIX.exec(message);
    if (!match) return null;
    return message.slice(match.index).trim();
}

export function parseFirewaterMessage(message) {
    const extracted = extractFirewaterMessage(message);
    if (!extracted) return null;

    const match = FIREWATER_PREFIX.exec(extracted);
    const type = match[1].toUpperCase();
    const fields = parseFields(extracted.slice(match[0].length).trim());
    if (!fields.stage) {
        throw new Error(`${match[0]} is missing the required stage field.`);
    }

    return { type, fields, raw: extracted };
}

/**
 * Owns the authoritative bot-side lifecycle for one Firewater stage.
 *
 * The LLM is deliberately not responsible for turning FWG protocol messages into
 * !goal/!endGoal commands. This class assigns each START goal once, keeps it
 * through RESET, and stops it only for CLEAR/ABORT.
 */
export class FirewaterSession {
    constructor(agent, options = {}) {
        this.agent = agent;
        this.conversationManager = options.conversationManager || convoManager;
        this.planningDelayMs = options.planningDelayMs ?? DEFAULT_PLANNING_DELAY_MS;
        this.role = String(agent.prompter?.profile?.firewater_role || '').toLowerCase();
        this.partner = String(
            agent.prompter?.profile?.firewater_partner || (this.role === 'wade' ? 'Ember' : 'Wade')
        ).trim();
        this.lifecycle = 'idle';
        this.session = null;
        this.generation = 0;
        this.planningTimer = null;
        this.eventQueue = Promise.resolve();
        this.conversationSequence = 0;
        this.ready = options.ready !== false;
        this.readyPromise = this.ready ? Promise.resolve() : new Promise(resolve => {
            this.resolveReady = resolve;
        });
        this.planningReady = true;
        this.planningReadyPromise = Promise.resolve();
        this._resetExplorationState();
    }

    isEnabled() {
        return FIREWATER_ROLES.has(this.role);
    }

    isRunning() {
        return this.lifecycle === 'running' || this.lifecycle === 'starting';
    }

    getRolePlayerName(role) {
        const normalizedRole = String(role || '').toLowerCase();
        if (this.session) {
            if (normalizedRole === 'wade') return this.session.wadePlayer;
            if (normalizedRole === 'ember') return this.session.emberPlayer;
        }
        if (normalizedRole === this.role) return this.agent.name;
        return this.partner;
    }

    getPartnerName() {
        return this.getRolePlayerName(this.role === 'wade' ? 'ember' : 'wade');
    }

    isConversationLead() {
        if (!this.session) return this.role === 'wade';
        return this.getRolePlayerName(this.role).toLowerCase() === this.session.lead.toLowerCase();
    }

    markReady() {
        if (this.ready) return;
        this.ready = true;
        this.resolveReady?.();
        this.resolveReady = null;
    }

    waitUntilPlanningReady() {
        return this.planningReadyPromise;
    }

    getObservationContext() {
        if (!this.session) return {};
        return {
            exitMaterials: [this.session.wadeExit, this.session.emberExit],
            poisonMaterials: [...this.session.poisonMaterials],
            role: this.role,
            bounds: this.session.bounds,
            gems: this.session.gems || [],
            interactions: this.session.interactions,

        };
    }

    validateObservedTarget(target, action) {
        if (!this.isRunning() || !this.session)
            return 'No Firewater stage is active.';
        if (!target)
            return 'Target was not visible in a Firewater observation from the last 30 seconds. Run !observeFirewater again.';
        if (!this.session.bounds)
            return 'The server did not provide stage bounds, so coordinate actions are disabled for safety.';

        const { x, y, z } = target.position;
        const { min, max } = this.session.bounds;
        if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z)
            return `Target (${x}, ${y}, ${z}) is outside the active stage bounds.`;

        const name = target.name;
        if (this.session.poisonMaterials.includes(name))
            return `${name} is poison for both roles.`;
        if (this.role === 'wade' && name === 'lava')
            return 'Wade may not target lava.';
        if (this.role === 'ember' && name === 'water')
            return 'Ember may not target water.';

        if (['activate', 'stand', 'collect'].includes(action) && target.role &&
            target.role !== 'any' && target.role !== this.role)
            return `This ${target.kind} is assigned to ${target.role}, not ${this.role}.`;
        if (action === 'collect' && target.kind !== 'gem')
            return 'Only an observed registered gem may be collected.';
        if (action === 'activate' && target.kind !== 'activator')
            return `Only a recently observed lever or button can be activated; ${name} is ${target.kind}.`;
        if (action === 'stand') {
            const ownExit = this.role === 'wade' ? this.session.wadeExit : this.session.emberExit;
            const otherExit = this.role === 'wade' ? this.session.emberExit : this.session.wadeExit;
            if (name === otherExit && otherExit !== ownExit)
                return `${name} is the other role's exit.`;
            if (target.kind !== 'pressure_plate' && name !== ownExit)
                return `Only a recently observed pressure plate or your own ${ownExit} exit can be stood on.`;
        }
        return null;
    }

    canInitiateConversation(playerName, options = {}) {
        if (!this.isRunning()) return true;
        if (String(playerName).toLowerCase() !== this.getPartnerName().toLowerCase()) return false;
        if (options.firewaterPlanning) return this.isConversationLead();
        return this.exploration.observedSinceIntel >= FIREWATER_EXPLORATIONS_BEFORE_INTEL ||
            this.exploration.failedSinceIntel >= FIREWATER_EXPLORATIONS_BEFORE_INTEL;
    }

    prepareExploration(current, minDistance) {
        this._rememberViewpoint(current);
        return planFirewaterExploration(
            this.session?.bounds,
            current,
            this.exploration.visited,
            this.role,
            minDistance,
            this.agent.vision_interpreter?.getExplorationHints?.() || [],
        ).filter(target => !this.exploration.failedTargets.some(failure =>
            pointDistance(current, failure.origin) < 3 &&
            pointDistance(target, failure.target) < 1
        ));
    }

    recordExplorationTargetFailure(origin, target) {
        this.exploration.failedTargets.push({
            origin: { x: origin.x, y: origin.y, z: origin.z },
            target: { x: target.x, y: target.y, z: target.z },
        });
    }

    handleExplorationBlockUpdate(oldBlock, newBlock) {
        const bounds = this.session?.bounds;
        const p = newBlock?.position;
        if (!this.isRunning() || !bounds || !oldBlock || !p) return;
        // Fluid levels change constantly; a level update does not open a gate.
        if (oldBlock.type === newBlock.type &&
            (['water', 'lava'].includes(newBlock.name) || oldBlock.stateId === newBlock.stateId)) return;
        if (p.x < bounds.min.x || p.x > bounds.max.x ||
            p.y < bounds.min.y || p.y > bounds.max.y ||
            p.z < bounds.min.z || p.z > bounds.max.z) return;
        this.exploration.failedTargets = [];
    }

    hasPendingExplorationObservation() {
        return this.exploration.pendingObservation;
    }

    recordExplorationViewpoint(start, end, minDistance) {
        const moved = pointDistance(start, end);
        const novelty = this.exploration.visited.length === 0
            ? moved
            : Math.min(...this.exploration.visited.map(point => pointDistance(point, end)));
        const requiredNovelty = Math.max(3, Math.min(8, minDistance * 0.6));
        if (moved < requiredNovelty || novelty < requiredNovelty) return false;
        this._rememberViewpoint(end);
        this.exploration.pendingObservation = true;
        return true;
    }

    recordExplorationFailure() {
        this.exploration.failedSinceIntel++;
        return this.getExplorationProgress();
    }

    recordExplorationObservation() {
        if (!this.exploration.pendingObservation) return null;
        this.exploration.pendingObservation = false;
        this.exploration.observedSinceIntel++;
        return this.getExplorationProgress();
    }

    getExplorationProgress() {
        const searched = this.exploration.observedSinceIntel;
        const failed = this.exploration.failedSinceIntel;
        return {
            searched,
            failed,
            required: FIREWATER_EXPLORATIONS_BEFORE_INTEL,
            mayRequestIntel: searched >= FIREWATER_EXPLORATIONS_BEFORE_INTEL ||
                failed >= FIREWATER_EXPLORATIONS_BEFORE_INTEL,
        };
    }

    markIntelExchangeStarted() {
        this.exploration.observedSinceIntel = 0;
        this.exploration.failedSinceIntel = 0;
        this.exploration.pendingObservation = false;
    }

    getConversationOptions() {
        if (!this.isRunning() || !this.session) return {};
        const configured = parsePositiveInt(
            this.agent.prompter?.profile?.firewater_conversation_message_limit,
            DEFAULT_CONVERSATION_LIMIT
        );
        const maxMessages = Math.min(configured, MAX_CONVERSATION_LIMIT);
        return {
            id: `fwg:${this.session.id}:${this.session.attempt}:${++this.conversationSequence}`,
            maxMessages,
        };
    }

    async handleRawMessage(source, rawMessage) {
        const extracted = extractFirewaterMessage(rawMessage);
        if (!this.isEnabled() || !extracted) return false;

        // Players and bot-to-bot planning must never be able to spoof the
        // server-owned lifecycle. Consume the fake prefix without showing it
        // to the LLM.
        if (!isTrustedProtocolSource(source, rawMessage)) {
            console.warn(`${this.agent.name} ignored FWG-like text from untrusted source ${source || 'unknown'}.`);
            return true;
        }

        let event;
        try {
            event = parseFirewaterMessage(extracted);
        } catch (error) {
            console.warn(`${this.agent.name} ignored malformed Firewater message: ${error.message}`);
            return true;
        }

        // whisper and messagestr callbacks can overlap. Serialize all trusted
        // lifecycle events so CLEAR/ABORT cannot overtake an awaiting START or
        // RESET and then be overwritten by it.
        this.eventQueue = this.eventQueue.then(async () => {
            await this.readyPromise;
            switch (event.type) {
                case 'START':
                    await this._handleStart(event.fields);
                    break;
                case 'RESET':
                    await this._handleReset(event.fields);
                    break;
                case 'CLEAR':
                    await this._handleTerminal('cleared', event.fields);
                    break;
                case 'ABORT':
                    await this._handleTerminal('aborted', event.fields);
                    break;
                default:
                    break;
            }
        }).catch((error) => {
            console.error(`${this.agent.name} failed to process Firewater ${event.type}:`, error);
        });
        await this.eventQueue;
        return true;
    }

    async _handleStart(fields) {
        const attempt = parsePositiveInt(fields.attempt, 1);
        const sessionId = fields.session || `legacy:${fields.stage}:${attempt}`;
        if (this.session?.id === sessionId && this.isRunning()) {
            console.log(`${this.agent.name} ignored duplicate FWG START for ${fields.stage}/${attempt}.`);
            return;
        }

        const generation = ++this.generation;
        this._cancelPlanning();
        this._beginPlanningObservation();
        this.lifecycle = 'starting';
        this.conversationSequence = 0;
        this._resetExplorationState();
        const fallbackWade = this.role === 'wade' ? this.agent.name : this.partner;
        const fallbackEmber = this.role === 'ember' ? this.agent.name : this.partner;
        const wadePlayer = normalizePlayerName(fields['wade-player'], fallbackWade);
        const emberPlayer = normalizePlayerName(fields['ember-player'], fallbackEmber);
        this.session = {
            id: sessionId,
            stage: fields.stage,
            startAttempt: attempt,
            attempt,
            wadePlayer,
            emberPlayer,
            leadRole: String(fields['lead-role'] || 'wade').trim().toLowerCase(),
            lead: normalizePlayerName(fields.lead, wadePlayer),
            goal: fields.goal || 'Both players must stand on their matching exits at the same time.',
            brief: fields.brief || 'Observe the stage and coordinate the role-specific route.',
            world: fields.world || null,
            bounds: parseBounds(fields),
            wadeExit: normalizeMaterial(fields['wade-exit'], 'light_blue_glazed_terracotta'),
            emberExit: normalizeMaterial(fields['ember-exit'], 'orange_glazed_terracotta'),
            holdTicks: parsePositiveInt(fields['hold-ticks'], 10),
            poisonMaterials: parseMaterialList(fields.poison),
            ...parseTargetContracts(fields),
        };
        this.agent.prompter.profile.firewater_active_poison_materials = [...this.session.poisonMaterials];
        if (this.session.bounds) {
            this.agent.prompter.profile.firewater_active_bounds = structuredClone(this.session.bounds);
        } else {
            delete this.agent.prompter.profile.firewater_active_bounds;
        }

        if (!this.agent.self_prompter.isStopped()) {
            await this.agent.self_prompter.stop(true);
        }
        await this.agent.self_prompter.waitForLoopStop();
        await this.agent.actions.stop();
        this.conversationManager.endAllConversations({ resume: false });
        this.agent.vision_interpreter?.clearFirewaterObservations?.();
        if (generation !== this.generation) return;

        const goalPrompt = this._buildGoalPrompt();
        await this._addSystemHistory(
            `FIREWATER START: stage=${fields.stage}, attempt=${attempt}. ` +
            `The server is authoritative. Keep working until an FWG CLEAR or ABORT event arrives.`
        );

        // Assign the goal once, but keep it paused until both bots finish the
        // observation/planning exchange. Conversation end resumes each bot once.
        this.agent.self_prompter.setPromptPaused(goalPrompt);
        this.lifecycle = 'running';
        await this._observeForPlanning('start', generation);
        if (generation !== this.generation) return;
        this._finishPlanningObservation();
        this._scheduleWadePlanning('start');
    }

    async _handleReset(fields) {
        const attempt = parsePositiveInt(fields.attempt);
        if (!this.isRunning() || !this._matchesSession(fields)) {
            console.warn(`${this.agent.name} ignored FWG RESET without a matching running stage.`);
            return;
        }
        if (!attempt || attempt <= this.session.attempt) {
            console.log(`${this.agent.name} ignored duplicate/stale FWG RESET for ${fields.stage}/${fields.attempt}.`);
            return;
        }

        const generation = ++this.generation;
        this._cancelPlanning();
        this._beginPlanningObservation();
        this.session.attempt = attempt;
        this.session.lastCause = fields.cause || 'unknown';
        this.session.lastVictim = fields.victim || 'unknown';
        this._resetExplorationState();

        if (this.agent.self_prompter.isActive()) {
            await this.agent.self_prompter.pause();
        }
        await this.agent.self_prompter.waitForLoopStop();
        await this.agent.actions.stop();
        this.conversationManager.endAllConversations({ resume: false });
        this.agent.vision_interpreter?.clearFirewaterObservations?.();
        if (generation !== this.generation) return;

        // Preserve the assigned goal object and update only its current-attempt
        // context. Calling start() with no argument resumes; it does not assign a
        // second goal.
        this.agent.self_prompter.prompt = this._buildGoalPrompt();
        if (this.agent.self_prompter.isStopped()) {
            this.agent.self_prompter.setPromptPaused(this.agent.self_prompter.prompt);
        }
        await this._addSystemHistory(
            `FIREWATER RESET: stage=${fields.stage}, attempt=${attempt}, ` +
            `cause=${this.session.lastCause}, victim=${this.session.lastVictim}. ` +
            `The stage goal is unchanged. Discard the failed route, observe again, and replan.`
        );
        await this._observeForPlanning('reset', generation);
        if (generation !== this.generation) return;
        this._finishPlanningObservation();
        this._scheduleWadePlanning('reset');
    }

    async _handleTerminal(lifecycle, fields) {
        if (!this._matchesSession(fields) ||
            (!this.isRunning() && this.lifecycle !== lifecycle)) {
            console.warn(`${this.agent.name} ignored FWG ${lifecycle.toUpperCase()} without a matching running stage.`);
            return;
        }
        if (this.lifecycle === lifecycle) return;

        ++this.generation;
        this._cancelPlanning();
        this._finishPlanningObservation();
        this.lifecycle = lifecycle;
        delete this.agent.prompter.profile.firewater_active_poison_materials;
        delete this.agent.prompter.profile.firewater_active_bounds;
        this.agent.vision_interpreter?.clearFirewaterObservations?.();
        await this.agent.self_prompter.stop(true);
        this.conversationManager.endAllConversations({ resume: false });

        const detail = lifecycle === 'cleared'
            ? `attempts=${fields.attempts || this.session.attempt}, time=${fields.time || 'unknown'}`
            : `cause=${fields.cause || 'unknown'}`;
        await this._addSystemHistory(
            `FIREWATER ${lifecycle.toUpperCase()}: stage=${fields.stage}, ${detail}. ` +
            `The server ended the stage. Do not continue the stage goal.`
        );
    }

    _buildGoalPrompt() {
        const safeLiquid = this.role === 'wade' ? 'water' : 'lava';
        const lethalLiquid = this.role === 'wade' ? 'lava' : 'water';
        const exitMaterial = this.role === 'wade' ? this.session.wadeExit : this.session.emberExit;
        const exit = `${exitMaterial.replaceAll('_', ' ')} ${this.role === 'wade' ? 'Wade' : 'Ember'} exit`;
        const poison = this.session.poisonMaterials.map(material => material.replaceAll('_', ' ')).join(', ');
        const bounds = this.session.bounds
            ? `Stage bounds are (${this.session.bounds.min.x}, ${this.session.bounds.min.y}, ${this.session.bounds.min.z}) through ` +
              `(${this.session.bounds.max.x}, ${this.session.bounds.max.y}, ${this.session.bounds.max.z}).`
            : 'Stage bounds were not supplied; coordinate actions will remain disabled.';
        const partner = this.getPartnerName();
        const roleSequence = this.session.gems?.length ? 'Collect observed gems assigned to your role or any. Open blocked routes using observed switches assigned to your role or any; do not wait on an unspecified plate. Prioritize gems before the final exit.' : this.role === 'wade'
            ? 'When Ember is holding a plate and you can see a lever or button, activate one switch before going to your exit. Ember may have no path until you do this.'
            : 'Hold the pressure plate until Wade reports that the switch is activated. Only then leave the plate for your exit; if the exit path reports no path, return to the plate and report the blocker.';
        return [
            `Clear Firewater stage "${this.session.stage}" with ${partner}.`,
            `Current attempt: ${this.session.attempt}. Server goal: ${this.session.goal}`,
            `Stage brief: ${this.session.brief}`,
            `You are ${this.role === 'wade' ? 'Wade' : 'Ember'}: ${safeLiquid} is safe; ${lethalLiquid} and poison are lethal.`,
            `Treat these stage blocks as poison: ${poison}.`,
            bounds,
            roleSequence,
            `Reach and hold the ${exit} while ${partner} holds their matching exit for ${this.session.holdTicks} server ticks.`,
            `After required gems are collected and route devices are complete, your final destination is the observed ${exitMaterial.replaceAll('_', ' ')} block.`,
            'Use !observeFirewater before coordinate actions, then use !collectGemAt for your registered gems, !activateBlockAt for allowed levers/buttons, or !standOnBlock for allowed plates/your exit with exact recently observed coordinates.',
            'If a still-needed plate, lever, button, gem, exit, or relevant wall/opening is not visible, do not repeat observation from the same place. Use !exploreFirewater(8), then !observeFirewater from the new viewpoint; the command prioritizes observed own gems, allowed devices, and your safe liquid before other unvisited viewpoints. If a registered own gem is visible, use !collectGemAt instead of continuing blind exploration.',
            `Do not ask ${partner} where a target is at the beginning. First explore and observe at least ${FIREWATER_EXPLORATIONS_BEFORE_INTEL} distinct new viewpoints. Only after that may either bot use !startConversation to request a still-missing target or proactively report a target the partner likely needs.`,
            'An intelligence request must say what you still need, what useful objects/routes you saw, and which areas you already searched. The reply must state whether the target is visible or last seen, give direction/observed coordinates when available, and divide the remaining search area. Partner coordinates are clues only; re-observe yourself before any coordinate action.',
            'After a device opens a route, do not toggle another device unless the route is still blocked or a new failure requires replanning.',
            'Preserve puzzle blocks, use only legitimate movement/interactions, and coordinate concise next actions.',
            'Never call !endGoal or claim success before the server sends FWG CLEAR.',
        ].join(' ');
    }

    _matchesSession(fields) {
        if (!this.session || fields.stage !== this.session.stage) return false;
        return !fields.session || fields.session === this.session.id;
    }

    _scheduleWadePlanning(reason) {
        if (!this.isConversationLead() || this.planningDelayMs < 0) return;
        const generation = this.generation;
        const stage = this.session.stage;
        const attempt = this.session.attempt;
        const partner = this.getPartnerName();
        this.planningTimer = setTimeout(() => {
            this.planningTimer = null;
            if (generation !== this.generation || !this.isRunning() ||
                this.session?.stage !== stage || this.session?.attempt !== attempt) return;
            if (this.conversationManager.inConversation(partner)) return;

            const message = reason === 'reset'
                ? `Replan stage=${stage} attempt=${attempt}. Failure was ${this.session.lastCause} affecting ${this.session.lastVictim}. ` +
                  'Report one new observation or blocker and propose your next action; I will assign the retry route. Four-message limit.'
                : `Plan stage=${stage} attempt=${attempt}. Goal: ${this.session.goal} Brief: ${this.session.brief} ` +
                  'Report one concrete observation and propose your role-specific next action. Four-message limit.';

            this.conversationManager.startConversation(
                partner,
                message,
                { ...this.getConversationOptions(), firewaterPlanning: true }
            ).catch((error) => {
                console.warn(`${this.agent.name} could not start Firewater planning: ${error.message}`);
            });
        }, this.planningDelayMs);
    }

    _beginPlanningObservation() {
        this.planningReady = false;
        this.planningReadyPromise = new Promise(resolve => {
            this.resolvePlanningReady = resolve;
        });
    }

    _finishPlanningObservation() {
        if (this.planningReady) return;
        this.planningReady = true;
        this.resolvePlanningReady?.();
        this.resolvePlanningReady = null;
    }

    async _observeForPlanning(reason, generation) {
        let observation;
        try {
            if (typeof this.agent.vision_interpreter?.observeFirewater !== 'function') {
                observation = 'FIREWATER_OBSERVATION unavailable: the vision interpreter is not initialized.';
            } else {
                observation = await this.agent.vision_interpreter.observeFirewater();
            }
        } catch (error) {
            observation = `FIREWATER_OBSERVATION failed: ${error.message}`;
        }
        if (generation !== this.generation) return;
        await this._addSystemHistory(
            `${reason === 'reset' ? 'Retry' : 'Initial'} stage observation:\n${observation}`
        );
    }

    _cancelPlanning() {
        if (this.planningTimer) clearTimeout(this.planningTimer);
        this.planningTimer = null;
    }

    _resetExplorationState() {
        this.exploration = {
            visited: [],
            failedTargets: [],
            observedSinceIntel: 0,
            failedSinceIntel: 0,
            pendingObservation: false,
        };
    }

    _rememberViewpoint(position) {
        if (!position) return;
        const point = {
            x: Number(position.x), y: Number(position.y), z: Number(position.z),
        };
        if (!Object.values(point).every(Number.isFinite)) return;
        const duplicate = this.exploration.visited.some(visited => pointDistance(visited, point) < 2);
        if (duplicate) return;
        this.exploration.visited.push(point);
        if (this.exploration.visited.length > MAX_VISITED_VIEWPOINTS) {
            this.exploration.visited.shift();
        }
    }

    async _addSystemHistory(message) {
        await this.agent.history.add('system', message);
        await this.agent.history.save();
    }
}
