import { climbHumanRoute } from './firewater_routes.js';
import { isHumanAction } from '../firewater_user_action.js';
import pf from 'mineflayer-pathfinder';

/** Approach a loaded player by a bounded path, without using the cheat helper. */
export async function approachFirewaterPlayer(agent, name, distance, navigate) {
    const session = agent.firewater;
    if (session.humanControl.request) session.humanControl.hold();
    const directed = isHumanAction(agent);
    const bounds = session.session?.bounds;
    if (!session.isRunning() || (!directed && !bounds))
        return 'An active stage with bounds is required to approach a player safely.';
    const player = Object.values(agent.bot.players).find(player =>
        player.username?.toLowerCase() === name.toLowerCase());
    const position = player?.entity?.position?.clone();
    if (!position) return `Cannot locate ${name} nearby. Ask them to come into view or describe the route.`;
    if (!['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) return 'Player position is unavailable.';
    if (!directed && ['x', 'y', 'z'].some(axis => !Number.isFinite(position[axis]) ||
        position[axis] < bounds.min[axis] || position[axis] > bounds.max[axis] + (axis === 'y' ? 1 : 0)))
        return `${name} is outside the active stage. Stay inside the puzzle.`;
    const generation = session.generation;
    const range = Math.max(1, Math.min(3, Number.isFinite(distance) ? distance : 2));
    try {
        const ladder = directed && position.y > agent.bot.entity.position.y + 1.5 ? botHasNearbyLadder(agent.bot) : null;
        if (ladder) {
            const result = await climbHumanRoute(agent, { name: ladder.name, position: ladder.position }, navigate);
            if (!result.startsWith('Climbed ')) return result;
        }
        if (agent.bot.interrupt_code || !session.isRunning() || generation !== session.generation)
            return 'Player approach interrupted.';
        await navigate(agent.bot, new pf.goals.GoalNear(position.x, position.y, position.z, range));
    } catch (error) {
        return directed ? `Movement to ${name} failed: ${error.message}.`
            : `No safe route to ${name}: ${error.message}. Ask them to show an accessible route.`;
    }
    if (agent.bot.interrupt_code || !session.isRunning() || generation !== session.generation)
        return 'Player approach interrupted.';
    const currentPlayer = player.entity?.position;
    if (!currentPlayer || agent.bot.entity.position.distanceTo(currentPlayer) > range + 1)
        return `${name} moved or is still too far away. Recheck their position before claiming arrival.`;
    if (session.humanControl.request) session.humanControl.hold();
    return `Reached ${name}. Stay here for their next instruction; if they requested a plate, observe now and use its allowed coordinates.`;
}

function botHasNearbyLadder(bot) {
    if (!bot.blockAt) return null;
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const block = bot.blockAt(feet.offset(dx, 0, dz));
        if (['ladder', 'vine'].includes(block?.name)) return block;
    }
    return null;
}
