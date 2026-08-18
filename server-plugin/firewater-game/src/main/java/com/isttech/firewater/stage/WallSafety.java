package com.isttech.firewater.stage;

import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.TileState;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Waterlogged;

import java.util.Set;

public final class WallSafety {
    private static final int[][] FACES = {
        { 1, 0, 0 }, { -1, 0, 0 }, { 0, 1, 0 },
        { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 }
    };

    private WallSafety() {
    }

    public static String unsafeReason(BlockData data) {
        if (data == null) return "missing BlockData";
        Material material = data.getMaterial();
        if (!material.isBlock() || material.isAir()) return "air/non-block material";
        if (isFluid(data)) return "fluid or waterlogged material";
        if (material.hasGravity()) return "gravity-affected material";
        if (material.isInteractable()) return "interactive/block-entity-prone material";
        return null;
    }

    public static String unsafeReason(Block block) {
        if (block.getState() instanceof TileState) return "tile/block-entity state";
        return unsafeReason(block.getBlockData());
    }

    public static boolean hasAdjacentFluid(World world, BlockPosition position, Set<BlockPosition> ownWall) {
        for (int[] face : FACES) {
            BlockPosition adjacent = new BlockPosition(
                position.x() + face[0], position.y() + face[1], position.z() + face[2]);
            if (ownWall.contains(adjacent)) continue;
            if (isFluid(world.getBlockAt(adjacent.x(), adjacent.y(), adjacent.z()).getBlockData())) return true;
        }
        return false;
    }

    public static boolean isFluid(BlockData data) {
        Material material = data.getMaterial();
        return material == Material.WATER
            || material == Material.LAVA
            || material == Material.BUBBLE_COLUMN
            || (data instanceof Waterlogged waterlogged && waterlogged.isWaterlogged());
    }
}
