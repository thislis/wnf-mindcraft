package com.isttech.firewater;

import com.isttech.firewater.builder.BuilderSelection;
import com.isttech.firewater.builder.FirewaterCommand;
import com.isttech.firewater.runtime.BotMessenger;
import com.isttech.firewater.runtime.HazardService;
import com.isttech.firewater.runtime.RoleService;
import com.isttech.firewater.runtime.SessionSnapshotStore;
import com.isttech.firewater.runtime.StageManager;
import com.isttech.firewater.runtime.WallService;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.StageRepository;
import org.bukkit.NamespacedKey;
import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.util.List;

public final class FirewaterPlugin extends JavaPlugin {
    private StageManager stageManager;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        ensureExampleStage();

        List<String> defaultPoison = getConfig().getStringList("default-poison-materials");
        RoleService roles = new RoleService(
            getConfig().getString("players.wade", "Wade"),
            getConfig().getString("players.ember", "Ember"));
        StageRepository repository = new StageRepository(getDataFolder(), getLogger(), defaultPoison);
        repository.reload();
        WallService walls = new WallService(this, roles);
        SessionSnapshotStore snapshots = new SessionSnapshotStore(getDataFolder(), getLogger());
        roles.restoreAll();
        try {
            snapshots.recoverIfPresent();
        } catch (Exception exception) {
            throw new IllegalStateException("Firewater crash recovery failed; refusing to enable", exception);
        }
        HazardService hazards = new HazardService();
        BotMessenger messenger = new BotMessenger(this, roles);
        stageManager = new StageManager(this, repository, roles, walls, hazards, messenger, snapshots,
            getConfig().getInt("max-bot-message-length", 240),
            getConfig().getInt("hazard-check-period-ticks", 2));

        BuilderSelection selections = new BuilderSelection();
        NamespacedKey wandKey = new NamespacedKey(this, "builder_wand");
        FirewaterCommand executor = new FirewaterCommand(this, repository, stageManager, walls, selections, wandKey);
        PluginCommand command = requireNonNull(getCommand("fw"), "Command /fw is missing from plugin.yml");
        command.setExecutor(executor);
        command.setTabCompleter(executor);
        getServer().getPluginManager().registerEvents(
            new FirewaterListener(repository, stageManager, roles, selections, wandKey), this);
        getServer().getScheduler().runTaskTimer(this, stageManager::tickSafely, 1L, 1L);

        for (StageDefinition stage : repository.all()) {
            if (!stage.enabled()) continue;
            List<String> errors = stageManager.validate(stage);
            if (!errors.isEmpty()) {
                getLogger().severe("Enabled stage " + stage.id() + " is invalid; defaults were not applied: "
                    + String.join(" | ", errors));
                continue;
            }
            try {
                walls.applyDefaults(stage);
            } catch (RuntimeException exception) {
                getLogger().severe("Could not apply defaults for enabled stage " + stage.id() + ": " + exception.getMessage());
            }
        }
        getLogger().info("FirewaterGame enabled with " + repository.all().size() + " stage definition(s). /fw status: " + stageManager.status());
    }

    @Override
    public void onDisable() {
        if (stageManager != null) stageManager.shutdown();
        getLogger().info("FirewaterGame disabled; participant permissions and stage defaults restored.");
    }

    private void ensureExampleStage() {
        File stages = new File(getDataFolder(), "stages");
        File example = new File(stages, "example.yml");
        if (!example.exists()) saveResource("stages/example.yml", false);
    }

    private static <T> T requireNonNull(T value, String message) {
        if (value == null) throw new IllegalStateException(message);
        return value;
    }
}
