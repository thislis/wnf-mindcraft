package com.isttech.firewater.builder;

import com.isttech.firewater.domain.Role;
import com.isttech.firewater.runtime.StageManager;
import com.isttech.firewater.runtime.WallService;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.FinishDefinition;
import com.isttech.firewater.stage.StageBounds;
import com.isttech.firewater.stage.StageDefinition;
import com.isttech.firewater.stage.StageLocation;
import com.isttech.firewater.stage.StageRepository;
import com.isttech.firewater.stage.StageValidator;
import com.isttech.firewater.stage.TriggerDefinition;
import com.isttech.firewater.stage.TriggerType;
import com.isttech.firewater.stage.WallBlockSnapshot;
import com.isttech.firewater.stage.WallDefinition;
import com.isttech.firewater.stage.WallSafety;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

public final class FirewaterCommand implements CommandExecutor, TabCompleter {
    private static final int MAX_WALL_BLOCKS = StageValidator.MAX_WALL_BLOCKS;
    private final JavaPlugin plugin;
    private final StageRepository repository;
    private final StageManager manager;
    private final WallService wallService;
    private final BuilderSelection selections;
    private final NamespacedKey wandKey;

    public FirewaterCommand(JavaPlugin plugin, StageRepository repository, StageManager manager,
                            WallService wallService, BuilderSelection selections, NamespacedKey wandKey) {
        this.plugin = plugin;
        this.repository = repository;
        this.manager = manager;
        this.wallService = wallService;
        this.selections = selections;
        this.wandKey = wandKey;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        try {
            if (args.length == 0 || args[0].equalsIgnoreCase("help")) {
                help(sender);
                return true;
            }
            return switch (args[0].toLowerCase(Locale.ROOT)) {
                case "status" -> status(sender);
                case "reload" -> reload(sender);
                case "wand" -> wand(sender);
                case "pos1" -> select(sender, true);
                case "pos2" -> select(sender, false);
                case "stage" -> stage(sender, Arrays.copyOfRange(args, 1, args.length));
                case "wall" -> wall(sender, Arrays.copyOfRange(args, 1, args.length));
                case "trigger" -> trigger(sender, Arrays.copyOfRange(args, 1, args.length));
                default -> { sender.sendMessage("§cUnknown subcommand. Use /fw help."); yield true; }
            };
        } catch (IllegalArgumentException | IOException exception) {
            sender.sendMessage("§c" + exception.getMessage());
            return true;
        }
    }

    private boolean status(CommandSender sender) {
        sender.sendMessage("§6Firewater: §f" + manager.status());
        return true;
    }

    private boolean reload(CommandSender sender) {
        if (manager.active().isPresent()) manager.abort("CONFIG_RELOAD");
        repository.reload();
        for (StageDefinition stage : repository.all()) {
            if (!stage.enabled()) continue;
            List<String> errors = manager.validate(stage);
            if (!errors.isEmpty()) {
                sender.sendMessage("§eSkipped defaults for invalid enabled stage " + stage.id() + ": " + errors.size() + " problem(s).");
                continue;
            }
            try {
                wallService.applyDefaults(stage);
            } catch (RuntimeException exception) {
                plugin.getLogger().severe("Could not apply defaults for stage " + stage.id() + " after reload: " + exception.getMessage());
                sender.sendMessage("§eSkipped defaults for stage " + stage.id() + "; see server log.");
            }
        }
        sender.sendMessage("§aReloaded " + repository.all().size() + " stages. Player-name config changes require a server restart.");
        return true;
    }

    private boolean wand(CommandSender sender) {
        Player player = requirePlayer(sender);
        ItemStack item = new ItemStack(Material.BLAZE_ROD);
        ItemMeta meta = item.getItemMeta();
        meta.setDisplayName("§6Firewater Builder Wand");
        meta.setLore(List.of("§7Left-click: pos1", "§7Right-click: pos2"));
        meta.getPersistentDataContainer().set(wandKey, PersistentDataType.BYTE, (byte) 1);
        item.setItemMeta(meta);
        player.getInventory().addItem(item);
        sender.sendMessage("§aBuilder wand given.");
        return true;
    }

