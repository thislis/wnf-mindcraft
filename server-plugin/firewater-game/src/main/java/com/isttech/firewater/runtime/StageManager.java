package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Hazard;
import com.isttech.firewater.domain.HazardRules;
import com.isttech.firewater.domain.Role;
import com.isttech.firewater.domain.SessionState;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.FinishDefinition;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.StageLocation;
import com.isttech.firewater.stage.StageRepository;
import com.isttech.firewater.stage.StageValidator;
import com.isttech.firewater.stage.TriggerDefinition;
import com.isttech.firewater.stage.TriggerType;
import com.isttech.firewater.stage.WallBlockSnapshot;
import com.isttech.firewater.stage.WallDefinition;
import com.isttech.firewater.stage.WallSafety;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.Sound;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.Powerable;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.HashSet;
import java.util.Set;
import java.util.logging.Level;

public final class StageManager {
    private final JavaPlugin plugin;
    private final StageRepository repository;
    private final RoleService roles;
    private final WallService walls;
    private final HazardService hazards;
    private final BotMessenger messenger;
    private final SessionSnapshotStore snapshots;
    private final int maxMessageLength;
    private final int hazardPeriod;
    private StageSession active;
    private long ticks;

    public StageManager(JavaPlugin plugin, StageRepository repository, RoleService roles, WallService walls,
                        HazardService hazards, BotMessenger messenger, SessionSnapshotStore snapshots,
                        int maxMessageLength, int hazardPeriod) {
        this.plugin = plugin;
        this.repository = repository;
        this.roles = roles;
        this.walls = walls;
        this.hazards = hazards;
        this.messenger = messenger;
        this.snapshots = snapshots;
        this.maxMessageLength = maxMessageLength;
        this.hazardPeriod = Math.max(1, hazardPeriod);
    }

    public Optional<StageSession> active() {
        return Optional.ofNullable(active);
    }

    public boolean start(String stageId, CommandSender feedback) {
        StageDefinition stage = repository.find(stageId).orElse(null);
        if (stage == null) {
            feedback.sendMessage("§cUnknown stage: " + stageId);
            return false;
        }
        return start(stage, feedback);
    }

    public boolean start(StageDefinition stage, CommandSender feedback) {
        if (active != null && active.state() == SessionState.CLEARED) {
            active.transitionTo(SessionState.IDLE);
            active = null;
        }
        if (active != null) {
            feedback.sendMessage("§cA stage is already active: " + active.stage().id() + " (" + active.state() + ")");
            return false;
        }
        if (!stage.enabled()) {
            feedback.sendMessage("§cStage is disabled: " + stage.id());
            return false;
        }
        List<String> errors = validate(stage);
        for (Role role : Role.values()) {
            Player player = roles.online(role);
            if (player == null) errors.add(roles.name(role) + " is not online");
            else if (player.isDead()) errors.add(roles.name(role) + " must respawn before the stage starts");
        }
        if (!errors.isEmpty()) {
            feedback.sendMessage("§cCannot start " + stage.id() + ":");
            errors.forEach(error -> feedback.sendMessage("§c- " + error));
            return false;
        }

        StageSession session = new StageSession(stage);
        try {
            snapshots.capture(session);
        } catch (Exception exception) {
            plugin.getLogger().severe("Could not commit recovery journal for stage " + stage.id() + ": " + exception.getMessage());
            feedback.sendMessage("§cStage start refused because its recovery journal could not be written.");
            return false;
        }
        active = session;
        session.transitionTo(SessionState.STARTING);
        try {
            walls.resetTriggers(stage);
            walls.applyDefaults(stage);
            for (Role role : Role.values()) {
                Player player = roles.online(role);
                roles.enterStage(player, role);
                teleportRequired(player, toBukkitLocation(stage, stage.spawns().get(role)), "stage start");
            }
            session.transitionTo(SessionState.RUNNING);
            messenger.start(session);
            log("STAGE_STARTED", "stage=" + stage.id() + " session-id=" + session.sessionId() + " attempt=1");
            feedback.sendMessage("§aStarted Firewater stage " + stage.id() + ".");
            return true;
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Failed to start stage " + stage.id() + ": " + exception.getMessage());
            safeAbort(session, "START_FAILED");
            feedback.sendMessage("§cStage start failed; participant state was restored. See server log.");
            return false;
        }
    }

