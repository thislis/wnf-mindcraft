package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class StageRepository {
    private final File stagesDirectory;
    private final Logger logger;
    private final List<String> defaultPoisonMaterials;
    private final Map<String, StageDefinition> stages = new LinkedHashMap<>();

    public StageRepository(File dataFolder, Logger logger, List<String> defaultPoisonMaterials) {
        this.stagesDirectory = new File(dataFolder, "stages");
        this.logger = logger;
        this.defaultPoisonMaterials = List.copyOf(defaultPoisonMaterials);
    }

    public void reload() {
        stages.clear();
        if (!stagesDirectory.exists() && !stagesDirectory.mkdirs()) {
            throw new IllegalStateException("Could not create " + stagesDirectory);
        }
        File[] files = stagesDirectory.listFiles((directory, name) -> name.toLowerCase(Locale.ROOT).endsWith(".yml"));
        if (files == null) return;
        for (File file : files) {
            try {
                StageDefinition stage = load(file);
                StageDefinition previous = stages.putIfAbsent(stage.id(), stage);
                if (previous != null) throw new IllegalArgumentException("duplicate stage id " + stage.id());
            } catch (RuntimeException exception) {
                logger.log(Level.SEVERE, "Could not load Firewater stage " + file.getName(), exception);
            }
        }
    }

    public Optional<StageDefinition> find(String id) {
        return Optional.ofNullable(stages.get(id.toLowerCase(Locale.ROOT)));
    }

    public Collection<StageDefinition> all() {
        return Collections.unmodifiableCollection(stages.values());
    }

    public StageDefinition create(String id, String world) throws IOException {
        String normalized = id.toLowerCase(Locale.ROOT);
        if (stages.containsKey(normalized)) throw new IllegalArgumentException("Stage already exists: " + normalized);
        StageDefinition stage = new StageDefinition(normalized, world);
        stage.poisonMaterials().addAll(defaultPoisonMaterials);
        stages.put(normalized, stage);
        try {
            save(stage);
        } catch (IOException exception) {
            stages.remove(normalized);
            throw exception;
        }
        return stage;
    }

    public void save(StageDefinition stage) throws IOException {
        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("schema-version", StageDefinition.SCHEMA_VERSION);
        yaml.set("id", stage.id());
        yaml.set("world", stage.world());
        yaml.set("enabled", stage.enabled());
        yaml.set("goal", stage.goal());
        yaml.set("bot-brief", stage.botBrief());
        if (stage.bounds() != null) {
            yaml.set("bounds.min", positionMap(stage.bounds().min()));
            yaml.set("bounds.max", positionMap(stage.bounds().max()));
        }
        if (stage.startTrigger() != null) yaml.set("start.trigger", triggerMap(stage.startTrigger()));
        for (Role role : Role.values()) {
            StageLocation spawn = stage.spawns().get(role);
            if (spawn != null) yaml.set("start." + role.key(), locationMap(spawn));
        }
        yaml.set("finish.hold-ticks", stage.finishHoldTicks());
        for (Role role : Role.values()) {
            FinishDefinition finish = stage.finishes().get(role);
            if (finish != null) {
                Map<String, Object> map = positionMap(finish.position());
                map.put("material", finish.material());
                yaml.set("finish." + role.key(), map);
            }
        }
        for (Map.Entry<String, WallDefinition> entry : stage.walls().entrySet()) {
            String path = "walls." + entry.getKey();
            WallDefinition wall = entry.getValue();
            yaml.set(path + ".default-visible", wall.defaultVisible());
            List<Map<String, Object>> blocks = new ArrayList<>();
            for (WallBlockSnapshot block : wall.blocks()) {
                Map<String, Object> map = positionMap(block.position());
                map.put("data", block.blockData());
                blocks.add(map);
            }
            yaml.set(path + ".blocks", blocks);
            yaml.set(path + ".triggers", wall.triggers().stream().map(StageRepository::triggerMap).toList());
        }
        yaml.set("hazards.poison-materials", stage.poisonMaterials());

        if (!stagesDirectory.exists() && !stagesDirectory.mkdirs()) {
            throw new IOException("Could not create " + stagesDirectory);
        }
        File destination = new File(stagesDirectory, stage.id() + ".yml");
        File temporary = new File(stagesDirectory, stage.id() + ".yml.tmp");
        yaml.save(temporary);
        try {
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        stages.put(stage.id(), stage);
    }

    public void delete(StageDefinition stage) throws IOException {
        File destination = new File(stagesDirectory, stage.id() + ".yml");
        if (destination.exists() && !Files.deleteIfExists(destination.toPath())) {
            throw new IOException("Could not delete " + destination);
        }
        stages.remove(stage.id(), stage);
    }

    private StageDefinition load(File file) {
        YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);
        int schema = yaml.getInt("schema-version", -1);
        if (schema != StageDefinition.SCHEMA_VERSION) {
            throw new IllegalArgumentException("unsupported schema-version " + schema);
        }
        String id = requiredString(yaml, "id").toLowerCase(Locale.ROOT);
        StageDefinition stage = new StageDefinition(id, requiredString(yaml, "world"));
        stage.setEnabled(yaml.getBoolean("enabled", false));
        stage.setGoal(yaml.getString("goal", ""));
        stage.setBotBrief(yaml.getString("bot-brief", ""));

        if (yaml.isConfigurationSection("bounds.min") && yaml.isConfigurationSection("bounds.max")) {
            stage.setBounds(new StageBounds(readPosition(yaml.getConfigurationSection("bounds.min")),
                readPosition(yaml.getConfigurationSection("bounds.max"))));
        }
        if (yaml.isConfigurationSection("start.trigger")) {
            stage.setStartTrigger(readTrigger(yaml.getConfigurationSection("start.trigger")));
        }
        for (Role role : Role.values()) {
            ConfigurationSection spawn = yaml.getConfigurationSection("start." + role.key());
            if (spawn != null) stage.spawns().put(role, readLocation(spawn));
            ConfigurationSection finish = yaml.getConfigurationSection("finish." + role.key());
            if (finish != null) {
                stage.finishes().put(role, new FinishDefinition(readPosition(finish), requiredString(finish, "material")));
            }
        }
        stage.setFinishHoldTicks(yaml.getInt("finish.hold-ticks", 10));

        ConfigurationSection wallsSection = yaml.getConfigurationSection("walls");
        if (wallsSection != null) {
            for (String wallId : wallsSection.getKeys(false)) {
                ConfigurationSection wallSection = wallsSection.getConfigurationSection(wallId);
                if (wallSection == null) continue;
                WallDefinition wall = new WallDefinition(wallSection.getBoolean("default-visible", true));
                for (Map<?, ?> raw : wallSection.getMapList("blocks")) {
                    Map<String, Object> map = stringKeyMap(raw);
                    wall.blocks().add(new WallBlockSnapshot(readPosition(map), requiredString(map, "data")));
                }
                for (Map<?, ?> raw : wallSection.getMapList("triggers")) {
                    Map<String, Object> map = stringKeyMap(raw);
                    wall.triggers().add(new TriggerDefinition(TriggerType.parse(requiredString(map, "type")), readPosition(map)));
                }
                stage.walls().put(wallId, wall);
            }
        }
        stage.poisonMaterials().addAll(yaml.getStringList("hazards.poison-materials"));
        if (stage.poisonMaterials().isEmpty()) stage.poisonMaterials().addAll(defaultPoisonMaterials);
        return stage;
    }

    private static Map<String, Object> stringKeyMap(Map<?, ?> raw) {
        Map<String, Object> result = new LinkedHashMap<>();
        raw.forEach((key, value) -> result.put(String.valueOf(key), value));
        return result;
    }

    private static StageLocation readLocation(ConfigurationSection section) {
        return new StageLocation(requiredDouble(section, "x"), requiredDouble(section, "y"), requiredDouble(section, "z"),
            (float) section.getDouble("yaw", 0), (float) section.getDouble("pitch", 0));
    }

    private static TriggerDefinition readTrigger(ConfigurationSection section) {
        return new TriggerDefinition(TriggerType.parse(requiredString(section, "type")), readPosition(section));
    }

    private static BlockPosition readPosition(ConfigurationSection section) {
        return new BlockPosition(requiredInt(section, "x"), requiredInt(section, "y"), requiredInt(section, "z"));
    }

    private static BlockPosition readPosition(Map<String, Object> map) {
        return new BlockPosition(requiredInt(map, "x"), requiredInt(map, "y"), requiredInt(map, "z"));
    }

    private static Map<String, Object> positionMap(BlockPosition position) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("x", position.x());
        map.put("y", position.y());
        map.put("z", position.z());
        return map;
    }

    private static Map<String, Object> locationMap(StageLocation location) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("x", location.x());
        map.put("y", location.y());
        map.put("z", location.z());
        map.put("yaw", location.yaw());
        map.put("pitch", location.pitch());
        return map;
    }

    private static Map<String, Object> triggerMap(TriggerDefinition trigger) {
        Map<String, Object> map = positionMap(trigger.position());
        map.put("type", trigger.type().key());
        return map;
    }

    private static String requiredString(ConfigurationSection section, String path) {
        String value = section.getString(path);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("missing " + section.getCurrentPath() + "." + path);
        return value;
    }

    private static String requiredString(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (value == null || String.valueOf(value).isBlank()) throw new IllegalArgumentException("missing " + key);
        return String.valueOf(value);
    }

    private static int requiredInt(ConfigurationSection section, String path) {
        if (!section.isInt(path)) throw new IllegalArgumentException("missing integer " + section.getCurrentPath() + "." + path);
        return section.getInt(path);
    }

    private static int requiredInt(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof Number number)) throw new IllegalArgumentException("missing integer " + key);
        return number.intValue();
    }

    private static double requiredDouble(ConfigurationSection section, String path) {
        if (!section.isSet(path)) throw new IllegalArgumentException("missing number " + section.getCurrentPath() + "." + path);
        return section.getDouble(path);
    }
}
