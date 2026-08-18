package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import com.isttech.firewater.domain.WallLogic;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.TriggerDefinition;
import com.isttech.firewater.stage.TriggerType;
import com.isttech.firewater.stage.WallBlockSnapshot;
import com.isttech.firewater.stage.WallDefinition;
import com.isttech.firewater.stage.WallSafety;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Powerable;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.BoundingBox;

import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;

public final class WallService {
    private final JavaPlugin plugin;
    private final RoleService roles;

    public WallService(JavaPlugin plugin, RoleService roles) {
        this.plugin = plugin;
        this.roles = roles;
    }

    public void applyDefaults(StageDefinition stage) {
        for (WallDefinition wall : stage.walls().values()) setVisible(stage, wall, wall.defaultVisible());
    }

    public void preview(StageDefinition stage, WallDefinition wall, boolean visible) {
        setVisible(stage, wall, visible);
    }

    public void restore(StageDefinition stage, WallDefinition wall) {
        setVisible(stage, wall, wall.defaultVisible());
    }

    public void restoreVisible(StageDefinition stage, WallDefinition wall) {
        setVisible(stage, wall, true);
    }

    public void resetTriggers(StageDefinition stage) {
        World world = Bukkit.getWorld(stage.world());
        if (world == null) return;
        for (WallDefinition wall : stage.walls().values()) {
            for (TriggerDefinition trigger : wall.triggers()) {
                if (trigger.type() == TriggerType.PAD) continue;
                Block block = block(world, trigger.position());
                if (block.getBlockData() instanceof Powerable powerable && powerable.isPowered()) {
                    powerable.setPowered(false);
                    block.setBlockData(powerable, false);
                }
            }
        }
    }

    public Optional<String> refresh(StageSession session) {
        StageDefinition stage = session.stage();
        World world = Bukkit.getWorld(stage.world());
        if (world == null) return Optional.of("WORLD_UNLOADED");
        Map<Role, Player> players = new EnumMap<>(Role.class);
        for (Role role : Role.values()) players.put(role, roles.online(role));

        for (Map.Entry<String, WallDefinition> entry : stage.walls().entrySet()) {
            boolean anyActive = entry.getValue().triggers().stream().anyMatch(trigger -> isActive(world, trigger, players));
            Boolean previousTrigger = session.wallTriggerActive().put(entry.getKey(), anyActive);
            if (previousTrigger == null || previousTrigger != anyActive) {
                log("TRIGGER_CHANGED", session, entry.getKey(), "active=" + anyActive);
            }
            boolean visible = WallLogic.isVisible(entry.getValue().defaultVisible(), anyActive);
            Boolean previous = session.wallVisibility().put(entry.getKey(), visible);
            if (previous != null && previous == visible) continue;
            if (visible && collides(world, entry.getValue(), players)) return Optional.of(entry.getKey());
            setVisible(stage, entry.getValue(), visible);
            log("WALL_VISIBILITY_CHANGED", session, entry.getKey(), "visible=" + visible);
        }
        return Optional.empty();
    }

    private boolean isActive(World world, TriggerDefinition trigger, Map<Role, Player> players) {
        if (trigger.type() == TriggerType.PAD) {
            for (Player player : players.values()) {
                if (player == null || !player.isOnline() || player.isDead() || player.getWorld() != world) continue;
                BlockPosition feet = position(player.getLocation().getBlock());
                BlockPosition below = position(player.getLocation().getBlock().getRelative(0, -1, 0));
                if (trigger.position().equals(feet) || trigger.position().equals(below)) return true;
            }
            return false;
        }
        BlockData data = block(world, trigger.position()).getBlockData();
        return data instanceof Powerable powerable && powerable.isPowered();
    }

    private boolean collides(World world, WallDefinition wall, Map<Role, Player> players) {
        for (WallBlockSnapshot snapshot : wall.blocks()) {
            BlockPosition position = snapshot.position();
            BoundingBox blockBox = new BoundingBox(position.x(), position.y(), position.z(),
                position.x() + 1, position.y() + 1, position.z() + 1);
            for (Player player : players.values()) {
                if (player != null && player.isOnline() && !player.isDead() && player.getWorld() == world
                    && player.getBoundingBox().overlaps(blockBox)) return true;
            }
        }
        return false;
    }

    private void setVisible(StageDefinition stage, WallDefinition wall, boolean visible) {
        World world = Bukkit.getWorld(stage.world());
        if (world == null) return;
        for (WallBlockSnapshot snapshot : wall.blocks()) {
            Block target = block(world, snapshot.position());
            BlockData source = Bukkit.createBlockData(snapshot.blockData());
            String unsafe = WallSafety.unsafeReason(source);
            if (unsafe != null) {
                throw new IllegalStateException("Unsafe wall material at " + snapshot.position() + ": " + unsafe);
            }
            BlockData data = visible ? source : Material.AIR.createBlockData();
            if (!target.getBlockData().equals(data)) target.setBlockData(data, false);
        }
    }

    private static Block block(World world, BlockPosition position) {
        return world.getBlockAt(position.x(), position.y(), position.z());
    }

    private static BlockPosition position(Block block) {
        return new BlockPosition(block.getX(), block.getY(), block.getZ());
    }

    private void log(String event, StageSession session, String wall, String details) {
        plugin.getLogger().info("event=" + event + " stage=" + session.stage().id()
            + " session-id=" + session.sessionId() + " attempt=" + session.attempt()
            + " wall=" + wall + " " + details);
    }
}