    private boolean select(CommandSender sender, boolean first) {
        Player player = requirePlayer(sender);
        Block block = target(player);
        BlockPosition position = position(block);
        if (first) selections.setFirst(player.getUniqueId(), position, block.getWorld().getName());
        else selections.setSecond(player.getUniqueId(), position, block.getWorld().getName());
        sender.sendMessage("§aSelected pos" + (first ? "1" : "2") + " at " + position + ".");
        return true;
    }

    private boolean stage(CommandSender sender, String[] args) throws IOException {
        if (args.length == 0) throw new IllegalArgumentException("Usage: /fw stage <create|create-reference|delete|enable|setbounds|setspawn|setstart|setfinish|setgoal|setbrief|sethold|setpoison|validate|start|reset|stop>");
        String action = args[0].toLowerCase(Locale.ROOT);
        if (action.equals("reset")) { manager.reset(sender); return true; }
        if (action.equals("stop")) { manager.stop(sender); return true; }
        if (args.length < 2) throw new IllegalArgumentException("A stage id is required.");
        String id = args[1].toLowerCase(Locale.ROOT);

        if (action.equals("create-reference")) {
            if (args.length != 2) throw new IllegalArgumentException("Usage: /fw stage create-reference <id>");
            createReferenceStage(requirePlayer(sender), id);
            sender.sendMessage("§aCreated disabled reference stage " + id + ". Review it, then validate and enable it.");
            return true;
        }
        if (action.equals("create")) {
            Player player = requirePlayer(sender);
            repository.create(id, player.getWorld().getName());
            sender.sendMessage("§aCreated disabled stage " + id + ". Configure and enable it before starting.");
            return true;
        }
        StageDefinition stage = requireStage(id);
        if (List.of("delete", "enable", "setbounds", "setspawn", "setstart", "setfinish", "setgoal", "setbrief", "sethold", "setpoison").contains(action)) {
            requireEditable(stage);
        }
        switch (action) {
            case "delete" -> {
                if (stage.enabled()) throw new IllegalArgumentException("Disable stage " + id + " before deleting it.");
                repository.delete(stage);
                sender.sendMessage("§aDeleted stage " + id + ".");
            }
            case "enable" -> {
                if (args.length != 3) throw new IllegalArgumentException("Usage: /fw stage enable <id> <true|false>");
                boolean enabled = parseBoolean(args[2]);
                if (enabled) {
                    List<String> errors = manager.validate(stage);
                    if (!errors.isEmpty()) {
                        throw new IllegalArgumentException("Stage " + id + " is invalid; run /fw stage validate " + id
                            + " (" + errors.size() + " problem(s))");
                    }
                }
                stage.setEnabled(enabled);
                repository.save(stage);
                if (stage.enabled()) wallService.applyDefaults(stage);
                sender.sendMessage("§aStage " + id + " enabled=" + stage.enabled());
            }
            case "setbounds" -> {
                Player player = requirePlayer(sender);
                BuilderSelection.Selection selection = selections.get(player.getUniqueId());
                if (selection == null || !selection.complete()) throw new IllegalArgumentException("Select pos1 and pos2 first.");
                if (!selection.world().equals(stage.world())) throw new IllegalArgumentException("Selection must be in stage world " + stage.world());
                stage.setBounds(new StageBounds(selection.first(), selection.second()));
                repository.save(stage);
                sender.sendMessage("§aSaved bounds for " + id + ".");
            }
            case "setspawn" -> {
                if (args.length != 3) throw new IllegalArgumentException("Usage: /fw stage setspawn <id> <wade|ember>");
                Player player = requirePlayer(sender);
                requireStageWorld(player, stage);
                Role role = Role.parse(args[2]);
                var location = player.getLocation();
                stage.spawns().put(role, new StageLocation(location.getX(), location.getY(), location.getZ(), location.getYaw(), location.getPitch()));
                repository.save(stage);
                sender.sendMessage("§aSaved " + role.key() + " spawn.");
            }
            case "setstart" -> {
                Player player = requirePlayer(sender);
                requireStageWorld(player, stage);
                Block block = target(player);
                TriggerType type = inferTriggerType(block, false);
                stage.setStartTrigger(new TriggerDefinition(type, position(block)));
                repository.save(stage);
                sender.sendMessage("§aSaved " + type.key() + " start trigger.");
            }
            case "setfinish" -> {
                if (args.length != 3) throw new IllegalArgumentException("Usage: /fw stage setfinish <id> <wade|ember>");
                Player player = requirePlayer(sender);
                requireStageWorld(player, stage);
                Role role = Role.parse(args[2]);
                Block block = target(player);
                if (block.getType().isAir()) throw new IllegalArgumentException("Finish cannot be air.");
                stage.finishes().put(role, new FinishDefinition(position(block), block.getType().getKey().toString()));
                repository.save(stage);
                sender.sendMessage("§aSaved " + role.key() + " finish.");
            }
            case "setgoal", "setbrief" -> {
                if (args.length < 3) throw new IllegalArgumentException("Usage: /fw stage " + action + " <id> <text>");
                String text = String.join(" ", Arrays.copyOfRange(args, 2, args.length));
                if (action.equals("setgoal")) stage.setGoal(text); else stage.setBotBrief(text);
                repository.save(stage);
                sender.sendMessage("§aSaved " + action.substring(3) + " for " + id + ".");
            }
            case "sethold" -> {
                if (args.length != 3) throw new IllegalArgumentException("Usage: /fw stage sethold <id> <ticks>");
                int ticks = Integer.parseInt(args[2]);
                if (ticks < 1 || ticks > StageValidator.MAX_FINISH_HOLD_TICKS) {
                    throw new IllegalArgumentException("Hold ticks must be 1.." + StageValidator.MAX_FINISH_HOLD_TICKS);
                }
                stage.setFinishHoldTicks(ticks);
                repository.save(stage);
                sender.sendMessage("§aSaved finish hold=" + ticks + " ticks for " + id + ".");
            }
            case "setpoison" -> {
                if (args.length < 3) throw new IllegalArgumentException("Usage: /fw stage setpoison <id> <material[,material...]>");
                List<String> materials = Arrays.stream(Arrays.copyOfRange(args, 2, args.length))
                    .flatMap(value -> Arrays.stream(value.split(",")))
                    .map(String::strip).filter(value -> !value.isEmpty()).map(value -> value.toLowerCase(Locale.ROOT)).distinct().toList();
                if (materials.isEmpty()) throw new IllegalArgumentException("At least one poison material is required.");
                for (String name : materials) {
                    Material material = Material.matchMaterial(name);
                    if (material == null || !material.isBlock() || material.isAir()) {
                        throw new IllegalArgumentException("Invalid poison block material: " + name);
                    }
                }
                stage.poisonMaterials().clear();
                stage.poisonMaterials().addAll(materials);
                repository.save(stage);
                sender.sendMessage("§aSaved " + materials.size() + " poison material(s) for " + id + ".");
            }
            case "validate" -> {
                List<String> errors = manager.validate(stage);
                if (errors.isEmpty()) sender.sendMessage("§aStage " + id + " is valid.");
                else {
                    sender.sendMessage("§cStage " + id + " has " + errors.size() + " problem(s):");
                    errors.forEach(error -> sender.sendMessage("§c- " + error));
                }
            }
            case "start" -> manager.start(stage, sender);
            default -> throw new IllegalArgumentException("Unknown stage action: " + action);
        }
        return true;
    }

