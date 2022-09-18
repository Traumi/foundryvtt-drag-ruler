import {highlightMeasurementTerrainRuler, measureDistances} from "./compatibility.js";
import {getGridPositionFromPixels, getGridPositionFromPixelsObj, getPixelsFromGridPositionObj} from "./foundry_fixes.js";
import {Line} from "./geometry.js";
import {disableSnap, moveWithoutAnimation} from "./keybindings.js";
import {trackRays} from "./movement_tracking.js"
import {findPath, isPathfindingEnabled} from "./pathfinding.js";
import {settingsKey} from "./settings.js";
import {recalculate} from "./socket.js";
import {applyTokenSizeOffset, enumeratedZip, getSnapPointForEntity, getSnapPointForToken, getSnapPointForTokenObj, getTokenShape, highlightTokenShape, sum} from "./util.js";

class DragRulerToken extends Token {
	// Functions below are overridden versions of functions in Ruler
	constructor(document) {
		super(document);
	}

	checkCollisionReplaced(destination, {origin, type="move", mode="any"}={}) {

		// The test origin is the last confirmed valid position of the Token
		const center = origin || {x: this.x+1, y: this.y+1}; //this.getCenter(this.x, this.y); <- Temporary fix to avoid usebug
		origin = this.getMovementAdjustedPoint(center);
		// The test destination is the adjusted point based on the proposed movement vector
		const dx = destination.x - center.x;
		const dy = destination.y - center.y;
		const offsetX = dx === 0 ? Math.sign(dx) : Math.sign(dx);
		const offsetY = dy === 0 ? Math.sign(dy) : Math.sign(dy);
		destination = this.getMovementAdjustedPoint(destination, {offsetX, offsetY});

		// Reference the correct source object
		let source;
		switch ( type ) {
			case "move":
				const movement = new MovementSource(this);
				source = movement.initialize({x: origin.x, y: origin.y, elevation: this.document.elevation});
				break;
			case "sight":
			source = this.vision; break;
			case "light":
			source = this.light; break;
			case "sound":
			throw new Error("Collision testing for Token sound sources is not supported at this time");
		}

		// Create a movement source passed to the polygon backend
		return CONFIG.Canvas.losBackend.testCollision(origin, destination, {type, mode, source});
	}
}
// This is a modified version of Ruler.moveToken from foundry 0.7.9
export async function moveEntities(draggedEntity, selectedEntities) {
	let wasPaused = game.paused;
	if (wasPaused && !game.user.isGM) {
		ui.notifications.warn(game.i18n.localize("GAME.PausedWarning"));
		return false;
	}
	if (!this.visible || !this.destination) return false;
	if (!draggedEntity) return;

	// Wait until all scheduled measurements are done
	await this.deferredMeasurementPromise;

	// Get the movement rays and check collision along each Ray
	// These rays are center-to-center for the purposes of collision checking
	//const rays = this.dragRulerGetRaysFromWaypoints(this.waypoints, this.destination);
	if ( this.destination )
	this.waypoints = this.waypoints.concat([this.destination]);
	const rays = this.waypoints.slice(1).map((wp, i) => {
		const ray =  new Ray(this.waypoints[i], wp);
		ray.isPrevious = Boolean(this.waypoints[i].isPrevious);
		return ray;
	});
/*

*/
	if (!game.user.isGM && draggedEntity instanceof Token) {
		const hasCollision = selectedEntities.some(token => {
			let savex = token.x
			let savey = token.y
			let isColliding = false;
			let toast = new DragRulerToken(token.document)
			token.checkCollision = toast.checkCollisionReplaced

			for(let i = 0 ; i < rays.length ; ++i){
				if(token.checkCollision(rays[i].B)) isColliding = true;
				token.x = rays[i].B.x
				token.y = rays[i].B.y
			}
			token.checkCollision = toast.checkCollision
			token.x = savex
			token.y = savey
			return isColliding;
			/*const offset = calculateEntityOffset(token, draggedEntity);
			const offsetRays = rays.filter(ray => !ray.isPrevious).map(ray => applyOffsetToRay(ray, offset))
			if (window.WallHeight) {
				window.WallHeight.addBoundsToRays(offsetRays, draggedEntity);
			}
			return offsetRays.some(r => canvas.walls.checkCollision(r));*/
		})
		if (hasCollision) {
			ui.notifications.error(game.i18n.localize("ERROR.TokenCollide"));
			this._endMeasurement();
			return true;
		}
	}

	// Execute the movement path.
	// Transform each center-to-center ray into a top-left to top-left ray using the prior token offsets.
	this._state = Ruler.STATES.MOVING;
	await animateEntities.call(this, selectedEntities, draggedEntity, rays, wasPaused);

	// Once all animations are complete we can clear the ruler
	if (this.draggedEntity?.id === draggedEntity.id)
		this._endMeasurement();
}

