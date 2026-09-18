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
            this.resumeRequested = false;
            try {
                return await respond();
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
            'Handle this request before autonomous gem collection or exploration. The stage goal is paused. ' +
            `For "come here", use !goToPlayer("${source}", 2) immediately; player positions come from the loaded world, so no puzzle observation is needed first. ` +
            'For "come here and stand on this plate", approach the speaker, observe, then stand on the freshly observed allowed plate nearest the speaker. ' +
            'If the target is ambiguous, ask one short clarification in ordinary chat. Do not use bot conversation commands for a human. ' +
            'Honor game bounds, role hazards, and observed-device permissions. If blocked, explain the actual blocker; do not substitute unrelated exploration. ' +
            'After arriving or standing, stay there until the player gives another instruction. Use !waitForInstructions for a request to wait/stop, ' +
            'and !resumeFirewater only when the human asks to resume autonomous play. After fulfilling the request, give a short result without another command.';
    }
}
