import type { KanbanBoard } from "./view";
import type { Task } from "./data";

const DRAG_THRESHOLD = 4;
const EASE = "cubic-bezier(0.19, 1, 0.22, 1)";

/**
 * Linear-style pointer drag: the grabbed card lifts into a floating clone that
 * follows the cursor, the source slot turns into a placeholder gap, and the
 * surrounding cards animate to open the insertion point as you move. On release
 * the clone settles into the gap and the status is committed.
 */
export function startCardDrag(
	board: KanbanBoard,
	task: Task,
	cardEl: HTMLElement,
	down: PointerEvent
): void {
	if (down.button !== 0) return;
	const startX = down.clientX;
	const startY = down.clientY;
	let started = false;
	let ghost: HTMLElement | null = null;
	let offsetX = 0;
	let offsetY = 0;
	let lastBody: HTMLElement | null = null;
	let lastIndex = -1;

	const onMove = (e: PointerEvent) => {
		if (!started) {
			if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
			started = true;
			begin();
		}
		if (ghost) {
			ghost.style.left = `${e.clientX - offsetX}px`;
			ghost.style.top = `${e.clientY - offsetY}px`;
		}
		updateInsertion(e);
	};

	const onUp = () => {
		activeDocument.removeEventListener("pointermove", onMove);
		activeDocument.removeEventListener("pointerup", onUp);
		if (!started) return;
		// Swallow the click that follows the drag so the note doesn't open.
		activeDocument.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
		}, { capture: true, once: true });
		drop();
	};

	activeDocument.addEventListener("pointermove", onMove);
	activeDocument.addEventListener("pointerup", onUp);

	function begin(): void {
		const rect = cardEl.getBoundingClientRect();
		offsetX = startX - rect.left;
		offsetY = startY - rect.top;

		ghost = cardEl.cloneNode(true) as HTMLElement;
		ghost.addClass("bk-card-ghost");
		ghost.style.width = `${rect.width}px`;
		ghost.style.left = `${rect.left}px`;
		ghost.style.top = `${rect.top}px`;
		activeDocument.body.appendChild(ghost);

		cardEl.addClass("bk-card-placeholder");
		activeDocument.body.addClass("bk-dragging");
	}

	function siblings(body: HTMLElement): HTMLElement[] {
		return Array.from(body.querySelectorAll<HTMLElement>(".bk-card")).filter((c) => c !== cardEl);
	}

	function indexAt(body: HTMLElement, clientY: number): number {
		let i = 0;
		for (const c of siblings(body)) {
			const r = c.getBoundingClientRect();
			if (clientY > r.top + r.height / 2) i++;
			else break;
		}
		return i;
	}

	function updateInsertion(e: PointerEvent): void {
		const body = board.columnBodyAt(e.clientX, e.clientY);
		if (!body) return;
		const index = indexAt(body, e.clientY);
		if (body === lastBody && index === lastIndex) return;
		lastBody = body;
		lastIndex = index;

		const first = board.captureCardRects();
		body.querySelector(".bk-column-empty, .bk-empty-konbini")?.remove();
		const before = siblings(body)[index];
		if (before) body.insertBefore(cardEl, before);
		else body.appendChild(cardEl);
		board.highlightColumn(body);
		board.playCardReflow(first);
	}

	function drop(): void {
		activeDocument.body.removeClass("bk-dragging");
		board.highlightColumn(null);
		const targetStatus = cardEl.closest<HTMLElement>(".bk-column")?.dataset.status ?? task.status;

		const settle = () => {
			ghost?.remove();
			ghost = null;
			cardEl.removeClass("bk-card-placeholder");
			void board.commitDrop(task, targetStatus);
		};

		if (!ghost) {
			settle();
			return;
		}
		// Glide the clone into the placeholder slot, then commit.
		const dest = cardEl.getBoundingClientRect();
		ghost.style.transition = `left 180ms ${EASE}, top 180ms ${EASE}`;
		ghost.style.left = `${dest.left}px`;
		ghost.style.top = `${dest.top}px`;
		ghost.addEventListener("transitionend", settle, { once: true });
		window.setTimeout(settle, 230);
	}
}
