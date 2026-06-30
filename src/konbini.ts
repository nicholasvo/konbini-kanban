/**
 * The empty-column state: a tiny animated ASCII "konbini" cat, with a different
 * pose and message per column. Two frames per cat are cycled purely in CSS
 * (styles.css) for a gentle idle animation; no JS timers.
 */

interface EmptyArt {
	frames: [string, string];
	message: string;
}

// Each cat is 3 lines; the two frames differ slightly (a blink, a drifting "z",
// a twitch) for a subtle loop. Keep them pure ASCII for monospace alignment.
const ART: Record<string, EmptyArt> = {
	backlog: {
		frames: ["  /\\_/\\  \n ( -.-)z \n  > ^ <  ", "  /\\_/\\ z\n ( -.- ) \n  > ^ <  "],
		message: "the backlog is napping",
	},
	todo: {
		frames: ["  /\\_/\\  \n ( o.o ) \n  > ^ <  ", "  /\\_/\\  \n ( -.- ) \n  > ^ <  "],
		message: "nothing to do — nice",
	},
	"in progress": {
		frames: ["  /\\_/\\ 7\n ( o.o ) \n  > ^ <  ", "  /\\_/\\  \n ( o.o )7\n  > ^ <  "],
		message: "all caught up!",
	},
	done: {
		frames: ["  /\\_/\\  \n ( ^.^ ) \n  > ^ <  ", "  /\\_/\\  \n ( ^o^ ) \n  > ^ <  "],
		message: "nothing shipped yet",
	},
	canceled: {
		frames: ["  /\\_/\\  \n ( -_- ) \n  > ~ <  ", "  /\\_/\\  \n ( ._. ) \n  > ~ <  "],
		message: "nothing canceled",
	},
};

const DEFAULT_ART: EmptyArt = {
	frames: ["  /\\_/\\  \n ( o.o ) \n  > ^ <  ", "  /\\_/\\  \n ( -.- ) \n  > ^ <  "],
	message: "no tasks",
};

export function renderEmptyKonbini(statusKey: string): HTMLElement {
	const art = ART[statusKey] ?? DEFAULT_ART;
	const wrap = createDiv("bk-empty-konbini");
	wrap.createDiv({ cls: "bk-konbini-label", text: "ｺﾝﾋﾞﾆ" });
	const ascii = wrap.createDiv("bk-ascii");
	for (const frame of art.frames) {
		ascii.createEl("pre", { cls: "bk-ascii-frame", text: frame });
	}
	wrap.createDiv({ cls: "bk-empty-caption", text: art.message });
	return wrap;
}
