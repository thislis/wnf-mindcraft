import pf from 'mineflayer-pathfinder';
import agentSettings from '../settings.js';

export const FIREWATER_ROLES = Object.freeze({
    WADE: 'wade',
    EMBER: 'ember',
});

export const FIREWATER_POISON_MATERIALS = Object.freeze([
    'lime_carpet',
    'green_stained_glass',
    'green_concrete',
]);

// Exclusion callbacks are additive path costs, not hard barriers. A finite
// value lets A* choose poison when every legitimate detour is more expensive.
// Firewater poison and out-of-bounds nodes must never be traversable.
const IMPASSABLE_COST = Number.POSITIVE_INFINITY;
const EMBER_LAVA_COST = 8;

/**
 * Return a supported Firewater role from a Mindcraft profile.
 * Missing or unknown roles deliberately return null so ordinary profiles keep
 * mineflayer-pathfinder's default behaviour.
 */
export function getFirewaterRole(profile=agentSettings.profile) {
    if (typeof profile?.firewater_role !== 'string') return null;

    const role = profile.firewater_role.trim().toLowerCase();
    if (role === FIREWATER_ROLES.WADE || role === FIREWATER_ROLES.EMBER) {
        return role;
    }
    return null;
}

function getBlockId(bot, name) {
    return bot.registry?.blocksByName?.[name]?.id;
}

function addBlockToSet(bot, set, name) {
    const id = getBlockId(bot, name);
    if (id !== undefined) set.add(id);
}

function removeBlockFromSet(bot, set, name) {
    const id = getBlockId(bot, name);
    if (id !== undefined) set.delete(id);
}

/**
 * A step exclusion receives the block at the candidate's feet. For a full
 * block floor that candidate is usually air, so inspect both it and the block
 * directly below it. This covers carpet poison as well as glass/concrete
 * poison floors.
 */
export function isPoisonStep(bot, block, poisonMaterials=FIREWATER_POISON_MATERIALS) {
    if (!block) return false;

    const names = poisonMaterials instanceof Set
        ? poisonMaterials
        : new Set(poisonMaterials);
    if (names.has(block.name)) return true;

    if (!block.position?.offset || typeof bot.blockAt !== 'function') return false;
    const floor = bot.blockAt(block.position.offset(0, -1, 0), false);
    return names.has(floor?.name);
}

/**
 * Construct movements for the active Mindcraft profile.
 *
 * Ordinary profiles receive an untouched Movements instance. Wade and Ember
 * cannot dig or create pathfinder scaffolding; they avoid poison and the
 * opposing liquid while retaining a traversable route through their own
 * liquid.
 */
export function createRoleAwareMovements(bot, profile=agentSettings.profile) {
    const movements = new pf.Movements(bot);
    const role = getFirewaterRole(profile);
    if (!role) return movements;

    movements.canDig = false;
    movements.allow1by1towers = false;
    // Pathfinder's parkour generator does not consistently apply step
    // exclusions to the destination floor. Disable it so poison cannot be
    // reached by jumping over the normal step/landing guards.
    movements.allowParkour = false;

    // The repository's pathfinder patch normally toggles lava avoidance from
    // the bot's current position before every search. Firewater roles are
    // fixed by the game contract, so that dynamic hook must not overwrite the
    // role-specific set below (notably before Ember enters lava).
    movements.updateLavaAvoidance = undefined;

    // With no scaffolding items every path node starts with zero placeable
    // blocks. The exclusion is a second guard for future pathfinder changes.
    movements.scafoldingBlocks = [];
    movements.exclusionAreasPlace.push(() => IMPASSABLE_COST);

    const configuredPoison = Array.isArray(profile.firewater_active_poison_materials)
        ? profile.firewater_active_poison_materials
            .map(name => String(name).trim().toLowerCase().replace(/^minecraft:/, ''))
            .filter(Boolean)
        : FIREWATER_POISON_MATERIALS;
    const poisonMaterials = new Set(configuredPoison);
    movements.exclusionAreasStep.push((block) => (
        isPoisonStep(bot, block, poisonMaterials) ? IMPASSABLE_COST : 0
    ));
    const bounds = profile.firewater_active_bounds;
    if (bounds?.min && bounds?.max) {
        movements.exclusionAreasStep.push((block) => {
            const position = block?.position;
            if (!position) return IMPASSABLE_COST;
            const outside = position.x < bounds.min.x || position.x > bounds.max.x ||
                position.y < bounds.min.y || position.y > bounds.max.y + 1 ||
                position.z < bounds.min.z || position.z > bounds.max.z;
            return outside ? IMPASSABLE_COST : 0;
        });
    }

    // mineflayer-pathfinder does not apply exclusionAreasStep to the final
    // landing block of a multi-block drop. Reject poison landings explicitly
    // so a route cannot jump over the normal step-cost check.
    const getLandingBlock = movements.getLandingBlock.bind(movements);
    movements.getLandingBlock = (node, direction) => {
        const landing = getLandingBlock(node, direction);
        if (landing && movements.exclusionStep(landing) >= IMPASSABLE_COST) {
            return null;
        }
        return landing;
    };

    if (role === FIREWATER_ROLES.WADE) {
        removeBlockFromSet(bot, movements.blocksToAvoid, 'water');
        addBlockToSet(bot, movements.blocksToAvoid, 'lava');
    } else {
        removeBlockFromSet(bot, movements.blocksToAvoid, 'lava');
        addBlockToSet(bot, movements.blocksToAvoid, 'water');
        addBlockToSet(bot, movements.blocksToAvoid, 'bubble_column');
        movements.liquidCost = Math.max(movements.liquidCost, EMBER_LAVA_COST);
    }

    return movements;
}