    private boolean wall(CommandSender sender, String[] args) throws IOException {
        if (args.length < 3) {
            throw new IllegalArgumentException("Usage: /fw wall <save|delete|preview|restore> <stage> <wall-id> [true|false]");
        }
        String action = args[0].toLowerCase(Locale.ROOT);
        Player player = requirePlayer(sender);
        StageDefinition stage = requireStage(args[1]);
        requireEditable(stage);
        requireStageWorld(player, stage);
        String wallId = args[2].toLowerCase(Locale.ROOT);
        if (action.equals("delete")) {
            if (args.length != 3) throw new IllegalArgumentException("Usage: /fw wall delete <stage> <wall-id>");
            WallDefinition wall = Optional.ofNullable(stage.walls().get(wallId))
                .orElseThrow(() -> new IllegalArgumentException("Unknown wall: " + wallId));
            wallService.restoreVisible(stage, wall);
            stage.walls().remove(wallId);
            repository.save(stage);
            sender.sendMessage("§aDeleted wall " + wallId + " after restoring its blocks.");
            return true;
        }
        if (action.equals("preview") || action.equals("restore")) {
            WallDefinition wall = Optional.ofNullable(stage.walls().get(wallId))
                .orElseThrow(() -> new IllegalArgumentException("Unknown wall: " + wallId));
            if (action.equals("preview")) {
                if (args.length != 4) throw new IllegalArgumentException("Usage: /fw wall preview <stage> <wall-id> <true|false>");
                wallService.preview(stage, wall, parseBoolean(args[3]));
                sender.sendMessage("§aPreviewed wall " + wallId + ". Use /fw wall restore to return to its default.");
            } else {
                if (args.length != 3) throw new IllegalArgumentException("Usage: /fw wall restore <stage> <wall-id>");
                wallService.restore(stage, wall);
                sender.sendMessage("§aRestored wall " + wallId + " to its configured default.");
            }
            return true;
        }
        if (!action.equals("save") || args.length != 4) {
            throw new IllegalArgumentException("Usage: /fw wall save <stage> <wall-id> <default-visible>");
        }
        if (!wallId.matches("[a-z0-9][a-z0-9_-]{0,31}")) throw new IllegalArgumentException("Invalid wall id.");
        BuilderSelection.Selection selection = selections.get(player.getUniqueId());
        if (selection == null || !selection.complete()) throw new IllegalArgumentException("Select pos1 and pos2 first.");
        if (!selection.world().equals(stage.world())) throw new IllegalArgumentException("Selection must be in stage world " + stage.world());

        StageBounds bounds = new StageBounds(selection.first(), selection.second());
        long volume = (long) (bounds.max().x() - bounds.min().x() + 1)
            * (bounds.max().y() - bounds.min().y() + 1) * (bounds.max().z() - bounds.min().z() + 1);
        if (volume > MAX_WALL_BLOCKS) throw new IllegalArgumentException("Wall selection exceeds " + MAX_WALL_BLOCKS + " blocks.");
        WallDefinition previous = stage.walls().get(wallId);
        WallDefinition wall = new WallDefinition(parseBoolean(args[3]));
        if (previous != null) wall.triggers().addAll(previous.triggers());
        for (int x = bounds.min().x(); x <= bounds.max().x(); x++) {
            for (int y = bounds.min().y(); y <= bounds.max().y(); y++) {
                for (int z = bounds.min().z(); z <= bounds.max().z(); z++) {
                    Block block = player.getWorld().getBlockAt(x, y, z);
                    if (!block.getType().isAir()) {
                        String unsafe = WallSafety.unsafeReason(block);
                        if (unsafe != null) throw new IllegalArgumentException("Unsafe wall block at " + position(block) + ": " + unsafe);
                        wall.blocks().add(new WallBlockSnapshot(position(block), block.getBlockData().getAsString()));
                    }
                }
            }
        }
        if (wall.blocks().isEmpty()) throw new IllegalArgumentException("Selection contains no wall blocks.");
        Set<BlockPosition> wallPositions = wall.blocks().stream().map(WallBlockSnapshot::position).collect(Collectors.toSet());
        for (WallBlockSnapshot block : wall.blocks()) {
            if (WallSafety.hasAdjacentFluid(player.getWorld(), block.position(), wallPositions)) {
                throw new IllegalArgumentException("Wall is adjacent to fluid at " + block.position() + ". Add a permanent dry barrier first.");
            }
        }
        int existingBlocks = stage.walls().entrySet().stream().filter(entry -> !entry.getKey().equals(wallId))
            .mapToInt(entry -> entry.getValue().blocks().size()).sum();
        if (existingBlocks + wall.blocks().size() > StageValidator.MAX_STAGE_WALL_BLOCKS) {
            throw new IllegalArgumentException("Stage wall total exceeds " + StageValidator.MAX_STAGE_WALL_BLOCKS + " blocks.");
        }
        Set<BlockPosition> otherWallPositions = stage.walls().entrySet().stream().filter(entry -> !entry.getKey().equals(wallId))
            .flatMap(entry -> entry.getValue().blocks().stream()).map(WallBlockSnapshot::position).collect(Collectors.toSet());
        for (BlockPosition block : wallPositions) {
            if (otherWallPositions.contains(block)) throw new IllegalArgumentException("Wall overlaps another wall at " + block);
        }
        stage.walls().put(wallId, wall);
        repository.save(stage);
        wallService.applyDefaults(stage);
        sender.sendMessage("§aSaved wall " + wallId + " with " + wall.blocks().size() + " blocks.");
        return true;
    }

