package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.MessageDeduplicator;
import com.isttech.firewater.domain.Role;
import com.isttech.firewater.stage.StageDefinition;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.Locale;

public final class BotMessenger {
    private static final int SAFE_TELL_COMMAND_LENGTH = 240;
    private final JavaPlugin plugin;
    private final RoleService roles;
    private final MessageDeduplicator deduplicator = new MessageDeduplicator();

    public BotMessenger(JavaPlugin plugin, RoleService roles) {
        this.plugin = plugin;
        this.roles = roles;
    }

    public void start(StageSession session) {
        sendBothOnce(session.sessionId() + ":start:" + session.attempt(),
            BotProtocol.start(session, roles.name(Role.WADE), roles.name(Role.EMBER)));
    }

    public void reset(StageSession session, String cause, String victim) {
        sendBothOnce(session.sessionId() + ":reset:" + session.attempt(),
            "[FWG:RESET] session=" + session.sessionId() + "; stage=" + session.stage().id() + "; attempt=" + session.attempt()
                + "; cause=" + clean(cause) + "; victim=" + clean(victim));
    }

    public void clear(StageSession session) {
        long seconds = Math.max(0, (System.currentTimeMillis() - session.startedAtMillis()) / 1000);
        sendBothOnce(session.sessionId() + ":clear",
            "[FWG:CLEAR] session=" + session.sessionId() + "; stage=" + session.stage().id()
                + "; attempts=" + session.attempt() + "; time=" + seconds);
    }

    public void abort(StageSession session, String cause) {
        sendBothOnce(session.sessionId() + ":abort",
            "[FWG:ABORT] session=" + session.sessionId() + "; stage=" + session.stage().id() + "; cause=" + clean(cause));
    }

    private void sendBothOnce(String key, String message) {
        if (!deduplicator.shouldSend(key)) return;
        for (Role role : Role.values()) {
            String delivery = deliver(role, message);
            plugin.getLogger().info("event=BOT_MESSAGE_SENT role=" + role.key() + " delivery=" + delivery + " message=" + message);
        }
    }

    private String deliver(Role role, String message) {
        if (message.length() <= SAFE_TELL_COMMAND_LENGTH) {
            try {
                if (Bukkit.dispatchCommand(Bukkit.getConsoleSender(),
                    "minecraft:tell " + roles.name(role) + " " + message)) return "minecraft:tell";
            } catch (RuntimeException exception) {
                plugin.getLogger().warning("minecraft:tell failed for " + roles.name(role)
                    + "; using an incoming-whisper component: " + exception.getMessage());
            }
        }

        Player player = roles.online(role);
        if (player == null) return "unavailable";
        try {
            // Keep the vanilla incoming-whisper translation key so Mineflayer's
            // messagestr fallback can authenticate and parse long FWG payloads.
            player.sendMessage(Component.translatable(
                "commands.message.display.incoming",
                Component.text("Server"),
                Component.text(message)));
            return "component-whisper";
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Could not deliver Firewater message to " + roles.name(role)
                + ": " + exception.getMessage());
            return "failed";
        }
    }

    private static String clean(String value) {
        return value.replace('\n', ' ').replace('\r', ' ').replace(';', ',').strip();
    }
}
