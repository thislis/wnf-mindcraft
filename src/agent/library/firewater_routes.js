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
    const hazards = new Set([...(profile.firewater_active_poison_materials || ['lime_carpet', 'green_concrete', 'green_stained_glass']),
        profile.firewater_role === 'wade' ? 'lava' : 'water', 'bubble_column']);
    return feet && head && floor && feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
        floor.boundingBox === 'block' && ![feet, head, floor].some(b => hazards.has(b.name));
}

/** Derive a landing from the observed route's connected, loaded column only. */
export function routeLandings(bot, target, profile) {
    const bounds = profile.firewater_active_bounds;
    const origin = new Vec3(target.position.x, target.position.y, target.position.z);
    if (!inside(origin, bounds)) return [];
    if (target.routeType === 'opening') {
        const delta = origin.minus(bot.entity.position);
        const step = Math.abs(delta.x) >= Math.abs(delta.z)
            ? new Vec3(Math.sign(delta.x) || 1, 0, 0) : new Vec3(0, 0, Math.sign(delta.z) || 1);
        let landing = origin;
        if (!safeLanding(bot, origin, profile)) return [];
        for (let n = 0; n < 3; n++) {
            const next = landing.plus(step);
            if (!inside(next, bounds) || !safeLanding(bot, next, profile)) break;
            landing = next;
        }
        return landing.equals(origin) ? [] : [landing];
    }
    if (!climbable.has(target.name)) return [];
    let bottom = origin;
    let top = origin;
    for (let n = 0; n < 16 && inside(bottom.offset(0, -1, 0), bounds) && climbable.has(bot.blockAt(bottom.offset(0, -1, 0))?.name); n++) bottom = bottom.offset(0, -1, 0);
    for (let n = 0; n < 16 && inside(top.offset(0, 1, 0), bounds) && climbable.has(bot.blockAt(top.offset(0, 1, 0))?.name); n++) top = top.offset(0, 1, 0);
    const up = bot.entity.position.y < top.y + 0.5;
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
    const landings = routeLandings(bot, target, profile);
    for (const landing of landings) {
        if (!active() || !routeStillExists()) return 'Route changed or traversal interrupted.';
        const goal = new pf.goals.GoalBlock(landing.x, landing.y, landing.z);
        const path = bot.pathfinder.getPathTo(movements, goal, 1000);
        // A route's landing is not permission to bypass an unrelated wall.
        if (path.status !== 'success' || (!bot.entity.position.floored().equals(targetPosition) &&
            !path.path?.some(p => p.x === target.position.x && p.z === target.position.z))) continue;
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