    private boolean trigger(CommandSender sender, String[] args) throws IOException {
        if (args.length != 4 || (!args[0].equalsIgnoreCase("add") && !args[0].equalsIgnoreCase("remove"))) {
            throw new IllegalArgumentException("Usage: /fw trigger <add|remove> <stage> <wall-id> <pad|lever|button>");
        }
        boolean remove = args[0].equalsIgnoreCase("remove");
        Player player = requirePlayer(sender);
        StageDefinition stage = requireStage(args[1]);
        requireEditable(stage);
        WallDefinition wall = Optional.ofNullable(stage.walls().get(args[2])).orElseThrow(() -> new IllegalArgumentException("Unknown wall: " + args[2]));
        requireStageWorld(player, stage);
        Block block = target(player);
        TriggerType requested = TriggerType.parse(args[3]);
        TriggerType actual = inferTriggerType(block, true);
        if (requested != actual) throw new IllegalArgumentException("Target is " + actual.key() + ", not " + requested.key());
        TriggerDefinition trigger = new TriggerDefinition(requested, position(block));
        if (remove) {
            if (!wall.triggers().remove(trigger)) throw new IllegalArgumentException("That trigger is not registered on " + args[2] + ".");
        } else if (!wall.triggers().contains(trigger)) {
            wall.triggers().add(trigger);
        }
        repository.save(stage);
        sender.sendMessage("§a" + (remove ? "Removed " : "Added ") + requested.key() + " trigger "
            + (remove ? "from " : "to ") + args[2] + ".");
        return true;
    }

