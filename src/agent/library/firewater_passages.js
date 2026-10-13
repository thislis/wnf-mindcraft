import { Vec3 } from 'vec3';

const air = block => ['air', 'cave_air', 'void_air'].includes(block?.name);
const within = (p, bounds) => !bounds || ['x', 'y', 'z'].every(a => p[a] >= bounds.min[a] && p[a] <= bounds.max[a]);

/** Geometric support, without role/hazard policy. Never scan through a solid floor. */
export function passageFoot(bot, position, bounds) {
    let feet = new Vec3(position.x, position.y, position.z);
    for (let depth = 0; depth <= 32 && within(feet, bounds); depth++, feet = feet.offset(0, -1, 0)) {
        const block = bot.blockAt(feet);
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!block || !below || !air(block)) return null;
        if (below.boundingBox === 'block')
            return bot.blockAt(feet.offset(0, 1, 0))?.boundingBox === 'empty' ? feet : null;
        if (!air(below)) return null;
    }
    return null;
}

export function hasPassageSupport(bot, p) {
    return bot.blockAt(p)?.boundingBox === 'empty' &&
        bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' &&
        bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block';
}

/** Build destinations beyond the doorway at their own floor height, including steps. */
export function passagePlan(bot, position, bounds) {
    const entrance = passageFoot(bot, position, bounds);
    if (!entrance) return { entrance: null, destinations: [], reason: 'No loaded floor with headroom was found below the opening marker.' };
    const delta = entrance.offset(0.5, 0, 0.5).minus(bot.entity.position);
    // A doorway's wall frame is a stronger direction cue than the bot's lateral offset.
    const framed = axis => [-1, 1].every(sign => {
        for (let n = 1; n <= 4; n++) {
            const p = entrance.offset(axis === 'x' ? sign * n : 0, 0, axis === 'z' ? sign * n : 0);
            if (bot.blockAt(p)?.boundingBox === 'block' || bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'block') return true;
        }
        return false;
    });
    const frameX = framed('x'), frameZ = framed('z');
    const axes = frameX !== frameZ ? [frameX ? 'z' : 'x']
        : Math.abs(delta.x) >= Math.abs(delta.z) ? ['x', 'z'] : ['z', 'x'];
    const destinations = [];
    for (const axis of axes) {
        const facing = axis === 'x' ? -Math.sin(bot.entity.yaw || 0) : -Math.cos(bot.entity.yaw || 0);
        const direction = Math.sign(delta[axis]) || Math.sign(facing) || 1;
        const dx = axis === 'x' ? direction : 0;
        const dz = axis === 'z' ? direction : 0;
        let previous = entrance;
        const line = [];
        for (let distance = 1; distance <= 3; distance++) {
            const next = [0, 1, -1, -2, -3].map(dy => previous.offset(dx, dy, dz))
                .find(p => within(p, bounds) && hasPassageSupport(bot, p));
            if (!next) break;
            line.push(next);
            previous = next;
        }
        destinations.push(...line.reverse());
    }
    return { entrance, destinations, reason: destinations.length ? null : 'The opening floor is loaded, but no supported destination beyond it was found.' };
}
