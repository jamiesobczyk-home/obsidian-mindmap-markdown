// Pure pieces of notes and images on topics: which files count as images, the
// embed text a picked image adds to a topic, cleaning up typed note text, and
// where the note popover goes. No Obsidian imports, so they're unit-tested
// under Node; src/note-ui.ts and src/view.ts use them.

// The image formats Obsidian shows inline in an ![[embed]].
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] as const;

// True for a file extension (with or without the dot) or a path ending in one.
export function isImageFile(pathOrExtension: string): boolean {
	const s = pathOrExtension.trim().toLowerCase();
	const dot = s.lastIndexOf(".");
	const ext = dot >= 0 ? s.slice(dot + 1) : s;
	if (dot >= 0 && s.slice(dot + 1).includes("/")) return false;
	return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

// The embed for an image, from the link text Obsidian would write for it.
export function imageEmbed(linktext: string): string {
	return `![[${linktext}]]`;
}

// A topic's text with an embed added at the end. Topic text is one line, so
// the embed goes after a space rather than on a line of its own.
export function appendToTopic(text: string, embed: string): string {
	const base = text.replace(/\s+$/, "");
	return base === "" ? embed : `${base} ${embed}`;
}

// What a typed note is saved as: line endings made "\n", trailing spaces and
// leading or trailing blank lines dropped, but indentation and blank lines
// inside kept. Only blank space means "no note", which is null.
export function normaliseNote(raw: string): string | null {
	const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length > 0 ? lines.join("\n") : null;
}

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

// Where to put a popover of a given size for a topic, inside the area: below
// the topic if it fits, else above, else whichever side has more room; and
// lined up with the topic's left edge but kept inside the area horizontally.
export function placePopover(
	anchor: Rect,
	size: { width: number; height: number },
	area: Rect,
	gap = 8,
	margin = 8,
): { left: number; top: number } {
	const below = area.top + area.height - (anchor.top + anchor.height) - gap - margin;
	const above = anchor.top - area.top - gap - margin;
	let top: number;
	if (size.height <= below || below >= above) top = anchor.top + anchor.height + gap;
	else top = anchor.top - gap - size.height;
	const maxTop = area.top + area.height - margin - size.height;
	top = Math.max(area.top + margin, Math.min(top, maxTop));
	const maxLeft = area.left + area.width - margin - size.width;
	const left = Math.max(area.left + margin, Math.min(anchor.left, maxLeft));
	return { left, top };
}