    public void tick() {
        ticks++;
        StageSession session = active;
        if (session == null) {
            roles.enforceIdleOnline();
            return;
        }
        if (session.state() != SessionState.RUNNING) return;

        for (Role role : Role.values()) {
            Player player = roles.online(role);
            if (player == null || !player.isOnline()) {
                abort("DISCONNECT_" + roles.name(role));
                return;
            }
            roles.enforceDedicatedBaseline(player);
            if (ticks % 20 == 0) roles.refreshRoleEffects(player, role);
            if (!player.getWorld().getName().equals(session.stage().world())) {
                log("BOUNDARY_VIOLATION", "stage=" + session.stage().id() + " attempt=" + session.attempt()
                    + " player=" + player.getName() + " cause=WORLD_EXIT position=" + compact(player.getLocation()));
                beginReset("WORLD_EXIT", player.getName(), false);
                return;
            }
            var box = player.getBoundingBox();
            if (session.stage().bounds() == null || !session.stage().bounds().contains(
                box.getMinX(), box.getMinY(), box.getMinZ(), box.getMaxX(), box.getMaxY(), box.getMaxZ())) {
                log("BOUNDARY_VIOLATION", "stage=" + session.stage().id() + " attempt=" + session.attempt()
                    + " player=" + player.getName() + " cause=BOUNDS_EXIT position=" + compact(player.getLocation()));
                beginReset("BOUNDS_EXIT", player.getName(), false);
                return;
            }
        }

        Optional<String> collision = walls.refresh(session);
        if (collision.isPresent()) {
            beginReset("WALL_COLLISION_" + collision.get(), "none", false);
            return;
        }

        if (ticks % hazardPeriod == 0) {
            for (Role role : Role.values()) {
                Player player = roles.online(role);
                checkHazard(player);
                if (session.state() != SessionState.RUNNING) return;
            }
        }

        boolean wadeOnExit = isOnOwnExit(session, Role.WADE);
        boolean emberOnExit = isOnOwnExit(session, Role.EMBER);
        boolean previousWade = session.exitHold().wadeOnExit();
        boolean previousEmber = session.exitHold().emberOnExit();
        boolean completed = session.exitHold().tick(wadeOnExit, emberOnExit);
        logFinishChange(session, Role.WADE, previousWade, wadeOnExit);
        logFinishChange(session, Role.EMBER, previousEmber, emberOnExit);
        if (completed) clear();
    }

    public void tickSafely() {
        try {
            tick();
        } catch (RuntimeException exception) {
            plugin.getLogger().log(Level.SEVERE, "event=RUNTIME_TICK_FAILURE; aborting active Firewater session", exception);
            StageSession session = active;
            if (session != null) {
                try {
                    safeAbort(session, "RUNTIME_TICK_FAILURE");
                } catch (RuntimeException cleanupFailure) {
                    plugin.getLogger().log(Level.SEVERE, "Firewater emergency cleanup failed; recovery journal retained", cleanupFailure);
                }
            }
        }
    }

    public void checkHazard(Player player) {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING || player == null || player.isDead()) return;
        Optional<Role> role = roles.roleOf(player);
        if (role.isEmpty() || !player.getWorld().getName().equals(session.stage().world())) return;
        StageDefinition stage = session.stage();
        if (stage.bounds() == null) return;
        Optional<Hazard> hazard = hazards.detect(player, stage);
        if (hazard.isEmpty() || !HazardRules.isFatal(role.get(), hazard.get())) return;
        if (!session.failureLatch().latch(player.getUniqueId())) return;

