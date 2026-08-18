package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Hazard;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.StageDefinition;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.block.data.Waterlogged;
import org.bukkit.entity.Player;
import org.bukkit.util.BoundingBox;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;

public final class HazardService {
    private static final double EDGE_EPSILON = 1.0e-7;

    public Optional<Hazard> detect(Player player, StageDefinition stage) {
        Set<Material> poisonMaterials = resolvePoisonMaterials(stage);
        Set<Block> contactBlocks = intersectingBlocks(player, stage);
        Set<Block> floorBlocks = floorBlocks(player, stage);

        for (Block block : contactBlocks) {
            if (poisonMaterials.contains(block.getType())) {
                return Optional.of(Hazard.POISON);
            }
        }
        for (Block block : floorBlocks) {
            if (poisonMaterials.contains(block.getType())) return Optional.of(Hazard.POISON);
        }
        for (Block block : contactBlocks) {
            if (block.getType() == Material.LAVA) return Optional.of(Hazard.LAVA);
        }
        for (Block block : contactBlocks) {
            if (isWater(block)) {
                return Optional.of(Hazard.WATER);
            }
        }
        return Optional.empty();
    }

    public Set<Material> resolvePoisonMaterials(StageDefinition stage) {
        Set<Material> result = new HashSet<>();
        for (String name : stage.poisonMaterials()) {
            Material material = Material.matchMaterial(name);
            if (material != null) result.add(material);
        }
        return result;
    }

    private static Set<Block> intersectingBlocks(Player player, StageDefinition stage) {
        BoundingBox box = player.getBoundingBox();
        int minX = floor(box.getMinX() + EDGE_EPSILON);
        int maxX = floor(box.getMaxX() - EDGE_EPSILON);
        int minY = floor(box.getMinY() + EDGE_EPSILON);
        int maxY = floor(box.getMaxY() - EDGE_EPSILON);
        int minZ = floor(box.getMinZ() + EDGE_EPSILON);
        int maxZ = floor(box.getMaxZ() - EDGE_EPSILON);
        Set<Block> blocks = new LinkedHashSet<>();
        for (int x = minX; x <= maxX; x++) {
            for (int y = minY; y <= maxY; y++) {
                for (int z = minZ; z <= maxZ; z++) {
                    addIfInside(blocks, player, stage, x, y, z);
                }
            }
        }
        return blocks;
    }

    private static Set<Block> floorBlocks(Player player, StageDefinition stage) {
        BoundingBox box = player.getBoundingBox();
        int minX = floor(box.getMinX() + EDGE_EPSILON);
        int maxX = floor(box.getMaxX() - EDGE_EPSILON);
        int y = floor(box.getMinY() - EDGE_EPSILON);
        int minZ = floor(box.getMinZ() + EDGE_EPSILON);
        int maxZ = floor(box.getMaxZ() - EDGE_EPSILON);
        Set<Block> blocks = new LinkedHashSet<>();
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) addIfInside(blocks, player, stage, x, y, z);
        }
        return blocks;
    }

    private static void addIfInside(Set<Block> blocks, Player player, StageDefinition stage, int x, int y, int z) {
        BlockPosition position = new BlockPosition(x, y, z);
        if (stage.bounds() != null && stage.bounds().contains(position)) {
            blocks.add(player.getWorld().getBlockAt(x, y, z));
        }
    }

    private static int floor(double value) {
        return (int) Math.floor(value);
    }

    private static boolean isWater(Block block) {
        return block.getType() == Material.WATER
            || block.getType() == Material.BUBBLE_COLUMN
            || (block.getBlockData() instanceof Waterlogged waterlogged && waterlogged.isWaterlogged());
    }
}