    private void createReferenceStage(Player player, String id) throws IOException {
        if (repository.find(id).isPresent()) throw new IllegalArgumentException("Stage already exists: " + id);
        World world = player.getWorld();
        int baseX = player.getLocation().getBlockX() + 4;
        int baseY = player.getLocation().getBlockY() - 1;
        int baseZ = player.getLocation().getBlockZ() - 6;

        for (int x = baseX - 2; x <= baseX + 18; x++) {
            for (int y = baseY + 1; y <= baseY + 4; y++) {
                for (int z = baseZ; z <= baseZ + 12; z++) {
                    if (!world.getBlockAt(x, y, z).getType().isAir()) {
                        throw new IllegalArgumentException("Reference build volume is not empty at " + new BlockPosition(x, y, z));
                    }
                }
            }
        }

        StageDefinition stage = repository.create(id, world.getName());
        Map<Block, BlockData> original = new LinkedHashMap<>();
        try {
            stage.setBounds(new StageBounds(
                new BlockPosition(baseX, baseY, baseZ), new BlockPosition(baseX + 18, baseY + 5, baseZ + 12)));
            stage.setStartTrigger(new TriggerDefinition(TriggerType.BUTTON,
                new BlockPosition(baseX - 2, baseY + 1, baseZ + 6)));
            stage.spawns().put(Role.WADE, new StageLocation(baseX + 1.5, baseY + 1.0, baseZ + 3.5, -90, 0));
            stage.spawns().put(Role.EMBER, new StageLocation(baseX + 1.5, baseY + 1.0, baseZ + 9.5, -90, 0));
            stage.finishes().put(Role.WADE, new FinishDefinition(
                new BlockPosition(baseX + 16, baseY, baseZ + 3), "minecraft:light_blue_glazed_terracotta"));
            stage.finishes().put(Role.EMBER, new FinishDefinition(
                new BlockPosition(baseX + 16, baseY, baseZ + 9), "minecraft:orange_glazed_terracotta"));
            stage.setGoal("Wade and Ember must cooperate through both gates and stand on their matching exits.");
            stage.setBotBrief("Use the pressure plate and lever/button, then take only your safe liquid lane and avoid green poison.");
            stage.setFinishHoldTicks(10);

            WallDefinition visibleGate = new WallDefinition(true);
            for (int y = baseY + 1; y <= baseY + 3; y++) {
                for (int z = baseZ + 1; z <= baseZ + 5; z++) {
                    visibleGate.blocks().add(new WallBlockSnapshot(
                        new BlockPosition(baseX + 8, y, z), "minecraft:red_stained_glass"));
                }
            }
            visibleGate.triggers().add(new TriggerDefinition(TriggerType.PAD,
                new BlockPosition(baseX + 3, baseY + 1, baseZ + 9)));
            visibleGate.triggers().add(new TriggerDefinition(TriggerType.PAD,
                new BlockPosition(baseX + 5, baseY + 1, baseZ + 9)));
            stage.walls().put("plate-gate", visibleGate);

            WallDefinition hiddenGate = new WallDefinition(false);
            for (int z = baseZ + 7; z <= baseZ + 11; z++) {
                hiddenGate.blocks().add(new WallBlockSnapshot(
                    new BlockPosition(baseX + 8, baseY, z), "minecraft:blue_stained_glass"));
            }
            hiddenGate.triggers().add(new TriggerDefinition(TriggerType.LEVER,
                new BlockPosition(baseX + 9, baseY + 1, baseZ + 2)));
            hiddenGate.triggers().add(new TriggerDefinition(TriggerType.BUTTON,
                new BlockPosition(baseX + 10, baseY + 1, baseZ + 2)));
            stage.walls().put("switch-gate", hiddenGate);

            if (!StageValidator.validateGlobal(stage, repository.all()).isEmpty()) {
                throw new IllegalArgumentException("Reference stage overlaps an enabled stage: "
                    + String.join("; ", StageValidator.validateGlobal(stage, repository.all())));
            }

            for (int x = baseX; x <= baseX + 18; x++) {
                for (int z = baseZ; z <= baseZ + 12; z++) {
                    setReferenceBlock(original, world, x, baseY, z, Material.SMOOTH_STONE.createBlockData());
                }
            }
            // Permanent perimeter and lane divider make both dynamic devices
            // unavoidable without overlapping their snapshots.
            for (int y = baseY + 1; y <= baseY + 3; y++) {
                for (int x = baseX; x <= baseX + 18; x++) {
                    setReferenceBlock(original, world, x, y, baseZ, Material.WHITE_CONCRETE.createBlockData());
                    setReferenceBlock(original, world, x, y, baseZ + 6, Material.WHITE_CONCRETE.createBlockData());
                    setReferenceBlock(original, world, x, y, baseZ + 12, Material.WHITE_CONCRETE.createBlockData());
                }
                for (int z = baseZ; z <= baseZ + 12; z++) {
                    setReferenceBlock(original, world, baseX, y, z, Material.WHITE_CONCRETE.createBlockData());
                    setReferenceBlock(original, world, baseX + 18, y, z, Material.WHITE_CONCRETE.createBlockData());
                }
            }
            setReferenceBlock(original, world, baseX - 2, baseY, baseZ + 6, Material.SMOOTH_STONE.createBlockData());
            setReferenceBlock(original, world, baseX - 2, baseY + 1, baseZ + 6,
                Bukkit.createBlockData("minecraft:oak_button[face=floor,facing=north,powered=false]"));

            setReferenceBlock(original, world, baseX + 3, baseY + 1, baseZ + 9,
                Material.STONE_PRESSURE_PLATE.createBlockData());
            setReferenceBlock(original, world, baseX + 5, baseY + 1, baseZ + 9,
                Material.STONE_PRESSURE_PLATE.createBlockData());
            setReferenceBlock(original, world, baseX + 9, baseY + 1, baseZ + 2,
                Bukkit.createBlockData("minecraft:lever[face=floor,facing=north,powered=false]"));
            setReferenceBlock(original, world, baseX + 10, baseY + 1, baseZ + 2,
                Bukkit.createBlockData("minecraft:oak_button[face=floor,facing=north,powered=false]"));

            for (WallBlockSnapshot snapshot : visibleGate.blocks()) {
                setReferenceBlock(original, world, snapshot.position().x(), snapshot.position().y(), snapshot.position().z(),
                    Bukkit.createBlockData(snapshot.blockData()));
            }
            for (WallBlockSnapshot snapshot : hiddenGate.blocks()) {
                setReferenceBlock(original, world, snapshot.position().x(), baseY - 1, snapshot.position().z(),
                    Material.AIR.createBlockData());
                setReferenceBlock(original, world, snapshot.position().x(), baseY - 2, snapshot.position().z(),
                    Material.AIR.createBlockData());
                setReferenceBlock(original, world, snapshot.position().x(), snapshot.position().y(), snapshot.position().z(),
                    Bukkit.createBlockData(snapshot.blockData()));
            }

            for (int x = baseX + 11; x <= baseX + 13; x++) {
                for (int z = baseZ + 1; z <= baseZ + 5; z++) {
                    setReferenceBlock(original, world, x, baseY - 1, z, Material.SMOOTH_STONE.createBlockData());
                    setReferenceBlock(original, world, x, baseY, z, Material.WATER.createBlockData());
                }
                for (int z = baseZ + 7; z <= baseZ + 11; z++) {
                    setReferenceBlock(original, world, x, baseY - 1, z, Material.SMOOTH_STONE.createBlockData());
                    setReferenceBlock(original, world, x, baseY, z, Material.LAVA.createBlockData());
                }
            }
            for (int z = baseZ + 2; z <= baseZ + 4; z++) {
                setReferenceBlock(original, world, baseX + 14, baseY, z, Material.GREEN_CONCRETE.createBlockData());
            }
            for (int z = baseZ + 8; z <= baseZ + 10; z++) {
                setReferenceBlock(original, world, baseX + 14, baseY, z, Material.GREEN_CONCRETE.createBlockData());
            }
            setReferenceBlock(original, world, baseX + 16, baseY, baseZ + 3,
                Material.LIGHT_BLUE_GLAZED_TERRACOTTA.createBlockData());
            setReferenceBlock(original, world, baseX + 16, baseY, baseZ + 9,
                Material.ORANGE_GLAZED_TERRACOTTA.createBlockData());

            repository.save(stage);
            wallService.applyDefaults(stage);
            List<String> errors = manager.validate(stage);
            if (!errors.isEmpty()) {
                throw new IllegalArgumentException("Generated reference stage failed validation: " + String.join("; ", errors));
            }
        } catch (RuntimeException | IOException exception) {
            original.forEach((block, data) -> block.setBlockData(data, false));
            try { repository.delete(stage); } catch (IOException cleanup) { exception.addSuppressed(cleanup); }
            throw exception;
        }
    }

