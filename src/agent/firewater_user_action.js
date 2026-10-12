import { AsyncLocalStorage } from 'node:async_hooks';

const userAction = new AsyncLocalStorage();

/** Permission lasts only for this serialized human turn and this stage generation. */
export function runHumanAction(agent, action) {
    return userAction.run({ agent, request: agent.firewater.humanControl.request,
        generation: agent.firewater.generation }, action);
}

export function isHumanAction(agentOrBot) {
    const context = userAction.getStore();
    return !!context && (context.agent === agentOrBot || context.agent.bot === agentOrBot) &&
        !!context.request && context.agent.firewater.humanControl.request === context.request &&
        context.agent.firewater.generation === context.generation && context.agent.firewater.isRunning();
}
