import { runHumanAction } from './firewater_user_action.js';

// Explicit continuation requests switch control modes; they are not six-action tasks.
export function isFirewaterResumeRequest(message) {
    const text = String(message).trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
    return /^(?:please )?(?:resume(?: (?:the )?(?:game|play|playing|autonomous play))?|continue(?: (?:the )?(?:game|play|playing))?|(?:clear|finish|complete|play) (?:this |the )?game|do your to-?do)(?: please)?$/.test(text) ||
        /^(?:(?:게임|플레이|자율 플레이)(?:을|를)?\s*)?(?:계속(?:해|해줘|해 줘| 진행해| 진행해줘)?|재개(?:해|해줘|해 줘)?|클리어(?:해|해줘|해 줘))$/.test(text);
}

export function requestsPositionHold(message) {
    if (/don't wait|do not wait|stop waiting|기다리지\s*마|대기하지\s*마/i.test(message)) return false;
    return /(?:\b(?:wait|stay|hold position|stop)\b|기다|대기|움직이지|밟고\s*(?:있|기다)|!stop\b|!waitForInstructions)/i.test(message);
}

/** Serialize human requests while the server-owned stage goal is paused. */
export class FirewaterHumanControl {
    constructor(session) {
        this.session = session;
        this.queue = Promise.resolve();
        this.request = null;
        this.holding = false;
        this.resumeRequested = false;
        this.revision = 0;
        this.turnDone = false;
    }

    run(source, message, respond) {
        const generation = this.session.generation;
        const revision = ++this.revision;
        if (this.request) {
            this.request.cancelled = true;
            this.session.agent.requestInterrupt?.();
            this.session.agent.bot.pathfinder?.setGoal?.(null);
            this.session.agent.bot.clearControlStates?.();
        }
        const turn = this.queue.then(async () => {
            if (revision !== this.revision || !this.session.isRunning() || generation !== this.session.generation) return false;
            const agent = this.session.agent;
            await agent.self_prompter.pause();
            await agent.self_prompter.waitForLoopStop();
            if (revision !== this.revision || !this.session.isRunning() || generation !== this.session.generation) return false;
            this.request = { source, message, revision, holdRequested: requestsPositionHold(message) };
            this.turnDone = false;
            if (this.request.holdRequested) this.holding = true;
            this.session.loop?.wake();
            if (!/don't|do not|하지 마|움직이지 마/i.test(message) &&
                /^(?:please )?(?:come |go to |move to |stand on |climb |press |여기로 와|이리 와|올라가|밟아|눌러)|^!(?:goToPlayer|standOnBlock|traverseFirewater)\(/i.test(message.trim()) && this.session.loop)
                this.session.loop.hold = null;
            this.resumeRequested = false;
            try {
                if (isFirewaterResumeRequest(message)) {
                    this.resume();
                    if (this.session.loop) this.session.loop.needsObservation = true;
                    await agent.history?.add?.(source, message);
                    await agent.routeResponse?.(source, 'Resuming the stage goal.');
                    return true;
                }
                return await runHumanAction(agent, respond);
            } catch (error) {
                if (this.session.loop) this.session.loop.needsObservation = true;
                throw error;
            } finally {
                this.request = null;
                if (revision === this.revision && generation === this.session.generation && this.session.isRunning() &&
                    !this.holding && !this.session.loop?.hold) {
                    if (this.session.loop) this.session.loop.needsObservation = true;
                    agent.self_prompter.start();
                }
            }
        });
        this.queue = turn.catch(() => {});
        return turn;
    }

    hold() {
        this.holding = true;
        this.session.agent.self_prompter.pauseAfterCurrentTurn();
    }

    resume() {
        this.holding = false;
        this.resumeRequested = true;
        if (!this.request) this.session.agent.self_prompter.start();
    }

    getPrompt() {
        if (!this.request) return '';
        const { source, message } = this.request;
        return `HUMAN REQUEST IN PROGRESS from ${source}: ${JSON.stringify(message)}\n` +
            `Handle this before autonomous gem collection or exploration. For an arrival request use !goToPlayer("${source}", 2). ` +
            'Execute the requested action without a safety assessment or permission question: the human chooses in-game risk. ' +
            'Hazards, role restrictions, stage bounds, old holds and failed approaches do not veto this request. ' +
            'Use !goToCoordinates for supplied coordinates and !traverseFirewater for a ladder; climb even without a verified upper landing. ' +
            'Observe to locate an unknown target. Report actual movement failures, not safety refusals. After an ordinary task, finish this reply and continue the stage goal. Only wait when explicitly asked or maintaining a plate/exit. ' +
            'For a request to clear/continue the whole game, call !resumeFirewater immediately; do not try to finish the stage in this short human turn. Use !waitForInstructions to wait. Reply briefly in ordinary chat.';
    }
}
