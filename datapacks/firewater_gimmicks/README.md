# Firewater Gimmicks (Legacy Builder)

The live Fire/Water rules are implemented by the `FirewaterGame` Paper plugin.
This pack remains installed only so old red-glass registrations can be restored
and removed during migration. Its tick and load-time scoreboard runtime are
intentionally disabled, preventing it from racing the plugin for the same wall
blocks.

Before registering the same wall in `FirewaterGame`, restore the legacy wall
once with:

```mcfunction
/function fwg:legacy/disable
```

The cleanup is safe to run again. It restores registered walls, removes every
legacy wall/scan marker, and removes the `fwg` scoreboard objective. A repeated
run may report that the already-absent objective could not be removed; that
command failure is harmless and the resulting world state is the same.

## Legacy Red Glass Trigger

Historical behavior (no longer run every tick):

- If any player stands on `minecraft:red_glazed_terracotta`, registered red glass devices disappear.
- When no player is standing on `minecraft:red_glazed_terracotta`, registered red glass devices are restored.

Legacy setup is documented only to identify old maps. Because `fwg:load` no
longer creates its scoreboard, do not run `/reload` or register new walls with
this data pack. Historical maps used `red_glazed_terracotta` as the trigger pad
and face-connected `red_stained_glass` as the device, registered with:

```mcfunction
/function fwg:builder/register_red_glass
```

Registration scans up to 256 face-connected `red_stained_glass` blocks.

Useful commands:

```mcfunction
/function fwg:builder/help
/function fwg:red/reset
/function fwg:builder/clear_red_glass_nearby
/function fwg:builder/clear_all_red_glass_markers
```

`clear_all_red_glass_markers` also removes red stained glass blocks at registered marker positions.

Do not add `fwg:tick` back to the Minecraft tick tag while the
`FirewaterGame` plugin is installed. Wall visibility, triggers, hazards,
attempt reset, and exits must have a single authoritative runtime.