// This is a modified version code extracted from Ruler.moveToken from foundry 0.7.9
async function animateEntities(entities, draggedEntity, draggedRays, wasPaused) {
	const newRays = draggedRays.filter(r => !r.isPrevious);
	const entityAnimationData = entities.map(entity => {
		const entityOffset = calculateEntityOffset(entity, draggedEntity);
		const offsetRays = newRays.map(ray => applyOffsetToRay(ray, entityOffset));

		// Determine offset relative to the Token top-left.
		// This is important so we can position the token relative to the ruler origin for non-1x1 tokens.
		const firstWaypoint = this.waypoints.find(w => !w.isPrevious);
		const origin = [firstWaypoint.x + entityOffset.x, firstWaypoint.y + entityOffset.y];
		let dx, dy;
		if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
			dx = entity.data.x - origin[0];
			dy = entity.data.y - origin[1];
		}
		else {
			dx = entity.data.x - origin[0];
			dy = entity.data.y - origin[1];
		}

		return {entity, rays: offsetRays, dx, dy};
	});

	const isToken = draggedEntity instanceof Token;
	const animate = isToken && !moveWithoutAnimation;
	const startWaypoint = animate ? 0 : entityAnimationData[0].rays.length - 1;

	// This is a flag of the "Monk's Active Tile Triggers" module that signals that the movement should be cancelled early
	this.cancelMovement = false;

	for (let i = startWaypoint;i < entityAnimationData[0].rays.length; i++) {
		if (!wasPaused && game.paused) break;
		const entityPaths = entityAnimationData.map(({entity, rays, dx, dy}) => {
			const ray = rays[i];
			const dest = [ray.B.x, ray.B.y];
			const path = new Ray({x: entity.x, y: entity.y}, {x: dest[0] + dx, y: dest[1] + dy});
			return {entity, path};
		});
		const updates = entityPaths.map(({entity, path}) => {
			return {x: path.B.x, y: path.B.y, _id: entity.id};
		});
		await draggedEntity.scene.updateEmbeddedDocuments(draggedEntity.constructor.embeddedName, updates, {animate});
		let nextmove = false;
		let lastx = draggedEntity.x
		let lasty = draggedEntity.y
		while(!nextmove){
			await sleep(30);
			if(lastx == draggedEntity.x && lasty == draggedEntity.y)
				nextmove = true;
			else{
				lastx = draggedEntity.x
				lasty = draggedEntity.y
			}
		}
		if (animate)
			await Promise.all(entityPaths.map(({entity}) => CanvasAnimation.getAnimation(entity.movementAnimationName)?.promise));
		
		// This is a flag of the "Monk's Active Tile Triggers" module that signals that the movement should be cancelled early
		if (this.cancelMovement) {
			entityAnimationData.forEach(ead => ead.rays = ead.rays.slice(0, i + 1));
			break;
		}
	}
	if (isToken)
		trackRays(entities, entityAnimationData.map(({rays}) => rays)).then(() => recalculate(entities));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateEntityOffset(entityA, entityB) {
	return {x: entityA.data.x - entityB.data.x, y: entityA.data.y - entityB.data.y};
}

