import settings from './settings.js';
import { containsCommand } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';

class Conversation {
    constructor(name, manager) {
        this.name = name;
        this.manager = manager;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.id = null;
        this.message_count = 0;
        this.max_messages = null;
    }

    reset(options = {}) {
        if (this.inMessageTimer) clearTimeout(this.inMessageTimer);
        this.active = false;
        this.ignore_until_start = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.id = options.id || null;
        this.message_count = 0;
        this.max_messages = _normalizeMessageLimit(options.maxMessages);
    }

    end() {
        const agent = this.manager.agent;
        if (this.inMessageTimer) clearTimeout(this.inMessageTimer);
        this.active = false;
        this.ignore_until_start = true;
        this.inMessageTimer = null;
        const full_message = _compileInMessages(this);
        if (full_message.message.trim().length > 0)
            agent.history.add(this.name, full_message.message);
        // add the full queued messages to history, but don't respond

        if (agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

const WAIT_TIME_START = 30000;
const FAST_RESPONSE_DELAY = 200;
const LONG_RESPONSE_DELAY = 5000;
const SELF_PROMPT_RESUME_DELAY = 5000;
const talkOverActions = ['stay', 'followPlayer', 'mode:']; // all mode actions

export class ConversationManager {
    constructor(sendBotChat = sendBotChatToServer, options = {}) {
        this.agent = null;
        this.agent_names = [];
        this.agents_in_game = [];
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.response_timeout_ms = options.responseTimeoutMs ?? WAIT_TIME_START;
        this.monitor_interval_ms = options.monitorIntervalMs ?? 1000;
        this.wait_time_limit = this.response_timeout_ms;
        this.sendBotChat = sendBotChat;
        this.fast_response_delay = options.fastResponseDelay ?? FAST_RESPONSE_DELAY;
        this.long_response_delay = options.longResponseDelay ?? LONG_RESPONSE_DELAY;
        this.self_prompt_resume_delay = options.selfPromptResumeDelay ?? SELF_PROMPT_RESUME_DELAY;
    }

    initAgent(a) {
        this.agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name, this);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && this.agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    if (this._isActiveFirewaterExchange()) {
                        this._closeTimedOutFirewaterExchange(convo_partner);
                        return;
                    }
                    this.agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`);
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = this.response_timeout_ms;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!this.agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        this.agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`);
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, this.monitor_interval_ms);
    }

    _isActiveFirewaterExchange() {
        return this.agent.firewater?.isRunning() &&
            this.activeConversation?.id?.startsWith('fwg:');
    }

