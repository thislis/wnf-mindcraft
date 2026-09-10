import pf from 'mineflayer-pathfinder';
import { createRoleAwareMovements } from './firewater_movements.js';

/** Probe loaded terrain before moving; never navigate toward an incomplete path. */
export async function findReachableExplorationTarget(bot, profile, candidates, onFailure) {
    const movements = createRoleAwareMovements(bot, profile);
    const deadline = Date.now() + 4000;
    for (const target of candidates.slice(0, 24)) {
        if (bot.interrupt_code || Date.now() >= deadline) return null;
        const goal = new pf.goals.GoalNear(target.x, target.y, target.z, 2);
        const result = bot.pathfinder.getPathTo(movements, goal, 150);
        if (bot.interrupt_code) return null;
        if (result.status === 'success') return target;
        onFailure(target);
        // Let interrupts and block updates run between bounded path probes.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return null;
}
