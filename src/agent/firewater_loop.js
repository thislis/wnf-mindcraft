const movementCommands = new Set(['!exploreFirewater', '!traverseFirewater', '!collectGemAt', '!activateBlockAt', '!goToPlayer', '!standOnBlock']);
const positionKey = p => `${p.x},${p.y},${p.z}`;
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;

/** Stage-local evidence and progress, independent of conversational summaries. */
export class FirewaterLoop {
    constructor() { this.reset(); }

    reset() {
        this.needsObservation = false;
        this.lastResult = '';
        this.failures = new Map();
        this.hold = null;
        this.targets = new Map();
        this.completedRoutes = new Set();
        this.plan = null;
        this.regroupAttempt = null;
        this.revision = 0;
        this.observation = null;
        this.inspection = null;
        this.pendingExploration = false;
        this.stalledExplorations = 0;
        this.blockedCommands = 0;
        this.waiting = false;
        this.reported = false;
    }

    wake() {
        this.waiting = false;
        this.reported = false;
        this.blockedCommands = 0;
    }

    targetKey(command, args) { return command === '!traverseFirewater' ? `${command}:${args[0]},${args[2]}` : `${command}:${args.join(',')}`; }

    availableRoutes(position) {
        return [...this.targets.values()].filter(t => t.kind === 'route' && t.fresh &&
            !this.completedRoutes.has(`${t.position.x},${t.position.z}`) &&
            !this.failedApproach('!traverseFirewater', [t.position.x, t.position.y, t.position.z], position));
    }

    failedApproach(command, args, position) {
        const failure = this.failures.get(this.targetKey(command, args));
        return failure && distance(position, failure) < 3;
    }

    beforeCommand(command, args, position, now = Date.now()) {
        if (this.hold && movementCommands.has(command))
            return 'Holding a plate/exit for the current plan. Release only after the dependent action finishes.';
        if (this.failedApproach(command, args, position))
            return 'This approach already failed. Find a different approach, open a route, or request help before retrying.';
        if (command === '!observeFirewater' && this.observation && !this.needsObservation &&
            distance(position, this.observation.position) < 1 && now - this.observation.at < 25_000)
            return 'Current coordinates are already fresh. Choose a target or ask for help; another observation adds no evidence.';
        if (command === '!inspectFirewater' && this.inspection &&
            distance(position, this.inspection.position) < 1.5 && this.inspection.revision === this.revision)
            return 'This viewpoint was already inspected. Approach a specific route or ask for help instead of repeating the images.';
        if (command === '!exploreFirewater') {
            const route = this.availableRoutes(position)[0];
            if (route && this.observation && now - this.observation.at < 25_000) {
                const p = route.position;
                return `A visible route is available. Use !traverseFirewater(${p.x}, ${p.y}, ${p.z}) before blind exploration.`;
            }
            if (this.stalledExplorations >= 2)
                return 'Two explorations added no useful target, route or device change. Inspect a specific obstacle, act on a known target, or ask the partner for help.';
        }
        return null;
    }

    recordBlocked(reason) {
        this.lastResult = reason;
        if (++this.blockedCommands >= 3) this.waiting = true;
    }

    recordObservation(targets, position, { now = Date.now(), visual = false, removed = [] } = {}) {
        let usefulChange = false;
        for (const target of this.targets.values()) target.fresh = false;
        for (const key of removed) {
            if (this.targets.delete(key)) usefulChange = true;
        }
        for (const target of targets.filter(t => t.kind !== 'hazard')) {
            const key = positionKey(target.position);
            const previous = this.targets.get(key);
            if (!previous || previous.name !== target.name || previous.powered !== target.powered ||
                JSON.stringify(previous.occupants || []) !== JSON.stringify(target.occupants || [])) usefulChange = true;
            this.targets.set(key, { ...target, fresh: true });
        }
        if (usefulChange) {
            this.revision++;
            this.stalledExplorations = 0;
            this.wake();
        } else if (this.pendingExploration) this.stalledExplorations++;
        this.pendingExploration = false;
        this.observation = { at: now, position: { ...position } };
        if (visual) this.inspection = { position: { ...position }, revision: this.revision };
        this.needsObservation = false;
        return usefulChange;
    }

    recordResult(command, args, result, position) {
        if (!result) return;
        // Preserve action evidence across redundant sensing commands.
        if (!['!observeFirewater', '!inspectFirewater'].includes(command))
            this.lastResult = `${command}: ${String(result).slice(-450)}`;
        const targeted = ['!traverseFirewater', '!collectGemAt', '!activateBlockAt', '!standOnBlock', '!goToPlayer'].includes(command);
        if (targeted && /ladder (?:movement failed|ascent|traversal failed)|navigation stalled|passage (?:planning failed|path not found|movement failed|arrival unconfirmed|geometry changed)|Movement to .* failed|no safe route|could not reach|outside the gem|did not confirm|no path|pathfinding|timed out|Code threw exception/i.test(result) && position) {
            this.failures.set(this.targetKey(command, args), { ...position });
            if (this.failures.size > 32) this.failures.delete(this.failures.keys().next().value);
        }
        if (command === '!exploreFirewater') this.pendingExploration = true;
        if (movementCommands.has(command)) this.needsObservation = true;
    }

    routeChanged() {
        this.revision++;
        this.failures.clear();
        this.needsObservation = true;
        this.stalledExplorations = 0;
        this.wake();
    }

    helpMessage() {
        if (this.plan?.phase === 'blocked')
            return `I could not reach the landing of the route at (${this.plan.target}). Please keep its supporting passage open or show me another approach.`;
        if (this.stalledExplorations >= 2)
            return 'I checked two more viewpoints without finding a useful target or opening. Can you point out the next route?';
        return 'I have not made progress from this view. Please show me the next route or tell me which device you need me to operate.';
    }

    getPrompt() {
        const known = [...this.targets.values()].filter(t => t.kind !== 'hazard').slice(-16);
        return [
            'CURRENT LOOP STATE (current evidence overrides old narrative memory):',
            this.hold ? `Hold: ${this.hold}. Keep position until released.` : 'No active position hold.',
            this.plan ? `Route task: ${JSON.stringify(this.plan)}` : '',
            this.lastResult || 'No action result yet.',
            `Explorations without useful evidence: ${this.stalledExplorations}.`,
            this.failures.size ? `Failed approaches: ${[...this.failures.keys()].slice(-6).join('; ')}` : '',
            this.waiting ? 'Waiting for changed conditions or partner guidance; do not repeat the blocked commands.' : '',
            ...known.map(t => `${t.fresh ? 'Visible' : 'Remembered (re-observe)'} ${t.kind} ${t.name} (${positionKey(t.position)})` +
                `${t.role ? ` role=${t.role}` : ''}${t.powered !== undefined ? ` powered=${t.powered}` : ''}` +
                `${t.occupants?.length ? ` held by ${t.occupants.join(',')}; use the route while they hold` : ''}`),
        ].filter(Boolean).join('\n');
    }
}

/** Stop waiting on obsolete model output; late results cannot execute actions. */
export function waitForFirewaterResponse(task, interrupted, timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
        const finish = (callback, value) => {
            clearInterval(poll);
            clearTimeout(timer);
            callback(value);
        };
        const poll = setInterval(() => {
            if (interrupted()) finish(resolve, '');
        }, 50);
        const timer = setTimeout(() => finish(reject, new Error('Firewater model response timed out.')), timeoutMs);
        Promise.resolve(task).then(value => finish(resolve, interrupted() ? '' : value), error => finish(reject, error));
    });
}
