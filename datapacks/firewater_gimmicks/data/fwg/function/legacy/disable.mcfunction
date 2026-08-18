function fwg:red/close
kill @e[type=minecraft:marker,tag=fwg.red_glass]
kill @e[type=minecraft:marker,tag=fwg.red_scan_frontier]
kill @e[type=minecraft:marker,tag=fwg.red_scan_visited]
kill @e[type=minecraft:marker,tag=fwg.scan_red_glass]
scoreboard objectives remove fwg
tellraw @s [{"text":"[FWG] ","color":"gold"},{"text":"Legacy state removed: walls restored, markers killed, scoreboard deleted.","color":"yellow"}]
