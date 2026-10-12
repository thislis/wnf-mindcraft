import { passagePlan, hasPassageSupport } from './firewater_passages.js';
import { isHumanAction } from '../firewater_user_action.js';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { createRoleAwareMovements } from './firewater_movements.js';

const climbable = new Set(['ladder', 'vine', 'scaffolding']);
const key = p => `${p.x},${p.y},${p.z}`;
const inside = (p, bounds) => bounds && ['x', 'y', 'z'].every(a => p[a] >= bounds.min[a] && p[a] <= bounds.max[a]);

function safeLanding(bot, p, profile) {
    const feet = bot.blockAt(p);
    const head = bot.blockAt(p.offset(0, 1, 0));
    const floor = bot.blockAt(p.offset(0, -1, 0));
    const hazards = new Set(isHumanAction(bot) ? [] : [...(profile.firewater_active_poison_materials || ['lime_carpet', 'green_concrete', 'green_stained_glass']),
        profile.firewater_role === 'wade' ? 'lava' : 'water', 'bubble_column']);
    return feet && head && floor && feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
        floor.boundingBox === 'block' && ![feet, head, floor].some(b => hazards.has(b.name));
}

/** Derive a landing from the observed route's connected, loaded column only. */
export function routeLandings(bot, target, profile, { upward } = {}) {
    const bounds = isHumanAction(bot)
        ? { min: { x: -Infinity, y: bot.game?.minY ?? -64, z: -Infinity }, max: { x: Infinity, y: 319, z: Infinity } }
        : profile.firewater_active_bounds;
    const origin = new Vec3(target.position.x, target.position.y, target.position.z);
    if (!inside(origin, bounds)) return [];
    if (target.routeType === 'opening') return passagePlan(bot, target.position, bounds).destinations;
    if (!climbable.has(target.name)) return [];
    let bottom = origin;
    let top = origin;
    for (let n = 0; n < 16 && inside(bottom.offset(0, -1, 0), bounds) && climbable.has(bot.blockAt(bottom.offset(0, -1, 0))?.name); n++) bottom = bottom.offset(0, -1, 0);
    for (let n = 0; n < 16 && inside(top.offset(0, 1, 0), bounds) && climbable.has(bot.blockAt(top.offset(0, 1, 0))?.name); n++) top = top.offset(0, 1, 0);
    const up = upward ?? bot.entity.position.y < top.y + 0.5;
    const levels = up ? [top.y + 1, top.y] : [bottom.y];
    const landings = [];
    for (const y of levels) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = new Vec3(origin.x + dx, y, origin.z + dz);
        if (inside(p, bounds) && safeLanding(bot, p, profile) &&
            (up ? p.y > bot.entity.position.y + 0.5 : p.y < bot.entity.position.y - 0.5)) landings.push(p);
    }
    return landings;
}

