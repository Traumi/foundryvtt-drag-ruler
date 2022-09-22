# Drag Ruler Temporary fix
This project is a temporary fix for drag-ruler and is not the official mod

It may have some bugs but it should work at least for Foundry v10.285 to v10.286

You can find the original project here : https://github.com/manuelVo/foundryvtt-drag-ruler

When the official update will comes out it should theorically be automatically updated

# Installation

- Find your FoundryData folder (Path in the Configuration tab in the lobby)
- Go to FoundryData/Data/modules/drag-ruler
- Replace all this files by those in this repo : module.json, js/foundry_imports.js, js/main.js, js/movement_tracking, js/pathfinding.js, js/ruler.js, js/settings.js, js/speed_provider.js, js/system.js, js/utils.js

-OR-

- Download the archive in https://github.com/Traumi/foundryvtt-drag-ruler/blob/master/download_zip/drag-ruler-fix-1.rar
- Replace the drag-ruler folder in FoundryData/Data/modules/drag-ruler by the one in the archive

# Last updates

- 22/09/2022 : Linked the module.json to this project
- 22/09/2022 : Fixed a bug where tokens could sometime get stuck into walls

# Known Bug

- Pathfinding doesn't work
