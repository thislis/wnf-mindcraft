import { runHumanAction } from './firewater_user_action.js';

// Explicit continuation requests switch control modes; they are not six-action tasks.
export function isFirewaterResumeRequest(message) {
    const text = String(message).trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
    return /^(?:please )?(?:resume(?: (?:the )?(?:game|play|playing|autonomous play))?|continue(?: (?:the )?(?:game|play|playing))?|(?:clear|finish|complete|play) (?:this |the )?game|do your to-?do)(?: please)?$/.test(text) ||
        /^(?:(?:게임|플레이|자율 플레이)(?:을|를)?\s*)?(?:계속(?:해|해줘|해 줘| 진행해| 진행해줘)?|재개(?:해|해줘|해 줘)?|클리어(?:해|해줘|해 줘))$/.test(text);
}

/** Serialize human requests while the server-owned stage goal is paused. */
export class FirewaterHumanControl {
    constructor(session) {
        this.session = session;
        this.queue = Promise.resolve();
        this.request = null;
        this.holding = false;
        this.resumeRequested = false;
    }

    run(source, message, respond) {
        const generation = this.session.generation;
        const turn = this.queue.then(async () => {
            if (!this.session.isRunning() || generation !== this.session.generation) return false;
            const agent = this.session.agent;
            const resume = agent.self_prompter.isActive();
            await agent.self_prompter.pause();
            await agent.self_prompter.waitForLoopStop();
            if (!this.session.isRunning() || generation !== this.session.generation) return false;
            this.request = { source, message };
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
                // A failed human turn must not silently restart unrelated exploration.
                this.holding = true;
                throw error;
            } finally {
                this.request = null;
                if (generation === this.session.generation && this.session.isRunning() &&
                    !this.holding && (resume || this.resumeRequested)) {
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
            'Observe only to locate an unknown target. Report actual movement failures, not safety refusals. Stay after arrival/hold. ' +
            'For a request to clear/continue the whole game, call !resumeFirewater immediately; do not try to finish the stage in this short human turn. Use !waitForInstructions to wait. Reply briefly in ordinary chat.';
    }
}
