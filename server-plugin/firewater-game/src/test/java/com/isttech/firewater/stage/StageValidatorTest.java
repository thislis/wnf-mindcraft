package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

class StageValidatorTest {
    @Test
    void boundsContainmentDefinesWhereRuntimeRulesApply() {
        StageBounds bounds = new StageBounds(new BlockPosition(10, 20, 30), new BlockPosition(0, 0, 0));
        assertTrue(bounds.contains(new BlockPosition(0, 0, 0)));
        assertTrue(bounds.contains(new BlockPosition(10, 20, 30)));
        assertTrue(!bounds.contains(new BlockPosition(11, 10, 10)));
        assertTrue(bounds.contains(0.25, 0, 0.25, 0.85, 1.8, 0.85));
        assertFalse(bounds.contains(-0.1, 0, 0, 0.5, 1.8, 0.5));
    }

    @Test
    void startControlMayBeOutsidePlayBounds() {
        StageDefinition stage = completeStage();
        stage.setStartTrigger(new TriggerDefinition(TriggerType.BUTTON, new BlockPosition(-5, 1, -5)));
        assertTrue(StageValidator.validateStructure(stage, 240).stream()
            .noneMatch(error -> error.contains("start trigger is outside")));
    }

    @Test
    void rejectsCrossWallAndFunctionalCoordinateCollisions() {
        StageDefinition stage = completeStage();
        BlockPosition shared = new BlockPosition(10, 2, 10);
        WallDefinition second = new WallDefinition(false);
        second.blocks().add(new WallBlockSnapshot(shared, "minecraft:glass"));
        stage.walls().put("second", second);
        stage.walls().get("gate").triggers().add(new TriggerDefinition(TriggerType.LEVER, shared));

        List<String> errors = StageValidator.validateStructure(stage, 240);
        assertTrue(errors.stream().anyMatch(error -> error.contains("overlaps wall")));
        assertTrue(errors.stream().anyMatch(error -> error.contains("spawn, finish, start, or trigger")));
    }

    @Test
    void rejectsEnabledStageGlobalOverlapButAllowsDisabledTemplate() {
        StageDefinition candidate = completeStage();
        StageDefinition other = completeStageWithId("other");
        other.setEnabled(true);
        assertTrue(StageValidator.validateGlobal(candidate, List.of(candidate, other)).stream()
            .anyMatch(error -> error.contains("play bounds overlap")));

        other.setEnabled(false);
        assertTrue(StageValidator.validateGlobal(candidate, List.of(candidate, other)).isEmpty());
    }

    @Test
    void acceptsCompleteDefinitionAndRejectsOutOfBoundsDevice() {
        StageDefinition stage = completeStage();
        assertTrue(StageValidator.validateStructure(stage, 240).isEmpty());

        stage.walls().get("gate").triggers().add(
            new TriggerDefinition(TriggerType.LEVER, new BlockPosition(99, 2, 2)));
        List<String> errors = StageValidator.validateStructure(stage, 240);
        assertTrue(errors.stream().anyMatch(error -> error.contains("outside stage bounds")));
    }

    @Test
    void detectsWallOverlapAndMissingRequiredFields() {
        StageDefinition stage = new StageDefinition("test", "world");
        List<String> incomplete = StageValidator.validateStructure(stage, 240);
        assertTrue(incomplete.stream().anyMatch(error -> error.contains("bounds")));
        assertTrue(incomplete.stream().anyMatch(error -> error.contains("wade spawn")));

        stage = completeStage();
        stage.walls().get("gate").blocks().add(new WallBlockSnapshot(new BlockPosition(2, 2, 2), "minecraft:stone"));
        assertTrue(StageValidator.validateStructure(stage, 240).stream().anyMatch(error -> error.contains("overlaps")));
    }

    @Test
    void finishRequiresItsStandingSpaceInsideBoundsAndProtectedFromWalls() {
        StageDefinition stage = completeStage();
        stage.finishes().put(Role.WADE,
            new FinishDefinition(new BlockPosition(18, 19, 17), "light_blue_glazed_terracotta"));

        List<String> outsideErrors = StageValidator.validateStructure(stage, 240);
        assertTrue(outsideErrors.stream().anyMatch(error -> error.contains("wade finish head is outside stage bounds")));

        stage.finishes().put(Role.WADE,
            new FinishDefinition(new BlockPosition(18, 1, 17), "light_blue_glazed_terracotta"));
        stage.walls().get("gate").blocks().add(
            new WallBlockSnapshot(new BlockPosition(18, 3, 17), "minecraft:stone"));

        assertTrue(StageValidator.validateStructure(stage, 240).stream()
            .anyMatch(error -> error.contains("overlaps a spawn, finish, start, or trigger")));
    }

    private static StageDefinition completeStage() {
        return completeStageWithId("test");
    }

    private static StageDefinition completeStageWithId(String id) {
        StageDefinition stage = new StageDefinition(id, "world");
        stage.setBounds(new StageBounds(new BlockPosition(0, 0, 0), new BlockPosition(20, 20, 20)));
        stage.setStartTrigger(new TriggerDefinition(TriggerType.BUTTON, new BlockPosition(1, 1, 1)));
        stage.spawns().put(Role.WADE, new StageLocation(2.5, 2, 2.5, 0, 0));
        stage.spawns().put(Role.EMBER, new StageLocation(4.5, 2, 2.5, 0, 0));
        stage.finishes().put(Role.WADE, new FinishDefinition(new BlockPosition(18, 1, 17), "light_blue_glazed_terracotta"));
        stage.finishes().put(Role.EMBER, new FinishDefinition(new BlockPosition(18, 1, 19), "orange_glazed_terracotta"));
        WallDefinition wall = new WallDefinition(true);
        wall.blocks().add(new WallBlockSnapshot(new BlockPosition(10, 2, 10), "minecraft:stone"));
        stage.walls().put("gate", wall);
        return stage;
    }
}
