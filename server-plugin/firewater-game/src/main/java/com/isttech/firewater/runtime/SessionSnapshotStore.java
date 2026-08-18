package com.isttech.firewater.runtime;

import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.TriggerDefinition;
import com.isttech.firewater.stage.WallBlockSnapshot;
import com.isttech.firewater.stage.WallDefinition;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.AnaloguePowerable;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Powerable;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

/**
 * A durable, idempotent rollback journal for wall and trigger state. The file
 * is committed before a session mutates the world and removed only after a
 * normal cleanup succeeds.
 */
public final class SessionSnapshotStore {
    private static final int SCHEMA_VERSION = 1;
    private final File snapshotFile;
    private final File temporaryFile;
    private final Logger logger;

    public SessionSnapshotStore(File dataFolder, Logger logger) {
        this.snapshotFile = new File(dataFolder, "active-session.yml");
        this.temporaryFile = new File(dataFolder, "active-session.yml.tmp");
        this.logger = logger;
    }

    public boolean hasPendingRecovery() {
        return snapshotFile.isFile();
    }

    public void capture(StageSession session) throws IOException {
        if (hasPendingRecovery()) {
            throw new IOException("A pending Firewater recovery journal already exists");
        }
        StageDefinition stage = session.stage();
        World world = Bukkit.getWorld(stage.world());
        if (world == null) throw new IOException("World is not loaded: " + stage.world());

        Map<BlockPosition, String> rollback = new LinkedHashMap<>();
        for (WallDefinition wall : stage.walls().values()) {
            for (WallBlockSnapshot block : wall.blocks()) {
                rollback.put(block.position(), wall.defaultVisible()
                    ? block.blockData() : Material.AIR.createBlockData().getAsString());
            }
            for (TriggerDefinition trigger : wall.triggers()) {
                rollback.putIfAbsent(trigger.position(), unpoweredData(block(world, trigger.position())).getAsString());
            }
        }

        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("schema-version", SCHEMA_VERSION);
        yaml.set("session-id", session.sessionId().toString());
        yaml.set("stage", stage.id());
        yaml.set("world.name", world.getName());
        yaml.set("world.uuid", world.getUID().toString());
        yaml.set("blocks", rollback.entrySet().stream().map(entry -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("x", entry.getKey().x());
            item.put("y", entry.getKey().y());
            item.put("z", entry.getKey().z());
            item.put("data", entry.getValue());
            return item;
        }).toList());
        writeAtomically(yaml.saveToString());
    }

    public RecoveryResult recoverIfPresent() throws IOException, InvalidConfigurationException {
        if (!hasPendingRecovery()) return null;
        YamlConfiguration yaml = new YamlConfiguration();
        yaml.load(snapshotFile);
        if (yaml.getInt("schema-version", -1) != SCHEMA_VERSION) {
            throw new InvalidConfigurationException("Unsupported Firewater recovery schema");
        }
        String stage = requiredString(yaml, "stage");
        String worldName = requiredString(yaml, "world.name");
        UUID worldId = UUID.fromString(requiredString(yaml, "world.uuid"));
        World world = Bukkit.getWorld(worldId);
        if (world == null || !world.getName().equals(worldName)) {
            throw new IllegalStateException("Recovery world is unavailable or has a different UUID: " + worldName);
        }
        List<Map<?, ?>> blocks = yaml.getMapList("blocks");
        int restored = 0;
        for (Map<?, ?> raw : blocks) {
            int x = requiredInt(raw, "x");
            int y = requiredInt(raw, "y");
            int z = requiredInt(raw, "z");
            String data = requiredString(raw, "data");
            world.getBlockAt(x, y, z).setBlockData(Bukkit.createBlockData(data), false);
            restored++;
        }
        clear();
        RecoveryResult result = new RecoveryResult(stage, restored);
        logger.warning("Recovered interrupted Firewater session for stage " + stage + " (" + restored + " blocks)");
        return result;
    }

    public void clear() throws IOException {
        Files.deleteIfExists(snapshotFile.toPath());
        Files.deleteIfExists(temporaryFile.toPath());
    }

    private void writeAtomically(String contents) throws IOException {
        File parent = snapshotFile.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
        byte[] bytes = contents.getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(temporaryFile)) {
            output.write(bytes);
            output.getChannel().force(true);
        }
        try {
            Files.move(temporaryFile.toPath(), snapshotFile.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException exception) {
            Files.deleteIfExists(temporaryFile.toPath());
            throw new IOException("Atomic recovery journal writes are not supported", exception);
        }
    }

    private static Block block(World world, BlockPosition position) {
        return world.getBlockAt(position.x(), position.y(), position.z());
    }

    private static BlockData unpoweredData(Block block) {
        BlockData data = block.getBlockData().clone();
        if (data instanceof Powerable powerable) powerable.setPowered(false);
        if (data instanceof AnaloguePowerable analogue) analogue.setPower(0);
        return data;
    }

    private static String requiredString(YamlConfiguration yaml, String path) throws InvalidConfigurationException {
        String value = yaml.getString(path);
        if (value == null || value.isBlank()) throw new InvalidConfigurationException("Missing " + path);
        return value;
    }

    private static String requiredString(Map<?, ?> map, String key) throws InvalidConfigurationException {
        Object value = map.get(key);
        if (value == null || String.valueOf(value).isBlank()) throw new InvalidConfigurationException("Missing " + key);
        return String.valueOf(value);
    }

    private static int requiredInt(Map<?, ?> map, String key) throws InvalidConfigurationException {
        Object value = map.get(key);
        if (!(value instanceof Number number)) throw new InvalidConfigurationException("Missing integer " + key);
        return number.intValue();
    }

    public record RecoveryResult(String stageId, int restoredBlocks) {
    }
}