/** Follow an observed route with role-safe pathfinding; never dig or build. */
export async function traverseObservedRoute(agent, target, navigate) {
    const { bot, firewater } = agent;
    if (target.routeType === 'opening') return traversePassage(agent, target, navigate);
    if (isHumanAction(agent) && ['ladder', 'vine'].includes(target.name))
        return climbHumanRoute(agent, target, navigate);
    const generation = firewater.generation;
    const active = () => !bot.interrupt_code && firewater.isRunning() && generation === firewater.generation;
    const profile = agent.prompter.profile;
    const targetPosition = new Vec3(target.position.x, target.position.y, target.position.z);
    const routeStillExists = () => bot.blockAt(targetPosition)?.name === target.name;
    if (!active() || !routeStillExists()) return 'Route changed or traversal interrupted. Re-observe.';
    const helper = [...firewater.loop.targets.values()].find(t => t.kind === 'pressure_plate' && t.powered &&
        t.occupants?.some(name => name !== agent.name));
    firewater.loop.plan = {
        target: key(target.position), phase: 'find landing',
        support: helper ? `${helper.occupants.join(',')} holds (${key(helper.position)}); linkage unconfirmed` : 'none observed',
        completeWhen: 'reach a verified safe landing',
    };
    const movements = createRoleAwareMovements(bot, profile);
    const directed = isHumanAction(agent);
    const landings = routeLandings(bot, target, profile);
    for (const landing of landings) {
        if (!active() || !routeStillExists()) return 'Route changed or traversal interrupted.';
        const goal = new pf.goals.GoalBlock(landing.x, landing.y, landing.z);
        const path = bot.pathfinder.getPathTo(movements, goal, 1000);
        // A route's landing is not permission to bypass an unrelated wall.
        if (!directed && (path.status !== 'success' || (!bot.entity.position.floored().equals(targetPosition) &&
            !path.path?.some(p => p.x === target.position.x && p.z === target.position.z)))) continue;
        firewater.loop.plan.phase = 'traverse';
        try { await navigate(bot, goal); }
        catch (error) {
            if (!active()) return 'Route traversal interrupted.';
            firewater.loop.plan.phase = 'blocked';
            return `No safe route to the landing: ${error.message}. Ask the partner to maintain the passage or inspect its landing.`;
        }
        if (!active()) return 'Route traversal interrupted.';
        if (!routeStillExists() || !goal.isEnd(bot.entity.position.floored()) || !safeLanding(bot, landing, profile)) {
            firewater.loop.plan.phase = 'blocked';
            return 'Could not reach a verified safe landing. The route or supporting device may have changed.';
        }
        for (const t of firewater.loop.targets.values()) {
            if (t.kind === 'route' && t.position.x === target.position.x && t.position.z === target.position.z)
                firewater.loop.completedRoutes.add(`${t.position.x},${t.position.z}`);
        }
        firewater.loop.plan.phase = 'complete';
        firewater.loop.stalledExplorations = 0;
        firewater.loop.wake();
        return `Traversed ${target.name}; verified landing (${key(landing)}). Re-observe the new level and report that the partner may release support if no further crossing needs it.`;
    }
    firewater.loop.plan.phase = 'blocked';
    return 'No safe route to a loaded landing on this passage. Inspect its top/landing or ask the partner to keep the route open; do not repeat blind exploration.';
}

/** Reach the doorway's actual floor first; then cross using the current world. */
async function traversePassage(agent, target, navigate) {
    const { bot, firewater } = agent;
    const generation = firewater.generation;
    const directed = isHumanAction(agent);
    const active = () => !bot.interrupt_code && firewater.isRunning() && generation === firewater.generation;
    const profile = agent.prompter.profile;
    const bounds = directed ? undefined : profile.firewater_active_bounds;
    const plan = passagePlan(bot, target.position, bounds);
    firewater.loop.plan = { target: key(target.position), phase: 'find passage floor',
        completeWhen: 'reach the doorway floor, then a destination beyond it' };
    const fail = (kind, detail) => {
        firewater.loop.plan.phase = 'blocked';
        return `Passage ${kind}: ${detail}`;
    };
    if (!plan.entrance || !plan.destinations.length)
        return fail('planning failed', `${plan.reason} Movement was not attempted; this does not mean the passage is closed or dangerous.`);
    if (!active()) return 'Passage traversal interrupted.';
    const entranceGoal = new pf.goals.GoalBlock(plan.entrance.x, plan.entrance.y, plan.entrance.z);
    try {
        firewater.loop.plan.phase = 'approach passage';
        if (!entranceGoal.isEnd(bot.entity.position.floored())) await navigate(bot, entranceGoal);
    } catch (error) {
        return active() ? fail('movement failed', `Could not reach the entrance floor (${key(plan.entrance)}): ${error.message}`) : 'Passage traversal interrupted.';
    }
    if (!active()) return 'Passage traversal interrupted.';
    if (!entranceGoal.isEnd(bot.entity.position.floored()))
        return fail('arrival unconfirmed', 'The bot did not reach the entrance floor.');
    const movements = createRoleAwareMovements(bot, profile);
    let lastFailure = 'No complete path from the entrance to the candidate destinations.';
    for (const destination of plan.destinations) {
        if (!active()) return 'Passage traversal interrupted.';
        if (!hasPassageSupport(bot, plan.entrance)) return fail('geometry changed', 'The entrance floor or headroom changed during traversal.');
        if (!hasPassageSupport(bot, destination)) continue;
        const goal = new pf.goals.GoalBlock(destination.x, destination.y, destination.z);
        if (!directed) {
            const path = bot.pathfinder.getPathTo(movements, goal, 1000);
            if (path.status !== 'success') { lastFailure = `Path search returned ${path.status} for (${key(destination)}).`; continue; }
        }
        try {
            firewater.loop.plan.phase = 'cross passage';
            await navigate(bot, goal);
        } catch (error) {
            if (!active()) return 'Passage traversal interrupted.';
            return fail('movement failed', `Navigation toward (${key(destination)}) failed: ${error.message}`);
        }
        if (!active()) return 'Passage traversal interrupted.';
        if (!goal.isEnd(bot.entity.position.floored()) || !hasPassageSupport(bot, destination))
            return fail('arrival unconfirmed', `Navigation ended without reaching the current destination (${key(destination)}).`);
        firewater.loop.completedRoutes.add(`${target.position.x},${target.position.z}`);
        firewater.loop.plan.phase = 'complete';
        firewater.loop.stalledExplorations = 0;
        firewater.loop.wake();
        return `Traversed passage; verified arrival (${key(destination)}) through entrance floor (${key(plan.entrance)}). Re-observe from here.`;
    }
    return fail('path not found', lastFailure);
}