function applyOffsetToRay(ray, offset) {
	const newRay = new Ray({x: ray.A.x + offset.x, y: ray.A.y + offset.y}, {x: ray.B.x + offset.x, y: ray.B.y + offset.y});
	newRay.isPrevious = ray.isPrevious;
	return newRay;
}

// This is a modified version of Ruler._onMouseMove from foundry 0.7.9
export function onMouseMove(event) {
	if (this._state === Ruler.STATES.MOVING) return;

	// Extract event data
	const destination = {x: event.data.destination.x + this.rulerOffset.x, y: event.data.destination.y + this.rulerOffset.y}

	// Hide any existing Token HUD
	canvas.hud.token.clear();
	delete event.data.hudState;

	// Draw measurement updates
	scheduleMeasurement.call(this, destination, event);
}

function scheduleMeasurement(destination, event) {
	const measurementInterval = 50;
	const mt = event._measureTime || 0;
	const originalEvent = event.data.originalEvent;
	if (Date.now() - mt > measurementInterval) {
		this.measure(destination, {snap: !disableSnap});
		event._measureTime = Date.now();
		this._state = Ruler.STATES.MEASURING;
		cancelScheduledMeasurement.call(this);
	}
	else {
		this.deferredMeasurementData = {destination, event};
		if (!this.deferredMeasurementTimeout) {
			this.deferredMeasurementPromise = new Promise((resolve, reject) => this.deferredMeasurementResolve = resolve);
			this.deferredMeasurementTimeout = window.setTimeout(() => scheduleMeasurement.call(this, this.deferredMeasurementData.destination, this.deferredMeasurementData.event), measurementInterval);
		}
	}
}

export function cancelScheduledMeasurement() {
	window.clearTimeout(this.deferredMeasurementTimeout);
	this.deferredMeasurementTimeout = undefined;
	this.deferredMeasurementResolve?.();
}

