import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

export function parseTargetContracts(fields) {
    const interactions = fields['interaction-roles'] === undefined ? null : [];
    for (const row of String(fields['interaction-roles'] || '').split('|').filter(Boolean)) {
        const [x, y, z, role] = row.split(',');
        if ([x, y, z].every(v => v !== '' && Number.isInteger(Number(v))) && ['any', 'wade', 'ember'].includes(role))
            interactions.push({ position: { x: +x, y: +y, z: +z }, role });
    }
    const gems = [];
    for (const row of String(fields.gems || '').split('|').filter(Boolean)) {
        const [x, y, z, name, role, offsetY, radius] = row.split(',');
        if (![x, y, z].every(v => v !== '' && Number.isInteger(Number(v))) ||
            !/^[a-z_]+$/.test(name) || !['any', 'wade', 'ember'].includes(role) ||
            !Number.isFinite(+offsetY) || Math.abs(+offsetY) > 2 || !Number.isFinite(+radius) || +radius <= 0.5 || +radius > 4) continue;
        gems.push({ position: { x: +x, y: +y, z: +z }, name, role, offsetY: +offsetY, radius: +radius });
    }
    return { interactions, gems };
}

export function targetPriority(target, role) {
    const allowed = target.role === 'any' || target.role === role;
    if (target.kind === 'gem' && allowed) return 0;
    if (['activator', 'pressure_plate'].includes(target.kind) && allowed && !target.powered) return 1;
    if (target.name === (role === 'wade' ? 'water' : 'lava')) return 2;
    return 3;
}

export class GoalCollectGem extends pf.goals.Goal {
    constructor(target) {
        super();
        this.center = new Vec3(target.position.x + 0.5, target.position.y + target.offsetY, target.position.z + 0.5);
        this.radius = target.radius;
    }
    heuristic(node) {
        return Math.max(0, this.center.distanceTo(new Vec3(node.x + 0.5, node.y, node.z + 0.5)) - this.radius + 0.35);
    }
    isEnd(node) {
        return this.center.distanceTo(new Vec3(node.x + 0.5, node.y, node.z + 0.5)) <= this.radius - 0.35;
    }
}

/** Approach without breaking anything and wait for the server to remove the gem. */
export async function collectObservedGem(agent, target, navigate) {
    const bot = agent.bot;
    const goal = new GoalCollectGem(target);
    const generation = agent.firewater.generation;
    const active = () => !bot.interrupt_code && agent.firewater.isRunning() && agent.firewater.generation === generation;
    const position = new Vec3(target.position.x, target.position.y, target.position.z);
    if (!active()) return 'Gem collection interrupted.';
    try { await navigate(bot, goal); }
    catch (error) { return `No safe route to this gem: ${error.message}. Explore a new viewpoint before retrying.`; }
    if (!active()) return 'Gem collection interrupted.';
    if (bot.entity.position.distanceTo(goal.center) > goal.radius)
        return 'Stopped outside the gem collection radius. Re-observe and find a closer safe approach.';
    for (let tick = 0; tick < 20; tick++) {
        if (!active()) return 'Gem collection interrupted.';
        const block = bot.blockAt(position);
        if (block?.name === 'air') {
            agent.vision_interpreter.clearFirewaterObservations();
            return `Server removed the collected ${target.name} gem at (${position.x}, ${position.y}, ${position.z}). Re-observe for the next target.`;
        }
        if (!block || block.name !== target.name) return 'Gem state changed unexpectedly. Re-observe before continuing.';
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return 'Reached the gem but the server did not confirm collection. Check the active stage and assigned role; do not claim it was collected.';
}
