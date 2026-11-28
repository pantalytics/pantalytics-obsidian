interface HasPath {
	path: string;
}

export function compareFilePaths(a: HasPath, b: HasPath): number {
	const aParts = a.path.split("/");
	const bParts = b.path.split("/");
	// Root files go last
	if (aParts.length === 2 && bParts.length > 2) return 1;
	if (bParts.length === 2 && aParts.length > 2) return -1;

	// Compare each path segment
	const minLength = Math.min(aParts.length, bParts.length);
	for (let i = 0; i < minLength; i++) {
		if (aParts[i] !== bParts[i]) {
			// For filenames (last part), compare numerically
			if (i === aParts.length - 1) {
				// Extract numbers from the strings
				const aMatches = aParts[i].match(/\d+/g);
				const bMatches = bParts[i].match(/\d+/g);

				if (aMatches && bMatches) {
					// Compare the first numbers found
					const aNum = parseInt(aMatches[0]);
					const bNum = parseInt(bMatches[0]);
					if (aNum !== bNum) {
						return aNum - bNum;
					}
				}
			}
			return aParts[i].localeCompare(bParts[i]);
		}
	}

	// When paths match up to shorter length, shortest wins
	return aParts.length - bParts.length;
}

/** A path as Obsidian names it: the queue's carries a leading slash. */
function bare(path: string): string {
	return path.replace(/^\/+/, "");
}

/**
 * The queue's order with the notes somebody has open in front.
 *
 * A first sync of a large vault runs for minutes, and the note on screen is
 * the one somebody is waiting for: an AI just wrote into it, or they are
 * about to type. Path order alone put it wherever it fell, and a note in the
 * vault's root last of all. Everything that is not open keeps the old order.
 */
export function openFirst(
	isOpen: (path: string) => boolean,
): (a: HasPath, b: HasPath) => number {
	return (a, b) => {
		const aOpen = isOpen(bare(a.path));
		const bOpen = isOpen(bare(b.path));
		if (aOpen !== bOpen) return aOpen ? -1 : 1;
		return compareFilePaths(a, b);
	};
}
