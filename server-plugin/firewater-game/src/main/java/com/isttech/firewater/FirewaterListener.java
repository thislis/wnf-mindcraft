package com.isttech.firewater;

import com.isttech.firewater.builder.BuilderSelection;
import com.isttech.firewater.domain.Role;
import com.isttech.firewater.domain.SessionState;
import com.isttech.firewater.runtime.RoleService;
import com.isttech.firewater.runtime.StageManager;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.StageRepository;
import org.bukkit.NamespacedKey;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockFromToEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.BlockPistonExtendEvent;
import org.bukkit.event.block.BlockPistonRetractEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;

public final class FirewaterListener implements Listener {
    private final StageRepository repository;
    private final StageManager manager;
    private final RoleService roles;
    private final BuilderSelection selections;
    private final NamespacedKey wandKey;

    public FirewaterListener(StageRepository repository, StageManager manager, RoleService roles,
                             BuilderSelection selections, NamespacedKey wandKey) {
        this.repository = repository;
        this.manager = manager;
        this.roles = roles;
        this.selections = selections;
        this.wandKey = wandKey;
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onInteract(PlayerInteractEvent event) {
        if (event.getHand() != null && event.getHand() != EquipmentSlot.HAND) return;
        Block clicked = event.getClickedBlock();
        if (clicked == null) return;
        if (isWand(event.getItem())) {
            if (event.getAction() == Action.LEFT_CLICK_BLOCK) {
                selections.setFirst(event.getPlayer().getUniqueId(), position(clicked), clicked.getWorld().getName());
                event.getPlayer().sendMessage("§aFirewater pos1: " + position(clicked));
                event.setCancelled(true);
            } else if (event.getAction() == Action.RIGHT_CLICK_BLOCK) {
                selections.setSecond(event.getPlayer().getUniqueId(), position(clicked), clicked.getWorld().getName());
                event.getPlayer().sendMessage("§aFirewater pos2: " + position(clicked));
                event.setCancelled(true);
            }
            return;
        }
        BlockPosition clickedPosition = position(clicked);
        boolean participant = roles.roleOf(event.getPlayer()).isPresent();
        if (manager.active().isPresent()) {
            boolean registeredUse = event.getAction() == Action.RIGHT_CLICK_BLOCK
                && manager.isRegisteredInteraction(event.getPlayer(), clicked.getWorld().getName(), clickedPosition);
            boolean registeredPad = event.getAction() == Action.PHYSICAL
                && manager.isRegisteredPad(event.getPlayer(), clicked.getWorld().getName(), clickedPosition);
            if ((participant || manager.protects(clicked.getWorld().getName(), clickedPosition))
                && !registeredUse && !registeredPad) {
                event.setCancelled(true);
                return;
            }
        }
        if (event.getAction() != Action.RIGHT_CLICK_BLOCK || roles.roleOf(event.getPlayer()).isPresent()) return;
        for (StageDefinition stage : repository.all()) {
            if (!stage.enabled() || stage.startTrigger() == null || !stage.world().equals(clicked.getWorld().getName())) continue;
            if (stage.startTrigger().position().equals(position(clicked))) {
                manager.start(stage, event.getPlayer());
                return;
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
        if (event.getTo() == null) return;
        if (event.getFrom().getBlockX() == event.getTo().getBlockX()
            && event.getFrom().getBlockY() == event.getTo().getBlockY()
            && event.getFrom().getBlockZ() == event.getTo().getBlockZ()) return;
        manager.checkHazard(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent event) {
        if (manager.onPlayerDeath(event.getEntity())) {
            event.setKeepInventory(true);
            event.getDrops().clear();
            event.setKeepLevel(true);
            event.setDroppedExp(0);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onRespawn(PlayerRespawnEvent event) {
        manager.configureRespawn(event);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        manager.onQuit(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onJoin(PlayerJoinEvent event) {
        manager.onJoin(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent event) {
        if (blocksPlayerChange(event.getPlayer(), position(event.getBlock()), event.getBlock().getWorld().getName())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent event) {
        if (blocksPlayerChange(event.getPlayer(), position(event.getBlock()), event.getBlock().getWorld().getName())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBucketEmpty(PlayerBucketEmptyEvent event) {
        Block target = event.getBlockClicked().getRelative(event.getBlockFace());
        if (blocksPlayerChange(event.getPlayer(), position(target), target.getWorld().getName())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBucketFill(PlayerBucketFillEvent event) {
        Block target = event.getBlockClicked();
        if (blocksPlayerChange(event.getPlayer(), position(target), target.getWorld().getName())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onFluidFlow(BlockFromToEvent event) {
        if (manager.isProtectedWallCell(event.getToBlock().getWorld().getName(), position(event.getToBlock()))) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onEntityChangeBlock(EntityChangeBlockEvent event) {
        if (manager.protects(event.getBlock().getWorld().getName(), position(event.getBlock()))) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBurn(BlockBurnEvent event) {
        if (manager.protects(event.getBlock().getWorld().getName(), position(event.getBlock()))) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockIgnite(BlockIgniteEvent event) {
        if (manager.protects(event.getBlock().getWorld().getName(), position(event.getBlock()))) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent event) {
        event.blockList().removeIf(block -> manager.protects(block.getWorld().getName(), position(block)));
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent event) {
        event.blockList().removeIf(block -> manager.protects(block.getWorld().getName(), position(block)));
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPistonExtend(BlockPistonExtendEvent event) {
        if (event.getBlocks().stream().anyMatch(block -> manager.protects(block.getWorld().getName(), position(block)))) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPistonRetract(BlockPistonRetractEvent event) {
        if (event.getBlocks().stream().anyMatch(block -> manager.protects(block.getWorld().getName(), position(block)))) {
            event.setCancelled(true);
        }
    }

    private boolean blocksPlayerChange(Player player, BlockPosition position, String world) {
        boolean activeParticipant = roles.roleOf(player).isPresent() && manager.active()
            .filter(session -> session.state() == SessionState.RUNNING || session.state() == SessionState.RESETTING)
            .isPresent();
        return activeParticipant || manager.protects(world, position);
    }

    private boolean isWand(ItemStack item) {
        return item != null && item.hasItemMeta()
            && item.getItemMeta().getPersistentDataContainer().has(wandKey, PersistentDataType.BYTE);
    }

    private static BlockPosition position(Block block) {
        return new BlockPosition(block.getX(), block.getY(), block.getZ());
    }
}