        String cause = hazard.get().name();
        session.markFailure(cause, player.getName());
        Location location = player.getLocation();
        log("HAZARD_CONTACT", "stage=" + session.stage().id() + " attempt=" + session.attempt()
            + " player=" + player.getName() + " hazard=" + cause + " position=" + compact(location));
        if (hazard.get() == Hazard.POISON) {
            player.getWorld().spawnParticle(Particle.DUST, location, 20, 0.35, 0.15, 0.35, 0,
                new Particle.DustOptions(org.bukkit.Color.LIME, 1.2f));
            player.getWorld().playSound(location, Sound.ENTITY_SLIME_HURT, 0.5f, 0.7f);
        }
        player.setHealth(0.0);
    }

    public boolean onPlayerDeath(Player player) {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING || roles.roleOf(player).isEmpty()) return false;
        String cause = session.pendingCause() == null ? "DEATH" : session.pendingCause();
        String victim = session.pendingVictim() == null ? player.getName() : session.pendingVictim();
        beginReset(cause, victim, true);
        return true;
    }

    public void configureRespawn(PlayerRespawnEvent event) {
        StageSession session = active;
        Optional<Role> role = roles.roleOf(event.getPlayer());
        if (session == null || role.isEmpty()) return;
        if (session.state() == SessionState.RESETTING || session.state() == SessionState.RUNNING) {
            event.setRespawnLocation(toBukkitLocation(session.stage(), session.stage().spawns().get(role.get())));
        }
    }

    public void onQuit(Player player) {
        if (active != null && roles.roleOf(player).isPresent()) {
            // PlayerQuitEvent is the last reliable point where the original GameMode can be restored.
            roles.restore(player);
            abort("DISCONNECT_" + player.getName());
        }
    }

    public void onJoin(Player player) {
        if (roles.roleOf(player).isEmpty()) return;
        StageSession session = active;
        if (session != null && session.state() == SessionState.RUNNING) {
            Role role = roles.roleOf(player).orElseThrow();
            roles.enterStage(player, role);
        } else {
            roles.restore(player);
        }
    }

    public boolean protects(String worldName, BlockPosition position) {
        StageSession session = active;
        return session != null
            && (session.state() == SessionState.RUNNING || session.state() == SessionState.RESETTING)
            && session.stage().world().equals(worldName)
            && session.stage().bounds() != null
            && session.stage().bounds().contains(position);
    }

    public boolean isRegisteredInteraction(Player player, String worldName, BlockPosition position) {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING || roles.roleOf(player).isEmpty()) return false;
        if (!session.stage().world().equals(worldName)) return false;
        return session.stage().walls().values().stream()
            .flatMap(wall -> wall.triggers().stream())
            .anyMatch(trigger -> trigger.position().equals(position)
                && (trigger.type() == TriggerType.LEVER || trigger.type() == TriggerType.BUTTON));
    }

    public boolean isRegisteredPad(Player player, String worldName, BlockPosition position) {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING || roles.roleOf(player).isEmpty()) return false;
        if (!session.stage().world().equals(worldName)) return false;
        return session.stage().walls().values().stream()
            .flatMap(wall -> wall.triggers().stream())
            .anyMatch(trigger -> trigger.type() == TriggerType.PAD && trigger.position().equals(position));
    }

    public boolean isProtectedWallCell(String worldName, BlockPosition position) {
        for (StageDefinition stage : repository.all()) {
            if (!stage.enabled() || !stage.world().equals(worldName)) continue;
            if (stage.walls().values().stream().flatMap(wall -> wall.blocks().stream())
                .anyMatch(block -> block.position().equals(position))) return true;
        }
        return false;
    }

    public void reset(CommandSender feedback) {
        if (active == null || active.state() != SessionState.RUNNING) {
            feedback.sendMessage("§cNo running stage to reset.");
            return;
        }
        beginReset("MANUAL_RESET", "admin", false);
        feedback.sendMessage("§aReset scheduled.");
    }

    public void stop(CommandSender feedback) {
        if (active == null) {
            feedback.sendMessage("§cNo active stage.");
            return;
        }
        String stageId = active.stage().id();
        abort("MANUAL_STOP");
        feedback.sendMessage("§aStopped " + stageId + ".");
    }

    public void abort(String cause) {
        StageSession session = active;
        if (session == null) return;
        safeAbort(session, cause);
    }

    public void shutdown() {
        if (active != null && active.state() == SessionState.CLEARED) {
            walls.resetTriggers(active.stage());
            walls.applyDefaults(active.stage());
            active.transitionTo(SessionState.IDLE);
            active = null;
        } else if (active != null) {
            safeAbort(active, "PLUGIN_DISABLE");
        }
        roles.restoreAll();
    }

    public List<String> validate(StageDefinition stage) {
        List<String> errors = new ArrayList<>(StageValidator.validateStructure(stage, maxMessageLength));
        errors.addAll(StageValidator.validateGlobal(stage, repository.all()));
        World world = Bukkit.getWorld(stage.world());
        if (world == null) {
            errors.add("world is not loaded: " + stage.world());
            return errors;
        }
        Set<BlockPosition> allPositions = collectPositions(stage);
        for (BlockPosition position : allPositions) {
            if (position.y() < world.getMinHeight() || position.y() >= world.getMaxHeight()) {
                errors.add("position is outside world build height: " + position);
            }
        }
        if (!errors.isEmpty() && allPositions.stream().anyMatch(position ->
            position.y() < world.getMinHeight() || position.y() >= world.getMaxHeight())) return errors;
        Set<Material> poison = hazards.resolvePoisonMaterials(stage);
        for (Role role : Role.values()) {
            StageLocation spawn = stage.spawns().get(role);
            if (spawn != null) {
                Block feet = world.getBlockAt(spawn.blockPosition().x(), spawn.blockPosition().y(), spawn.blockPosition().z());
                Block head = feet.getRelative(0, 1, 0);
                if (!feet.isPassable() || !head.isPassable()) errors.add(role.key() + " spawn has no feet/head space");
                Block support = feet.getRelative(0, -1, 0);
                if (!support.getType().isSolid()) errors.add(role.key() + " spawn has no solid support");
                if (poison.contains(feet.getType()) || poison.contains(head.getType()) || poison.contains(support.getType())
                    || isLiquid(feet) || isLiquid(head) || isLiquid(support)) {
                    errors.add(role.key() + " spawn touches a configured hazard");
                }
            }
            FinishDefinition finish = stage.finishes().get(role);
            if (finish != null) {
                Block support = block(world, finish.position());
                Block feet = support.getRelative(0, 1, 0);
                Block head = support.getRelative(0, 2, 0);
                Material expected = Material.matchMaterial(finish.material());
                if (expected == null) errors.add("unknown " + role.key() + " finish material: " + finish.material());
                else if (support.getType() != expected) errors.add(role.key() + " finish block does not match " + expected);
                if (!support.getType().isSolid()) errors.add(role.key() + " finish has no solid support");
                if (!feet.isPassable() || !head.isPassable()) errors.add(role.key() + " finish has no feet/head space");
                if (poison.contains(support.getType()) || poison.contains(feet.getType()) || poison.contains(head.getType())
                    || isLiquid(support) || isLiquid(feet) || isLiquid(head)) {
                    errors.add(role.key() + " finish touches a configured hazard");
                }
            }
        }
        if (stage.startTrigger() != null && stage.startTrigger().type() == TriggerType.PAD) {
            errors.add("start trigger must be a button or lever");
        }
        validateTrigger(errors, world, stage.startTrigger(), "start trigger");
        for (var wallEntry : stage.walls().entrySet()) {
            WallDefinition wall = wallEntry.getValue();
            Set<BlockPosition> wallPositions = wall.blocks().stream().map(WallBlockSnapshot::position).collect(java.util.stream.Collectors.toSet());
            for (WallBlockSnapshot snapshot : wall.blocks()) {
                try {
                    var data = Bukkit.createBlockData(snapshot.blockData());
                    String unsafe = WallSafety.unsafeReason(data);
                    if (unsafe != null) errors.add("unsafe wall " + wallEntry.getKey() + " block at " + snapshot.position() + ": " + unsafe);
                    if (WallSafety.hasAdjacentFluid(world, snapshot.position(), wallPositions)) {
                        errors.add("wall " + wallEntry.getKey() + " is adjacent to fluid at " + snapshot.position());
                    }
                } catch (IllegalArgumentException exception) {
                    errors.add("invalid BlockData in wall " + wallEntry.getKey() + ": " + snapshot.blockData());
                }
            }
            wall.triggers().forEach(trigger -> validateTrigger(errors, world, trigger, "wall " + wallEntry.getKey() + " trigger"));
        }
        for (String material : stage.poisonMaterials()) {
            if (Material.matchMaterial(material) == null) errors.add("unknown poison material: " + material);
        }
        return errors;
    }

    public String status() {
        if (active == null) return "IDLE; loaded-stages=" + repository.all().size();
        return active.state() + "; stage=" + active.stage().id() + "; attempt=" + active.attempt()
            + "; exits=" + active.exitHold().wadeOnExit() + "/" + active.exitHold().emberOnExit()
            + "; hold=" + active.exitHold().heldTicks() + "/" + active.stage().finishHoldTicks()
            + "; players=" + participantStatus(Role.WADE) + "," + participantStatus(Role.EMBER)
            + "; triggers=" + active.wallTriggerActive();
    }

    private void beginReset(String cause, String victim, boolean respawnVictim) {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING) return;
        session.markFailure(cause, victim);
        session.transitionTo(SessionState.RESETTING);
        if (respawnVictim) {
            Bukkit.getScheduler().runTask(plugin, () -> {
                Player player = Bukkit.getPlayerExact(victim);
                if (player != null && player.isDead()) player.spigot().respawn();
            });
        }
        Bukkit.getScheduler().runTaskLater(plugin, () -> finishReset(session), respawnVictim ? 3L : 1L);
    }

    private void finishReset(StageSession session) {
        if (active != session || session.state() != SessionState.RESETTING) return;
        try {
            for (Role role : Role.values()) {
                Player player = roles.online(role);
                if (player == null) {
                    abort("DISCONNECT_" + roles.name(role));
                    return;
                }
                if (player.isDead()) player.spigot().respawn();
            }
            String cause = session.pendingCause() == null ? "UNKNOWN" : session.pendingCause();
            String victim = session.pendingVictim() == null ? "none" : session.pendingVictim();
            walls.resetTriggers(session.stage());
            walls.applyDefaults(session.stage());
            session.beginNextAttempt();
            for (Role role : Role.values()) {
                Player player = roles.online(role);
                roles.enterStage(player, role);
                teleportRequired(player, toBukkitLocation(session.stage(), session.stage().spawns().get(role)), "attempt reset");
            }
            session.transitionTo(SessionState.RUNNING);
            messenger.reset(session, cause, victim);
            log("ATTEMPT_RESET", "stage=" + session.stage().id() + " attempt=" + session.attempt()
                + " cause=" + cause + " victim=" + victim);
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Attempt reset failed for " + session.stage().id() + ": " + exception.getMessage());
            safeAbort(session, "RESET_FAILED");
        }
    }

    private void clear() {
        StageSession session = active;
        if (session == null || session.state() != SessionState.RUNNING) return;
        session.transitionTo(SessionState.CLEARED);
        boolean worldRestored = false;
        try {
            walls.resetTriggers(session.stage());
            walls.applyDefaults(session.stage());
            worldRestored = true;
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Could not restore stage walls after clear: " + exception.getMessage());
        }
        try {
            messenger.clear(session);
        } catch (RuntimeException exception) {
            plugin.getLogger().warning("Could not send clear message: " + exception.getMessage());
        }
        try {
            roles.restoreAll();
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Could not fully restore participant state after clear: " + exception.getMessage());
        }
        if (worldRestored) clearRecoveryJournal();
        session.transitionTo(SessionState.IDLE);
        active = null;
        log("STAGE_CLEARED", "stage=" + session.stage().id() + " session-id=" + session.sessionId()
            + " attempts=" + session.attempt());
    }

    private void safeAbort(StageSession session, String cause) {
        try { messenger.abort(session, cause); } catch (RuntimeException exception) {
            plugin.getLogger().warning("Could not send abort message: " + exception.getMessage());
        }
        boolean worldRestored = false;
        try {
            walls.resetTriggers(session.stage());
            walls.applyDefaults(session.stage());
            worldRestored = true;
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Could not restore stage walls: " + exception.getMessage());
        }
        try {
            roles.restoreAll();
        } catch (RuntimeException exception) {
            plugin.getLogger().severe("Could not fully restore participant state after abort: " + exception.getMessage());
        } finally {
            if (worldRestored) clearRecoveryJournal();
            if (session.state() != SessionState.IDLE) {
                try { session.transitionTo(SessionState.IDLE); }
                catch (RuntimeException exception) {
                    plugin.getLogger().severe("Could not retire aborted session: " + exception.getMessage());
                }
            }
            if (active == session) active = null;
        }
        log("STAGE_ABORTED", "stage=" + session.stage().id() + " cause=" + cause);
    }

    private void clearRecoveryJournal() {
        try {
            snapshots.clear();
        } catch (Exception exception) {
            plugin.getLogger().log(Level.SEVERE, "Could not clear Firewater recovery journal; it will be replayed on next enable", exception);
        }
    }

    private boolean isOnOwnExit(StageSession session, Role role) {
        Player player = roles.online(role);
        FinishDefinition finish = session.stage().finishes().get(role);
        World world = Bukkit.getWorld(session.stage().world());
        if (player == null || finish == null || world == null || player.getWorld() != world || player.isDead()) return false;
        Material material = Material.matchMaterial(finish.material());
        if (material == null || block(world, finish.position()).getType() != material) return false;
        BlockPosition feet = position(player.getLocation().getBlock());
        BlockPosition below = position(player.getLocation().getBlock().getRelative(0, -1, 0));
        return finish.position().equals(feet) || finish.position().equals(below);
    }

    private static Set<BlockPosition> collectPositions(StageDefinition stage) {
        Set<BlockPosition> positions = new HashSet<>();
        if (stage.startTrigger() != null) positions.add(stage.startTrigger().position());
        stage.spawns().values().forEach(spawn -> {
            BlockPosition feet = spawn.blockPosition();
            positions.add(feet);
            positions.add(new BlockPosition(feet.x(), feet.y() + 1, feet.z()));
            positions.add(new BlockPosition(feet.x(), feet.y() - 1, feet.z()));
        });
        stage.finishes().values().forEach(finish -> {
            BlockPosition support = finish.position();
            positions.add(support);
            positions.add(new BlockPosition(support.x(), support.y() + 1, support.z()));
            positions.add(new BlockPosition(support.x(), support.y() + 2, support.z()));
        });
        stage.walls().values().forEach(wall -> {
            wall.blocks().forEach(snapshot -> positions.add(snapshot.position()));
            wall.triggers().forEach(trigger -> positions.add(trigger.position()));
        });
        return positions;
    }

    private static boolean isLiquid(Block block) {
        return WallSafety.isFluid(block.getBlockData());
    }

    private void validateTrigger(List<String> errors, World world, TriggerDefinition trigger, String label) {
        if (trigger == null) return;
        Material material = block(world, trigger.position()).getType();
        boolean valid = switch (trigger.type()) {
            case PAD -> material.name().endsWith("_PRESSURE_PLATE");
            case LEVER -> material == Material.LEVER;
            case BUTTON -> material.name().endsWith("_BUTTON");
        };
        if (!valid) errors.add(label + " expects " + trigger.type().key() + " but found " + material);
        if (trigger.type() != TriggerType.PAD && !(block(world, trigger.position()).getBlockData() instanceof Powerable)) {
            errors.add(label + " is not powerable");
        }
    }

    private static Location toBukkitLocation(StageDefinition stage, StageLocation location) {
        World world = Bukkit.getWorld(stage.world());
        if (world == null) throw new IllegalStateException("World is not loaded: " + stage.world());
        return new Location(world, location.x(), location.y(), location.z(), location.yaw(), location.pitch());
    }

    private static void teleportRequired(Player player, Location destination, String operation) {
        if (player.isDead()) throw new IllegalStateException(player.getName() + " is dead during " + operation);
        if (!destination.getChunk().load()) {
            throw new IllegalStateException("Could not load destination chunk for " + player.getName() + " during " + operation);
        }
        if (!player.teleport(destination)) {
            throw new IllegalStateException("Teleport was rejected for " + player.getName() + " during " + operation);
        }
    }

    private static Block block(World world, BlockPosition position) {
        return world.getBlockAt(position.x(), position.y(), position.z());
    }

    private static BlockPosition position(Block block) {
        return new BlockPosition(block.getX(), block.getY(), block.getZ());
    }

    private static String compact(Location location) {
        return location.getWorld().getName() + ":" + location.getBlockX() + "," + location.getBlockY() + "," + location.getBlockZ();
    }

    private String participantStatus(Role role) {
        Player player = roles.online(role);
        return role.key() + "@" + (player == null ? "offline" : compact(player.getLocation()));
    }

    private void logFinishChange(StageSession session, Role role, boolean previous, boolean current) {
        if (previous == current) return;
        Player player = roles.online(role);
        String position = player == null ? "offline" : compact(player.getLocation());
        log(current ? "FINISH_ENTER" : "FINISH_EXIT",
            "stage=" + session.stage().id() + " session-id=" + session.sessionId()
                + " attempt=" + session.attempt() + " player=" + roles.name(role) + " position=" + position);
    }

    private void log(String event, String details) {
        plugin.getLogger().info("event=" + event + " " + details);
    }
}
