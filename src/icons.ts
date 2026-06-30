import { StatusIconKind, PriorityIconKind, StatusDef, PriorityDef } from "./constants";

/** An emoji glyph wrapped to sit where a 16px icon would. */
function emojiSpan(emoji: string): HTMLSpanElement {
	const span = activeDocument.createElement("span");
	span.className = "bk-emoji";
	span.textContent = emoji;
	return span;
}

/** Status glyph: the chosen emoji if set, otherwise the drawn Linear icon. */
export function statusGlyph(def: StatusDef): Node {
	return def.emoji ? emojiSpan(def.emoji) : statusIcon(def.icon, def.color);
}

/** Priority glyph: the chosen emoji if set, otherwise the drawn icon (tinted). */
export function priorityGlyph(def: PriorityDef): Node {
	if (def.emoji) return emojiSpan(def.emoji);
	const icon = priorityIcon(def.icon);
	if (def.color) icon.style.color = def.color;
	return icon;
}

/**
 * Linear-style status & priority glyphs as inline SVG. Returned as SVGElement so
 * callers can append directly. Sized to 16px and colored via the `color` arg
 * (statuses) or `currentColor` (priorities, which inherit text color).
 */

function svg(width = 16, height = 16): SVGSVGElement {
	const el = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("viewBox", "0 0 16 16");
	el.setAttribute("width", String(width));
	el.setAttribute("height", String(height));
	el.setAttribute("fill", "none");
	el.addClass("bk-icon");
	return el;
}

function child(parent: SVGElement, tag: string, attrs: Record<string, string>): SVGElement {
	const el = activeDocument.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	parent.appendChild(el);
	return el;
}

export function statusIcon(kind: StatusIconKind, color: string): SVGSVGElement {
	const el = svg();
	el.style.color = color;
	switch (kind) {
		case "backlog":
			// Dashed ring.
			child(el, "circle", {
				cx: "8", cy: "8", r: "6.5",
				stroke: color, "stroke-width": "1.5", fill: "none",
				"stroke-dasharray": "1.6 1.8", "stroke-linecap": "round",
			});
			break;
		case "unstarted":
			// Empty ring.
			child(el, "circle", {
				cx: "8", cy: "8", r: "6.5",
				stroke: color, "stroke-width": "1.5", fill: "none",
			});
			break;
		case "started":
			// Ring + filled wedge (clockwise from 12 o'clock, ~55%).
			child(el, "circle", {
				cx: "8", cy: "8", r: "6.5",
				stroke: color, "stroke-width": "1.5", fill: "none",
			});
			child(el, "path", {
				d: "M8 8 L8 3.5 A4.5 4.5 0 1 1 4.18 5.7 Z",
				fill: color,
			});
			break;
		case "done":
			child(el, "circle", { cx: "8", cy: "8", r: "7", fill: color });
			child(el, "path", {
				d: "M4.7 8.2 L7 10.4 L11.3 5.8",
				stroke: "#fff", "stroke-width": "1.6",
				"stroke-linecap": "round", "stroke-linejoin": "round", fill: "none",
			});
			break;
		case "canceled":
			child(el, "circle", { cx: "8", cy: "8", r: "7", fill: color });
			child(el, "path", {
				d: "M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5",
				stroke: "#fff", "stroke-width": "1.6", "stroke-linecap": "round",
			});
			break;
	}
	return el;
}

/** Vertical signal bars used by high/medium/low. */
function bars(filled: number): SVGSVGElement {
	const el = svg();
	el.addClass("bk-icon-current");
	const cfg = [
		{ x: 1.5, y: 9.5, h: 4.5 },
		{ x: 6.25, y: 6.5, h: 7.5 },
		{ x: 11, y: 3.5, h: 10.5 },
	];
	cfg.forEach((b, i) => {
		child(el, "rect", {
			x: String(b.x), y: String(b.y),
			width: "3.5", height: String(b.h), rx: "1",
			fill: "currentColor",
			"fill-opacity": i < filled ? "1" : "0.28",
		});
	});
	return el;
}

export function priorityIcon(kind: PriorityIconKind): SVGSVGElement {
	switch (kind) {
		case "high": return bars(3);
		case "medium": return bars(2);
		case "low": return bars(1);
		case "urgent": {
			const el = svg();
			el.addClass("bk-icon-urgent");
			child(el, "rect", {
				x: "1.5", y: "1.5", width: "13", height: "13", rx: "3.5",
				fill: "currentColor",
			});
			child(el, "rect", { x: "7", y: "3.75", width: "2", height: "5.5", rx: "1", fill: "#fff" });
			child(el, "rect", { x: "7", y: "10.75", width: "2", height: "2", rx: "1", fill: "#fff" });
			return el;
		}
		case "none":
		default: {
			const el = svg();
			el.addClass("bk-icon-current");
			[2, 7, 12].forEach((x) => {
				child(el, "rect", {
					x: String(x), y: "7.25", width: "2.5", height: "1.5", rx: "0.75",
					fill: "currentColor", "fill-opacity": "0.5",
				});
			});
			return el;
		}
	}
}

/** Sub-task rollup ring (used by the N/M pill). */
export function rollupRing(done: number, total: number): SVGSVGElement {
	const el = svg(13, 13);
	const r = 5;
	const c = 2 * Math.PI * r;
	const frac = total > 0 ? done / total : 0;
	child(el, "circle", {
		cx: "8", cy: "8", r: String(r),
		stroke: "currentColor", "stroke-width": "2", fill: "none", "stroke-opacity": "0.25",
	});
	if (frac > 0) {
		child(el, "circle", {
			cx: "8", cy: "8", r: String(r),
			stroke: "currentColor", "stroke-width": "2", fill: "none",
			"stroke-dasharray": `${c * frac} ${c}`,
			"stroke-linecap": "round", transform: "rotate(-90 8 8)",
		});
	}
	return el;
}