/** Human-directed ascent uses the ladder controls, without requiring an upper floor first. */
export async function climbHumanRoute(agent, target, navigate) {
    const { bot, firewater } = agent;
    const generation = firewater.generation;
    const active = () => isHumanAction(agent) && !bot.interrupt_code && firewater.isRunning() && firewater.generation === generation;
    let bottom = new Vec3(target.position.x, target.position.y, target.position.z);
    let top = bottom.clone();
    for (let n = 0; n < 128 && climbable.has(bot.blockAt(bottom.offset(0, -1, 0))?.name); n++) bottom = bottom.offset(0, -1, 0);
    for (let n = 0; n < 128 && climbable.has(bot.blockAt(top.offset(0, 1, 0))?.name); n++) top = top.offset(0, 1, 0);
    if (!active() || !climbable.has(bot.blockAt(bottom)?.name)) return 'Ladder traversal interrupted or ladder missing.';
    const anchor = bottom.offset(0.5, 0, 0.5);
    firewater.loop.plan = { target: key(target.position), phase: 'climb', completeWhen: 'reach the ladder top' };
    try {
        if (Math.hypot(bot.entity.position.x - anchor.x, bot.entity.position.z - anchor.z) > 0.8 || bot.entity.position.y < bottom.y - 0.5)
            await navigate(bot, new pf.goals.GoalBlock(bottom.x, bottom.y, bottom.z));
        if (!active()) return 'Ladder traversal interrupted.';
        const block = bot.blockAt(bottom);
        const facing = block?.getProperties?.()?.facing;
        const supports = { north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0] };
        const direction = supports[facing] || [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([x, z]) =>
            bot.blockAt(bottom.offset(x, 0, z))?.boundingBox === 'block');
        if (!direction) return 'Could not locate the ladder attachment; specify the climbing face.';
        await bot.lookAt(bottom.offset(0.5 + direction[0], 1, 0.5 + direction[1]), true);
        let bestY = bot.entity.position.y;
        let stalled = 0;
        for (let tick = 0; tick < 600; tick++) {
            if (!active() || !climbable.has(bot.blockAt(top)?.name)) return 'Ladder traversal interrupted or ladder changed.';
            if (bot.entity.position.y >= top.y + 0.2) {
                bot.clearControlStates();
                const landing = routeLandings(bot, target, agent.prompter.profile, { upward: true })
                    .find(p => p.y >= top.y);
                if (landing) await navigate(bot, new pf.goals.GoalBlock(landing.x, landing.y, landing.z));
                if (!active()) return 'Ladder traversal interrupted.';
                if (bot.entity.position.y < top.y) return 'The bot slipped below the ladder top; ascent is incomplete.';
                firewater.loop.plan.phase = 'climbed';
                if (firewater.humanControl.request) firewater.humanControl.hold();
                return `Climbed the requested ladder to y=${bot.entity.position.y.toFixed(2)}. Check the next movement from here.`;
            }
            bot.setControlState('sneak', false);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await bot.waitForTicks(1);
            if (bot.entity.position.y > bestY + 0.05) { bestY = bot.entity.position.y; stalled = 0; }
            else if (++stalled >= 60) return 'Ladder ascent made no vertical progress for 3 seconds; a collision or attachment is blocking movement.';
        }
        return 'Ladder ascent exceeded 30 seconds without reaching the top.';
    } catch (error) {
        return `Ladder movement failed: ${error.message}.`;
    } finally {
        bot.clearControlStates();
        if (generation === firewater.generation && firewater.loop.plan?.phase === 'climb') firewater.loop.plan.phase = 'blocked';
    }
}