    private static void setReferenceBlock(Map<Block, BlockData> original, World world,
                                          int x, int y, int z, BlockData data) {
        Block block = world.getBlockAt(x, y, z);
        original.putIfAbsent(block, block.getBlockData().clone());
        block.setBlockData(data, false);
    }

    private StageDefinition requireStage(String id) {
        return repository.find(id).orElseThrow(() -> new IllegalArgumentException("Unknown stage: " + id));
    }

    private void requireEditable(StageDefinition stage) {
        manager.active()
            .filter(session -> session.stage().id().equals(stage.id()))
            .ifPresent(session -> {
                throw new IllegalArgumentException("Stage " + stage.id() + " is active; stop it before editing.");
            });
    }

    private static TriggerType inferTriggerType(Block block, boolean allowPad) {
        String name = block.getType().name();
        if (block.getType() == Material.LEVER) return TriggerType.LEVER;
        if (name.endsWith("_BUTTON")) return TriggerType.BUTTON;
        if (allowPad && name.endsWith("_PRESSURE_PLATE")) return TriggerType.PAD;
        throw new IllegalArgumentException("Target block is not a supported " + (allowPad ? "pad, lever, or button." : "lever or button."));
    }

    private static boolean parseBoolean(String value) {
        if (value.equalsIgnoreCase("true")) return true;
        if (value.equalsIgnoreCase("false")) return false;
        throw new IllegalArgumentException("Expected true or false, got: " + value);
    }

