package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class StageValidator {
    public static final int MAX_WALL_BLOCKS = 1_024;
    public static final int MAX_STAGE_WALL_BLOCKS = 4_096;
    public static final int MAX_FINISH_HOLD_TICKS = 1_200;

    private StageValidator() {
    }

    public static List<String> validateStructure(StageDefinition stage, int maxMessageLength) {
        List<String> errors = new ArrayList<>();
        StageBounds bounds = stage.bounds();
        if (bounds == null) errors.add("bounds are not set");
        if (stage.startTrigger() == null) errors.add("start trigger is not set");
        for (Role role : Role.values()) {
            if (!stage.spawns().containsKey(role)) errors.add(role.key() + " spawn is not set");
            if (!stage.finishes().containsKey(role)) errors.add(role.key() + " finish is not set");
        }
        if (stage.goal().isBlank()) errors.add("goal is blank");
        if (stage.botBrief().isBlank()) errors.add("bot-brief is blank");
        if ((stage.goal() + stage.botBrief()).length() > maxMessageLength) {
            errors.add("goal + bot-brief exceeds " + maxMessageLength + " characters");
        }
        if (stage.finishHoldTicks() > MAX_FINISH_HOLD_TICKS) {
            errors.add("finish hold ticks exceeds " + MAX_FINISH_HOLD_TICKS);
        }

        if (bounds != null) {
            // The start control panel is intentionally allowed outside the play bounds.
            stage.spawns().forEach((role, location) -> {
                BlockPosition feet = location.blockPosition();
                requireInside(errors, bounds, feet, role.key() + " spawn");
                requireInside(errors, bounds, offset(feet, 0, 1, 0), role.key() + " spawn head");
            });
            stage.finishes().forEach((role, finish) -> {
                BlockPosition support = finish.position();
                requireInside(errors, bounds, support, role.key() + " finish");
                requireInside(errors, bounds, offset(support, 0, 1, 0), role.key() + " finish feet");
                requireInside(errors, bounds, offset(support, 0, 2, 0), role.key() + " finish head");
            });
            stage.walls().forEach((wallId, wall) -> {
                wall.blocks().forEach(block -> requireInside(errors, bounds, block.position(), "wall " + wallId));
                wall.triggers().forEach(trigger -> requireInside(errors, bounds, trigger.position(), "trigger for " + wallId));
            });
        }

        if (stage.spawns().size() == 2
            && stage.spawns().get(Role.WADE).blockPosition().equals(stage.spawns().get(Role.EMBER).blockPosition())) {
            errors.add("wade and ember spawns overlap");
        }
        if (stage.finishes().size() == 2
            && stage.finishes().get(Role.WADE).position().equals(stage.finishes().get(Role.EMBER).position())) {
            errors.add("wade and ember finishes overlap");
        }

        Set<BlockPosition> protectedPositions = new HashSet<>();
        Map<BlockPosition, String> exclusivePositions = new HashMap<>();
        stage.spawns().values().forEach(location -> {
            protectedPositions.add(location.blockPosition());
            protectedPositions.add(offset(location.blockPosition(), 0, 1, 0));
        });
        stage.finishes().values().forEach(finish -> {
            protectedPositions.add(finish.position());
            protectedPositions.add(offset(finish.position(), 0, 1, 0));
            protectedPositions.add(offset(finish.position(), 0, 2, 0));
        });
        if (stage.startTrigger() != null) protectedPositions.add(stage.startTrigger().position());
        stage.walls().values().forEach(wall -> wall.triggers().forEach(trigger -> protectedPositions.add(trigger.position())));

        stage.spawns().forEach((role, location) -> {
            addExclusive(errors, exclusivePositions, location.blockPosition(), role.key() + " spawn feet");
            addExclusive(errors, exclusivePositions, offset(location.blockPosition(), 0, 1, 0), role.key() + " spawn head");
        });
        stage.finishes().forEach((role, finish) -> {
            addExclusive(errors, exclusivePositions, finish.position(), role.key() + " finish support");
            addExclusive(errors, exclusivePositions, offset(finish.position(), 0, 1, 0), role.key() + " finish feet");
            addExclusive(errors, exclusivePositions, offset(finish.position(), 0, 2, 0), role.key() + " finish head");
        });
        if (stage.startTrigger() != null) {
            addExclusive(errors, exclusivePositions, stage.startTrigger().position(), "start trigger");
        }
        Map<BlockPosition, TriggerType> triggerTypes = new HashMap<>();
        for (Map.Entry<String, WallDefinition> wall : stage.walls().entrySet()) {
            for (TriggerDefinition trigger : wall.getValue().triggers()) {
                TriggerType previousType = triggerTypes.putIfAbsent(trigger.position(), trigger.type());
                if (previousType != null && previousType != trigger.type()) {
                    errors.add("trigger at " + trigger.position() + " has conflicting types " + previousType.key()
                        + " and " + trigger.type().key());
                }
                String exclusive = exclusivePositions.get(trigger.position());
                if (exclusive != null) {
                    errors.add("trigger for " + wall.getKey() + " overlaps " + exclusive + " at " + trigger.position());
                }
            }
        }

        for (Map.Entry<Role, StageLocation> spawn : stage.spawns().entrySet()) {
            for (Map.Entry<Role, FinishDefinition> finish : stage.finishes().entrySet()) {
                BlockPosition feet = spawn.getValue().blockPosition();
                if (feet.equals(finish.getValue().position()) || offset(feet, 0, -1, 0).equals(finish.getValue().position())) {
                    errors.add(spawn.getKey().key() + " spawn overlaps " + finish.getKey().key() + " finish");
                }
            }
        }

        Map<BlockPosition, String> wallOwners = new HashMap<>();
        int totalWallBlocks = 0;
        for (Map.Entry<String, WallDefinition> entry : stage.walls().entrySet()) {
            if (!entry.getKey().matches("[a-z0-9][a-z0-9_-]{0,31}")) errors.add("invalid wall id: " + entry.getKey());
            if (entry.getValue().blocks().isEmpty()) errors.add("wall " + entry.getKey() + " has no blocks");
            if (entry.getValue().blocks().size() > MAX_WALL_BLOCKS) {
                errors.add("wall " + entry.getKey() + " exceeds " + MAX_WALL_BLOCKS + " blocks");
            }
            totalWallBlocks += entry.getValue().blocks().size();
            for (WallBlockSnapshot snapshot : entry.getValue().blocks()) {
                if (protectedPositions.contains(snapshot.position())) {
                    errors.add("wall " + entry.getKey() + " overlaps a spawn, finish, start, or trigger at " + snapshot.position());
                }
                String previous = wallOwners.putIfAbsent(snapshot.position(), entry.getKey());
                if (previous != null) {
                    errors.add("wall " + entry.getKey() + " overlaps wall " + previous + " at " + snapshot.position());
                }
            }
        }
        if (totalWallBlocks > MAX_STAGE_WALL_BLOCKS) {
            errors.add("stage has " + totalWallBlocks + " wall blocks; maximum is " + MAX_STAGE_WALL_BLOCKS);
        }
        return errors;
    }

    public static List<String> validateGlobal(StageDefinition candidate, Collection<StageDefinition> allStages) {
        List<String> errors = new ArrayList<>();
        if (candidate.bounds() == null) return errors;
        for (StageDefinition other : allStages) {
            if (other == candidate || other.id().equals(candidate.id()) || !other.enabled()) continue;
            if (!candidate.world().equals(other.world()) || other.bounds() == null) continue;
            if (candidate.bounds().overlaps(other.bounds())) {
                errors.add("play bounds overlap enabled stage " + other.id());
            }
            if (samePosition(candidate.startTrigger(), other.startTrigger())) {
                errors.add("start trigger overlaps enabled stage " + other.id());
            }
            if (candidate.startTrigger() != null && other.bounds().contains(candidate.startTrigger().position())) {
                errors.add("start trigger is inside enabled stage " + other.id() + " play bounds");
            }
            if (other.startTrigger() != null && candidate.bounds().contains(other.startTrigger().position())) {
                errors.add("enabled stage " + other.id() + " start trigger is inside this play bounds");
            }
        }
        return errors;
    }

    private static void requireInside(List<String> errors, StageBounds bounds, BlockPosition position, String label) {
        if (position != null && !bounds.contains(position)) errors.add(label + " is outside stage bounds: " + position);
    }

    private static boolean samePosition(TriggerDefinition first, TriggerDefinition second) {
        return first != null && second != null && first.position().equals(second.position());
    }

    private static BlockPosition offset(BlockPosition position, int x, int y, int z) {
        return new BlockPosition(position.x() + x, position.y() + y, position.z() + z);
    }

    private static void addExclusive(List<String> errors, Map<BlockPosition, String> positions,
                                     BlockPosition position, String label) {
        String previous = positions.putIfAbsent(position, label);
        if (previous != null) errors.add(label + " overlaps " + previous + " at " + position);
    }
}