// This is a modified version of Ruler.measure form foundry 0.7.9
export function measure(destination, options={}) {

	const isToken = this.draggedEntity instanceof Token;
	if (isToken && !this.draggedEntity.isVisible)
		return []

	options.snap = options.snap ?? !disableSnap;

	if (options.snap) {
		destination = getSnapPointForEntity(destination.x, destination.y, this.draggedEntity);
	}

	this.dragRulerRemovePathfindingWaypoints();

	if (isToken && isPathfindingEnabled.call(this)) {
		const from = getGridPositionFromPixelsObj(this.waypoints[this.waypoints.length - 1]);
		const to = getGridPositionFromPixelsObj(destination);
		let path = findPath(from, to, this.draggedEntity, this.waypoints);
		if (path) {
			path = path.map(point => getSnapPointForTokenObj(getPixelsFromGridPositionObj(point), this.draggedEntity));

			// If the token is snapped to the grid, the first point of the path is already handled by the ruler
			if (path[0].x === this.waypoints[this.waypoints.length - 1].x && path[0].y === this.waypoints[this.waypoints.length - 1].y)
				path = path.slice(1);

			// If snapping is enabled, the last point of the path is already handled by the ruler
			if (options.snap)
				path = path.slice(0, path.length - 1);

			for (const point of path) {
				point.isPathfinding = true;
				this.labels.addChild(new PreciseText("", CONFIG.canvasTextStyle));
			}
			this.waypoints = this.waypoints.concat(path);
		}
		else {
			// Don't show a path if the pathfinding yields no result to show the user that the destination is unreachable
			destination = this.waypoints[this.waypoints.length - 1];
		}
	}

	if(options.gridSpaces === undefined) {
		options.gridSpaces = canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS;
	}

	if (canvas.grid.diagonalRule === "EUCL") {
		options.gridSpaces = false;
		options.ignoreGrid = true;
	}

	if(options.ignoreGrid === undefined) {
		options.ignoreGrid = false;
	}

	options.enableTerrainRuler = isToken && game.modules.get("terrain-ruler")?.active;

	const waypoints = this.waypoints.concat([destination]);
	// Move the waypoints to the center of the grid if a size is used that measures from edge to edge
	const centeredWaypoints = isToken ? applyTokenSizeOffset(waypoints, this.draggedEntity) : duplicate(waypoints);
	// Foundries native ruler requires the waypoints to sit in the dead center of the square to work properly
	if (!options.enableTerrainRuler && !options.ignoreGrid)
		centeredWaypoints.forEach(w => [w.x, w.y] = canvas.grid.getCenter(w.x, w.y));

	const r = this.ruler;
	this.destination = destination;

	// Iterate over waypoints and construct segment rays
	const segments = [];
	const centeredSegments = []
	for (let [i, dest] of waypoints.slice(1).entries()) {
		const centeredDest = centeredWaypoints[i + 1]
		const origin = waypoints[i];
		const centeredOrigin = centeredWaypoints[i]
		const label = this.labels.children[i];
		const ray = new Ray(origin, dest);
		const centeredRay = new Ray(centeredOrigin, centeredDest)
		ray.isPrevious = Boolean(origin.isPrevious);
		centeredRay.isPrevious = ray.isPrevious;
		ray.dragRulerVisitedSpaces = origin.dragRulerVisitedSpaces;
		centeredRay.dragRulerVisitedSpaces = ray.dragRulerVisitedSpaces;
		ray.dragRulerFinalState = origin.dragRulerFinalState;
		centeredRay.dragRulerFinalState = ray.dragRulerFinalState;
		if (ray.distance < 10) {
			if (label) label.visible = false;
			continue;
		}
		segments.push({ ray, label });
		centeredSegments.push({ray: centeredRay, label})
	}

	const shape = isToken ? getTokenShape(this.draggedEntity) : null;

	// Compute measured distance
	const distances = measureDistances(centeredSegments, this.draggedEntity, shape, options);

	let totalDistance = 0;
	for (let [i, d] of distances.entries()) {
		let s = centeredSegments[i];
		s.startDistance = totalDistance
		totalDistance += d;
		s.last = i === (centeredSegments.length - 1);
		s.distance = d;
		s.text = this._getSegmentLabel(s, totalDistance);
	}

	// Clear the grid highlight layer
	const hlt = canvas.grid.highlightLayers[this.name] || canvas.grid.addHighlightLayer(this.name);
	hlt.clear();
	// Draw measured path
	r.clear();
	let rulerColor
	if (!options.gridSpaces || canvas.grid.type === CONST.GRID_TYPES.GRIDLESS)
		rulerColor = this.dragRulerGetColorForDistance(totalDistance);
	else
		rulerColor = this.color
	for (const [i, s, cs] of enumeratedZip([...segments].reverse(), [...centeredSegments].reverse())) {
		const { label, text, last } = cs;

		// Draw line segment
		const opacityMultiplier = s.ray.isPrevious ? 0.33 : 1;
		r.lineStyle(6, 0x000000, 0.5 * opacityMultiplier).moveTo(s.ray.A.x, s.ray.A.y).lineTo(s.ray.B.x, s.ray.B.y)
			.lineStyle(4, rulerColor, 0.25 * opacityMultiplier).moveTo(s.ray.A.x, s.ray.A.y).lineTo(s.ray.B.x, s.ray.B.y);

		// Draw the distance label just after the endpoint of the segment
		if (label) {
			label.text = text;
			label.alpha = last ? 1.0 : 0.5;
			label.visible = true;
			let labelPosition = {x: s.ray.x0, y: s.ray.y0};
			labelPosition.x -= label.width / 2;
			labelPosition.y -= label.height / 2;
			const rayLine = Line.fromPoints(s.ray.A, s.ray.B);
			const rayLabelXHitY = rayLine.calcY(labelPosition.x);
			let innerDistance;
			// If ray hits top or bottom side of label
			if (rayLine.isVertical || rayLabelXHitY < labelPosition.y || rayLabelXHitY > labelPosition.y + label.height)
				innerDistance = Math.abs((label.height / 2) / Math.sin(s.ray.angle));
			// If ray hits left or right side of label
			else
				innerDistance = Math.abs((label.width / 2) / Math.cos(s.ray.angle));
			labelPosition = s.ray.project((s.ray.distance + 50 + innerDistance) / s.ray.distance);
			labelPosition.x -= label.width / 2;
			labelPosition.y -= label.height / 2;
			label.position.set(labelPosition.x, labelPosition.y);
		}

		// Highlight grid positions
		if (isToken && canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS && options.gridSpaces) {
			if (options.enableTerrainRuler) {
				highlightMeasurementTerrainRuler.call(this, cs.ray, cs.startDistance, shape, opacityMultiplier)
			}
			else {
				const previousSegments = centeredSegments.slice(0, segments.length - 1 - i);
				highlightMeasurementNative.call(this, cs.ray, previousSegments, shape, opacityMultiplier);
			}
		}
	}

	// Draw endpoints
	for (let p of waypoints) {
		r.lineStyle(2, 0x000000, 0.5).beginFill(rulerColor, 0.25).drawCircle(p.x, p.y, 8);
	}

	// Return the measured segments
	return segments;
}