    private static Player requirePlayer(CommandSender sender) {
        if (!(sender instanceof Player player)) throw new IllegalArgumentException("This command requires an in-game player.");
        return player;
    }

    private static void requireStageWorld(Player player, StageDefinition stage) {
        if (!player.getWorld().getName().equals(stage.world())) throw new IllegalArgumentException("Go to stage world " + stage.world() + " first.");
    }

    private static Block target(Player player) {
        Block block = player.getTargetBlockExact(8);
        if (block == null) throw new IllegalArgumentException("Look at a block within 8 blocks.");
        return block;
    }

    private static BlockPosition position(Block block) {
        return new BlockPosition(block.getX(), block.getY(), block.getZ());
    }

    private void help(CommandSender sender) {
        sender.sendMessage("§6Firewater commands:");
        sender.sendMessage("§e/fw status | reload | wand | pos1 | pos2");
        sender.sendMessage("§e/fw stage create|create-reference|delete|enable|setbounds|setspawn|setstart|setfinish|setgoal|setbrief|sethold|setpoison|validate|start|reset|stop");
        sender.sendMessage("§e/fw wall save|delete|preview|restore <stage> <wall-id> [true|false]");
        sender.sendMessage("§e/fw trigger add|remove <stage> <wall-id> <pad|lever|button>");
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        List<String> values = new ArrayList<>();
        if (args.length == 1) values.addAll(List.of("help", "status", "reload", "wand", "pos1", "pos2", "stage", "wall", "trigger"));
        else if (args.length == 2 && args[0].equalsIgnoreCase("stage")) values.addAll(List.of("create", "create-reference", "delete", "enable", "setbounds", "setspawn", "setstart", "setfinish", "setgoal", "setbrief", "sethold", "setpoison", "validate", "start", "reset", "stop"));
        else if (args.length == 2 && args[0].equalsIgnoreCase("wall")) values.addAll(List.of("save", "delete", "preview", "restore"));
        else if (args.length == 2 && args[0].equalsIgnoreCase("trigger")) values.addAll(List.of("add", "remove"));
        else if (args.length == 3 && List.of("stage", "wall", "trigger").contains(args[0].toLowerCase(Locale.ROOT))) values.addAll(repository.all().stream().map(StageDefinition::id).toList());
        String prefix = args[args.length - 1].toLowerCase(Locale.ROOT);
        return values.stream().filter(value -> value.startsWith(prefix)).toList();
    }
}
