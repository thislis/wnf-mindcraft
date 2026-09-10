package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.OfflinePlayer;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;

import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;

public final class RoleService {
    private final Map<Role, String> names = new EnumMap<>(Role.class);
    private final Map<Role, String> manualNames = new EnumMap<>(Role.class);

    public RoleService(String wadeName, String emberName) {
        String validatedWadeName = validateName(wadeName);
        String validatedEmberName = validateName(emberName);
        if (validatedWadeName.equalsIgnoreCase(validatedEmberName)) {
            throw new IllegalArgumentException("Wade and Ember must use different player names");
        }
        names.put(Role.WADE, validatedWadeName);
        names.put(Role.EMBER, validatedEmberName);
    }

    public String name(Role role) {
        return manualNames.getOrDefault(role, names.get(role));
    }

    public Optional<Role> roleOf(Player player) {
        return roleOf(player.getName());
    }

    public Optional<Role> roleOf(String playerName) {
        return java.util.Arrays.stream(Role.values())
            .filter(role -> name(role).equalsIgnoreCase(playerName))
            .findFirst();
    }

    public boolean isManual(Role role) {
        return manualNames.containsKey(role);
    }

    public boolean isManual(Player player) {
        return roleOf(player).map(this::isManual).orElse(false);
    }

    public boolean isDedicated(Player player) {
        return roleOf(player).filter(role -> !isManual(role)).isPresent();
    }

    public void loadAssignments(Map<Role, String> assignments) {
        Map<Role, String> validated = new EnumMap<>(Role.class);
        assignments.forEach((role, name) -> validated.put(role, validateName(name)));
        String wade = validated.getOrDefault(Role.WADE, names.get(Role.WADE));
        String ember = validated.getOrDefault(Role.EMBER, names.get(Role.EMBER));
        if (wade.equalsIgnoreCase(ember)) {
            throw new IllegalArgumentException("Wade and Ember must use different player names");
        }
        manualNames.clear();
        manualNames.putAll(validated);
    }

    public void assign(Role role, String playerName) {
        String validated = validateName(playerName);
        validateDistinct(role, validated);
        manualNames.put(role, validated);
    }

    public void clearAssignment(Role role) {
        validateDistinct(role, names.get(role));
        manualNames.remove(role);
    }

    private void validateDistinct(Role role, String playerName) {
        for (Role other : Role.values()) {
            if (other != role && name(other).equalsIgnoreCase(playerName)) {
                throw new IllegalArgumentException(playerName + " already has the " + other.key() + " role.");
            }
        }
    }

    public Player online(Role role) {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.getName().equalsIgnoreCase(name(role))) return player;
        }
        return null;
    }

    public void enterStage(Player player, Role role) {
        if (isManual(player)) {
            refreshRoleEffects(player, role);
            return;
        }
        enforceDedicatedBaseline(player);
        clearEffects(player);
        player.setFireTicks(0);
        player.setFoodLevel(20);
        player.setSaturation(20.0f);
        if (!player.isDead()) player.setHealth(player.getMaxHealth());
        applyRoleEffect(player, role);
    }

    public void refreshRoleEffects(Player player, Role role) {
        enforceDedicatedBaseline(player);
        if (isManual(player)) {
            // Short-lived effects expire after leaving the stage or stopping the plugin.
            // Do not replace stronger/longer effects belonging to the player.
            PotionEffectType type = role == Role.WADE ? PotionEffectType.WATER_BREATHING : PotionEffectType.FIRE_RESISTANCE;
            PotionEffect current = player.getPotionEffect(type);
            if (current == null || (!current.isInfinite() && current.getDuration() <= 20 && current.getAmplifier() == 0)) {
                player.addPotionEffect(new PotionEffect(type, 40, 0, false, false, true));
            }
        } else {
            applyRoleEffect(player, role);
        }
        if (role == Role.EMBER) player.setFireTicks(0);
    }

    public void restore(Player player) {
        enforceIdle(player);
    }

    public void restoreAll() {
        for (Role role : Role.values()) {
            Player player = online(role);
            if (player != null) enforceIdle(player);
            if (isManual(role)) continue;
            OfflinePlayer offline = Bukkit.getOfflinePlayer(name(role));
            if (offline.isOp()) offline.setOp(false);
        }
    }

    public void enforceIdleOnline() {
        for (Role role : Role.values()) {
            Player player = online(role);
            if (player != null) enforceIdle(player);
        }
    }

    public void enforceDedicatedBaseline(Player player) {
        if (!isDedicated(player)) return;
        if (player.isOp()) player.setOp(false);
        if (player.getGameMode() != GameMode.ADVENTURE) player.setGameMode(GameMode.ADVENTURE);
        boolean hasInventory = false;
        for (ItemStack item : player.getInventory().getContents()) {
            if (item != null && !item.getType().isAir()) {
                hasInventory = true;
                break;
            }
        }
        if (hasInventory) {
            player.getInventory().clear();
            player.getInventory().setArmorContents(new ItemStack[4]);
            player.getInventory().setItemInOffHand(new ItemStack(Material.AIR));
        }
        if (!player.getItemOnCursor().getType().isAir()) player.setItemOnCursor(new ItemStack(Material.AIR));
    }

    private void enforceIdle(Player player) {
        if (!isDedicated(player)) return;
        enforceDedicatedBaseline(player);
        clearEffects(player);
        player.setFireTicks(0);
        teleportToLobby(player);
    }

    private static void teleportToLobby(Player player) {
        if (Bukkit.getWorlds().isEmpty()) return;
        World lobbyWorld = Bukkit.getWorlds().get(0);
        Location lobby = lobbyWorld.getSpawnLocation().add(0.5, 0.0, 0.5);
        boolean alreadyThere = player.getWorld().equals(lobbyWorld)
            && player.getLocation().distanceSquared(lobby) <= 0.25;
        if (!alreadyThere && !player.teleport(lobby)) {
            throw new IllegalStateException("Could not return dedicated Firewater account " + player.getName() + " to the lobby");
        }
    }

    private static void applyRoleEffect(Player player, Role role) {
        PotionEffectType type = role == Role.WADE ? PotionEffectType.WATER_BREATHING : PotionEffectType.FIRE_RESISTANCE;
        player.addPotionEffect(new PotionEffect(type, PotionEffect.INFINITE_DURATION, 0, false, false, true), true);
    }

    private static void clearEffects(Player player) {
        for (PotionEffect effect : player.getActivePotionEffects()) player.removePotionEffect(effect.getType());
    }

    private static String validateName(String name) {
        if (name == null || !name.matches("[A-Za-z0-9_]{1,16}")) {
            throw new IllegalArgumentException("Invalid Minecraft player name: " + name);
        }
        return name;
    }

}