export function highlightMeasurementNative(ray, previousSegments, tokenShape=[{x: 0, y: 0}], alpha=1) {
	const spacer = canvas.scene.data.gridType === CONST.GRID_TYPES.SQUARE ? 1.41 : 1;
	const nMax = Math.max(Math.floor(ray.distance / (spacer * Math.min(canvas.grid.w, canvas.grid.h))), 1);
	const tMax = Array.fromRange(nMax+1).map(t => t / nMax);

	// Track prior position
	let prior = null;

	// Iterate over ray portions
	for ( let [i, t] of tMax.reverse().entries() ) {
		let {x, y} = ray.project(t);

		// Get grid position
		let [x0, y0] = (i === 0) ? [null, null] : prior;
		let [x1, y1] = canvas.grid.grid.getGridPositionFromPixels(x, y);
		if ( x0 === x1 && y0 === y1 ) continue;

		// Highlight the grid position
		let [xgtl, ygtl] = canvas.grid.grid.getPixelsFromGridPosition(x1, y1);
		let [xg, yg] = canvas.grid.grid.getCenter(xgtl, ygtl);
		const pathUntilSpace = previousSegments.concat([{ray: new Ray(ray.A, {x: xg, y: yg})}]);
		const distance = sum(canvas.grid.measureDistances(pathUntilSpace, {gridSpaces: true}));
		const color = this.dragRulerGetColorForDistance(distance);
		const snapPoint = getSnapPointForToken(...canvas.grid.getTopLeft(x, y), this.draggedEntity);
		const [snapX, snapY] = getGridPositionFromPixels(snapPoint.x + 1, snapPoint.y + 1);

		prior = [x1, y1];

		// If the positions are not neighbors, also highlight their halfway point
		if (i > 0 && !canvas.grid.isNeighbor(x0, y0, x1, y1)) {
			let th = tMax[i - 1] - (0.5 / nMax);
			let {x, y} = ray.project(th);
			let [x1h, y1h] = canvas.grid.grid.getGridPositionFromPixels(x, y);
			let [xghtl, yghtl] = canvas.grid.grid.getPixelsFromGridPosition(x1h, y1h);
			let [xgh, ygh] = canvas.grid.grid.getCenter(xghtl, yghtl);
			const pathUntilSpace = previousSegments.concat([{ray: new Ray(ray.A, {x: xgh, y: ygh})}]);
			const distance = sum(canvas.grid.measureDistances(pathUntilSpace, {gridSpaces: true}));
			const color = this.dragRulerGetColorForDistance(distance);
			const snapPoint = getSnapPointForToken(...canvas.grid.getTopLeft(x, y), this.draggedEntity);
			const [snapX, snapY] = getGridPositionFromPixels(snapPoint.x + 1, snapPoint.y + 1);
			highlightTokenShape.call(this, {x: snapX, y: snapY}, tokenShape, color, alpha);
		}

		highlightTokenShape.call(this, {x: snapX, y: snapY}, tokenShape, color, alpha);
	}
}