    _closeTimedOutFirewaterExchange(convoPartner) {
        const convo = this.activeConversation;
        if (!convo || convo.name !== convoPartner) return;
        const terminalMessage = `Firewater planning timed out. Resume the stage goal. !endConversation("${convoPartner}")`;
        this.sendToBot(convoPartner, terminalMessage, false, false);
        this.endConversation(convoPartner);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message, options = {}) {
        if (this.agent.firewater?.isRunning() && !this.agent.firewater.canInitiateConversation(send_to)) {
            console.warn(`${this.agent.name} is not allowed to initiate a Firewater conversation with ${send_to}.`);
            return false;
        }
        const convo = this._getConvo(send_to);
        if (convo.active)
            return false;
        convo.reset(options);
        this.wait_time_limit = this.response_timeout_ms;
        
        if (this.agent.self_prompter.isActive()) {
            if (options.pauseAfterCurrentTurn && this.agent.self_prompter.pauseAfterCurrentTurn) {
                this.agent.self_prompter.pauseAfterCurrentTurn();
            }
            else {
                await this.agent.self_prompter.pause();
            }
        }
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, false);
        return true;
    }

    startConversationFromOtherBot(name, options = {}) {
        const convo = this._getConvo(name);
        convo.id = options.id || convo.id;
        convo.max_messages = _normalizeMessageLimit(options.maxMessages) ?? convo.max_messages;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${this.agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);
        
        if (settings.chat_bot_messages && open_chat)
            this.agent.openChat(`(To ${send_to}) ${message}`);
        
        if (convo.ignore_until_start)
            return false;
        const explicitEnd = message.includes('!endConversation');
        if (convo.max_messages !== null && this.awaiting_response && !start && !explicitEnd) {
            console.warn(`${this.agent.name} cannot send two consecutive messages to ${send_to}.`);
            return false;
        }
        convo.active = true;
        
        let messageIndex = null;
        let reachedLimit = false;
        if (convo.max_messages !== null) {
            messageIndex = convo.message_count + 1;
            convo.message_count = messageIndex;
            reachedLimit = messageIndex >= convo.max_messages;
        }
        const end = explicitEnd || reachedLimit;
        const json = {
            'message': message,
            start,
            end,
            conversation_id: convo.id,
            message_index: messageIndex,
            max_messages: convo.max_messages,
        };

        this.awaiting_response = true;
        this.sendBotChat(send_to, json);
        if (reachedLimit && !explicitEnd) {
            console.log(`${this.agent.name} reached the ${convo.max_messages}-message conversation limit with ${send_to}.`);
            this.endConversation(send_to);
        }
        return true;
    }

    async receiveFromBot(sender, received) {
        const convo = this._getConvo(sender);

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset({
                id: received.conversation_id,
                maxMessages: received.max_messages,
            });
            this.startConversationFromOtherBot(sender, {
                id: received.conversation_id,
                maxMessages: received.max_messages,
            });
        }

        if (received.conversation_id && convo.id && received.conversation_id !== convo.id) {
            console.warn(`${this.agent.name} ignored a stale conversation packet from ${sender}.`);
            return;
        }
        if (received.message_index && Number.isInteger(received.message_index)) {
            const expectedIndex = convo.message_count + 1;
            if (received.message_index !== expectedIndex) {
                console.warn(
                    `${this.agent.name} ignored out-of-order conversation packet ${received.message_index}; expected ${expectedIndex}.`
                );
                return;
            }
            convo.message_count = received.message_index;
        }
        if (convo.max_messages !== null && convo.message_count >= convo.max_messages) {
            received.end = true;
        }

        this._clearMonitorTimeouts();
        convo.queue(received);
        
        // responding to conversation takes priority over self prompting
        if (this.agent.self_prompter.isActive()){
            await this.agent.self_prompter.pause();
        }

        if (this.agent.firewater?.isRunning())
            await this.agent.firewater.waitUntilPlanningReady();
    
        await this._scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return this.agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return this.agents_in_game.some((n) => n === name);
    }
    
    updateAgents(agents) {
        this.agent_names = agents.map(a => a.name);
        this.agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return this.agents_in_game;
    }
    
    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }
    
    endConversation(sender, options = {}) {
        const resume = options.resume !== false;
        if (this.convos[sender]) {
            if (!this.convos[sender].active) return;
            this.convos[sender].end();
            if (this.activeConversation?.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
                if (resume && this.agent.self_prompter.isPaused() && !this.inConversation()) {
                    this._resumeSelfPrompter().catch(error => console.error('Failed to resume self-prompter:', error));
                }
            }
        }
    }
    
    endAllConversations(options = {}) {
        const resume = options.resume !== false;
        for (const sender in this.convos) {
            this.endConversation(sender, { resume: false });
        }
        if (resume && this.agent.self_prompter.isPaused()) {
            this._resumeSelfPrompter().catch(error => console.error('Failed to resume self-prompter:', error));
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }

    async _scheduleProcessInMessage(sender, received, convo) {
        if (convo.inMessageTimer)
            clearTimeout(convo.inMessageTimer);
        let otherAgentBusy = containsCommand(received.message);

        const scheduleResponse = (delay) => convo.inMessageTimer = setTimeout(
            () => this._processInMessageQueue(sender),
            delay
        );

        // A terminal packet must never remain queued behind a long-running action.
        if (received.end) {
            scheduleResponse(this.fast_response_delay);
            return;
        }

        if (!this.agent.isIdle() && otherAgentBusy) {
            // both are busy
            let canTalkOver = talkOverActions.some(a => this.agent.actions.currentActionLabel.includes(a));
            if (canTalkOver)
                scheduleResponse(this.fast_response_delay);
            // otherwise don't respond
        }
        else if (otherAgentBusy)
            // other bot is busy but I'm not
            scheduleResponse(this.long_response_delay);
        else if (!this.agent.isIdle()) {
            // I'm busy but other bot isn't
            let canTalkOver = talkOverActions.some(a => this.agent.actions.currentActionLabel.includes(a));
            if (canTalkOver) {
                scheduleResponse(this.fast_response_delay);
            }
            else {
                let shouldRespond = await this.agent.prompter.promptShouldRespondToBot(received.message);
                console.log(`${this.agent.name} decided to ${shouldRespond?'respond':'not respond'} to ${sender}`);
                if (shouldRespond)
                    scheduleResponse(this.fast_response_delay);
            }
        }
        else {
            // neither are busy
            scheduleResponse(this.fast_response_delay);
        }
    }

    _processInMessageQueue(name) {
        const convo = this._getConvo(name);
        this._handleFullInMessage(name, _compileInMessages(convo)).catch(error => {
            console.error(`Failed to process conversation packet from ${name}:`, error);
        });
    }

    async _handleFullInMessage(sender, received) {
        console.log(`${this.agent.name} responding to "${received.message}" from ${sender}`);

        const convo = this._getConvo(sender);
        convo.active = true;

        let message = _tagMessage(received.message);
        if (received.end) {
            await this.agent.history.add(sender, message);
            this.endConversation(sender);
            return;
        }
        else if (received.start)
            this.agent.shut_up = false;
        convo.inMessageTimer = null;
        await this.agent.handleMessage(sender, message, 1);
    }

    async _resumeSelfPrompter() {
        await new Promise(resolve => setTimeout(resolve, this.self_prompt_resume_delay));
        if (this.agent.self_prompter.isPaused() && !this.inConversation()) {
            this.agent.self_prompter.start();
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

/*
This function controls conversation flow by deciding when the bot responds.
The logic is as follows:
- If neither bot is busy, respond quickly with a small delay.
- If only the other bot is busy, respond with a long delay to allow it to finish short actions (ex check inventory)
- If I'm busy but other bot isn't, let LLM decide whether to respond
- If both bots are busy, don't respond until someone is done, excluding a few actions that allow fast responses
- New messages received during the delay will reset the delay following this logic, and be queued to respond in bulk
*/
function _compileInMessages(convo) {
    let pack = {};
    let full_message = '';
    let start = false;
    let end = false;
    while (convo.in_queue.length > 0) {
        pack = convo.in_queue.shift();
        if (full_message.length > 0) full_message += '\n';
        full_message += pack.message;
        start ||= !!pack.start;
        end ||= !!pack.end;
    }
    pack.message = full_message;
    pack.start = start;
    pack.end = end;
    return pack;
}

function _tagMessage(message) {
    return "(FROM OTHER BOT)" + message;
}

function _normalizeMessageLimit(value) {
    if (value === null || value === undefined) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
